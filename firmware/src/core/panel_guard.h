// Bounded e-paper BUSY waits (eink-ha-os#181). The SDK's waits are unbounded (UC8179/UC8279 idle-high) or 30 s (SSD1677), on
// loopTask, which the 30 s task watchdog watches: a panel that never releases BUSY boot-looped on TASK_WDT. The hw layer
// gates every SDK wait through PanelGuard::wait (hw/x4_display.cpp, QEMU: hw/qemu_hw.cpp): the first wait that runs
// past kPanelBusyMaxMs marks the panel failed, and from then on every wait returns at once and the display skips panel
// I/O until the next boot. The clock and the poll step are injected (uint32_t ms, wraps like millis()).
#pragma once
#include <atomic>
#include <cstdint>
#include <string>

namespace x4 {

// Longest legitimate wait: a full refresh is ~3 s, a gray overlay pass a few more, cold panels slower.
constexpr uint32_t kPanelBusyMaxMs = 20000;

class PanelGuard {
 public:
  // Polls busy() until it reads false, calling idle() between polls (sleep a tick + feed the watchdog). true = BUSY
  // released. false = this wait timed out (panel now failed) or the panel failed earlier (no poll at all).
  template <class Busy, class Now, class Idle>
  bool wait(Busy busy, Now now, Idle idle, const char* what, uint32_t maxMs = kPanelBusyMaxMs) {
    if (failed()) return false;
    const uint32_t start = now();
    while (busy()) {
      const uint32_t waited = now() - start;
      if (waited >= maxMs) {
        fail(waited, what);
        return false;
      }
      idle();
    }
    return true;
  }

  bool failed() const { return failed_.load(); }
  // true exactly once after the panel failed: the caller logs the failure once.
  bool takeFailureLog() { return failed() && !logged_.exchange(true); }
  // "BUSY stuck 20 s (refresh)" for /diagnostics; "" while the panel is fine.
  std::string failureText() const;
  void reset();   // X4_QEMU test hook only (POST /__qemu/panel): a real stuck panel stays failed until the next boot

 private:
  void fail(uint32_t waitedMs, const char* what);
  std::atomic<bool> failed_{false}, logged_{false};
  std::atomic<uint32_t> waitedMs_{0};
  std::atomic<const char*> what_{nullptr};   // string literal (SDK wait tag or our phase name)
};

PanelGuard& panelGuard();   // the one panel's guard: written by loopTask, read by the web server (/status, /diagnostics)

}  // namespace x4
