// Battery days left (ha-paper#30), a port of emulator/src/core/batteryDays.ts: the glance sleep face's line "Battery 64% ·
// about 58 days left". A model (1100 mAh, deep-sleep floor + awake time from the wake tally) from the first sleep; the
// measured drain since an anchor (first unplugged gauge % with a clock, RTC memory in net/power.cpp) takes over as
// the gauge falls. Pure; vectors spec/test-vectors/battery-days.json.
#pragma once
#include <cstdint>
#include <string>
#include <type_traits>

#include "core/strings.h"

namespace x4::battdays {

constexpr double kMah = 1100;          // A27 (unverified)
constexpr double kSleepMa = 0.2;       // A32 target < 200 µA
constexpr double kAwakeMa = 40;        // live 27–38 mA, glance wake ~64 mA
constexpr double kDefaultAwakeMin = 11;
constexpr double kTallyMinH = 6;
constexpr double kMeasureMinH = 1;
constexpr double kBlendPts = 10;
constexpr double kBlendDays = 7;
constexpr int kDaysCap = 99;           // kDaysCap + 1 = "99+"

double modelPctPerDay(uint64_t awakeMs, int64_t asleepS);

// epoch 0 = none. No member initializers: a constructor would rewrite the RTC_NOINIT record at startup and break its
// checksum (glance::Rtc). Anchor{} = none.
struct Anchor { int64_t epoch; int16_t pct; };
static_assert(std::is_trivial<Anchor>::value, "lives in RTC_NOINIT memory");
inline bool has(const Anchor& a) { return a.epoch > 0; }
Anchor anchorStep(Anchor a, int pct, bool charging, int64_t epoch);

struct Estimate {
  int pct = -1;
  bool charging = false;
  int days = 0;              // 0 = none (charging or gauge unknown); kDaysCap + 1 = "99+"
  double model = 0;
  double measured = -1;      // < 0 = none yet
  double weight = 0;
};
Estimate estimate(int pct, bool charging, const Anchor& a, int64_t epoch, double model);
std::string line(Lang l, const Estimate& e);   // "" = no line
// GET /diagnostics battery.estimate: {"pct","charging","days_left","model_pct_per_day","measured_pct_per_day","measured_weight"}
std::string json(const Estimate& e);

}  // namespace x4::battdays
