// Port of emulator src/core/history.ts (#268); spec/test-vectors/history.json. Arithmetic order follows the TS so the
// doubles match the vectors.
#include "core/history.h"
#include "core/config.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace x4 {
namespace hist {

namespace {

const char* const kLadder[] = {"1m", "5m", "10m", "15m", "30m", "1h", "2h", "3h", "6h", "12h", "1d"};
const char* const kAggs[] = {"mean", "max", "min", "last", "change"};

int64_t floorDiv(int64_t a, int64_t b) { int64_t q = a / b; return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q; }

bool isDigit(char c) { return c >= '0' && c <= '9'; }
// /^-?\d+(\.\d+)?/ from i; returns the end or npos
size_t decimal(const char* s, size_t len, size_t i) {
  if (i < len && s[i] == '-') ++i;
  size_t d = i;
  while (i < len && isDigit(s[i])) ++i;
  if (i == d) return std::string::npos;
  if (i < len && s[i] == '.') {
    size_t f = ++i;
    while (i < len && isDigit(s[i])) ++i;
    if (i == f) return std::string::npos;
  }
  return i;
}
// /^-?\d+(\.\d+)?$/ → number, else NaN (history.ts numOf)
double numOf(const std::string& v) {
  return decimal(v.data(), v.size(), 0) == v.size() ? std::strtod(v.c_str(), nullptr) : kNone;
}
// local (UTC + tz) day number and ms into that day
void local(int64_t t, int tz, int64_t& day, int64_t& ms) {
  int64_t lt = t + int64_t(tz) * kMin;
  day = floorDiv(lt, kDay);
  ms = lt - day * kDay;
}
void dayAbbr(Lang lang, int wday, char* out) {   // first two letters of the day name ("Mo" / "Ma")
  const char* d = tr(lang, static_cast<S>(int(S::day0) + wday));
  out[0] = d[0]; out[1] = d[0] ? d[1] : 0; out[2] = 0;
}
int wdayOf(int64_t day) { return int(((day % 7) + 7 + 4) % 7); }   // 1970-01-01 was a Thursday

}  // namespace

int64_t parseSpan(const std::string& v) {
  if (v.size() < 2) return -1;
  int64_t unit = v.back() == 'm' ? kMin : v.back() == 'h' ? kHour : v.back() == 'd' ? kDay : 0;
  if (!unit) return -1;
  for (size_t i = 0; i + 1 < v.size(); ++i) if (!isDigit(v[i])) return -1;
  double n = std::strtod(v.substr(0, v.size() - 1).c_str(), nullptr);
  if (n <= 0) return -1;
  return n * double(unit) > 1e15 ? int64_t(1e15) : int64_t(n) * unit;   // huge = out of every range
}

int64_t defaultBucket(int64_t win, int cs) {
  int64_t last = -1;
  for (auto* s : kLadder) {
    int64_t b = parseSpan(s);
    if (win % b != 0 || win / b < kMinBars || win / b > kMaxBars) continue;
    if (win / b <= int64_t(kBarsPerCol) * cs) return b;
    last = b;
  }
  return last;
}

bool aggOf(const std::string& v, Agg& out) {
  for (int i = 0; i < 5; ++i) if (v == kAggs[i]) { out = Agg(i); return true; }
  return false;
}
const char* aggName(Agg a) { return kAggs[int(a)]; }

Style resolveStyle(Agg a, const std::string& style) {
  if (style == "bars") return Style::Bars;
  if (style == "line") return Style::Line;
  return a == Agg::Mean ? Style::Line : Style::Bars;
}

std::string configError(const Field& window, const Field& bucket, const Field& agg, const Field& style, const Field& min,
                        const Field& max, int cs) {
  std::string winText = window.present ? window.v : kWindowDefault;
  int64_t win = parseSpan(winText);
  if (win < 0 || win < kWindowMin || win > kWindowMax) return "history: window must be like 30m, 6h or 7d (10m–7d)";
  if (bucket.present) {
    int64_t b = -1;
    for (auto* s : kLadder) if (bucket.v == s) b = parseSpan(s);
    if (b <= 0) {
      std::string all;
      for (auto* s : kLadder) all += (all.empty() ? "" : " ") + std::string(s);
      return "history: bucket must be one of " + all;
    }
    if (win % b != 0) return "history: bucket " + bucket.v + " does not divide window " + winText;
    int64_t n = win / b;
    if (n < kMinBars || n > kMaxBars)
      return "history: " + winText + " / " + bucket.v + " = " + std::to_string(n) + (n == 1 ? " bar (" : " bars (") +
             std::to_string(kMinBars) + "–" + std::to_string(kMaxBars) + ")";
  } else if (defaultBucket(win, cs) < 0) {
    return "history: no bucket fits window " + winText + "; set bucket";
  }
  Agg a;
  if (agg.present && !aggOf(agg.v, a)) return "history: agg must be mean, max, min, last, change";
  if (style.present && style.v != "bars" && style.v != "line" && style.v != "auto") return "history: style must be bars, line or auto";
  double lo = min.present ? numOf(min.v) : 0, hi = max.present ? numOf(max.v) : 0;
  if ((min.present && !has(lo)) || (max.present && !has(hi))) return "history: min and max must be numbers";
  if (min.present && max.present && lo >= hi) return "history: min must be below max";
  return "";
}

Spec specOf(const Widget& w) {
  auto f = [&](const char* k) { auto it = w.fields.find(k); return it == w.fields.end() ? Field{} : Field{true, it->second}; };
  Spec s;
  s.entity = w.field("entity");
  Field win = f("window"), b = f("bucket"), ag = f("agg"), st = f("style"), lo = f("min"), hi = f("max");
  s.windowMs = parseSpan(win.present ? win.v : kWindowDefault);
  s.bucketMs = b.present ? parseSpan(b.v) : defaultBucket(s.windowMs, w.cs ? w.cs : 1);
  s.n = s.bucketMs > 0 ? int(s.windowMs / s.bucketMs) : 0;
  if (!ag.present || !aggOf(ag.v, s.agg)) s.agg = Agg::Mean;
  s.style = resolveStyle(s.agg, st.v);
  s.min = lo.present ? numOf(lo.v) : kNone;
  s.max = hi.present ? numOf(hi.v) : kNone;
  return s;
}

Period statsPeriod(int64_t b) { return b < 5 * kMin ? Period::None : b < kHour ? Period::FiveMinute : b < kDay ? Period::Hour : Period::Day; }
const char* periodName(Period p) {
  static const char* const N[] = {"", "5minute", "hour", "day"};
  return N[int(p)];
}
const char* statsType(Agg a) { return a == Agg::Last ? "mean" : aggName(a); }

int64_t bucketStart(int64_t t, int64_t bucketMs, int tz) {
  int64_t off = int64_t(tz) * kMin;
  return floorDiv(t + off, bucketMs) * bucketMs - off;
}

Span chartSpan(int64_t windowMs, int64_t bucketMs, int64_t now, int tz) {
  int64_t end = bucketStart(now, bucketMs, tz) + bucketMs;
  return {end - windowMs, end};
}

void fromStatistics(const StatRow* rows, size_t nRows, int64_t windowMs, int64_t bucketMs, Agg agg, int64_t now, int tz,
                    Series& out) {
  Span sp = chartSpan(windowMs, bucketMs, now, tz);
  out.start = sp.start; out.bucketMs = bucketMs; out.n = int(std::min<int64_t>(windowMs / bucketMs, kMaxBars));
  for (int i = 0; i < out.n; ++i) {   // rows in input order per bucket, as the TS accumulates them
    double sum = 0, w = 0, v = kNone;
    int64_t at = INT64_MIN;
    bool any = false;
    for (size_t k = 0; k < nRows; ++k) {
      const StatRow& r = rows[k];
      double x = agg == Agg::Mean || agg == Agg::Last ? r.mean : agg == Agg::Min ? r.min : agg == Agg::Max ? r.max : r.change;
      if (!std::isfinite(x) || r.start < sp.start || r.start >= sp.end || (r.start - sp.start) / bucketMs != i) continue;
      if (agg == Agg::Mean) {
        int64_t d = (r.end >= 0 ? r.end : r.start) - r.start;
        double wt = d ? double(d) : 1;
        sum += x * wt; w += wt;
      } else if (agg == Agg::Last) {
        if (!any || r.start > at) { v = x; at = r.start; any = true; }
      } else {
        v = !has(v) ? x : agg == Agg::Min ? std::min(v, x) : agg == Agg::Max ? std::max(v, x) : v + x;
      }
    }
    out.v[i] = agg == Agg::Mean ? (w != 0 ? sum / w : kNone) : v;
  }
}

Point pointOf(const char* s, size_t len, double lu) {
  Point p{int64_t(std::floor(lu * 1000 + 0.5)), kNone};
  size_t i = decimal(s, len, 0);
  if (i != std::string::npos && i < len && (s[i] == 'e' || s[i] == 'E')) {   // ([eE][-+]?\d+)?
    size_t j = i + 1;
    if (j < len && (s[j] == '-' || s[j] == '+')) ++j;
    size_t d = j;
    while (j < len && isDigit(s[j])) ++j;
    i = j > d ? j : std::string::npos;
  }
  if (i == len) p.v = std::strtod(std::string(s, len).c_str(), nullptr);
  return p;
}

void sortPoints(Point* p, size_t n) { std::stable_sort(p, p + n, [](const Point& a, const Point& b) { return a.t < b.t; }); }

namespace {
double firstHeld(const Point* p, size_t n, int64_t a, int64_t e) {   // the first non-gap value held inside [a, e)
  for (size_t k = 0; k < n; ++k) {
    int64_t s1 = k + 1 < n ? p[k + 1].t : INT64_MAX;
    if (has(p[k].v) && std::max(p[k].t, a) < std::min(s1, e)) return p[k].v;
  }
  return kNone;
}
}  // namespace

void bucketize(const Point* p, size_t n, int64_t windowMs, int64_t bucketMs, Agg agg, int64_t now, int tz, Series& out) {
  Span sp = chartSpan(windowMs, bucketMs, now, tz);
  out.start = sp.start; out.bucketMs = bucketMs; out.n = int(std::min<int64_t>(windowMs / bucketMs, kMaxBars));
  double carried = kNone;   // last non-gap value held before the current bucket (change)
  for (size_t k = 0; k < n; ++k) if (p[k].t < sp.start && has(p[k].v)) carried = p[k].v;
  size_t k0 = 0;
  for (int i = 0; i < out.n; ++i) {
    int64_t a = sp.start + i * bucketMs, e = std::min(a + bucketMs, now);
    while (k0 + 1 < n && p[k0 + 1].t <= a) ++k0;   // held only before this bucket
    double sum = 0, dt = 0, lo = kNone, hi = kNone, endV = kNone, lastHeld = kNone;
    for (size_t k = k0; k < n && p[k].t < e; ++k) {
      int64_t s0 = std::max(p[k].t, a), s1 = std::min(k + 1 < n ? p[k + 1].t : now, e);
      if (s1 <= s0) continue;
      double v = p[k].v;
      endV = v;
      if (!has(v)) continue;
      sum += v * double(s1 - s0); dt += double(s1 - s0); lastHeld = v;
      lo = has(lo) ? std::min(lo, v) : v; hi = has(hi) ? std::max(hi, v) : v;
    }
    double o = kNone;
    if (e > a && dt > 0) {
      if (agg == Agg::Mean) o = sum / dt;
      else if (agg == Agg::Min) o = lo;
      else if (agg == Agg::Max) o = hi;
      else if (agg == Agg::Last) o = endV;
      else {
        double base = has(carried) ? carried : firstHeld(p, n, a, e);
        o = lastHeld - (has(base) ? base : lastHeld);
      }
    }
    out.v[i] = o;
    if (has(lastHeld)) carried = lastHeld;
  }
}

Range yScale(const double* v, int n, Style style, double min, double max) {
  bool any = false;
  double lo = 0, hi = 1;
  for (int i = 0; i < n; ++i) {
    if (!has(v[i])) continue;
    if (!any) { lo = hi = v[i]; any = true; }
    else { lo = std::min(lo, v[i]); hi = std::max(hi, v[i]); }
  }
  if (any && style == Style::Bars) { lo = std::min(0.0, lo); hi = std::max(0.0, hi); if (lo == hi) hi = 1; }
  else if (any && lo == hi) { lo -= 1; hi += 1; }
  else if (any) { double pad = (hi - lo) * 0.1; lo -= pad; hi += pad; }
  if (has(min)) lo = min;
  if (has(max)) hi = max;
  if (lo >= hi) { if (has(min)) hi = lo + 1; else lo = hi - 1; }
  return {lo, hi};
}

void pointTime(int64_t t, int64_t windowMs, int tz, Lang lang, char* out, size_t cap) {
  int64_t day, ms;
  local(t, tz, day, ms);
  int h = int(ms / kHour), m = int(ms % kHour / kMin);
  if (windowMs > 2 * kDay) {
    char d[3];
    dayAbbr(lang, wdayOf(day), d);
    std::snprintf(out, cap, "%s %02d:%02d", d, h, m);
  } else {
    std::snprintf(out, cap, "%02d:%02d", h, m);
  }
}

static bool lowHighOf(const double* v, int n, int64_t start, int64_t bucketMs, int64_t windowMs, int tz, Lang lang,
                      Extreme& low, Extreme& high) {
  int lo = -1, hi = -1;
  for (int i = 0; i < n; ++i) {
    if (!has(v[i])) continue;
    if (lo < 0 || v[i] < v[lo]) lo = i;
    if (hi < 0 || v[i] > v[hi]) hi = i;
  }
  if (lo < 0) return false;
  auto ex = [&](int i, Extreme& x) {
    x.i = i; x.v = v[i]; x.t = start + i * bucketMs;
    pointTime(x.t, windowMs, tz, lang, x.time, sizeof x.time);
  };
  ex(lo, low); ex(hi, high);
  return true;
}

bool lowHigh(const Series& s, int64_t windowMs, int tz, Lang lang, Extreme& low, Extreme& high) {
  return lowHighOf(s.v, s.n, s.start, s.bucketMs, windowMs, tz, lang, low, high);
}

bool dayLowHigh(const double* v, int n, Lang lang, Extreme& low, Extreme& high) {
  return n > 0 && lowHighOf(v, n, 0, kDay / n, kDay, 0, lang, low, high);
}

int axisTicks(int64_t w, int64_t bucketMs, int64_t now, int tz, Lang lang, Tick* out) {
  Span sp = chartSpan(w, bucketMs, now, tz);
  auto x = [&](int64_t t) { return double(t - sp.start) / double(w); };
  int n = 0;
  if (w <= 3 * kHour) {
    int64_t step = 60 * kMin;
    for (int m : {5, 10, 15, 30, 60}) if ((now - sp.start) / (m * kMin) + 1 <= 5) { step = m * kMin; break; }
    int count = int((now - sp.start) / step) + 1;
    for (int i = 0; i < count && n < kMaxTicks; ++i, ++n) {   // oldest first
      int64_t t = now - int64_t(count - 1 - i) * step;
      out[n].x = x(t);
      if (t == now) std::snprintf(out[n].text, sizeof out[n].text, "%s", tr(lang, S::now));
      else std::snprintf(out[n].text, sizeof out[n].text, "-%s", std::to_string((now - t) / kMin).c_str());
    }
    return n;
  }
  if (w <= 2 * kDay) {
    for (int h : {1, 2, 3, 6, 12, 24}) {
      int64_t st = h * kHour;
      n = 0;
      bool fits = true;
      for (int64_t t = bucketStart(sp.start, st, tz) + st; t < sp.end; t += st) {
        if (t <= sp.start) continue;
        if (n == 5) { fits = false; break; }
        int64_t day, ms;
        local(t, tz, day, ms);
        out[n].x = x(t);
        std::snprintf(out[n].text, sizeof out[n].text, "%02d", int(ms / kHour));
        ++n;
      }
      if (fits) return n;
    }
    return n;
  }
  for (int64_t t = bucketStart(sp.start, kDay, tz) + kDay; t < sp.end && n < kMaxTicks; t += kDay, ++n) {
    int64_t day, ms;
    local(t, tz, day, ms);
    out[n].x = x(t);
    dayAbbr(lang, wdayOf(day), out[n].text);
  }
  return n;
}

}  // namespace hist
}  // namespace x4
