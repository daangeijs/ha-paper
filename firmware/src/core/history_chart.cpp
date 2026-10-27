#include "core/history_chart.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include "core/logic.h"

namespace x4 {
namespace hist {

namespace {
double r4(double v) { return std::floor(v * 10000 + 0.5) / 10000; }   // Math.round(v * 1e4) / 1e4
int q(double v, int px) { return int(std::floor(v * px + 0.5)); }
std::string num4(double v) {   // String(r4(v)) for 0…1
  char b[24];
  std::snprintf(b, sizeof b, "%.4f", r4(v));
  std::string s = b;
  while (s.back() == '0') s.pop_back();
  if (s.back() == '.') s.pop_back();
  return s == "-0" ? "0" : s;
}
}  // namespace

const char* stateName(State s) {
  switch (s) {
    case State::Ok: return "ok";
    case State::Loading: return "loading";
    case State::None: return "none";
    case State::TooMany: return "tooMany";
    case State::NeedsStats: return "needsStats";
  }
  return "";
}

const char* stateText(State s, Lang l) {
  return s == State::None ? tr(l, S::histNone) : s == State::TooMany ? tr(l, S::histTooMany)
         : s == State::NeedsStats ? tr(l, S::histNeedsStats) : "";
}

double Chart::y(double val) const { return r4(std::max(0.0, std::min(1.0, (val - r.lo) / (r.hi - r.lo)))); }
double Chart::x(int i) const { return r4((i + 0.5) / n); }
double Chart::edge(int i) const { return r4(double(i) / n); }

void chart(const Spec& spec, const Series* s, State st, int64_t now, int tz, Lang lang, Chart& out) {
  out = Chart();
  out.style = spec.style;
  out.n = spec.n;
  const bool fits = s && s->n == spec.n && s->bucketMs == spec.bucketMs;
  if (st == State::Ok && !fits) st = State::Loading;
  if (st == State::Ok) out.v = s->v;
  if (out.v) {
    for (int i = 0; i < out.n; ++i) if (has(out.v[i])) out.latest = i;
    if (out.latest < 0) { st = State::None; out.v = nullptr; }
    else if (spec.aheadMs) {   // #292: a window that looks ahead marks the bucket holding now, when it has data
      const int i = int((bucketStart(now, spec.bucketMs, tz) - chartSpan(spec.windowMs, spec.bucketMs, now, tz, spec.aheadMs).start) / spec.bucketMs);
      out.latest = i >= 0 && i < out.n && has(out.v[i]) ? i : -1;
    }
  }
  out.state = st;
  static const double kEmpty[1] = {kNone};
  out.r = out.v ? yScale(out.v, out.n, spec.style, spec.min, spec.max, spec.threshold) : yScale(kEmpty, 0, spec.style, spec.min, spec.max);
  if (out.r.lo <= 0 && out.r.hi >= 0) out.zero = out.y(0);
  if (st == State::Ok && has(spec.threshold) && spec.threshold >= out.r.lo && spec.threshold <= out.r.hi) out.threshold = out.y(spec.threshold);
  out.nTicks = axisTicks(spec.windowMs, spec.bucketMs, now, tz, lang, out.ticks, spec.aheadMs);
  for (int k = 0; k < out.nTicks; ++k) out.ticks[k].x = r4(out.ticks[k].x);
  if (out.v) out.lowHigh = lowHigh(*s, spec.windowMs, tz, lang, out.low, out.high);
  if (spec.labels && out.lowHigh) {   // #304: one label per spot; the last one only away from the max and min
    auto put = [&](LabelKind k, int i) { out.labels[out.nLabels++] = Label{k, i, out.x(i) < 0.5}; };
    put(LabelKind::Max, out.high.i);
    if (out.low.i != out.high.i) put(LabelKind::Min, out.low.i);
    const int L = out.latest;
    bool own = L >= 0;
    for (int k = 0; k < out.nLabels && own; ++k) {
      const int i = out.labels[k].i;
      own = i != L && !(std::fabs(out.x(i) - out.x(L)) < 0.25 && std::fabs(out.y(out.v[i]) - out.y(out.v[L])) < 0.25);
    }
    if (own) put(LabelKind::Last, L);
  }
}

std::string chartKey(const Chart& c, int dp, int px) {
  std::string k = stateName(c.state);
  k += ';';
  if (c.style == Style::Bars) {
    for (int i = 0; i < c.n; ++i) {
      if (i) k += ',';
      if (c.gap(i)) k += '_';
      else k += std::to_string(q(c.barB(i), px)) + ":" + std::to_string(q(c.barT(i), px));
    }
  } else {
    bool open = false, first = true;
    for (int i = 0; i < c.n; ++i) {
      if (c.gap(i)) { open = false; continue; }
      if (!first) k += open ? ',' : '|';
      k += std::to_string(q(c.y(c.v[i]), px));
      open = true; first = false;
    }
  }
  k += ';';
  for (int i = 0; i < c.nTicks; ++i) k += (i ? " " : "") + num4(c.ticks[i].x);
  auto v = [&](const Extreme& e) { return std::to_string(c.lowHigh ? e.i : -1) + "=" + (c.lowHigh ? fmtFixed(e.v, dp) : ""); };
  k += ";" + v(c.low) + ";" + v(c.high);
  if (has(c.threshold)) k += ";t" + std::to_string(q(c.threshold, px));
  for (int i = 0; i < c.nLabels; ++i)
    if (c.labels[i].kind == LabelKind::Last) k += ";l" + std::to_string(c.labels[i].i) + "=" + fmtFixed(c.v[c.labels[i].i], dp);
  return k;
}

std::string seriesKey(const Spec& s) {
  std::string k = s.entity + "|" + std::to_string(s.windowMs) + "|" + std::to_string(s.bucketMs) + "|" + aggName(s.agg);
  if (s.kind != Kind::Recorder)   // #292, like the device sim's histKey
    k += "|" + std::to_string(s.aheadMs) + "|" + s.attribute + "|" + s.value + "|" + s.time + "|" +
         (s.kind == Kind::Forecast ? (s.daily ? "daily" : "hourly") : "");
  return k;
}

int tzMinutes(int lYday, int lYear, int lMinOfDay, int uYday, int uYear, int uMinOfDay) {
  int dd = lYear == uYear ? lYday - uYday : lYear > uYear ? 1 : -1;
  return dd * 1440 + lMinOfDay - uMinOfDay;
}

}  // namespace hist
}  // namespace x4
