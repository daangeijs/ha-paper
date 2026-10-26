#include "hw/watchdog.h"

#include <esp_system.h>
#include <esp_timer.h>

#include <atomic>
#include <cstdio>

#include "Logging.h"

namespace x4::wdt {

namespace {
esp_timer_handle_t g_backstop = nullptr;
std::atomic<int> g_depth{0};
std::atomic<const char*> g_what{""};

void onStuck(void*) {
  static char msg[96];
  snprintf(msg, sizeof msg, "x4: blocking call '%s' stuck for %u s", g_what.load(), unsigned(kBlockingCallMaxMs / 1000));
  esp_system_abort(msg);
}
}  // namespace

bool begin() {
  const esp_task_wdt_config_t c = {.timeout_ms = kTimeoutMs, .idle_core_mask = 1u << 0, .trigger_panic = true};
  esp_err_t e = esp_task_wdt_reconfigure(&c);
  if (e == ESP_ERR_INVALID_STATE) e = esp_task_wdt_init(&c);   // sdkconfig without CONFIG_ESP_TASK_WDT_INIT
  const esp_timer_create_args_t args = {
      .callback = onStuck,
      .arg = nullptr,
      .dispatch_method = ESP_TIMER_TASK,
      .name = "x4blocking",
      .skip_unhandled_events = true,
  };
  if (!g_backstop) esp_timer_create(&args, &g_backstop);
  if (e != ESP_OK) LOG_ERR("WDT", "task watchdog reconfigure failed (%d)", int(e));
  return e == ESP_OK;
}

BlockingCall::BlockingCall(const char* what) : subscribed_(esp_task_wdt_status(nullptr) == ESP_OK) {
  if (subscribed_) esp_task_wdt_delete(nullptr);
  if (g_depth.fetch_add(1) == 0 && g_backstop) {
    g_what = what;
    esp_timer_start_once(g_backstop, uint64_t(kBlockingCallMaxMs) * 1000);
  }
}

BlockingCall::~BlockingCall() {
  if (g_depth.fetch_sub(1) == 1 && g_backstop) esp_timer_stop(g_backstop);
  if (subscribed_) esp_task_wdt_add(nullptr);   // re-adding starts a fresh 30 s period
}

}  // namespace x4::wdt
