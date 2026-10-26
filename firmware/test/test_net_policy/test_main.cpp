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
  TEST_ASSERT_TRUE(heapOkForTls(40948, 120000));   // the device's largest internal region (#79): must pass
}

// #149: record buffers from the TLS reserve (2 slots free) → a fragmented heap may still take a handshake
static void test_heap_threshold_pooled() {
  TEST_ASSERT_TRUE(heapOkForTls(7668, 40 * 1024, 2));    // the device's state after the price-source episode
  TEST_ASSERT_TRUE(heapOkForTls(4096, 40 * 1024, 3));
  TEST_ASSERT_FALSE(heapOkForTls(4095, 100 * 1024, 3));
  TEST_ASSERT_FALSE(heapOkForTls(40948, 40 * 1024 - 1, 2));
  TEST_ASSERT_FALSE(heapOkForTls(7668, 40 * 1024, 1));   // the WebSocket holds two slots: the old rule
  TEST_ASSERT_TRUE(heapOkForTls(20 * 1024, 64 * 1024, 1));
  TEST_ASSERT_FALSE(heapOkForTls(20 * 1024, 64 * 1024 - 1, 0));
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

// #108: link "up" but every HA connect fails → one relink after 4 fails spanning 5 min; the wait doubles to a 60 min
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
  RUN_TEST(test_same_origin_write);
  RUN_TEST(test_stale_link_relinks_after_fails_and_time);
  RUN_TEST(test_stale_link_backoff_and_reset);
  return UNITY_END();
}
