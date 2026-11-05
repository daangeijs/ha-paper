// core/net_policy: HA backoff jitter, Wi-Fi escalation ladder, heap guard. The clock is injected (uint32_t ms, like
// millis()), including runs across the 2^32 wrap.
#include <unity.h>

#include <cstdint>

#include "core/net_policy.h"

using namespace x4;
using A = WifiEscalation::Action;

void setUp() {}
void tearDown() {}

static void test_jitter_bounds() {
  TEST_ASSERT_EQUAL_UINT32(1600, jitterMs(2000, 0));
  TEST_ASSERT_EQUAL_UINT32(2000, jitterMs(2000, 0x80000000u));
  TEST_ASSERT_EQUAL_UINT32(2399, jitterMs(2000, 0xFFFFFFFFu));
  TEST_ASSERT_EQUAL_UINT32(48000, jitterMs(60000, 0));
  TEST_ASSERT_EQUAL_UINT32(71999, jitterMs(60000, 0xFFFFFFFFu));
  uint32_t r = 12345;
  for (int i = 0; i < 1000; i++) {   // LCG sweep: always within ±20 %
    r = r * 1664525u + 1013904223u;
    const uint32_t j = jitterMs(60000, r);
    TEST_ASSERT_TRUE(j >= 48000 && j < 72000);
  }
}

static void test_backoff_doubles_and_caps() {
  uint32_t b = 2000;
  const uint32_t want[] = {4000, 8000, 16000, 32000, 60000, 60000};
  for (uint32_t w : want) TEST_ASSERT_EQUAL_UINT32(w, b = nextBackoffMs(b, 60000));
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX - 1, nextBackoffMs(UINT32_MAX / 2 + 1, UINT32_MAX - 1));   // no overflow
}

// Poll every `step` ms from `start` until `untilMs` of offline time; returns the elapsed time of each action.
struct Seen { uint32_t reconnects = 0, resets = 0, restarts = 0, firstReset = 0, firstRestart = 0; };
static Seen run(WifiEscalation& e, uint32_t start, uint32_t untilMs, uint32_t step, bool mayReset, bool mayRestart) {
  Seen s;
  for (uint32_t t = 0; t <= untilMs; t += step) {
    switch (e.poll(start + t, mayReset, mayRestart)) {
      case A::Reconnect: s.reconnects++; break;
      case A::Reset: if (!s.resets++) s.firstReset = t; break;
      case A::Restart: if (!s.restarts++) s.firstRestart = t; break;
      default: break;
    }
  }
  return s;
}

static void test_wifi_ladder() {
  WifiEscalation e;
  Seen s = run(e, 1000, 59 * 60000, 100, true, true);
  TEST_ASSERT_EQUAL_UINT32(5, s.resets);               // 10, 20, 30, 40, 50 min
  TEST_ASSERT_EQUAL_UINT32(10 * 60000, s.firstReset);
  TEST_ASSERT_EQUAL_UINT32(0, s.restarts);
  TEST_ASSERT_TRUE(s.reconnects > 200 && s.reconnects < 240);   // every 15 s minus the reset slots
  // carry on to 61 min in the same episode → one restart, then never again
  Seen s2;
  for (uint32_t t = 59 * 60000; t <= 70 * 60000; t += 100)
    if (e.poll(1000 + t, true, true) == A::Restart) s2.restarts++;
  TEST_ASSERT_EQUAL_UINT32(1, s2.restarts);
}

static void test_wifi_restart_waits_for_permission() {
  WifiEscalation e;
  Seen s = run(e, 0, 90 * 60000, 1000, true, false);   // OTA running / image pending
  TEST_ASSERT_EQUAL_UINT32(0, s.restarts);
  TEST_ASSERT_EQUAL(A::Restart, e.poll(90 * 60000 + 1000, true, true));
}

static void test_wifi_no_reset_with_softap() {
  WifiEscalation e;
  Seen s = run(e, 0, 30 * 60000, 1000, false, false);
  TEST_ASSERT_EQUAL_UINT32(0, s.resets);
  TEST_ASSERT_TRUE(s.reconnects >= 119);
}

static void test_wifi_reset_on_link() {
  WifiEscalation e;
  run(e, 0, 9 * 60000, 1000, true, true);
  e.reset();   // connected
  TEST_ASSERT_EQUAL_UINT32(0, e.offlineMs());
  Seen s = run(e, 20 * 60000, 9 * 60000, 1000, true, true);   // the next episode starts at 0 again
  TEST_ASSERT_EQUAL_UINT32(0, s.resets);
  TEST_ASSERT_EQUAL_UINT32(9 * 60000, e.offlineMs());
}

static void test_wifi_across_millis_wrap() {
  WifiEscalation e;
  Seen s = run(e, 0xFFFFFFFFu - 5 * 60000, 61 * 60000, 500, true, true);
  TEST_ASSERT_EQUAL_UINT32(10 * 60000, s.firstReset);
  TEST_ASSERT_EQUAL_UINT32(60 * 60000, s.firstRestart);
}

static void test_wifi_restart_threshold_doubles() {
  TEST_ASSERT_EQUAL_UINT32(60 * 60000, WifiEscalation(0).restartAfterMs());
  TEST_ASSERT_EQUAL_UINT32(120 * 60000, WifiEscalation(1).restartAfterMs());
  TEST_ASSERT_EQUAL_UINT32(240 * 60000, WifiEscalation(2).restartAfterMs());
  TEST_ASSERT_EQUAL_UINT32(480 * 60000, WifiEscalation(3).restartAfterMs());
  TEST_ASSERT_EQUAL_UINT32(480 * 60000, WifiEscalation(50).restartAfterMs());
  WifiEscalation e(1);
  Seen s = run(e, 0, 125 * 60000, 1000, true, true);
  TEST_ASSERT_EQUAL_UINT32(120 * 60000, s.firstRestart);
}

static void test_wifi_stalled_caller_counts_one_minute() {
  WifiEscalation e;
  e.poll(0, true, true);
  e.poll(30 * 60000, true, true);   // a 30 min gap counts as 1 min
  TEST_ASSERT_EQUAL_UINT32(60000, e.offlineMs());
}

static void test_heap_threshold() {
  const uint32_t free = 64 * 1024;
  TEST_ASSERT_FALSE(heapOkForTls(20 * 1024 - 1, free));
  TEST_ASSERT_TRUE(heapOkForTls(20 * 1024, free));
  TEST_ASSERT_FALSE(heapOkForTls(40 * 1024, free - 1));
  TEST_ASSERT_TRUE(heapOkForTls(40948, 120000));   // the device's largest internal region (eink-ha-os#79): must pass
}

// eink-ha-os#149: record buffers from the TLS reserve (2 slots free) → a fragmented heap may still take a handshake
static void test_heap_threshold_pooled() {
  TEST_ASSERT_TRUE(heapOkForTls(7668, 40 * 1024, 2));    // the device's state after the price-source episode
  TEST_ASSERT_TRUE(heapOkForTls(4096, 40 * 1024, 3));
  TEST_ASSERT_FALSE(heapOkForTls(4095, 100 * 1024, 3));
  TEST_ASSERT_FALSE(heapOkForTls(40948, 40 * 1024 - 1, 2));
  TEST_ASSERT_FALSE(heapOkForTls(7668, 40 * 1024, 1));   // the WebSocket holds two slots: the old rule
  TEST_ASSERT_TRUE(heapOkForTls(20 * 1024, 64 * 1024, 1));
  TEST_ASSERT_FALSE(heapOkForTls(20 * 1024, 64 * 1024 - 1, 0));
}

// eink-ha-os#248: per-peer floor, DMA RAM counted too (numbers from the real X4 Pro)
static void test_tls_peer_for_host() {
  TEST_ASSERT_TRUE(tlsPeerFor("api.github.com") == TlsPeer::GitHub);
  TEST_ASSERT_TRUE(tlsPeerFor("github.com") == TlsPeer::GitHub);
  TEST_ASSERT_TRUE(tlsPeerFor("objects.githubusercontent.com") == TlsPeer::GitHub);
  TEST_ASSERT_TRUE(tlsPeerFor("homeassistant.local") == TlsPeer::Ha);
  TEST_ASSERT_TRUE(tlsPeerFor("abc.ui.nabu.casa") == TlsPeer::Ha);
  TEST_ASSERT_TRUE(tlsPeerFor("notgithub.com") == TlsPeer::Ha);
  TEST_ASSERT_TRUE(tlsPeerFor("github.com.evil.example") == TlsPeer::Ha);
  TEST_ASSERT_TRUE(tlsPeerFor("") == TlsPeer::Ha);
}

static void test_tls_floor_per_peer() {
  TlsFloor ha = tlsFloor(TlsPeer::Ha, 2), gh = tlsFloor(TlsPeer::GitHub, 2);
  TEST_ASSERT_EQUAL_UINT32(40 * 1024, ha.freeInternal);   // unchanged (eink-ha-os#149)
  TEST_ASSERT_EQUAL_UINT32(28 * 1024, ha.freeDma);
  TEST_ASSERT_EQUAL_UINT32(4 * 1024, ha.largestDma);
  TEST_ASSERT_EQUAL_UINT32(56 * 1024, gh.freeInternal);   // ~47 KB handshake + margin
  TEST_ASSERT_EQUAL_UINT32(44 * 1024, gh.freeDma);
  TlsFloor haU = tlsFloor(TlsPeer::Ha, 1), ghU = tlsFloor(TlsPeer::GitHub, 0);
  TEST_ASSERT_EQUAL_UINT32(64 * 1024, haU.freeInternal);
  TEST_ASSERT_EQUAL_UINT32(20 * 1024, haU.largestDma);
  TEST_ASSERT_EQUAL_UINT32(80 * 1024, ghU.freeInternal);
}

static void test_tls_heap_dma_and_peer() {
  const TlsHeap ok{60 * 1024, 30 * 1024, 52 * 1024, 30 * 1024, 2};
  TEST_ASSERT_TRUE(heapOkForTls(ok, TlsPeer::Ha));
  TEST_ASSERT_TRUE(heapOkForTls(ok, TlsPeer::GitHub));
  TlsHeap h = ok;
  h.freeDma = 44 * 1024 - 1;   // GitHub's DMA floor
  TEST_ASSERT_TRUE(heapOkForTls(h, TlsPeer::Ha));
  TEST_ASSERT_FALSE(heapOkForTls(h, TlsPeer::GitHub));
  h = ok;
  h.freeDma = 28 * 1024 - 1;
  TEST_ASSERT_FALSE(heapOkForTls(h, TlsPeer::Ha));
  h = ok;
  h.largestDma = 4 * 1024 - 1;
  TEST_ASSERT_FALSE(heapOkForTls(h, TlsPeer::Ha));
  // the device before its api.github.com handshake (low point 5,304 B after): HA yes, GitHub no
  const TlsHeap before{53760, 20 * 1024, 46 * 1024, 20 * 1024, 2};
  TEST_ASSERT_TRUE(heapOkForTls(before, TlsPeer::Ha));
  TEST_ASSERT_FALSE(heapOkForTls(before, TlsPeer::GitHub));
  // the refused manual check: internal free 39,644 B
  const TlsHeap refused{39644, 20 * 1024, 32 * 1024, 20 * 1024, 2};
  TEST_ASSERT_FALSE(heapOkForTls(refused, TlsPeer::Ha));
  // the WebSocket holds two slots: the unpooled 64 KB rule, plus 16 KB for GitHub
  const TlsHeap unpooled{70 * 1024, 30 * 1024, 58 * 1024, 30 * 1024, 1};
  TEST_ASSERT_TRUE(heapOkForTls(unpooled, TlsPeer::Ha));
  TEST_ASSERT_FALSE(heapOkForTls(unpooled, TlsPeer::GitHub));
}

static constexpr uint32_t kFree = 100 * 1024;

static void test_heap_watch_night_window() {
  HeapWatch w;
  const uint32_t low = 16 * 1024;
  int fired = 0;
  // low from 02:00; restart only once 30 min low and inside 03:xx
  for (uint32_t t = 0; t <= 120 * 60000; t += 10000) {
    const int hour = 2 + int(t / 3600000);
    if (w.sample(t, low, kFree, hour, true)) {
      fired++;
      TEST_ASSERT_EQUAL_UINT32(60 * 60000, t);   // 03:00 sharp (low for 60 min by then)
    }
  }
  TEST_ASSERT_EQUAL(1, fired);
}

static void test_heap_watch_needs_continuous_low() {
  HeapWatch w;
  for (uint32_t t = 0; t <= 25 * 60000; t += 10000) TEST_ASSERT_FALSE(w.sample(t, 16000, kFree, 3, true));
  TEST_ASSERT_FALSE(w.sample(25 * 60000 + 10000, 80000, kFree, 3, true));   // recovered → reset
  for (uint32_t t = 26 * 60000; t < 56 * 60000; t += 10000) TEST_ASSERT_FALSE(w.sample(t, 16000, kFree, 3, true));
  TEST_ASSERT_TRUE(w.sample(56 * 60000, 16000, kFree, 3, true));
}

static void test_heap_watch_blocked_outside_window_or_ota() {
  HeapWatch w;
  for (uint32_t t = 0; t <= 60 * 60000; t += 10000) TEST_ASSERT_FALSE(w.sample(t, 16000, kFree, 14, true));
  for (uint32_t t = 60 * 60000; t <= 90 * 60000; t += 10000) TEST_ASSERT_FALSE(w.sample(t, 16000, kFree, -1, true));
  TEST_ASSERT_FALSE(w.sample(90 * 60000 + 10000, 16000, kFree, 3, false));   // OTA running
  TEST_ASSERT_TRUE(w.sample(90 * 60000 + 20000, 16000, kFree, 3, true));
}

static void test_heap_starve_sheds_once_after_10s() {
  HeapStarve s;
  const uint32_t okI = 90 * 1024, okD = 70 * 1024;
  TEST_ASSERT_FALSE(s.sample(0, okI, okD));
  TEST_ASSERT_FALSE(s.sample(2000, 22 * 1024, okD));    // device log eink-ha-os#248: 22 KB internal
  TEST_ASSERT_FALSE(s.sample(10000, 22 * 1024, okD));   // low 8 s
  TEST_ASSERT_TRUE(s.sample(12000, 22 * 1024, okD));    // low 10 s → shed
  TEST_ASSERT_FALSE(s.sample(30000, 22 * 1024, okD));   // once per spell
  TEST_ASSERT_FALSE(s.sample(32000, 26 * 1024, okD));   // above floor, not yet + 8 KB: still armed off
  for (uint32_t t = 34000; t <= 50000; t += 2000) TEST_ASSERT_FALSE(s.sample(t, 22 * 1024, okD));
  TEST_ASSERT_FALSE(s.sample(52000, okI, okD));         // recovered → re-armed
  TEST_ASSERT_FALSE(s.sample(54000, okI, 14 * 1024));   // DMA alone: 14.8 KB in the device log
  TEST_ASSERT_TRUE(s.sample(64000, okI, 14 * 1024));
}

static void test_heap_starve_web_refuse_floor() {
  TEST_ASSERT_FALSE(HeapStarve::critical(24 * 1024, 16 * 1024));   // QEMU heap-hog level: still served
  TEST_ASSERT_TRUE(HeapStarve::critical(11 * 1024, 40 * 1024));
  TEST_ASSERT_TRUE(HeapStarve::critical(40 * 1024, 7 * 1024));
  TEST_ASSERT_TRUE(HeapStarve::under(22 * 1024, 40 * 1024));
}

static void test_heap_starve_brief_dip_ignored() {
  HeapStarve s;
  for (uint32_t t = 0; t < 60000; t += 4000)   // dips every other sample: never 10 s in a row
    TEST_ASSERT_FALSE(s.sample(t, (t / 4000) % 2 ? 10 * 1024 : 60 * 1024, 50 * 1024));
}

static void test_same_origin_write() {
  const std::string h = "ha-paper-a1b2.local";
  TEST_ASSERT_TRUE(sameOriginWrite("http://ha-paper-a1b2.local", "", h));
  TEST_ASSERT_TRUE(sameOriginWrite("", "http://ha-paper-a1b2.local/screens", h));
  TEST_ASSERT_TRUE(sameOriginWrite("", "http://ha-paper-a1b2.local", h));
  TEST_ASSERT_TRUE(sameOriginWrite("http://127.0.0.1:8080", "", "127.0.0.1:8080"));
  TEST_ASSERT_FALSE(sameOriginWrite("", "", h));                                         // neither header
  TEST_ASSERT_FALSE(sameOriginWrite("http://evil.example", "", h));
  TEST_ASSERT_FALSE(sameOriginWrite("null", "", h));
  TEST_ASSERT_FALSE(sameOriginWrite("http://evil.example", "http://ha-paper-a1b2.local/", h));   // Origin wins
  TEST_ASSERT_FALSE(sameOriginWrite("", "http://ha-paper-a1b2.local.evil.example/", h));        // prefix trick
  TEST_ASSERT_FALSE(sameOriginWrite("", "http://evil.example/http://ha-paper-a1b2.local/", h));
  TEST_ASSERT_FALSE(sameOriginWrite("https://ha-paper-a1b2.local", "", h));
  TEST_ASSERT_FALSE(sameOriginWrite("http://127.0.0.1:8081", "", "127.0.0.1:8080"));
  TEST_ASSERT_FALSE(sameOriginWrite("http://", "", ""));                                  // no Host header
}

// eink-ha-os#108: link "up" but every HA connect fails → one relink after 4 fails spanning 5 min; the wait doubles to a 60 min
// cap while HA stays unreachable; a success or a link drop starts over. Across the millis() wrap too.
static void test_stale_link_relinks_after_fails_and_time() {
  StaleLink s;
  const uint32_t t0 = 0xFFFFFFFFu - 60000;   // wraps during the episode
  for (uint32_t i = 0; i < 10; i++) {        // a fail per minute: due at 5 min, not before
    s.failed(t0 + i * 60000);
    const bool due = s.poll(t0 + i * 60000);
    TEST_ASSERT_EQUAL(i == 5, due);
    if (due) break;
  }
  TEST_ASSERT_EQUAL_UINT32(10UL * 60000, s.waitMs());
  StaleLink q;   // many fails fast: still waits for the time
  for (uint32_t i = 0; i < 20; i++) q.failed(i * 1000);
  TEST_ASSERT_FALSE(q.poll(20000));
  TEST_ASSERT_TRUE(q.poll(StaleLink::kStaleMs));
  TEST_ASSERT_FALSE(q.poll(StaleLink::kStaleMs + 1));   // once
  StaleLink f;   // long wait, too few fails
  f.failed(0); f.failed(1000); f.failed(2000);
  TEST_ASSERT_FALSE(f.poll(3600000));
}

static void test_stale_link_backoff_and_reset() {
  StaleLink s;
  uint32_t t = 0;
  const uint32_t want[] = {5, 10, 20, 40, 60, 60};
  for (uint32_t w : want) {
    TEST_ASSERT_EQUAL_UINT32(w * 60000, s.waitMs());
    const uint32_t start = t;
    while (!(s.failed(t), s.poll(t))) t += 60000;
    TEST_ASSERT_EQUAL_UINT32(w * 60000, t - start);
    t += 60000;
  }
  s.reached();
  TEST_ASSERT_EQUAL_UINT32(StaleLink::kStaleMs, s.waitMs());
  for (int i = 0; i < 4; i++) s.failed(i);
  s.linkDown();   // the Wi-Fi escalation takes over; the count starts over, the wait is kept
  TEST_ASSERT_EQUAL_UINT32(0, s.fails());
  TEST_ASSERT_FALSE(s.poll(StaleLink::kStaleMs * 2));
}

// eink-ha-os#227: idle alone never reconnects; the gateway check decides; served requests and each check restart the window
void test_inbound_watch() {
  InboundWatch w;
  const uint32_t idle = InboundWatch::kIdleMs, t0 = 0xFFFF0000u;   // wraps during the test
  TEST_ASSERT_FALSE(w.due(t0 + idle));   // link never up
  w.linkUp(t0);
  w.linkUp(t0 + 1000);                    // still up: the window keeps its start
  TEST_ASSERT_FALSE(w.due(t0 + idle - 1));
  TEST_ASSERT_TRUE(w.due(t0 + idle));
  w.served(t0 + idle);
  TEST_ASSERT_FALSE(w.due(t0 + 2 * idle - 1));
  TEST_ASSERT_TRUE(w.due(t0 + 2 * idle));
  TEST_ASSERT_TRUE(w.checked(t0 + 2 * idle, true) == InboundWatch::Action::MdnsRestart);
  TEST_ASSERT_FALSE(w.due(t0 + 3 * idle - 1));
  TEST_ASSERT_TRUE(w.checked(t0 + 3 * idle, false) == InboundWatch::Action::Reconnect);
  w.linkDown();
  TEST_ASSERT_FALSE(w.due(t0 + 10 * idle));
  w.linkUp(t0 + 10 * idle);
  TEST_ASSERT_FALSE(w.due(t0 + 11 * idle - 1));
}

// eink-ha-os#326: the GOT_IP of the join that just started it is dropped; after stopMdns (Wi-Fi off) the next join inits again
void test_mdns_plan() {
  MdnsPlan p;
  const uint32_t t0 = 0xFFFFF000u;   // wraps during the test
  TEST_ASSERT_TRUE(p.next(false, t0) == MdnsStep::Init);   // also after a failed init: try again
  p.lastMs = t0;
  TEST_ASSERT_TRUE(p.next(true, t0 + 200) == MdnsStep::Skip);
  TEST_ASSERT_TRUE(p.next(true, t0 + MdnsPlan::kSettleMs - 1) == MdnsStep::Skip);
  TEST_ASSERT_TRUE(p.next(true, t0 + MdnsPlan::kSettleMs) == MdnsStep::Rebind);
  TEST_ASSERT_TRUE(p.next(false, t0 + 200) == MdnsStep::Init);   // stopped inside the window: init, never a re-bind
}

// eink-ha-os#376: a re-bind whose ENABLE the full mdns queue dropped leaves IPv4 off; a lost tie-break renames the host
void test_mdns_check() {
  MdnsPlan p;
  const uint32_t t0 = 0xFFFFF000u, S = MdnsPlan::kSettleMs, R = MdnsPlan::kReclaimMs;   // wraps during the test
  p.lastMs = t0;                                                        // re-bind posted DISABLE, ENABLE dropped
  TEST_ASSERT_TRUE(p.check(false, false, true, t0 + S - 1) == MdnsFix::None);   // the pair may still be in the queue
  TEST_ASSERT_TRUE(p.check(false, false, true, t0 + S) == MdnsFix::Enable);
  TEST_ASSERT_TRUE(p.check(false, false, false, t0 + S) == MdnsFix::Enable);   // off and renamed: enable first
  p.did(MdnsFix::Enable, t0 + S);
  TEST_ASSERT_TRUE(p.check(false, false, true, t0 + 2 * S - 1) == MdnsFix::None);   // one repair per settle window
  TEST_ASSERT_TRUE(p.check(true, false, true, t0 + 2 * S) == MdnsFix::None);
  // renamed: reclaim, then not again for kReclaimMs (a real twin on the LAN wins every probe)
  const uint32_t t1 = t0 + 2 * S;
  TEST_ASSERT_TRUE(p.check(true, false, false, t1) == MdnsFix::Reclaim);
  p.did(MdnsFix::Reclaim, t1);
  TEST_ASSERT_TRUE(p.check(true, false, false, t1 + S) == MdnsFix::None);
  TEST_ASSERT_TRUE(p.check(true, false, false, t1 + R - 1) == MdnsFix::None);
  TEST_ASSERT_TRUE(p.check(true, false, false, t1 + R) == MdnsFix::Reclaim);
  TEST_ASSERT_TRUE(p.check(false, false, false, t1 + S) == MdnsFix::Enable);   // the reclaim limit never blocks an enable
  // a re-bind inside the window holds every fix back
  p.lastMs = t1 + R;
  TEST_ASSERT_TRUE(p.check(false, false, false, t1 + R + 5) == MdnsFix::None);
  p.did(MdnsFix::None, t1 + R + S);
  TEST_ASSERT_TRUE(p.lastMs == t1 + R);
}

// ha-paper#20: the IPv6 pcb lost while v4 runs; v4 off first, a rename waits for the v6 enable
void test_mdns_check_v6() {
  MdnsPlan p;
  const uint32_t t0 = 0xFFFFF000u, S = MdnsPlan::kSettleMs;
  p.lastMs = t0;
  TEST_ASSERT_TRUE(p.check(true, true, true, t0 + S - 1) == MdnsFix::None);
  TEST_ASSERT_TRUE(p.check(true, true, true, t0 + S) == MdnsFix::Enable6);
  TEST_ASSERT_TRUE(p.check(false, true, true, t0 + S) == MdnsFix::Enable);
  TEST_ASSERT_TRUE(p.check(true, true, false, t0 + S) == MdnsFix::Enable6);
  p.did(MdnsFix::Enable6, t0 + S);
  TEST_ASSERT_TRUE(p.lastMs == t0 + S && !p.reclaimed);
  TEST_ASSERT_TRUE(p.check(true, true, true, t0 + 2 * S - 1) == MdnsFix::None);   // one repair per settle window
  TEST_ASSERT_TRUE(p.check(true, false, true, t0 + 2 * S) == MdnsFix::None);
}

// ha-paper#20: a cached-IP join restarts DHCP once, the first time the link is up outside a glance
void test_cached_ip_lease() {
  CachedIpLease l;
  TEST_ASSERT_FALSE(l.due(true, false));   // a DHCP join: nothing to do
  l.pending = true;
  TEST_ASSERT_FALSE(l.due(true, true));    // glance: sleeps again soon, keep the fast path
  TEST_ASSERT_FALSE(l.due(false, false));  // link down: wait for it
  TEST_ASSERT_TRUE(l.due(true, false));    // key press / live mode with the link up
  TEST_ASSERT_FALSE(l.due(true, false));   // once
}

void test_bssid_tag() {
  const uint8_t a[6] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55}, b[6] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x56};
  TEST_ASSERT_EQUAL(4, bssidTag(a).size());
  TEST_ASSERT_TRUE(bssidTag(a) != bssidTag(b));
  TEST_ASSERT_TRUE(bssidTag(a) == bssidTag(a));
  TEST_ASSERT_TRUE(bssidTag(nullptr).empty());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_jitter_bounds);
  RUN_TEST(test_backoff_doubles_and_caps);
  RUN_TEST(test_wifi_ladder);
  RUN_TEST(test_wifi_restart_waits_for_permission);
  RUN_TEST(test_wifi_no_reset_with_softap);
  RUN_TEST(test_wifi_reset_on_link);
  RUN_TEST(test_wifi_across_millis_wrap);
  RUN_TEST(test_wifi_restart_threshold_doubles);
  RUN_TEST(test_wifi_stalled_caller_counts_one_minute);
  RUN_TEST(test_heap_threshold);
  RUN_TEST(test_heap_threshold_pooled);
  RUN_TEST(test_heap_watch_night_window);
  RUN_TEST(test_heap_watch_needs_continuous_low);
  RUN_TEST(test_heap_watch_blocked_outside_window_or_ota);
  RUN_TEST(test_heap_starve_sheds_once_after_10s);
  RUN_TEST(test_heap_starve_brief_dip_ignored);
  RUN_TEST(test_heap_starve_web_refuse_floor);
  RUN_TEST(test_same_origin_write);
  RUN_TEST(test_stale_link_relinks_after_fails_and_time);
  RUN_TEST(test_stale_link_backoff_and_reset);
  RUN_TEST(test_tls_peer_for_host);
  RUN_TEST(test_tls_floor_per_peer);
  RUN_TEST(test_tls_heap_dma_and_peer);
  RUN_TEST(test_inbound_watch);
  RUN_TEST(test_bssid_tag);
  RUN_TEST(test_mdns_plan);
  RUN_TEST(test_mdns_check);
  RUN_TEST(test_mdns_check_v6);
  RUN_TEST(test_cached_ip_lease);
  return UNITY_END();
}
