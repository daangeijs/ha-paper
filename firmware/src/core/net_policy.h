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
// or lease that went bad without a disconnect event, a driver stuck after a link flap (eink-ha-os#108: 1.5 h of "Host is
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

// ---------- inbound watch (eink-ha-os#227) ----------
// Overnight soak: the .local name stopped resolving for an hour while the device kept pushing to HA. With the link up
// and no web request served for kIdleMs, the net task pings the gateway: unreachable → Wi-Fi reconnect; reachable →
// mDNS restart only. Idle alone never reconnects (no browser open is normal). Each check starts the window over.
class InboundWatch {
 public:
  static constexpr uint32_t kIdleMs = 30UL * 60UL * 1000UL;
  enum class Action : uint8_t { MdnsRestart, Reconnect };
  void linkUp(uint32_t now) {
    if (!up_) since_ = now;
    up_ = true;
  }
  void linkDown() { up_ = false; }
  void served(uint32_t now) { since_ = now; }   // a request completed
  bool due(uint32_t now) const { return up_ && now - since_ >= kIdleMs; }
  Action checked(uint32_t now, bool gatewayOk) {
    since_ = now;
    return gatewayOk ? Action::MdnsRestart : Action::Reconnect;
  }

 private:
  bool up_ = false;
  uint32_t since_ = 0;
};

// ---------- mDNS responder (eink-ha-os#326) ----------
// beta.4/beta.5 PANIC in the mdns task (esp_pbuf_free calls NULL, exc_vaddr 0): a received packet waits in the
// mdns action queue as a Wi-Fi rx pbuf that points at the STA esp_netif. WiFi.mode(WIFI_OFF) (deep-sleep entry,
// radio reset, forget) runs esp_netif_destroy_default_wifi, and the mdns task then frees that pbuf through the freed
// netif's driver_free_rx_buffer. So WifiMgr::stopMdns() (mdns_free: task stopped, pcbs closed, queue drained while the
// netif lives) runs before every Wi-Fi off; the next join inits again. A re-bind (lease, roam, idle, reconnect) is
// disable + enable of the STA pcb, which re-probes and re-announces; one within kSettleMs of the last is dropped.
// eink-ha-os#376: the espressif mdns component (1.11.3) can lose the name without telling anyone. mdns_netif_action() returns
// ESP_OK when its 16-slot action queue is full and drops the action, so a re-bind's DISABLE can land and its ENABLE
// not: IPv4 stays off for good (the device answers HTTP by IP, the .local name is silent). And a lost probe
// tie-break renames the host (mangle_name: ha-paper-9574 → ha-paper-9575), which nobody looks up. check() runs on the
// minute NET tick with the link up: IPv4 pcb off → Enable (one ENABLE|ANNOUNCE action, idempotent); the responder's
// hostname not ours → Reclaim (hostname set again: re-probe), at most once per kReclaimMs so a real twin cannot
// make us probe-storm. Both wait kSettleMs after the last action (a re-bind's pair may still be queued).
enum class MdnsStep : uint8_t { Init, Rebind, Skip };
enum class MdnsFix : uint8_t { None, Enable, Reclaim };
struct MdnsPlan {
  static constexpr uint32_t kSettleMs = 30000;
  static constexpr uint32_t kReclaimMs = 10 * 60000;
  MdnsStep next(bool inited, uint32_t now) const {
    if (!inited) return MdnsStep::Init;
    return now - lastMs < kSettleMs ? MdnsStep::Skip : MdnsStep::Rebind;
  }
  MdnsFix check(bool v4Ready, bool nameOurs, uint32_t now) const {
    if (now - lastMs < kSettleMs) return MdnsFix::None;
    if (!v4Ready) return MdnsFix::Enable;   // first: a reclaim only re-probes pcbs that are up
    if (!nameOurs && (!reclaimed || now - reclaimMs >= kReclaimMs)) return MdnsFix::Reclaim;
    return MdnsFix::None;
  }
  void did(MdnsFix f, uint32_t now) {
    if (f == MdnsFix::None) return;
    lastMs = now;
    if (f == MdnsFix::Reclaim) reclaimed = true, reclaimMs = now;
  }
  uint32_t lastMs = 0;   // last Init, Rebind or fix
  uint32_t reclaimMs = 0;
  bool reclaimed = false;
};

// Short, non-reversible AP tag for logs and /diagnostics: 4 hex digits of FNV-1a over the 6 BSSID bytes. Tells a
// roam between APs apart without publishing a MAC.
std::string bssidTag(const uint8_t* bssid);

// ---------- heap guard ----------
// mbedTLS allocates from internal RAM (CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC). Measured under QEMU (eink-ha-os#79): a handshake
// peaks at ~45 KB in total; its largest single piece is a 16,717 B record buffer (one in, one out:
// MBEDTLS_SSL_MAX_CONTENT_LEN 16384). Below either limit a TLS attempt fails (backoff) instead of starving Wi-Fi/lwIP.
// The old single 40 KB largest-block rule could never pass: the internal heap's largest region is 40,948 B.
constexpr uint32_t kTlsMinLargestBlock = 20 * 1024;   // one record buffer + margin
constexpr uint32_t kTlsMinFreeInternal = 64 * 1024;   // handshake peak + room for Wi-Fi, lwIP, the web server
inline bool heapOkForTls(uint32_t largestFreeBlock, uint32_t freeInternal) {
  return largestFreeBlock >= kTlsMinLargestBlock && freeInternal >= kTlsMinFreeInternal;
}
// With two free slots in net/tls_pool.cpp's reserve a session's record buffers come from there and the heap only holds
// the handshake's small pieces: largest 944 B, ~18 KB for handshake + WebSocket start (QEMU, eink-ha-os#149). The 20 KB block
// rule refused the WebSocket's reconnect for as long as the heap stayed fragmented (largest block 7.6 KB).
constexpr uint32_t kTlsMinLargestPooled = 4 * 1024;
constexpr uint32_t kTlsMinFreePooled = 40 * 1024;
inline bool heapOkForTls(uint32_t largestFreeBlock, uint32_t freeInternal, unsigned poolSlotsFree) {
  if (poolSlotsFree < 2) return heapOkForTls(largestFreeBlock, freeInternal);
  return largestFreeBlock >= kTlsMinLargestPooled && freeInternal >= kTlsMinFreePooled;
}

// Per peer and with a DMA floor (eink-ha-os#248, real X4 Pro): an HA handshake costs ~10 KB of internal RAM, api.github.com
// ~47 KB (52.5 KB free before, 5,304 B at the low point, min_dma 716 B; the Wi-Fi RX buffers need DMA RAM). GitHub
// adds 16 KB to the internal floor. MALLOC_CAP_INTERNAL also counts ~8 KB of non-DMA RAM (seen: DMA 4.6–7.7 KB under
// internal), so the DMA floor is the internal one minus 12 KB; the largest DMA block must hold what the internal rule
// asks for.
enum class TlsPeer : uint8_t { Ha, GitHub };   // Ha: any host but GitHub's
TlsPeer tlsPeerFor(const std::string& host);    // github.com, *.github.com, *.githubusercontent.com → GitHub
constexpr uint32_t kTlsGitHubExtra = 16 * 1024;
constexpr uint32_t kTlsDmaSlack = 12 * 1024;
struct TlsHeap {
  uint32_t freeInternal, largestInternal, freeDma, largestDma;
  unsigned poolSlotsFree;
};
struct TlsFloor {
  uint32_t freeInternal, largestInternal, freeDma, largestDma;
};
TlsFloor tlsFloor(TlsPeer peer, unsigned poolSlotsFree);
bool heapOkForTls(const TlsHeap& h, TlsPeer peer);

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

// Internal or DMA RAM under the floor for kLowForMs → drop the HA WebSocket (eink-ha-os#248). The TLS guard only stops new
// sessions; at RSSI -88 the Wi-Fi buffers drained the heap with the WebSocket up (min 340 B, 1.6 KB RX allocs failing,
// then a watchdog reset). True once per low spell; re-arms when both are back above floor + kRecover.
class HeapStarve {
 public:
  static constexpr uint32_t kFloorInternal = 24 * 1024;
  static constexpr uint32_t kFloorDma = 16 * 1024;
  static constexpr uint32_t kRecover = 8 * 1024;
  static constexpr uint32_t kLowForMs = 10000;
  static bool under(uint32_t freeInternal, uint32_t freeDma) {
    return freeInternal < kFloorInternal || freeDma < kFloorDma;
  }
  // Deeper: the web server refuses new connections (503) below this, at once.
  static constexpr uint32_t kRefuseInternal = 12 * 1024;
  static constexpr uint32_t kRefuseDma = 8 * 1024;
  static bool critical(uint32_t freeInternal, uint32_t freeDma) {
    return freeInternal < kRefuseInternal || freeDma < kRefuseDma;
  }
  bool sample(uint32_t now, uint32_t freeInternal, uint32_t freeDma);

 private:
  ElapsedSum low_;
  bool sent_ = false;
};

// ---------- CSRF ----------
// A cookie-authenticated write must come from the console's own pages: Origin == "http://" + host (Host header,
// port included), or, when the browser sent no Origin, a Referer on that origin. Origin wins when both are present.
bool sameOriginWrite(const std::string& origin, const std::string& referer, const std::string& host);

}  // namespace x4
