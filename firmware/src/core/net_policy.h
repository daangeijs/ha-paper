// Pure network-health decisions for the net task (docs/ROBUSTNESS_PLAN.md phase 2): HA reconnect backoff with
// jitter, Wi-Fi escalation (reconnect → radio reset → maintenance restart), heap guard for TLS. No Arduino: the
// clock (millis(), wraps after 49.7 days) and the random value are passed in, so the host tests drive them.
#pragma once
#include <cstdint>
#include <string>

namespace x4 {

// ---------- HA reconnect backoff ----------
// base ± 20 %. rnd = any 32-bit random value (esp_random()): 0 → -20 %, 0xFFFFFFFF → just under +20 %.
uint32_t jitterMs(uint32_t baseMs, uint32_t rnd);
uint32_t nextBackoffMs(uint32_t curMs, uint32_t maxMs);   // doubles, capped at maxMs

// Offline/low time measured by summing the gaps between polls: wrap-safe, and a stalled caller (gap > 1 min) only
// counts as 1 min, so a long blocking call never jumps the escalation ladder.
class ElapsedSum {
 public:
  void reset() { running_ = false; total_ = 0; }
  uint32_t add(uint32_t now);   // first call starts at 0
  uint32_t total() const { return total_; }
  bool running() const { return running_; }

 private:
  bool running_ = false;
  uint32_t last_ = 0, total_ = 0;
};

// ---------- Wi-Fi escalation ----------
// While the saved network is unreachable: WiFi.reconnect() every 15 s; every 10 min offline the radio is reset
// (WiFi.mode(OFF) → STA → begin); after 60 min a maintenance restart. Each consecutive Wi-Fi restart without a
// connection in between doubles the restart threshold (60 min, 2 h, 4 h, 8 h cap): a dead router must not reboot the
// display every hour. The count survives the restart in RTC memory (net/wifi_mgr.cpp).
class WifiEscalation {
 public:
  static constexpr uint32_t kRetryMs = 15000;
  static constexpr uint32_t kResetMs = 10UL * 60UL * 1000UL;
  static constexpr uint32_t kRestartMs = 60UL * 60UL * 1000UL;
  static constexpr uint32_t kRestartMaxMs = 8UL * 60UL * 60UL * 1000UL;
  enum class Action : uint8_t { None, Reconnect, Reset, Restart };

  explicit WifiEscalation(uint32_t restartsBefore = 0) : restarts_(restartsBefore) {}
  void setRestartsBefore(uint32_t n) { restarts_ = n; }
  void reset();   // link up, or reconnect not wanted (user disconnected / nothing saved)
  // Every loop pass while the link is down and wanted. mayReset: no SoftAP or scan to break. mayRestart: no OTA running
  // and the image is confirmed. At most one action per call; Restart is returned once per offline episode.
  Action poll(uint32_t now, bool mayReset, bool mayRestart);
  uint32_t offlineMs() const { return offline_.total(); }
  uint32_t restartAfterMs() const;

 private:
  ElapsedSum offline_;
  uint32_t nextRetry_ = 0, nextReset_ = 0;
  uint32_t restarts_;
  bool restartSent_ = false;
};

// ---------- stale link ----------
// The link counts as up (Wi-Fi associated with an IP; QEMU: NIC with a lease) yet every connect to HA fails: a route
// or lease that went bad without a disconnect event, a driver stuck after a link flap (#108: 1.5 h of "Host is
// unreachable" with the link "up"). WifiEscalation never runs then. After kFails failed connects in a row spanning
// kStaleMs, the link is re-made (Wi-Fi reconnect / DHCP restart). HA itself being down looks the same from here, so
// each relink without a success in between doubles the wait (5, 10, 20, 40, 60 min cap).
class StaleLink {
 public:
  static constexpr uint32_t kFails = 4;
  static constexpr uint32_t kStaleMs = 5UL * 60UL * 1000UL;
  static constexpr uint32_t kMaxMs = 60UL * 60UL * 1000UL;
  void reached();              // HA answered: all clear
  void failed(uint32_t now);   // a connect / token refresh that never reached HA
  void linkDown();             // the link went down: WifiEscalation owns it, the count starts over
  bool poll(uint32_t now);     // link up: true once when a relink is due
  uint32_t fails() const { return fails_; }
  uint32_t waitMs() const { return waitMs_; }

 private:
  uint32_t fails_ = 0, firstFail_ = 0, waitMs_ = kStaleMs;
};

// ---------- heap guard ----------
// mbedTLS allocates from internal RAM (CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC). Measured under QEMU (#79): a handshake
// peaks at ~45 KB in total; its largest single piece is a 16,717 B record buffer (one in, one out:
// MBEDTLS_SSL_MAX_CONTENT_LEN 16384). Below either limit a TLS attempt fails (backoff) instead of starving Wi-Fi/lwIP.
// The old single 40 KB largest-block rule could never pass: the internal heap's largest region is 40,948 B.
constexpr uint32_t kTlsMinLargestBlock = 20 * 1024;   // one record buffer + margin
constexpr uint32_t kTlsMinFreeInternal = 64 * 1024;   // handshake peak + room for Wi-Fi, lwIP, the web server
inline bool heapOkForTls(uint32_t largestFreeBlock, uint32_t freeInternal) {
  return largestFreeBlock >= kTlsMinLargestBlock && freeInternal >= kTlsMinFreeInternal;
}
// With two free slots in net/tls_pool.cpp's reserve a session's record buffers come from there and the heap only holds
// the handshake's small pieces: largest 944 B, ~18 KB for handshake + WebSocket start (QEMU, #149). The 20 KB block
// rule refused the WebSocket's reconnect for as long as the heap stayed fragmented (largest block 7.6 KB).
constexpr uint32_t kTlsMinLargestPooled = 4 * 1024;
constexpr uint32_t kTlsMinFreePooled = 40 * 1024;
inline bool heapOkForTls(uint32_t largestFreeBlock, uint32_t freeInternal, unsigned poolSlotsFree) {
  if (poolSlotsFree < 2) return heapOkForTls(largestFreeBlock, freeInternal);
  return largestFreeBlock >= kTlsMinLargestPooled && freeInternal >= kTlsMinFreePooled;
}

// Low on every sample for 30 min → maintenance restart, but only 03:00–03:59 local and when allowed.
class HeapWatch {
 public:
  static constexpr uint32_t kLowForMs = 30UL * 60UL * 1000UL;
  // localHour: 0–23, -1 = clock not set (never restarts). Returns true once when the restart is due.
  bool sample(uint32_t now, uint32_t largestFreeBlock, uint32_t freeInternal, int localHour, bool mayRestart);
  uint32_t lowForMs() const { return low_.total(); }

 private:
  ElapsedSum low_;
  bool sent_ = false;
};

// ---------- CSRF ----------
// A cookie-authenticated write must come from the console's own pages: Origin == "http://" + host (Host header,
// port included), or, when the browser sent no Origin, a Referer on that origin. Origin wins when both are present.
bool sameOriginWrite(const std::string& origin, const std::string& referer, const std::string& host);

}  // namespace x4
