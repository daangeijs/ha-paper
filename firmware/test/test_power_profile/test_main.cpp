// core/power_profile (#249): the CPU / Wi-Fi profile follows a USB unplug, settled over 2 s.
#include <unity.h>

#include "core/power_profile.h"

using namespace x4;

void setUp() {}
void tearDown() {}

static PowerInputs battery() {
  PowerInputs i;
  i.powerSave = PowerSave::Glance;
  i.battery = 95;
  i.live = true;
  return i;
}

static void test_usb_unplug_forgets_the_recent_charge() {
  ChargeMemory m;
  m.step(true, true, 1000);   // on a USB host, charging
  m.step(false, true, 5000);  // cell full: STAT drops, host still there
  TEST_ASSERT_TRUE(m.agoMin(5000) >= 0);
  PowerInputs i = battery();
  i.voltage = 4.18;
  i.chargedAgoMin = m.agoMin(5000);
  TEST_ASSERT_TRUE(powerDecision(i).external);   // pre-#249: still external after the unplug for 30 min
  m.step(false, false, 6000); // unplugged
  i.chargedAgoMin = m.agoMin(6000);
  TEST_ASSERT_TRUE(i.chargedAgoMin < 0);
  const PowerDecision d = powerDecision(i);
  TEST_ASSERT_FALSE(d.external);
  TEST_ASSERT_TRUE(d.cpuProfile == CpuProfile::Auto);
  TEST_ASSERT_TRUE(d.wifiPs == WifiPs::Min);
  TEST_ASSERT_EQUAL(80, cpuMhzFor(d.cpuProfile));
}

static void test_dumb_charger_keeps_the_30_minute_rule() {
  ChargeMemory m;
  m.step(true, false, 0);
  m.step(false, false, 60000);   // STAT drops (full, or unplugged: no way to tell)
  TEST_ASSERT_TRUE(m.agoMin(120000) == 2.0);
  PowerInputs i = battery();
  i.voltage = 4.18;
  i.chargedAgoMin = m.agoMin(120000);
  TEST_ASSERT_TRUE(powerDecision(i).external);
}

static void test_gate_applies_first_at_once_and_changes_after_2s() {
  ProfileGate g;
  const PowerProfile ext{true, CpuProfile::Full, WifiPs::None}, bat{false, CpuProfile::Auto, WifiPs::Min};
  TEST_ASSERT_TRUE(g.step(ext, 0));
  TEST_ASSERT_TRUE(g.applied() == ext);
  TEST_ASSERT_FALSE(g.step(ext, 1000));
  TEST_ASSERT_FALSE(g.step(bat, 2000));
  TEST_ASSERT_TRUE(g.settling());
  TEST_ASSERT_FALSE(g.step(bat, 3999));
  TEST_ASSERT_TRUE(g.applied() == ext);
  TEST_ASSERT_TRUE(g.step(bat, 4000));
  TEST_ASSERT_TRUE(g.applied() == bat);
  TEST_ASSERT_FALSE(g.settling());
}

static void test_gate_ignores_flapping() {
  ProfileGate g;
  const PowerProfile ext{true, CpuProfile::Full, WifiPs::None}, bat{false, CpuProfile::Auto, WifiPs::Min};
  g.step(ext, 0);
  for (uint32_t t = 1000; t < 20000; t += 1000) TEST_ASSERT_FALSE(g.step(t / 1000 % 2 ? bat : ext, t));
  TEST_ASSERT_TRUE(g.applied() == ext);   // bat waiting since 19000
  TEST_ASSERT_FALSE(g.step(bat, 20000));
  TEST_ASSERT_TRUE(g.step(bat, 21000));
}

static void test_gate_restarts_on_a_third_profile() {
  ProfileGate g;
  const PowerProfile ext{true, CpuProfile::Full, WifiPs::None}, bat{false, CpuProfile::Auto, WifiPs::Min},
      ota{false, CpuProfile::Full, WifiPs::None};
  g.step(bat, 0);
  g.step(ext, 1000);
  TEST_ASSERT_FALSE(g.step(ota, 2500));   // a different wish restarts the 2 s
  TEST_ASSERT_FALSE(g.step(ota, 4000));
  TEST_ASSERT_TRUE(g.step(ota, 4500));
  TEST_ASSERT_TRUE(g.applied() == ota);
}

static void test_wraparound() {
  ProfileGate g;
  const PowerProfile ext{true, CpuProfile::Full, WifiPs::None}, bat{false, CpuProfile::Auto, WifiPs::Min};
  g.step(ext, 0xFFFFF000u);
  g.step(bat, 0xFFFFFC00u);
  TEST_ASSERT_FALSE(g.step(bat, 0x00000100u));   // 1280 ms
  TEST_ASSERT_TRUE(g.step(bat, 0x00000400u));    // 2048 ms
  ChargeMemory m;
  m.step(true, false, 0xFFFFFFF0u);
  TEST_ASSERT_TRUE(m.agoMin(0x00000010u) < 0.001);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_usb_unplug_forgets_the_recent_charge);
  RUN_TEST(test_dumb_charger_keeps_the_30_minute_rule);
  RUN_TEST(test_gate_applies_first_at_once_and_changes_after_2s);
  RUN_TEST(test_gate_ignores_flapping);
  RUN_TEST(test_gate_restarts_on_a_third_profile);
  RUN_TEST(test_wraparound);
  return UNITY_END();
}
