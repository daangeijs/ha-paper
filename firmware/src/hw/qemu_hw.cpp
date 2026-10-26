#if X4_QEMU
#include "hw/qemu_hw.h"

#include <Arduino.h>
#include <esp_heap_caps.h>
#include <esp_private/system_internal.h>
#include <esp_rom_sys.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include "Logging.h"
#include "core/input_spec.h"
#include "core/panel_guard.h"
#include "hw/hw_diag.h"
#include "hw/watchdog.h"
#include "net/power.h"

// QEMU's panic handler loops instead of resetting (main.cpp, X4_TEST_CRASH_ON_BOOT), so a task-watchdog panic would
// leave QEMU hung. The TWDT ISR calls this hook after printing the starved tasks and right before that panic: record
// the reason the panic would have recorded and reset like esp_restart(). Hardware takes the real path (panic → core
// dump → reset, hw/watchdog.h). QEMU's MWDT does not count either, so today only the X4_TEST_WDT_HANG stand-in
// (main.cpp, sim/qemu/wdt-test.sh) calls this.
extern "C" void IRAM_ATTR esp_task_wdt_isr_user_handler(void) {
  esp_rom_printf("[qemu] task watchdog fired · software reset (TASK_WDT)\n");
  esp_reset_reason_set_hint(ESP_RST_TASK_WDT);
  esp_rom_software_reset_system();
}

namespace x4 {

namespace {
QueueHandle_t g_queue = nullptr;
std::atomic<TaskHandle_t> g_consumer{nullptr};
QemuDisplay* g_display = nullptr;
constexpr int64_t kSaneEpoch = 1700000000;
}  // namespace

bool QemuDisplay::begin() {
  last_ = static_cast<uint8_t*>(heap_caps_malloc(Framebuffer::kBytes, MALLOC_CAP_SPIRAM));
  if (!last_) last_ = static_cast<uint8_t*>(malloc(Framebuffer::kBytes));
  if (last_) memset(last_, 0xFF, Framebuffer::kBytes);
  g_display = this;
  LOG_INF("DISP", "X4_QEMU null display (framebuffer at GET /__qemu/framebuffer.pgm)");
  return last_ != nullptr;
}

// Same gate as hw/x4_display.cpp's EpdBus wraps: bounded, watchdog-fed, logged once, then no panel I/O. The frame is
// still kept (preview.png), only the refresh counters stop.
bool QemuDisplay::panelIo() {
  const bool ok = panelGuard().wait([this] { return stuck_.load(); }, [] { return static_cast<uint32_t>(millis()); },
                                    [] {
                                      delay(10);
                                      wdt::feedIfSubscribed();
                                    },
                                    "qemu stuck BUSY");
  if (panelGuard().takeFailureLog())
    LOG_ERR("EPD", "!!! panel BUSY never released · %s · panel marked failed, no more panel I/O until restart",
            panelGuard().failureText().c_str());
  return ok;
}

void QemuDisplay::setStuck(bool stuck) {
  stuck_ = stuck;
  if (!stuck) panelGuard().reset();
  LOG_WRN("QEMU", "panel BUSY %s", stuck ? "stuck (next refresh times out)" : "released · panel failure cleared");
}

void QemuDisplay::fullRefresh(const Framebuffer& fb) {
  if (last_ && fb.data != last_) memcpy(last_, fb.data, Framebuffer::kBytes);
  if (!panelIo()) return;
  ++fulls_;
  LOG_DBG("DISP", "full refresh #%u", unsigned(fulls_));
}

void QemuDisplay::fastRefresh(const Framebuffer& fb) {
  if (last_ && fb.data != last_) memcpy(last_, fb.data, Framebuffer::kBytes);
  if (!panelIo()) return;
  ++fasts_;
  LOG_DBG("DISP", "fast refresh #%u", unsigned(fasts_));
}

void QemuDisplay::partialRefresh(const Framebuffer& fb, Rect r) {
  if (last_ && fb.data != last_) memcpy(last_, fb.data, Framebuffer::kBytes);
  if (!panelIo()) return;
  ++partials_;
  LOG_DBG("DISP", "partial refresh #%u %dx%d+%d+%d", unsigned(partials_), r.w, r.h, r.x, r.y);
}

QemuDisplay& qemuDisplayStats() { return *g_display; }

void QemuBoard::begin() {
  g_queue = xQueueCreate(32, sizeof(InputEvent));
  const char* tz = getenv("TZ");
  if (!tz || !*tz) {
    setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3", 1);
    tzset();
  }
  LOG_INF("BOARD", "X4_QEMU board: no I2C (touch/gauge/RTC), no front light; input via POST /__qemu/input");
}

void QemuBoard::notifyOnInput(void* task) { g_consumer = static_cast<TaskHandle_t>(task); }

bool QemuBoard::pollInput(InputEvent& out) { return g_queue && xQueueReceive(g_queue, &out, 0) == pdTRUE; }

// No I2C in QEMU: a fixed gauge, 80 % at 3950 mV (below the 4.15 V "recently charged" line). USB unless POST /__qemu/power.
PowerInfo QemuBoard::power() { return PowerInfo{80, false, !net::powerSimBattery(), true, 3950}; }

uint32_t QemuBoard::millis() { return ::millis(); }

int64_t QemuBoard::epochSeconds() {
  time_t now = time(nullptr);
  return now > kSaneEpoch ? static_cast<int64_t>(now) : 0;
}

void QemuBoard::restart() { esp_restart(); }

bool QemuBoard::pushInput(const InputEvent& e) { return qemuPushEvent(e); }

bool qemuPushEvent(const InputEvent& e) {
  if (!g_queue || xQueueSend(g_queue, &e, 0) != pdTRUE) return false;
  if (TaskHandle_t c = g_consumer.load()) xTaskNotifyGive(c);
  return true;
}

bool qemuPushInput(const std::string& spec) {
  InputEvent e;
  return parseInputSpec(spec, e) && qemuPushEvent(e);
}

std::string qemuFramebufferPgm(const uint8_t* fb) {
  static const char kHead[] = "P5\n800 480\n255\n";
  std::string out;
  out.reserve(sizeof(kHead) - 1 + kScreenW * kScreenH);
  out.append(kHead);
  for (size_t i = 0; i < Framebuffer::kBytes; ++i) {
    const uint8_t b = fb ? fb[i] : 0xFF;
    for (int s = 6; s >= 0; s -= 2) out.push_back(static_cast<char>(((b >> s) & 3) * 85));
  }
  return out;
}

// No panel and no touch under QEMU: GET /api/v1/diagnostics reports controller "none", touch_recoveries null.
void panelDiag(diag::Panel& out) {
  out = diag::Panel();
  out.failure = panelGuard().failureText();
}
int64_t touchRecoveries() { return -1; }

}  // namespace x4
#endif
