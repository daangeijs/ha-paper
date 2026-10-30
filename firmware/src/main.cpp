// HA Paper — device entry point. Wires Display + Board + Services into the UI runtime (src/app).
//
// Tasks: loopTask (core 1) runs App::loop() + DeviceServices::pump() (every 20 ms, at once on input); "x4input"
// (core 1, sleeps on GPIO interrupts) owns the I2C bus (touch/keys/battery/RTC); "x4net" (core 0) runs Wi-Fi,
// the HA WebSocket, OTA and blocking HTTPS; AsyncTCP (core 0) serves the web console and /api/v1.
#include <Arduino.h>
#include <BoardConfig.h>
#if X4_QEMU
#include <esp_heap_caps.h>
#include <esp_rom_sys.h>
#ifdef X4_TEST_WDT_HANG
#include <esp_task_wdt.h>
#include <soc/timer_group_reg.h>
#include <cstring>
#endif
#endif

#include <cstdlib>
#include <ctime>

#include "Logging.h"
#include "app/app.h"
#include "app/gfx/canvas.h"
#include "core/home.h"
#include "core/recovery.h"
#include "hw/watchdog.h"
#if X4_QEMU
#include "hw/qemu_hw.h"
#if X4_QEMU_DEBUG
#include "hw/qemu_debug.h"
#endif
#else
#include "hw/x4_board.h"
#include "hw/x4_display.h"
#endif
#include "net/device_services.h"
#include "net/diag.h"
#include "net/hub.h"
#include "net/improv_serial.h"
#include "net/web_server.h"
#include "net/log.h"
#include "net/morning_rtc.h"
#include "net/ota.h"
#include "net/power.h"
#include "net/time_sync.h"
#include "net/util.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// Keep a freshly installed OTA image in ESP_OTA_IMG_PENDING_VERIFY until it proves itself (net/ota.h).
// Must be extern "C": the Arduino core's weak default (esp32-hal-misc.c, returns false → image confirmed before
// setup()) is a C symbol. With C++ linkage this override was silently ignored and rollback could never happen
// (found with the real firmware under QEMU, sim/qemu/ota-fw-test.sh).
extern "C" bool verifyRollbackLater() { return true; }

namespace {
#if X4_QEMU
x4::QemuDisplay g_display;   // Espressif QEMU: no panel / I2C / LEDC (docs/ESP32_EMULATION.md §5)
x4::QemuBoard g_board;
#else
x4::X4Display g_display;
x4::X4Board g_board;
#endif
x4::App* g_app = nullptr;

#ifdef X4_TEST_WDT_HANG
// QEMU's ESP32-S3 timer-group watchdog never counts or fires (docs/ESP32_EMULATION.md), so the TWDT cannot reset the
// guest. This shows what QEMU can: the TWDT hardware is armed (30 s, stage 0 = interrupt) with loopTask subscribed,
// and after the hang the TWDT's own bookkeeping names loopTask as the task blocking the feed. Then it takes the reset
// the TWDT interrupt takes under QEMU (esp_task_wdt_isr_user_handler, hw/qemu_hw.cpp). Runs on loopTask: never feeds.
__attribute__((noinline)) void qemuTaskWdtStandIn() {
  const uint32_t cfg0 = REG_READ(TIMG_WDTCONFIG0_REG(0));
  const uint32_t prescale = REG_READ(TIMG_WDTCONFIG1_REG(0)) >> 16;
  const uint32_t ms = uint32_t(uint64_t(REG_READ(TIMG_WDTCONFIG2_REG(0))) * prescale / 80000);   // APB 80 MHz
  esp_rom_printf("[qemu] TWDT armed: en=%u stage0=%u timeout %u ms · loopTask %s\n", unsigned(cfg0 >> 31),
                 unsigned((cfg0 >> 29) & 3), unsigned(ms), esp_task_wdt_status(nullptr) == ESP_OK ? "subscribed" : "NOT subscribed");
  delay(x4::wdt::kTimeoutMs + 1000);
  static char list[256];
  list[0] = '\0';
  // A header, then "- <task> (CPU n)" per task that did not reset; one line in the log.
  esp_task_wdt_print_triggered_tasks([](void*, const char* msg) { strlcat(list, msg, sizeof list); }, nullptr, nullptr);
  for (char* c = list; *c; c++)
    if (*c == '\n' || *c == '\r') *c = ' ';
  esp_rom_printf("[qemu] TWDT after %u s, not reset:%s\n", unsigned(x4::wdt::kTimeoutMs / 1000 + 1), list);
  if (strstr(list, "loopTask")) esp_task_wdt_isr_user_handler();
  esp_rom_printf("[qemu] loopTask not reported by the TWDT · hanging\n");
  for (;;) delay(1000);
}
#endif
// loop() sleeps this long between passes unless the board queues input (task notification). Bounds the latency of
// Hub work (HA updates, web config, restart requests), which is polled, not signalled.
constexpr uint32_t kLoopIdleMs = 20;

}  // namespace

void setup() {
  // Log ring in PSRAM + the previous boot's tail out of RTC memory, before the first LOG line (net/log.h, #200).
  x4::net::logBegin();
  // Deep-sleep wake cause + the glance record in RTC memory (net/power.h); diag reads it under QEMU.
  x4::net::powerEarlyBoot();
  // Reset reason + the panic message of the previous boot, before anything else can crash (net/diag.h).
  x4::net::diagEarlyBoot();
  // Unconfirmed OTA image: arm the restart guard before anything can hang, so a broken update always ends in a reset
  // (→ bootloader rollback), even one that never crashes (net/ota.h).
  const bool otaGuard = x4::net::otaBootGuard();
  x4::wdt::begin();   // task watchdog 30 s for every image (hw/watchdog.h); tasks subscribe themselves
#if X4_QEMU
  esp_rom_printf("[qemu] setup()\n");
  Serial.begin(115200);   // UART0 (ARDUINO_USB_CDC_ON_BOOT=0): QEMU drops USB-Serial-JTAG output
  LOG_INF("MAIN", "HA Paper %s · QEMU (X4_QEMU)", x4::net::firmwareVersion());
  if (otaGuard) LOG_WRN("MAIN", "unconfirmed OTA image · rollback guard armed");
#if X4_QEMU_DEBUG
  x4::qemuDebugBegin();
#endif
#else
  // GPIO1 (power latch + touch rail) is already HIGH and pad-held: a constructor in hw/x4_board.cpp asserts it before
  // Arduino's init (#225). Not BoardConfig::holdPowerRails(): it releases the hold. X4 Pro has no chargeEnable pin.
  Serial.begin(115200);
  Serial.setTxTimeoutMs(1);   // HWCDC, logged from several tasks: no host reading → each write blocks 100 ms by default (crosspoint-reader does the same)
  LOG_INF("MAIN", "HA Paper %s · %s", x4::net::firmwareVersion(), BoardConfig::isX4Pro() ? "X4 Pro" : "?");
  x4::powerLatchLog();
  if (otaGuard) LOG_WRN("MAIN", "unconfirmed OTA image · rollback guard armed");
#endif

  // malloc() keeps Arduino's split: up to 4 KB internal, above that PSRAM. HA data that fragmented internal RAM
  // allocates PSRAM explicitly instead (net/psram.h, core/psram_alloc.h). Not lower (#79): libraries hand plain
  // malloc'd buffers to DMA peripherals, e.g. NetworkClientSecure's `new sslclient_context` holds the CTR_DRBG counter
  // the AES DMA reads, and QEMU's GDMA can't read PSRAM (every https call hung).

  auto& services = x4::net::deviceServices();
  services.begin();                                          // storage, Wi-Fi, web server, net task
  x4::net::diagBegin();                                      // boot ring → userdata /diag.json
  // Glance timer wake (#10): no boot screen, the panel keeps what it shows until a visible value changed. A key wake
  // from glance sleep (#299) holds it too, until the data is in.
  const bool glanceWake = x4::net::powerBegin(services.bootSettings());
#ifdef X4_TEST_CRASH_ON_BOOT
  // Test-only image (sim/qemu/ota-fw-test.sh): a broken update that resets before it is confirmed must be rolled
  // back by the bootloader. esp_restart() rather than abort(): QEMU's panic handler loops instead of resetting.
  LOG_ERR("MAIN", "X4_TEST_CRASH_ON_BOOT · resetting before the image is confirmed");
  Serial.flush();
  esp_restart();
#endif
#ifdef X4_TEST_HANG_ON_BOOT
  // Test-only: a broken update that hangs instead of crashing (network up, UI never starts). Not confirmed because
  // loop() never runs; the guard armed by otaBootGuard() restarts it → bootloader rollback.
  LOG_ERR("MAIN", "X4_TEST_HANG_ON_BOOT · hanging before the UI starts");
  for (;;) delay(1000);
#endif
  // loopTask joins the task watchdog after the test hooks: the hang-test image must stay the OTA guard's case.
  // Every step below (first-boot panel init, first full refresh ~3 s) is well under 30 s; a panel whose BUSY never
  // releases gives up after 20 s per wait, feeding the watchdog, once (core/panel_guard.h, #181).
  x4::wdt::subscribe();
  setenv("TZ", x4::net::timezone().c_str(), 1);
  tzset();
  {
    const char* ps = x4::net::wifiPsMode();   // Wi-Fi was started by services.begin()
    LOG_INF("MAIN", "power · CPU %u MHz · Wi-Fi PS %s · USB host %s", unsigned(getCpuFrequencyMhz()), ps ? ps : "n/a",
            x4::net::usbHostPlugged() ? "yes" : "no");
  }
#if !X4_QEMU
  // First-boot diagnostics: the X4 Pro has 8 MB octal PSRAM; without it the app framebuffer (96 KB) and the gray
  // planes fall back to internal RAM / B/W (hw/x4_display.cpp, app/app.cpp).
  if (psramFound()) {
    LOG_INF("MAIN", "PSRAM %u KB free · heap %u KB free", unsigned(ESP.getFreePsram() / 1024), unsigned(ESP.getFreeHeap() / 1024));
  } else {
    LOG_ERR("MAIN", "!!! PSRAM NOT FOUND · heap %u KB free · running on internal RAM only", unsigned(ESP.getFreeHeap() / 1024));
  }
#endif
  g_board.begin();
  g_board.notifyOnInput(xTaskGetCurrentTaskHandle());   // setup() and loop() both run on loopTask
  x4::net::setRemoteInput(&g_board);
  // A failed panel init (no framebuffer, or BUSY stuck: /status panel "failed") is logged, not retried: restarting
  // would loop forever, and the web console (already up) is the way to diagnose it. Refreshes are no-ops until the next
  // boot.
  if (!g_display.begin()) LOG_ERR("MAIN", "!!! display init FAILED · panel stays blank; web console still serves");
  {
    std::lock_guard<std::recursive_mutex> l(x4::net::hub().mu);
    x4::net::hub().lastFrame = nullptr;
  }
  services.onForceRefresh([] {
    const uint32_t t0 = millis();
    g_display.redrawLast();
    LOG_INF("APP", "EPD full refresh (manual · last frame) · %u ms", unsigned(millis() - t0));
  });

  g_app = new x4::App(g_display, g_board, services);
  g_app->setPanelHeld(glanceWake);
  g_app->setBootWake(x4::net::powerWakeName());   // quiet hours (#295): a press, power-on or charger boot opens with a peek
  g_app->setMorningState(x4::net::morningRtcLoad());   // Good morning page (#330): armed overnight, across deep sleep
  g_app->onMorningState([](const x4::morning::State& m) { x4::net::morningRtcSave(m); });
#if !X4_QEMU
  x4::net::powerOnSleep([](int64_t seconds) {
    g_display.sleep();             // panel deep-sleep command first: the rails go down next
    g_board.deepSleep(seconds);
  });
#endif
  if (!g_app->framebuffer().data) LOG_ERR("MAIN", "!!! out of memory for the 96 KB UI framebuffer · nothing will be drawn");
  if (g_app->framebuffer().data) {   // render micro-benchmark, once per boot (#213); begin() repaints the framebuffer
    x4::Framebuffer fb = g_app->framebuffer();   // same buffer (a pointer)
    x4::Canvas c(&fb);
    const uint32_t t0 = micros();
    c.box(x4::rc(0, 0, x4::kScreenW, x4::kScreenH), 10, x4::Ink::Paper, 2, x4::Ink::Black);
    const uint32_t t1 = micros();
    c.arc(400, 240, 46, 12, -90, 250, x4::Ink::Black);
    const uint32_t t2 = micros();
    c.tone(x4::rc(0, 0, 400, 240), 14, x4::Tone::Track);
    LOG_INF("MAIN", "render bench · full-screen card %u us · arc r46 %u us · tone 400x240 %u us", unsigned(t1 - t0),
            unsigned(t2 - t1), unsigned(micros() - t2));
  }
  g_app->onLog([](const std::string& s) { LOG_INF("APP", "%s", s.c_str()); });   // every refresh with its reason (#71)
  g_app->onPowerStage([](const char* s) { x4::net::powerKeyStage(s); });   // #225 power trail
  g_app->onSettingsChanged([](const x4::DisplaySettings& s) { x4::net::deviceServices().saveDeviceSettings(s); });
  g_app->begin(services.bootConfig(), services.bootSettings());
  // Safe recovery (#21): ≥ 3 crash resets in a row → offer the factory reset screen (Right erases, 10 s timeout).
  if (const int streak = x4::net::diagCrashStreak(); streak >= x4::kCrashLoopBoots) {
    LOG_WRN("MAIN", "crash loop · %d crash resets in a row · offering factory reset", streak);
    g_app->offerRecovery();
  }
}

void loop() {
  x4::wdt::feedIfSubscribed();
  g_app->loop();
  x4::net::otaLoopAlive();
  x4::net::diagLoop();
  x4::net::deviceServices().pump(*g_app, g_board);
  x4::net::powerLoop(*g_app, g_board);   // live: may deep-sleep; glance wake: snapshot → redraw? → sleep
  x4::net::improvPoll();   // Wi-Fi from the web flasher over the serial console (#31)
  if (x4::net::takeTimeSynced()) g_board.writeRtcFromSystemClock();
  {
    // expose the panel content to GET /api/v1/screens/{id}/preview.png
    const uint8_t* f = g_display.lastFrame();
    std::lock_guard<std::recursive_mutex> l(x4::net::hub().mu);
    x4::net::hub().lastFrame = f;
  }
  {
    // GET /console/state entity_gaps (#86): tile entities HA has no value for, from the App's store, once a second
    static uint32_t gapsAt = 0;
    const uint32_t now = millis();
    if (now - gapsAt >= 1000) {
      gapsAt = now;
      auto gaps = x4::entityGaps(g_app->config(), g_app->entities());
#if X4_QEMU
      std::string regions;   // GET /__qemu/regions: what each region shows (canvas signatures), for contract checks
      for (auto& kv : g_app->regionSignatures()) regions += kv.first + "\t" + kv.second + "\n";
#endif
      std::lock_guard<std::recursive_mutex> l(x4::net::hub().mu);
      x4::net::hub().entityGaps = std::move(gaps);
#if X4_QEMU
      x4::net::hub().regionText = std::move(regions);
#endif
    }
  }
#ifdef X4_TEST_WDT_HANG
  // Test-only (sim/qemu/wdt-test.sh): a confirmed image whose loop task hangs must be reset by the task watchdog.
  // Hangs 20 s after boot (network up), but not again after a TASK_WDT reset, so the test sees the device come back.
  static const bool hang = esp_reset_reason() != ESP_RST_TASK_WDT;
  if (hang && millis() > 20000) {
    LOG_ERR("MAIN", "X4_TEST_WDT_HANG · loop task hangs now");
    qemuTaskWdtStandIn();
  }
#endif
  ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(kLoopIdleMs));   // input wakes us at once; was delay(1), a 1 kHz spin
}
