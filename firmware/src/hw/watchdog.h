// Task watchdog (TWDT) for every image, confirmed or not. The prebuilt sdkconfig starts it at 5 s, panic on, IDLE0
// only; begin() widens it to 30 s and keeps panic + IDLE0. Subscribed: loopTask (main.cpp), x4input (hw/x4_board.cpp),
// x4net (net/device_services.cpp) and async_tcp (AsyncTCP subscribes itself, CONFIG_ASYNC_TCP_USE_WDT=1, and feeds
// between events). A subscribed task silent for 30 s → panic → reset with reason TASK_WDT.
//
// Unconfirmed OTA images keep their own guard (net/ota.h: esp_timer restart + RTC WDT). Both end in a reset, and any
// reset of a PENDING_VERIFY image makes the bootloader roll back, so whichever fires first gives the same result.
#pragma once
#include <esp_task_wdt.h>

#include <cstdint>

namespace x4::wdt {

constexpr uint32_t kTimeoutMs = 30000;
// Backstop for BlockingCall: one HTTP(S) request can follow a redirect, and each hop has its own DNS, connect,
// TLS handshake and header timeouts (worst case ~70 s for the GitHub release download).
constexpr uint32_t kBlockingCallMaxMs = 120000;

bool begin();   // setup(), before any task subscribes

inline void subscribe() {
  if (esp_task_wdt_status(nullptr) == ESP_ERR_NOT_FOUND) esp_task_wdt_add(nullptr);
}

// Safe from any task: tasks that are not subscribed (or a build without the TWDT) are left alone.
inline void feedIfSubscribed() {
  if (esp_task_wdt_status(nullptr) == ESP_OK) esp_task_wdt_reset();
}

// Scope around one library call that blocks on the network with its own timeouts (HTTPClient GET/POST, TLS connect)
// and so cannot feed. The calling task leaves the TWDT for the call; an esp_timer aborts (reset reason PANIC) if the
// call outlives kBlockingCallMaxMs. Meant for x4net; overlapping scopes share one backstop deadline.
class BlockingCall {
 public:
  explicit BlockingCall(const char* what);
  ~BlockingCall();
  BlockingCall(const BlockingCall&) = delete;
  BlockingCall& operator=(const BlockingCall&) = delete;

 private:
  bool subscribed_;
};

}  // namespace x4::wdt
