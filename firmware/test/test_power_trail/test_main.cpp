// core/power_trail (eink-ha-os#225): what the previous boot was doing when the X4 Pro lost power, and when the marker is written.
#include <unity.h>

#include "core/phases.h"
#include "core/power_trail.h"

using namespace x4::powertrail;

void setUp() {}
void tearDown() {}

static void test_poweron_after_sleep_is_lost_asleep() {
  TEST_ASSERT_TRUE(verdict(sleepMarker("standby"), "POWERON") == Verdict::LostAsleep);
  TEST_ASSERT_EQUAL_STRING("lost-asleep", verdictName(verdict("sleep glance", "POWERON")));
}

static void test_poweron_after_running_is_lost_awake() {
  TEST_ASSERT_TRUE(verdict(kAwake, "POWERON") == Verdict::LostAwake);
}

// eink-ha-os#258: turned off by a Power hold, then switched on again: asked for, not a loss
static void test_poweron_after_off_is_not_a_loss() {
  const std::string t = append(append(kAwake, keyLine(9000, 4100, false)), offLine(11200));
  TEST_ASSERT_EQUAL_STRING("off 11200", lastLine(t).c_str());
  TEST_ASSERT_TRUE(verdict(t, "POWERON") == Verdict::None);
}

static void test_other_resets_are_not_a_power_loss() {
  for (const char* r : {"DEEPSLEEP", "SW", "PANIC", "TASK_WDT", "USB", "BROWNOUT"}) {
    TEST_ASSERT_TRUE(verdict("sleep standby", r) == Verdict::None);
    TEST_ASSERT_TRUE(verdict(kAwake, r) == Verdict::None);
  }
  TEST_ASSERT_TRUE(verdict("", "POWERON") == Verdict::None);   // first boot: no marker yet
  TEST_ASSERT_TRUE(verdict("garbage", "POWERON") == Verdict::None);
  TEST_ASSERT_TRUE(verdict(kAwake, nullptr) == Verdict::None);
}

static void test_glance_cycles_do_not_write_flash() {
  // a glance wake does not call awakeWrite; sleeping again for the same reason: no write
  TEST_ASSERT_EQUAL_STRING("", sleepWrite("sleep glance", "glance").c_str());
  TEST_ASSERT_EQUAL_STRING("", sleepWrite("awake\nsleep glance\n", "glance").c_str());
  TEST_ASSERT_EQUAL_STRING("sleep glance\nsleep standby\n", sleepWrite("sleep glance", "standby").c_str());
}

static void test_boot_marks_awake_once() {
  TEST_ASSERT_EQUAL_STRING("sleep standby\nawake\n", awakeWrite("sleep standby").c_str());
  TEST_ASSERT_EQUAL_STRING("awake\n", awakeWrite("").c_str());
  TEST_ASSERT_EQUAL_STRING("", awakeWrite("awake").c_str());
  TEST_ASSERT_EQUAL_STRING("", awakeWrite("key 1 3950 0\nawake\n").c_str());
  TEST_ASSERT_EQUAL_STRING("sleep ?", sleepMarker(nullptr).c_str());
}

// Power key stages (eink-ha-os#225): which stage the board reached before a POWERON tells the hardware path from the load spike
static void test_key_stages_are_lost_awake() {
  std::string t = awakeWrite("");
  t = append(t, keyLine(123456, 3950, false));
  TEST_ASSERT_EQUAL_STRING("key 123456 3950 0", lastLine(t).c_str());
  TEST_ASSERT_TRUE(verdict(t, "POWERON") == Verdict::LostAwake);
  t = append(t, standbyLine(124900));
  TEST_ASSERT_EQUAL_STRING("standby drawn 124900", lastLine(t).c_str());
  TEST_ASSERT_TRUE(verdict(t, "POWERON") == Verdict::LostAwake);
  t = append(t, keyUpLine(180));
  TEST_ASSERT_TRUE(verdict(t, "POWERON") == Verdict::LostAwake);
  TEST_ASSERT_EQUAL_STRING("key 0 -1 1", keyLine(0, -1, true).c_str());   // gauge not read, on USB
  auto l = lastLines(t, 2);
  TEST_ASSERT_EQUAL_UINT32(2, l.size());
  TEST_ASSERT_EQUAL_STRING("standby drawn 124900", l[0].c_str());
  TEST_ASSERT_EQUAL_STRING("keyup 180", l[1].c_str());
}

static void test_trail_is_capped() {
  std::string t;
  for (int i = 0; i < 100; i++) t = append(t, keyUpLine(i));
  auto all = lastLines(t, 1000);
  TEST_ASSERT_EQUAL_UINT32(kMaxLines, all.size());
  TEST_ASSERT_EQUAL_STRING("keyup 68", all.front().c_str());
  TEST_ASSERT_EQUAL_STRING("keyup 99", all.back().c_str());
  TEST_ASSERT_EQUAL_STRING("", lastLine("").c_str());
  TEST_ASSERT_EQUAL_STRING("sleep standby", lastLine("sleep standby").c_str());   // pre-eink-ha-os#225 single marker
}

// ---------- awake phases (eink-ha-os#327, core/phases.h) ----------
static void test_phases_cut_in_order() {
  x4::phases::Marks m;
  m.bootMs = 800; m.wifiMs = 2300; m.haMs = 4500; m.drawAtHaMs = 1500;
  const auto r = x4::phases::measure(m, 10000, 600, 2400);   // 1500 ms of drawing after HA: idle 5500 - 1500
  TEST_ASSERT_EQUAL_UINT32(800, r.boot);
  TEST_ASSERT_EQUAL_UINT32(1500, r.wifi);
  TEST_ASSERT_EQUAL_UINT32(2200, r.ha);
  TEST_ASSERT_EQUAL_UINT32(4000, r.idle);
  TEST_ASSERT_EQUAL_UINT32(10000, r.total);
  TEST_ASSERT_EQUAL_STRING("boot 800 · wifi 1500 · ha 2200 · render 600 · panel 2400 · idle 4000 · total 10000 ms",
                           x4::phases::line(r).c_str());
}

static void test_phases_overlap_and_not_reached() {
  x4::phases::Marks m;
  m.bootMs = 3000; m.wifiMs = 1200;   // Wi-Fi up during setup: no wifi phase
  auto r = x4::phases::measure(m, 9000, 100, 200);   // HA never connected: the rest is ha, no idle
  TEST_ASSERT_EQUAL_UINT32(3000, r.boot);
  TEST_ASSERT_EQUAL_UINT32(0, r.wifi);
  TEST_ASSERT_EQUAL_UINT32(6000, r.ha);
  TEST_ASSERT_EQUAL_UINT32(0, r.idle);
  m = {};
  r = x4::phases::measure(m, 500, 0, 0);   // still in setup
  TEST_ASSERT_EQUAL_UINT32(500, r.boot);
  TEST_ASSERT_EQUAL_UINT32(0, r.wifi + r.ha + r.idle);
}

static void test_phases_ring_newest_first() {
  x4::phases::Ring ring{};
  TEST_ASSERT_EQUAL_STRING("{\"boot\":null,\"wakes\":[]}", x4::phases::json(nullptr, ring).c_str());
  for (uint32_t i = 1; i <= x4::phases::kWakes + 2; i++) {
    x4::phases::Rec r{};
    r.total = i;
    r.mv = -1; r.pct = 90; r.raw = 92; r.wake = 't';
    x4::phases::push(ring, r);
  }
  TEST_ASSERT_EQUAL_UINT8(x4::phases::kWakes, ring.n);
  const std::string j = x4::phases::json(nullptr, ring);
  TEST_ASSERT_EQUAL(0, int(j.find("{\"boot\":null,\"wakes\":[{\"wake\":\"timer\",\"epoch\":null,\"boot_ms\":0,")));
  TEST_ASSERT_TRUE(j.find("\"total_ms\":14,\"pct\":90,\"raw\":92,\"mv\":null}") < j.find("\"total_ms\":13,"));
  TEST_ASSERT_TRUE(j.find("\"total_ms\":2,") == std::string::npos);   // the two oldest fell out
  TEST_ASSERT_TRUE(j.find("\"total_ms\":3,") != std::string::npos);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_poweron_after_sleep_is_lost_asleep);
  RUN_TEST(test_poweron_after_running_is_lost_awake);
  RUN_TEST(test_poweron_after_off_is_not_a_loss);
  RUN_TEST(test_other_resets_are_not_a_power_loss);
  RUN_TEST(test_glance_cycles_do_not_write_flash);
  RUN_TEST(test_boot_marks_awake_once);
  RUN_TEST(test_key_stages_are_lost_awake);
  RUN_TEST(test_trail_is_capped);
  RUN_TEST(test_phases_cut_in_order);
  RUN_TEST(test_phases_overlap_and_not_reached);
  RUN_TEST(test_phases_ring_newest_first);
  return UNITY_END();
}
