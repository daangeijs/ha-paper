// Port of emulator src/core/quiet.ts quietSources / quietTomorrow (#328).
#include "core/tomorrow.h"

#include "core/bins.h"
#include "core/logic.h"

namespace x4 {
namespace quiet {

namespace {
constexpr int64_t kMin = 60000, kDay = 1440 * kMin;
int64_t floorDiv(int64_t a, int64_t b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }
int64_t localDay(int64_t t, int tz) { return floorDiv(t + int64_t(tz) * kMin, kDay); }
int minuteOf(int64_t t, int tz) { int64_t m = floorDiv(t + int64_t(tz) * kMin, kMin) % 1440; return int(m < 0 ? m + 1440 : m); }
std::string hm(int64_t t, int tz) { int m = minuteOf(t, tz); return pad2(m / 60) + ":" + pad2(m % 60); }
}  // namespace

Sources sources(const std::vector<Screen>& screens) {
  Sources out;
  for (int i = 0; i < int(screens.size()); ++i)
    for (int k = 0; k < int(screens[size_t(i)].widgets.size()); ++k) {
      const Widget& w = screens[size_t(i)].widgets[size_t(k)];
      if (w.type == "weather" && out.weather.screen < 0 && !w.field("entity").empty()) out.weather = {i, k};
      if (agenda::isAgendaType(w.type) && out.agenda.screen < 0 && !agenda::calendarsOf(w.field("entities")).empty()) out.agenda = {i, k};
      if (w.type == "bins" && out.bins.screen < 0 && !listOf(w, "entities").empty()) out.bins = {i, k};
    }
  return out;
}

int64_t day(int64_t nowMs, int tz, int endHour) {
  return localDay(nowMs, tz) + (minuteOf(nowMs, tz) / 60 < endHour ? 0 : 1);
}

Row tomorrow(const In& in) {
  Row r;
  const int64_t today = localDay(in.now, in.tz), d = day(in.now, in.tz, in.endHour);
  if (in.fc && in.fc->hasDaily) {
    const wx::Entry* e = nullptr;
    for (int k = 0; k < in.fc->nDaily && !e; ++k)
      if (localDay(int64_t(in.fc->daily[k].tS) * 1000, in.tz) == d) e = &in.fc->daily[k];
    if (e && e->temp != wx::kNoT) {
      Item it{Kind::Weather, int(e->icon), wx::degText(wx::tempOf(e->temp)), ""};
      if (e->low != wx::kNoT) it.bold += " / " + wx::degText(wx::tempOf(e->low));
      for (int k = 0; in.fc->hasHourly && k < in.fc->nHourly; ++k) {
        const wx::Entry& h = in.fc->hourly[k];
        const int64_t t = int64_t(h.tS) * 1000;
        if (t + 60 * kMin > in.now && localDay(t, in.tz) == d && wx::isWet(h)) { it.text = tr(in.lang, S::qtRain, hm(t, in.tz)); break; }
      }
      r.items.push_back(std::move(it));
    }
  }
  if (in.events) {
    const agenda::Event* ev = nullptr;
    for (int pass = 0; pass < 2 && !ev; ++pass)   // a timed event first, else an all-day one
      for (auto& e : in.events->events)
        if (localDay(e.start, in.tz) == d && e.end > in.now && e.allDay == (pass == 1)) { ev = &e; break; }
    if (ev) r.items.push_back({Kind::Event, -1, ev->allDay ? std::string(tr(in.lang, S::agAllDay)) : hm(ev->start, in.tz),
                               ev->len ? ev->text() : std::string(tr(in.lang, S::agBusy))});
  }
  if (in.bins) {
    std::string labels;
    for (auto& b : *in.bins)
      if (b.days != bins::kUnknown && today + b.days == d) labels += (labels.empty() ? "" : " + ") + b.label;
    if (!labels.empty()) {
      const S t = d == today ? S::qtBinToday : minuteOf(in.now, in.tz) >= in.tonight * 60 ? S::qtBinTonight : S::qtBinTomorrow;
      r.items.push_back({Kind::Bins, -1, labels, tr(in.lang, t)});
    }
  }
  if (!r.items.empty()) r.head = tr(in.lang, d == today ? S::qtToday : S::qtTomorrow);
  return r;
}

}  // namespace quiet
}  // namespace x4
