// core/panel_guard (eink-ha-os#181): a stub bus whose BUSY never releases times out once, marks the panel failed and every later
// wait returns without touching the bus. The clock is injected and advanced by idle(), across the 2^32 wrap.
#include <unity.h>

#include <cstdint>

#include "core/panel_guard.h"

using namespace x4;

void setUp() {}
void tearDown() {}

// Stub panel: BUSY reads true for `busyPolls` polls (UINT32_MAX = never releases); idle() = one 1 ms tick.
struct StubBus {
  uint32_t clock = 0, busyPolls = 0, polls = 0, idles = 0;
  bool busy() { return polls++ < busyPolls; }
  void idle() { ++clock; ++idles; }
  bool wait(PanelGuard& g, const char* what = "refresh", uint32_t maxMs = kPanelBusyMaxMs) {
    return g.wait([&] { return busy(); }, [&] { return clock; }, [&] { idle(); }, what, maxMs);
  }
};

static void test_healthy_panel_releases() {
  PanelGuard g;
  StubBus b{0, 3000};   // a 3 s refresh
  TEST_ASSERT_TRUE(b.wait(g));
  TEST_ASSERT_EQUAL_UINT32(3000, b.idles);
  TEST_ASSERT_FALSE(g.failed());
  TEST_ASSERT_FALSE(g.takeFailureLog());
  TEST_ASSERT_EQUAL_STRING("", g.failureText().c_str());
}

static void test_stuck_busy_times_out_once() {
  PanelGuard g;
  StubBus b{0, UINT32_MAX};
  TEST_ASSERT_FALSE(b.wait(g, "init"));
  TEST_ASSERT_EQUAL_UINT32(kPanelBusyMaxMs, b.clock);   // bounded: exactly the limit, well under the 30 s TWDT
  TEST_ASSERT_TRUE(g.failed());
  TEST_ASSERT_EQUAL_STRING("BUSY stuck 20 s (init)", g.failureText().c_str());
  TEST_ASSERT_TRUE(g.takeFailureLog());    // logged once
  TEST_ASSERT_FALSE(g.takeFailureLog());
  // every later wait (rest of init, each redraw) skips the bus: no poll, no idle
  const uint32_t polls = b.polls, idles = b.idles;
  for (int i = 0; i < 100; i++) TEST_ASSERT_FALSE(b.wait(g));
  TEST_ASSERT_EQUAL_UINT32(polls, b.polls);
  TEST_ASSERT_EQUAL_UINT32(idles, b.idles);
  TEST_ASSERT_EQUAL_STRING("BUSY stuck 20 s (init)", g.failureText().c_str());   // the first failure stays
}

static void test_wraps_and_null_tag() {
  PanelGuard g;
  StubBus b{0xFFFFF000u, UINT32_MAX};   // millis() wraps 4 s into the wait
  TEST_ASSERT_FALSE(b.wait(g, nullptr, 5000));
  TEST_ASSERT_EQUAL_UINT32(5000, b.clock - 0xFFFFF000u);
  TEST_ASSERT_EQUAL_STRING("BUSY stuck 5 s", g.failureText().c_str());
}

static void test_just_under_the_limit_passes() {
  PanelGuard g;
  StubBus b{0, kPanelBusyMaxMs};
  TEST_ASSERT_TRUE(b.wait(g));
  TEST_ASSERT_FALSE(g.failed());
}

static void test_reset_clears() {
  PanelGuard g;
  StubBus b{0, UINT32_MAX};
  TEST_ASSERT_FALSE(b.wait(g, "x", 10));
  g.reset();
  TEST_ASSERT_FALSE(g.failed());
  StubBus ok{0, 2};
  TEST_ASSERT_TRUE(ok.wait(g));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_healthy_panel_releases);
  RUN_TEST(test_stuck_busy_times_out_once);
  RUN_TEST(test_wraps_and_null_tag);
  RUN_TEST(test_just_under_the_limit_passes);
  RUN_TEST(test_reset_clears);
  return UNITY_END();
}
