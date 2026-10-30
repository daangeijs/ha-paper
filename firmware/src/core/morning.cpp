// Good morning page (#330), a port of emulator src/core/morning.ts.
#include "core/morning.h"

#include <algorithm>
#include "core/logic.h"

namespace x4 {
namespace morning {

namespace {
constexpr int64_t kMin = 60000, kHour = 60 * kMin;

int64_t floorDiv(int64_t a, int64_t b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }
std::string deg(int16_t v) { return wx::degText(wx::tempOf(v)); }
}  // namespace

Step step(const State& s, const Tick& t) {
  Step o;
  o.s = s;
  if (!t.clockKnown) return o;
  if (isNightHour(t.hour, t.quiet)) {
    o.end = s.until != 0;
    o.s.armed = 1;
    o.s.until = 0;
    return o;
  }
  if (s.armed) {
    const bool on = t.enabled && t.quiet != "off";
    o.s.armed = 0;
    if (on) o.s.until = t.now + kMs;
    o.start = on;
    return o;
  }
  if (s.until && t.now >= s.until) {
    o.s.until = 0;
    o.end = true;
  }
  return o;
}

View view(const In& in) {
  View v;
  const Lang l = in.lang;
  const int64_t now = in.now, today = agenda::dayOf(now, in.tz);
  v.head = tr(l, S::gmHead);
  {  // civil from days (H. Hinnant)
    const int64_t z = today + 719468, era = floorDiv(z, 146097), doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153, d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
    v.date = dateLine(l, int(((today + 4) % 7 + 7) % 7), int(d), int(m - 1));
  }
  // weather: today's daily entry, the first wet hour today that is not over
  if (in.fc) {
    const wx::Forecast& f = *in.fc;
    const wx::Entry* day = nullptr;
    if (f.hasDaily)
      for (int i = 0; i < f.nDaily && !day; ++i)
        if (agenda::dayOf(int64_t(f.daily[i].tS) * 1000, in.tz) == today) day = &f.daily[i];
    if (day && day->temp != wx::kNoT) v.temps = deg(day->temp) + (day->low != wx::kNoT ? " / " + deg(day->low) : "");
    if (f.hasHourly)
      for (int i = 0; i < f.nHourly; ++i) {
        const wx::Entry& e = f.hourly[i];
        const int64_t t = int64_t(e.tS) * 1000;
        if (t + kHour <= now || agenda::dayOf(std::max(t, now), in.tz) != today || !wx::isWet(e)) continue;
        if (t <= now) v.rain = tr(l, S::gmRainNow);
        else {
          const int64_t m = ((floorDiv(t + int64_t(in.tz) * kMin, kMin)) % 1440 + 1440) % 1440;
          v.rain = tr(l, S::gmRainFrom, hhmm(int(m)));
        }
        break;
      }
    v.weather = !v.temps.empty() || !v.rain.empty();
    if (v.weather && day) { v.hasIcon = true; v.icon = wx::Icon(day->icon); }
  }
  // today's events, as the agenda tile writes them
  if (in.events) {
    agenda::Fetch on;
    for (auto& e : in.events->events)
      if (e.end > now && std::max(agenda::dayOf(e.start, in.tz), today) == today) on.events.push_back(e);
    agenda::Lines a = agenda::lines(on, now, in.tz, l, kEvents + 1);
    for (auto& x : a.lines) if (!x.day) v.events.push_back({x.time, x.text});
    if (a.more) v.more = tr(l, S::gmMore, std::to_string(a.more));
  }
  // bins collected today, then the ones to put out tonight
  if (in.bins)
    for (int n = 0; n < 2; ++n) {
      std::string labels;
      for (auto& b : *in.bins) if (b.days == n) labels += (labels.empty() ? "" : " + ") + b.label;
      if (!labels.empty()) v.bins.push_back({labels, tr(l, n == 0 ? S::gmBinToday : S::gmBinTonight)});
    }
  return v;
}

}  // namespace morning
}  // namespace x4
