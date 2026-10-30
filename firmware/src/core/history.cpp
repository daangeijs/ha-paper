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

int64_t defaultBucket(int64_t win, int cs, int64_t minMs) {
  int64_t last = -1;
  for (auto* s : kLadder) {
    int64_t b = parseSpan(s);
    if (b < minMs || win % b != 0 || win / b < kMinBars || win / b > kMaxBars) continue;
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

namespace {
const char* const kStyles[] = {"bars", "line", "area", "step", "dots"};
}
Style resolveStyle(Agg a, const std::string& style) {
  for (int i = 0; i < 5; ++i) if (style == kStyles[i]) return Style(i);
  return a == Agg::Mean ? Style::Line : Style::Bars;
}
const char* styleName(Style s) { return kStyles[int(s)]; }

Kind sourceOf(bool hasAttribute, const std::string& entity) {
  return hasAttribute ? Kind::Attribute : entity.compare(0, 8, "weather.") == 0 ? Kind::Forecast : Kind::Recorder;
}
const char* kindName(Kind k) {
  static const char* const N[] = {"recorder", "attribute", "forecast"};
  return N[int(k)];
}
const std::vector<const char*>& historyDomains(Kind k) {
  static const std::vector<const char*> rec = {"sensor", "input_number", "number"}, attr = {"sensor", "binary_sensor", "weather"},
                                        fc = {"weather"};
  return k == Kind::Recorder ? rec : k == Kind::Attribute ? attr : fc;
}

namespace {
bool fieldName(const std::string& v) {   // /^[A-Za-z_][A-Za-z0-9_]*$/
  if (v.empty() || isDigit(v[0])) return false;
  for (char c : v) if (!(isDigit(c) || c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
  return true;
}
int64_t aheadOf(const std::string& v) { return v == "0" ? 0 : parseSpan(v); }   // -1 = not a valid value
int64_t forecastStep(Kind k, const Field& fc) { return k != Kind::Forecast ? 0 : fc.present && fc.v == "daily" ? kDay : kHour; }
}  // namespace

std::string configError(const Fields& f) {
  std::string winText = f.window.present ? f.window.v : kWindowDefault;
  int64_t win = parseSpan(winText);
  if (win < 0 || win < kWindowMin || win > kWindowMax) return "history: window must be like 30m, 6h or 7d (10m–7d)";
  const Kind src = sourceOf(f.attribute.present, f.entity);
  if (src == Kind::Recorder) {
    const std::pair<const char*, const Field*> keys[] = {{"attribute", &f.attribute}, {"value", &f.value}, {"time", &f.time},
                                                         {"ahead", &f.ahead}, {"forecast", &f.forecast}, {"past", &f.past}};
    for (auto& k : keys) if (k.second->present) return std::string("history: ") + k.first + " needs an attribute or a weather entity";
  }
  const std::pair<const char*, const Field*> names[] = {{"attribute", &f.attribute}, {"value", &f.value}, {"time", &f.time}};
  for (auto& k : names)
    if (k.second->present && !fieldName(k.second->v)) return std::string("history: ") + k.first + " must be an attribute name (letters, digits, _)";
  if (f.forecast.present && (src != Kind::Forecast || (f.forecast.v != "hourly" && f.forecast.v != "daily")))
    return "history: forecast must be hourly or daily, on a weather entity without attribute";
  const int64_t step = forecastStep(src, f.forecast);
  if (f.bucket.present && step && std::max<int64_t>(parseSpan(f.bucket.v), 0) < step)
    return std::string("history: ") + (step == kDay ? "a daily forecast needs a bucket of 1d" : "an hourly forecast needs a bucket of 1h") + " or more";
  int64_t b = -1;
  if (f.bucket.present) {
    for (auto* s : kLadder) if (f.bucket.v == s) b = parseSpan(s);
    if (b <= 0) {
      std::string all;
      for (auto* s : kLadder) all += (all.empty() ? "" : " ") + std::string(s);
      return "history: bucket must be one of " + all;
    }
    if (win % b != 0) return "history: bucket " + f.bucket.v + " does not divide window " + winText;
    int64_t n = win / b;
    if (n < kMinBars || n > kMaxBars)
      return "history: " + winText + " / " + f.bucket.v + " = " + std::to_string(n) + (n == 1 ? " bar (" : " bars (") +
             std::to_string(kMinBars) + "–" + std::to_string(kMaxBars) + ")";
  } else if ((b = defaultBucket(win, f.cs, step)) < 0) {
    return "history: no bucket fits window " + winText + "; set bucket";
  }
  if (f.ahead.present) {
    const int64_t a = aheadOf(f.ahead.v);
    if (a < 0 || a > win) return "history: ahead must be 0 or like 30m or 2h, at most the window";
    if (a % b != 0)
      return "history: bucket " + (f.bucket.present ? f.bucket.v : std::to_string(b / kMin) + "m") + " does not divide ahead " + f.ahead.v;
  }
  if (f.past.present) {   // #307
    const size_t dot = f.past.v.find('.');
    bool ok = dot != std::string::npos && dot + 1 < f.past.v.size();
    if (ok) {
      const std::string dom = f.past.v.substr(0, dot);
      ok = dom == "sensor" || dom == "input_number" || dom == "number";
      for (size_t i = dot + 1; ok && i < f.past.v.size(); ++i) {
        const char c = f.past.v[i];
        ok = (c >= 'a' && c <= 'z') || isDigit(c) || c == '_';
      }
    }
    if (!ok) return "history: past “" + f.past.v + "” is not a sensor / input_number / number entity";
    const int64_t a = f.ahead.present ? aheadOf(f.ahead.v) : win;
    if (a == 0 || a >= win) return "history: past needs ahead shorter than the window";
  }
  Agg a;
  if (f.agg.present && !aggOf(f.agg.v, a)) return "history: agg must be mean, max, min, last, change";
  bool styleOk = f.style.v == "auto";
  for (const char* k : kStyles) styleOk = styleOk || f.style.v == k;
  if (f.style.present && !styleOk)
    return "history: style must be bars, line, area, step, dots or auto";
  double lo = f.min.present ? numOf(f.min.v) : 0, hi = f.max.present ? numOf(f.max.v) : 0;
  if ((f.min.present && !has(lo)) || (f.max.present && !has(hi))) return "history: min and max must be numbers";
  if (f.min.present && f.max.present && lo >= hi) return "history: min must be below max";
  if (f.threshold.present && !has(numOf(f.threshold.v))) return "history: threshold must be a number";
  if (f.labels.present && f.labels.v != "true" && f.labels.v != "false") return "history: labels must be true or false";
  return "";
}

Spec specOf(const Widget& w) {
  auto f = [&](const char* k) { auto it = w.fields.find(k); return it == w.fields.end() ? Field{} : Field{true, it->second}; };
  Spec s;
  s.entity = w.field("entity");
  Field win = f("window"), b = f("bucket"), ag = f("agg"), st = f("style"), lo = f("min"), hi = f("max"), at = f("attribute"),
        fc = f("forecast"), ah = f("ahead"), va = f("value"), ti = f("time"), th = f("threshold");
  s.kind = sourceOf(at.present, s.entity);
  s.daily = s.kind == Kind::Forecast && fc.present && fc.v == "daily";
  s.windowMs = parseSpan(win.present ? win.v : kWindowDefault);
  s.bucketMs = b.present ? parseSpan(b.v) : defaultBucket(s.windowMs, w.cs ? w.cs : 1, forecastStep(s.kind, fc));
  s.n = s.bucketMs > 0 ? int(s.windowMs / s.bucketMs) : 0;
  if (!ag.present || !aggOf(ag.v, s.agg)) s.agg = Agg::Mean;
  s.style = resolveStyle(s.agg, st.v);
  s.min = lo.present ? numOf(lo.v) : kNone;
  s.max = hi.present ? numOf(hi.v) : kNone;
  s.threshold = th.present ? numOf(th.v) : kNone;
  s.labels = f("labels").v == "true";
  if (s.kind == Kind::Recorder) return s;
  // an attribute or forecast series looks ahead by default (a nowcast, a forecast): the whole window from now
  s.aheadMs = ah.present ? std::max<int64_t>(aheadOf(ah.v), 0) : s.windowMs;
  s.attribute = s.kind == Kind::Forecast ? "forecast" : at.v;
  s.value = va.present ? va.v : s.kind == Kind::Forecast ? "temperature" : "value";
  s.time = ti.present ? ti.v : "datetime";
  s.past = f("past").v;
  return s;
}

void joinSeries(const Spec& s, const Series* past, const Series* ahead, int64_t now, int tz, Series& out) {
  const int split = pastBuckets(s);
  out.start = chartSpan(s.windowMs, s.bucketMs, now, tz, s.aheadMs).start;
  out.bucketMs = s.bucketMs;
  out.n = std::min(s.n, kMaxBars);
  for (int i = 0; i < out.n; ++i) {
    const Series* x = i < split ? past : ahead;
    const int64_t t = out.start + int64_t(i) * s.bucketMs;
    double v = kNone;
    if (x && x->n > 0 && x->bucketMs > 0 && (t - x->start) % x->bucketMs == 0) {
      const int64_t k = (t - x->start) / x->bucketMs;
      if (k >= 0 && k < x->n) v = x->v[k];
    }
    out.v[i] = v;
  }
}

Spec pastSpec(const Spec& s) {
  Spec p;
  p.entity = s.past;
  p.windowMs = s.windowMs - s.aheadMs + s.bucketMs;
  p.bucketMs = s.bucketMs;
  p.n = s.bucketMs > 0 ? int(p.windowMs / s.bucketMs) : 0;
  p.agg = s.agg;
  p.style = s.style;
  p.min = s.min;
  p.max = s.max;
  return p;
}

const char* sourceUnit(const Spec& s) {
  if (s.kind == Kind::Recorder) return "";
  std::string v;
  for (char c : s.value) v += char(c >= 'A' && c <= 'Z' ? c + 32 : c);
  return v.find("precip") != std::string::npos || v.find("rain") != std::string::npos ? "mm/h"
         : v.find("temp") != std::string::npos ? "°C" : "";
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

Span chartSpan(int64_t windowMs, int64_t bucketMs, int64_t now, int tz, int64_t aheadMs) {
  const int64_t b = bucketStart(now, bucketMs, tz), start = aheadMs ? b - (windowMs - aheadMs) : b + bucketMs - windowMs;
  return {start, start + windowMs};
}

void fromStatistics(const StatRow* rows, size_t nRows, int64_t windowMs, int64_t bucketMs, Agg agg, int64_t now, int tz,
                    Series& out, int64_t aheadMs) {
  Span sp = chartSpan(windowMs, bucketMs, now, tz, aheadMs);
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

int64_t parseTimeNum(double v) {
  if (!std::isfinite(v) || v <= 0) return kNoTime;
  return int64_t(std::floor((v < 1e11 ? v * 1000 : v) + 0.5));
}

namespace {
int64_t daysFromCivil(int64_t y, int m, int d) {   // H. Hinnant; d may run past the month (Date.UTC rolls over)
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400, yoe = y - era * 400;
  const int64_t doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5, doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468 + d - 1;
}
}  // namespace

// /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/ after trim
int64_t parseTime(const char* s, size_t n, int tz) {
  auto ws = [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; };
  while (n && ws(*s)) ++s, --n;
  while (n && ws(s[n - 1])) --n;
  size_t i = 0;
  auto num = [&](int digits, int& out) {
    if (i + digits > n) return false;
    out = 0;
    for (int k = 0; k < digits; ++k, ++i) { if (!isDigit(s[i])) return false; out = out * 10 + (s[i] - '0'); }
    return true;
  };
  int y, mo, d, h = 0, mi = 0, se = 0;
  if (!num(4, y) || i >= n || s[i++] != '-' || !num(2, mo) || i >= n || s[i++] != '-' || !num(2, d)) return kNoTime;
  if (i < n && (s[i] == 'T' || s[i] == ' ')) {
    ++i;
    if (!num(2, h) || i >= n || s[i++] != ':' || !num(2, mi)) return kNoTime;
    if (i < n && s[i] == ':') {
      ++i;
      if (!num(2, se)) return kNoTime;
      if (i < n && s[i] == '.') {
        size_t f = ++i;
        while (i < n && isDigit(s[i])) ++i;
        if (i == f) return kNoTime;
      }
    }
  }
  int off = tz;
  if (i < n && s[i] == 'Z') { off = 0; ++i; }
  else if (i < n && (s[i] == '+' || s[i] == '-')) {
    const int sign = s[i++] == '-' ? -1 : 1;
    int oh, om;
    if (!num(2, oh)) return kNoTime;
    if (i < n && s[i] == ':') ++i;
    if (!num(2, om)) return kNoTime;
    off = sign * (oh * 60 + om);
  }
  if (i != n) return kNoTime;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return kNoTime;
  if (y <= 99) y += 1900;   // Date.UTC maps years 0–99 to 1900–1999
  return ((daysFromCivil(y, mo, d) * 24 + h) * 60 + mi - off) * kMin + int64_t(se) * 1000;
}

void fromSamples(const Sample* p, size_t n, const Spec& spec, int64_t now, int tz, Series& out) {
  // fromStatistics with one-instant rows (weight 1), without a row array; samples in time order per bucket
  Span sp = chartSpan(spec.windowMs, spec.bucketMs, now, tz, spec.aheadMs);
  const int64_t bk = spec.bucketMs;
  out.start = sp.start; out.bucketMs = bk; out.n = int(std::min<int64_t>(spec.windowMs / bk, kMaxBars));
  for (int i = 0; i < out.n; ++i) {
    const int64_t a = sp.start + i * bk, e = a + bk;
    double sum = 0, w = 0, v = kNone;
    int64_t at = INT64_MIN;
    for (size_t k = 0; k < n; ++k) {
      const Sample& r = p[k];
      if (r.t < a || r.t >= e || r.t >= sp.end || !std::isfinite(r.v)) continue;
      if (spec.agg == Agg::Mean) { sum += r.v; w += 1; }
      else if (spec.agg == Agg::Last) { if (r.t > at) { v = r.v; at = r.t; } }
      else v = !has(v) ? r.v : spec.agg == Agg::Min ? std::min(v, r.v) : spec.agg == Agg::Max ? std::max(v, r.v) : v + r.v;
    }
    out.v[i] = spec.agg == Agg::Mean ? (w != 0 ? sum / w : kNone) : v;
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

Range yScale(const double* v, int n, Style style, double min, double max, double threshold) {
  bool any = false;
  double lo = 0, hi = 1;
  for (int i = 0; i < n; ++i) {
    if (!has(v[i])) continue;
    if (!any) { lo = hi = v[i]; any = true; }
    else { lo = std::min(lo, v[i]); hi = std::max(hi, v[i]); }
  }
  if (any && has(threshold)) { lo = std::min(lo, threshold); hi = std::max(hi, threshold); }
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

int axisTicks(int64_t w, int64_t bucketMs, int64_t now, int tz, Lang lang, Tick* out, int64_t aheadMs) {
  Span sp = chartSpan(w, bucketMs, now, tz, aheadMs);
  auto x = [&](int64_t t) { return double(t - sp.start) / double(w); };
  int n = 0;
  if (w <= 3 * kHour) {
    auto after = [&](int64_t st) { return aheadMs ? (sp.end - now) / st : int64_t(0); };
    int64_t step = 60 * kMin;
    for (int m : {5, 10, 15, 30, 60})
      if ((now - sp.start) / (m * kMin) + 1 + after(m * kMin) <= 5) { step = m * kMin; break; }
    int count = int((now - sp.start) / step) + 1;
    for (int i = 0; i < count && n < kMaxTicks; ++i, ++n) {   // oldest first
      int64_t t = now - int64_t(count - 1 - i) * step;
      out[n].x = x(t);
      if (t == now) std::snprintf(out[n].text, sizeof out[n].text, "%s", tr(lang, S::now));
      else std::snprintf(out[n].text, sizeof out[n].text, "-%s", std::to_string((now - t) / kMin).c_str());
    }
    for (int64_t k = 1; k <= after(step) && n < kMaxTicks; ++k, ++n) {   // #292: after now
      out[n].x = x(now + k * step);
      std::snprintf(out[n].text, sizeof out[n].text, "+%s", std::to_string(k * step / kMin).c_str());
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
