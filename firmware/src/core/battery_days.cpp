#include "core/battery_days.h"

#include <algorithm>
#include <cmath>

#include "core/json.h"

namespace x4::battdays {

namespace {
constexpr int64_t kSaneEpoch = 1700000000;
}

double modelPctPerDay(uint64_t awakeMs, int64_t asleepS) {
  const double awakeS = double(awakeMs) / 1000, total = awakeS + double(std::max<int64_t>(0, asleepS));
  const double frac = total >= kTallyMinH * 3600 ? awakeS / total : kDefaultAwakeMin / 1440;
  return (24 * (frac * kAwakeMa + (1 - frac) * kSleepMa) * 100) / kMah;
}

Anchor anchorStep(Anchor a, int pct, bool charging, int64_t epoch) {
  if (pct < 0) return a;
  if (charging) return Anchor{};
  if (epoch <= kSaneEpoch) return a;
  if (!has(a) || pct > a.pct || epoch < a.epoch) return Anchor{epoch, int16_t(pct)};
  return a;
}

Estimate estimate(int pct, bool charging, const Anchor& a, int64_t epoch, double model) {
  Estimate e;
  e.pct = pct;
  e.charging = charging;
  e.model = model;
  if (pct < 0 || charging) return e;
  if (has(a) && epoch > kSaneEpoch && epoch - a.epoch >= int64_t(kMeasureMinH * 3600)) {
    const double d = double(epoch - a.epoch) / 86400, drop = std::max(0, a.pct - pct);
    e.measured = std::max(drop, 0.5) / d;   // whole points: no drop yet = under one point
    e.weight = std::min(1.0, std::max(drop / kBlendPts, d / kBlendDays));
  }
  const double rate = e.weight * (e.measured < 0 ? 0 : e.measured) + (1 - e.weight) * model;
  const double days = std::floor(pct / rate + 0.5);
  e.days = int(std::min<double>(kDaysCap + 1, std::max(1.0, days)));
  return e;
}

std::string line(Lang l, const Estimate& e) {
  if (e.pct < 0) return "";
  const std::string pct = std::to_string(e.pct);
  if (e.charging) return tr(l, S::battCharging, pct);
  if (e.days <= 0) return "";
  if (e.days == 1) return tr(l, S::battDay1, pct);
  return tr(l, S::battDays, pct, e.days > kDaysCap ? std::to_string(kDaysCap) + "+" : std::to_string(e.days));
}

std::string json(const Estimate& e) {
  auto r3 = [](double v) { return jsNumber(jsRound(v * 1000) / 1000); };
  std::string o = "{\"pct\":" + (e.pct < 0 ? std::string("null") : std::to_string(e.pct));
  o += std::string(",\"charging\":") + (e.charging ? "true" : "false");
  o += ",\"days_left\":" + (e.days <= 0 ? std::string("null") : std::to_string(e.days));
  o += ",\"model_pct_per_day\":" + r3(e.model);
  o += ",\"measured_pct_per_day\":" + (e.measured < 0 ? std::string("null") : r3(e.measured));
  o += ",\"measured_weight\":" + r3(e.weight) + "}";
  return o;
}

}  // namespace x4::battdays
