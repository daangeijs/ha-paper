// core/power_trail (#225): what the previous boot was doing when the X4 Pro lost power, and when the marker is written.
#include <unity.h>

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
  TEST_ASSERT_EQUAL_STRING("sleep standby", sleepWrite("sleep glance", "standby").c_str());
}

static void test_boot_marks_awake_once() {
  TEST_ASSERT_EQUAL_STRING("awake", awakeWrite("sleep standby").c_str());
  TEST_ASSERT_EQUAL_STRING("awake", awakeWrite("").c_str());
  TEST_ASSERT_EQUAL_STRING("", awakeWrite("awake").c_str());
  TEST_ASSERT_EQUAL_STRING("sleep ?", sleepMarker(nullptr).c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_poweron_after_sleep_is_lost_asleep);
  RUN_TEST(test_poweron_after_running_is_lost_awake);
  RUN_TEST(test_other_resets_are_not_a_power_loss);
  RUN_TEST(test_glance_cycles_do_not_write_flash);
  RUN_TEST(test_boot_marks_awake_once);
  return UNITY_END();
}
