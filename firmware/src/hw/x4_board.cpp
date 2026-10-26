#include "hw/x4_board.h"

#include <Arduino.h>
#include <BatteryMonitor.h>
#include <BoardConfig.h>
#include <HWCDC.h>
#include <FrontlightManager.h>
#include <InputManager.h>
#include <PowerManager.h>
#include <Rtc.h>
#include <Wire.h>
#include <driver/gpio.h>
#include <driver/rtc_io.h>
#include <esp_rom_gpio.h>
#include <esp_rtc_time.h>
#include <esp_sleep.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <sys/time.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <ctime>

#include "Logging.h"
#include "core/cw2017.h"
#include "core/logic.h"
#include "core/recovery.h"
#include "hw/hw_diag.h"
#include "hw/watchdog.h"

namespace x4 {

namespace {
uint64_t g_latchUs = 0;     // RTC time (µs since power-on) when the latch was asserted; 0 = no latch pin

// Glitch-free: level and output enable are set while a hold from the previous boot still freezes the pad, then the
// hold is cycled (dis → en) with the pad already driven HIGH. Plain registers only: runs from a global constructor.
void assertLatch(int8_t pin) {
  if (pin < 0) return;
  const auto g = static_cast<gpio_num_t>(pin);
  esp_rom_gpio_pad_select_gpio(g);
  gpio_set_level(g, 1);
  gpio_set_direction(g, GPIO_MODE_INPUT_OUTPUT);   // input too: powerLatchHigh() reads the pad
  gpio_hold_dis(g);
  gpio_hold_en(g);
}

__attribute__((constructor)) void powerLatchEarly() {
  const int8_t pin = BoardConfig::XTEINK_X4_PRO.power.latch0;
  if (pin < 0) return;
  assertLatch(pin);
  assertLatch(BoardConfig::XTEINK_X4_PRO.power.latch1);
  g_latchUs = esp_rtc_get_time_us();
}

InputManager g_input;
FrontlightManager g_light;
BatteryMonitor g_battery;   // charge STAT pin (GPIO21); SoC via g_gauge on a CW2017 board
freeink::Rtc g_rtc;
Cw2017 g_gauge;
uint32_t g_adcNext = 0;     // non-CW2017 boards: vendor read (ADC, no blocking recovery) every kBatteryEveryMs

bool gaugeIsCw2017() {
  const auto& g = BoardConfig::ACTIVE.batteryGauge;
  return g.gaugeAddr != 0 && g.gaugeType == BoardConfig::GaugeType::Cw2017;
}

// Same transactions as the vendor readReg8/writeReg8 (repeated start), on the shared Wire owned by x4input.
struct WireGauge : Cw2017Bus {
  bool read(uint8_t reg, uint8_t& v) override {
    const uint8_t a = BoardConfig::ACTIVE.batteryGauge.gaugeAddr;
    Wire.beginTransmission(a);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(a, static_cast<uint8_t>(1), static_cast<uint8_t>(true)) < 1) return false;
    v = static_cast<uint8_t>(Wire.read());
    return true;
  }
  bool write(uint8_t reg, uint8_t v) override {
    Wire.beginTransmission(BoardConfig::ACTIVE.batteryGauge.gaugeAddr);
    Wire.write(reg);
    Wire.write(v);
    return Wire.endTransmission(true) == 0;
  }
} g_gaugeBus;

constexpr uint32_t kBatteryEveryMs = 30000;
constexpr int64_t kSaneEpoch = 1700000000;   // 2023-11 — anything earlier means "clock not set"
constexpr uint32_t kTouchProbeEveryMs = 60000;
constexpr uint8_t kTouchProbeFailLimit = 3;

constexpr uint32_t kFastPollMs = 8;        // key debounce or touch contact in flight
constexpr uint32_t kFallbackPollMs = 15;   // GT911 INT not yet seen working: the old polling cadence
constexpr uint32_t kIdleCapMs = 1000;      // longest sleep on interrupts (a lost edge costs at most this)

uint32_t g_touchRecoveries = 0;
TaskHandle_t g_inputTask = nullptr;
volatile uint32_t g_touchEdges = 0;
bool g_touchIrqArmed = false;

void IRAM_ATTR onInputEdge() {
  BaseType_t woken = pdFALSE;
  if (g_inputTask) vTaskNotifyGiveFromISR(g_inputTask, &woken);
  portYIELD_FROM_ISR(woken);
}

void IRAM_ATTR onTouchEdge() {
  g_touchEdges = g_touchEdges + 1;
  onInputEdge();
}

// GT911 INT (GPIO10). Its trigger mode lives in the self-loaded OEM config, so wake on both edges. Armed only while
// the controller answers: with the rail off the pin floats.
void armTouchIrq(bool on) {
  const auto& t = BoardConfig::ACTIVE.touch;
  if (t.controller != BoardConfig::TouchController::Gt911 || t.irq < 0) return;
  on = on && g_input.hasTouch();
  if (on == g_touchIrqArmed) return;
  if (on) attachInterrupt(t.irq, onTouchEdge, CHANGE);
  else detachInterrupt(t.irq);
  g_touchIrqArmed = on;
}

bool touchRailGated() {
  const auto& t = BoardConfig::ACTIVE.touch;
  return t.controller == BoardConfig::TouchController::Gt911 && t.powerEnable >= 0;
}

// A warm reset doesn't cycle the GT911 rail: drop it, then let the SDK redo power-on + reset/address dance + probe.
bool recoverTouch() {
  if (!touchRailGated()) return false;
  const auto& t = BoardConfig::ACTIVE.touch;
  armTouchIrq(false);   // the reset dance drives INT as an output
  pinMode(t.powerEnable, OUTPUT);
  digitalWrite(t.powerEnable, t.powerEnableActiveHigh ? LOW : HIGH);   // rail off
  delay(100);
  g_input.begin();
  ++g_touchRecoveries;
  if (g_input.hasTouch()) {
    LOG_INF("BOARD", "GT911 recovered (recovery #%u)", static_cast<unsigned>(g_touchRecoveries));
  } else {
    LOG_WRN("BOARD", "GT911 still absent after rail cycle (recovery #%u)", static_cast<unsigned>(g_touchRecoveries));
  }
  armTouchIrq(true);
  return g_input.hasTouch();
}

// ACK on either strap address; the SDK keeps the resolved one private.
bool touchAcks() {
  const auto& t = BoardConfig::ACTIVE.touch;
  for (const uint8_t a : {t.i2cAddress, t.i2cAddressAlt}) {
    if (a == 0) continue;
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) return true;
  }
  return false;
}

// days since 1970-01-01 for a civil date (Howard Hinnant)
int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<int64_t>(era) * 146097 + static_cast<int64_t>(doe) - 719468;
}
}  // namespace

bool powerLatchHigh() {
  const int8_t pin = BoardConfig::ACTIVE.power.latch0;
  return pin >= 0 && gpio_get_level(static_cast<gpio_num_t>(pin)) == 1;
}

void powerLatchLog() {
  const int8_t pin = BoardConfig::ACTIVE.power.latch0;
  if (pin < 0) {
    LOG_WRN("POWER", "no power latch pin in the board profile");
    return;
  }
  // On a cold power-on this is how long Power must be held before the board keeps itself on (stock: "Hold Power to
  // turn on"); after a deep-sleep wake the RTC clock counts from the first power-on, so it is only reported then.
  if (esp_reset_reason() == ESP_RST_POWERON)
    LOG_INF("POWER", "latch GPIO%d %s · held · asserted %u ms after power-on", pin, powerLatchHigh() ? "HIGH" : "LOW?!",
            unsigned(g_latchUs / 1000));
  else
    LOG_INF("POWER", "latch GPIO%d %s · held (kept through the reset)", pin, powerLatchHigh() ? "HIGH" : "LOW?!");
}

void X4Board::begin() {
  queue_ = xQueueCreate(32, sizeof(InputEvent));
  // After a deep-sleep wake (#10) the wake pins are still RTC IO and the front-light pads still held LOW: hand them
  // back to the digital GPIO matrix before the drivers configure them (no-op after any other reset).
  if (esp_reset_reason() == ESP_RST_DEEPSLEEP) {
    for (const int8_t pin : {BoardConfig::ACTIVE.input.power, BoardConfig::ACTIVE.input.down, BoardConfig::ACTIVE.batteryChargeStatus})
      if (pin >= 0) rtc_gpio_deinit(static_cast<gpio_num_t>(pin));
    for (const int8_t pin : {BoardConfig::ACTIVE.frontlight.gpio, BoardConfig::ACTIVE.frontlight.gpioWarm})
      if (pin >= 0) gpio_hold_dis(static_cast<gpio_num_t>(pin));
  }
  g_input.begin();
  if (!g_input.hasTouch() && touchRailGated()) {
    LOG_WRN("BOARD", "GT911 not found, cycling touch rail");
    recoverTouch();
  }
  g_light.begin();
  g_light.off();
  // TZ before any localtime(): RTC holds UTC, the UI shows local time.
  const char* tz = getenv("TZ");
  if (!tz || !*tz) {
    setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3", 1);   // Europe/Amsterdam (overridden by net/time_sync)
    tzset();
  }
  if (g_rtc.begin()) {
    freeink::Rtc::DateTime dt;
    if (g_rtc.now(dt) && dt.year >= 2024) {
      const int64_t epoch = daysFromCivil(dt.year, dt.month, dt.day) * 86400 + dt.hour * 3600 + dt.minute * 60 + dt.second;
      timeval tv{static_cast<time_t>(epoch), 0};
      settimeofday(&tv, nullptr);
      LOG_INF("BOARD", "clock from BM8563: %04u-%02u-%02u %02u:%02u UTC", dt.year, dt.month, dt.day, dt.hour, dt.minute);
    } else {
      LOG_WRN("BOARD", "BM8563 time not set (waiting for NTP)");
    }
  } else {
    LOG_WRN("BOARD", "BM8563 RTC not found");
  }
  // Boot may wait for a gauge recovery (≤ ~4.2 s, as before) so the first frame has a real percentage.
  if (gaugeIsCw2017()) Wire.begin(BoardConfig::ACTIVE.batteryGauge.i2cSda, BoardConfig::ACTIVE.batteryGauge.i2cScl,
                                  BoardConfig::ACTIVE.batteryGauge.i2cHz);   // no-op when touch already began it
  const uint32_t t0 = ::millis();
  readBattery(t0);
  while (g_gauge.recovering() && ::millis() - t0 < 5000) {
    delay(g_gauge.msUntilDue(::millis()));
    readBattery(::millis());
  }
  TaskHandle_t h = nullptr;
  xTaskCreatePinnedToCore(taskEntry, "x4input", 6144, this, 4, &h, 1);
  inputTask_ = h;
  g_inputTask = h;
  // Keys are active-LOW with pull-ups (Left GPIO0, Right GPIO7, Power GPIO3): any edge wakes the task, which then
  // samples until the SDK debounce settles.
  const auto& in = BoardConfig::ACTIVE.input;
  for (const int8_t pin : {in.up, in.down, in.power}) {
    if (pin >= 0) attachInterrupt(pin, onInputEdge, CHANGE);
  }
  armTouchIrq(true);
}

uint32_t X4Board::batteryDueIn(uint32_t now) const {
  if (gaugeIsCw2017()) return g_gauge.msUntilDue(now);
  return int32_t(now - g_adcNext) >= 0 ? 0 : g_adcNext - now;
}

// One gauge step when due: a steady read every 30 s, or the next 20–100 ms step of a recovery. Never blocks.
void X4Board::readBattery(uint32_t now) {
  if (batteryDueIn(now) != 0) return;
  if (gaugeIsCw2017()) {
    const bool wasRecovering = g_gauge.recovering();
    if (g_gauge.step(g_gaugeBus, now)) {
      battery_ = g_gauge.soc();
      batteryMv_ = g_gauge.mv();
      batteryKnown_ = true;
    }
    if (g_gauge.recovering() != wasRecovering) LOG_INF("BOARD", "CW2017 %s", wasRecovering ? "recovery done" : "recovering");
  } else {
    g_adcNext = now + kBatteryEveryMs;
    uint16_t pct;
    if (g_battery.readPercentageChecked(pct)) {
      battery_ = static_cast<uint8_t>(pct > 100 ? 100 : pct);
      batteryKnown_ = true;
    }
  }
  charging_ = g_battery.isCharging();   // GPIO21 only: the CW2017 cannot observe charging
}

void X4Board::notifyOnInput(void* task) { consumer_ = task; }

bool X4Board::pushInput(const InputEvent& e) {
  auto* q = static_cast<QueueHandle_t>(queue_);
  if (!q || xQueueSend(q, &e, 0) != pdTRUE) return false;
  if (auto* c = static_cast<TaskHandle_t>(consumer_.load())) xTaskNotifyGive(c);
  return true;
}

void X4Board::taskEntry(void* self) { static_cast<X4Board*>(self)->task(); }

void X4Board::task() {
  auto* q = static_cast<QueueHandle_t>(queue_);
  auto send = [this, q](const InputEvent& e) {
    xQueueSend(q, &e, 0);
    if (auto* c = static_cast<TaskHandle_t>(consumer_.load())) xTaskNotifyGive(c);
  };
  auto emitKey = [&send](Key k) {
    InputEvent e{};
    e.kind = InputEvent::Kind::KeyDown;
    e.key = k;
    send(e);
  };
  bool down = false;
  float sx = 0, sy = 0, lx = 0, ly = 0;
  uint32_t downMs = 0, lastTouchProbe = ::millis();
  bool touchSeen = g_input.hasTouch();
  uint8_t touchFails = 0;
  // Until a touch-down arrives together with a GT911 INT edge, poll at the old cadence: a GT911 that never raises
  // INT (unknown config) must keep working. After that, sleep on the notification.
  bool touchIrqOk = false;
  uint32_t seenEdges = g_touchEdges;
  wdt::subscribe();
  for (;;) {
    wdt::feedIfSubscribed();
    const uint32_t edges = g_touchEdges;
    const bool touchEdge = edges != seenEdges;
    seenEdges = edges;
    g_input.update();
    if (g_input.wasPressed(InputManager::BTN_UP)) emitKey(Key::Prev);       // Left  GPIO0
    if (g_input.wasPressed(InputManager::BTN_DOWN)) emitKey(Key::Next);     // Right GPIO7
    if (g_input.wasPressed(InputManager::BTN_POWER)) emitKey(Key::Power);   // GPIO3
    const bool homeKey = g_input.wasHomeKeyPressed();
    if (homeKey) emitKey(Key::Home);                                        // GT911 capacitive key

    float nx, ny;
    const bool touchDown = g_input.wasTouchPressedAt(nx, ny);
    if ((touchDown || homeKey) && touchEdge && !touchIrqOk) {
      touchIrqOk = true;
      LOG_INF("BOARD", "GT911 INT seen · input task now sleeps on interrupts");
    }
    if (touchDown) {
      down = true;
      sx = lx = nx;
      sy = ly = ny;
      downMs = ::millis();
    }
    if (down && g_input.isTouchHeldAt(nx, ny)) {
      lx = nx;
      ly = ny;
    }
    bool swiped = false;
    if (down && g_input.wasTouchReleased()) {
      down = false;
      const int dx = static_cast<int>(std::lround((lx - sx) * kScreenW));
      const int dy = static_cast<int>(std::lround((ly - sy) * kScreenH));
      const int nav = swipeNav(dx, dy, ::millis() - downMs);   // same rule as the emulator (core/logic.h)
      if (nav != 0) {
        InputEvent e{};
        e.kind = InputEvent::Kind::Swipe;
        e.x = static_cast<int16_t>(sx * kScreenW);
        e.y = static_cast<int16_t>(sy * kScreenH);
        e.dir = static_cast<int8_t>(-nav);   // finger moves left → next page (dir -1)
        send(e);
        swiped = true;
      }
    }
    if (g_input.wasTouchTap(nx, ny) && !swiped) {
      InputEvent e{};
      e.kind = InputEvent::Kind::Tap;
      e.x = static_cast<int16_t>(nx * kScreenW);
      e.y = static_cast<int16_t>(ny * kScreenH);
      send(e);
    }

    const uint32_t now = ::millis();
    readBattery(now);
    if (now - lastTouchProbe > kTouchProbeEveryMs) {
      lastTouchProbe = now;
      touchSeen = touchSeen || g_input.hasTouch();
      if (touchSeen && !down && touchRailGated()) {
        touchFails = touchAcks() ? 0 : touchFails + 1;
        if (touchFails >= kTouchProbeFailLimit) {
          LOG_WRN("BOARD", "GT911 not ACKing (%u probes), cycling touch rail", static_cast<unsigned>(touchFails));
          touchFails = 0;
          recoverTouch();
        }
      }
    }
    if (rtcWriteRequested_.exchange(false)) {
      const time_t t = time(nullptr);
      if (t > kSaneEpoch && g_rtc.present()) {
        tm u;
        gmtime_r(&t, &u);
        freeink::Rtc::DateTime dt;
        dt.year = static_cast<uint16_t>(u.tm_year + 1900);
        dt.month = static_cast<uint8_t>(u.tm_mon + 1);
        dt.day = static_cast<uint8_t>(u.tm_mday);
        dt.hour = static_cast<uint8_t>(u.tm_hour);
        dt.minute = static_cast<uint8_t>(u.tm_min);
        dt.second = static_cast<uint8_t>(u.tm_sec);
        dt.weekday = static_cast<uint8_t>(u.tm_wday);
        if (g_rtc.set(dt)) LOG_INF("BOARD", "BM8563 set from NTP");
      }
    }
    // Poll while a debounce or touch is in flight; otherwise sleep until an edge, an RTC write request or the next
    // periodic job (battery 30 s or a recovery step, touch probe 60 s), capped at kIdleCapMs.
    uint32_t waitMs;
    if (down || g_input.isDebouncePending()) {
      waitMs = kFastPollMs;
    } else if (!touchIrqOk && g_touchIrqArmed) {
      waitMs = kFallbackPollMs;
    } else {
      const uint32_t t = ::millis();
      auto until = [t](uint32_t last, uint32_t every) { return t - last > every ? 0u : every + 1 - (t - last); };
      waitMs = std::min({kIdleCapMs, batteryDueIn(t), until(lastTouchProbe, kTouchProbeEveryMs)});
    }
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(waitMs));
  }
}

bool X4Board::pollInput(InputEvent& out) {
  return queue_ && xQueueReceive(static_cast<QueueHandle_t>(queue_), &out, 0) == pdTRUE;
}

void X4Board::setFrontlight(uint8_t brightnessPct, uint8_t warmthPct) {
  if (!g_light.present()) return;
  if (brightnessPct == 0) {
    g_light.off();
    return;
  }
  if (g_light.hasColorTemperature()) g_light.setColorTemperature(warmthPct > 100 ? 100 : warmthPct);
  g_light.setBrightness(brightnessPct > 100 ? 100 : brightnessPct);
  g_light.on();
}

PowerInfo X4Board::power() { return PowerInfo{battery_.load(), charging_.load(), HWCDC::isPlugged(), batteryKnown_.load(), batteryMv_.load()}; }

uint32_t X4Board::millis() { return ::millis(); }

int64_t X4Board::epochSeconds() {
  const time_t t = time(nullptr);
  return t > kSaneEpoch ? static_cast<int64_t>(t) : 0;
}

void X4Board::restart() {
  LOG_INF("POWER", "restart · latch GPIO%d %s, held through the reset", BoardConfig::ACTIVE.power.latch0,
          powerLatchHigh() ? "HIGH" : "LOW?!");
  Serial.flush();
  g_light.off();
  ESP.restart();
}

void X4Board::deepSleep(int64_t seconds) {
  // The input task owns I2C (touch, gauge, RTC): stop it before the rails go down.
  if (inputTask_) vTaskSuspend(static_cast<TaskHandle_t>(inputTask_));
  g_light.off();
  // Front light pads LOW and held through sleep (FrontlightManager::park() is only built with FREEINK_FRONTLIGHT_LS).
  for (const int8_t pin : {BoardConfig::ACTIVE.frontlight.gpio, BoardConfig::ACTIVE.frontlight.gpioWarm}) {
    if (pin < 0) continue;
    gpio_hold_dis(static_cast<gpio_num_t>(pin));
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    gpio_hold_en(static_cast<gpio_num_t>(pin));
  }
  freeink::PowerManager::powerDownRailsForSleep();   // touch rail (GPIO2) off, SD (GPIO5) off, panel RST held
  // GPIO1 (power latch) HIGH through deep sleep, or the X4 Pro cold-boots instead of waking (crosspoint HalPowerManager).
  // Held since the first constructor (#225); asserted again in case anything touched it.
  assertLatch(BoardConfig::ACTIVE.power.latch0);
  assertLatch(BoardConfig::ACTIVE.power.latch1);
  // Wake: Power (GPIO3) or Right (GPIO7) pressed (ext1, any low). Left (GPIO0) stays out: it is the download strap.
  const auto& in = BoardConfig::ACTIVE.input;
  uint64_t keys = 0;
  if (in.power >= 0) keys |= 1ULL << in.power;
  if (in.down >= 0) keys |= 1ULL << in.down;
  if (keys) freeink::PowerManager::armWakeOnPins(keys, !in.powerActiveHigh);
  // Charger STAT (GPIO21, active-high: charging) → wake (ext0)
  if (const int8_t stat = BoardConfig::ACTIVE.batteryChargeStatus; stat >= 0) esp_sleep_enable_ext0_wakeup(static_cast<gpio_num_t>(stat), 1);
  if (seconds > 0) esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(seconds) * 1000000ULL);
  LOG_INF("POWER", "deep sleep · timer %lld s · wake keys mask 0x%llx · latch GPIO%d %s, held", static_cast<long long>(seconds),
          static_cast<unsigned long long>(keys), BoardConfig::ACTIVE.power.latch0, powerLatchHigh() ? "HIGH" : "LOW?!");
  Serial.flush();
  freeink::PowerManager::deepSleep();
}

// Plain GPIO reads, safe from loopTask (no I2C): Left GPIO0 / Right GPIO7 active-LOW, Power per board polarity.
void X4Board::pause(uint32_t ms) { ::delay(ms); }

uint8_t X4Board::heldKeys() {
  const auto& in = BoardConfig::ACTIVE.input;
  uint8_t k = 0;
  if (in.power >= 0 && digitalRead(in.power) == (in.powerActiveHigh ? HIGH : LOW)) k |= kKeyPower;
  if (in.down >= 0 && digitalRead(in.down) == LOW) k |= kKeyRight;
  if (in.up >= 0 && digitalRead(in.up) == LOW) k |= kKeyLeft;
  return k;
}

void X4Board::writeRtcFromSystemClock() {
  rtcWriteRequested_ = true;
  if (inputTask_) xTaskNotifyGive(static_cast<TaskHandle_t>(inputTask_));
}

int64_t touchRecoveries() { return touchRailGated() ? static_cast<int64_t>(g_touchRecoveries) : -1; }

}  // namespace x4
