// History tile (#264, #268): config rules, time-weighted bucketing from HA statistics or history rows, y scale,
// low / high and axis ticks. Port of emulator src/core/history.ts, checked against spec/test-vectors/history.json.
// Pure and heap-free: inputs are plain arrays, a Series is a fixed POD (~0.8 KB) the caller places in PSRAM (SeriesList).
// Times are epoch ms; tz = local UTC offset in minutes at `now`. No data = NaN.
#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "core/psram_alloc.h"
#include "core/strings.h"

namespace x4 {
struct Widget;

namespace hist {

constexpr int kMaxTiles = 6, kMinBars = 2, kMaxBars = 96, kBarsPerCol = 12;
constexpr int64_t kMin = 60000, kHour = 60 * kMin, kDay = 24 * kHour;
constexpr int64_t kWindowMin = 10 * kMin, kWindowMax = 7 * kDay, kFallbackMax = kDay;
constexpr const char* kWindowDefault = "24h";
inline const double kNone = NAN;
inline bool has(double v) { return !std::isnan(v); }

enum class Agg : uint8_t { Mean, Max, Min, Last, Change };
enum class Style : uint8_t { Bars, Line, Area, Step, Dots };   // area / step / dots: #304
enum class Period : uint8_t { None, FiveMinute, Hour, Day };   // statistics_during_period `period`; None = history rows only

int64_t parseSpan(const std::string& v);              // "30m" / "6h" / "7d" → ms; anything else → -1
// -1 = the window needs an explicit bucket. minMs: the data's own step (a forecast's hour or day, #283).
int64_t defaultBucket(int64_t windowMs, int cs = 1, int64_t minMs = 0);
bool aggOf(const std::string& v, Agg& out);
const char* aggName(Agg a);
Style resolveStyle(Agg a, const std::string& style);  // a style as written, else (auto) line for mean, bars otherwise
const char* styleName(Style s);                        // "bars" | "line" | "area" | "step" | "dots"

// Where the series comes from (#283, #292): the recorder, a list in an attribute of the entity, or a weather entity's
// weather.get_forecasts answer. Implied by the keys: `attribute` wins, then a weather.* entity.
enum class Kind : uint8_t { Recorder, Attribute, Forecast };
Kind sourceOf(bool hasAttribute, const std::string& entity);
const char* kindName(Kind k);                                      // "recorder" | "attribute" | "forecast"
const std::vector<const char*>& historyDomains(Kind k);           // entity domains a history widget accepts

// A widget key as the config parser holds it (present = written; v = its text, numbers normalised).
struct Field { bool present = false; std::string v; };
struct Fields {
  std::string entity;
  int cs = 1;
  Field window, bucket, agg, style, min, max, attribute, value, time, ahead, forecast, threshold, labels;
};
// The tile's own rules (entity is checked by the shared domain rule first). "" = valid; else the emulator's message.
std::string configError(const Fields& f);

struct Spec {
  std::string entity;
  int64_t windowMs = 0, bucketMs = 0;
  int n = 0;
  Agg agg = Agg::Mean;
  Style style = Style::Line;
  double min = kNone, max = kNone;
  double threshold = kNone;   // #304: dashed reference line (NaN = none)
  bool labels = false;        // #304: min / max / last values on the chart
  // attribute / forecast series (#292): the part of the window after now (0 = the recorder span), entry fields
  Kind kind = Kind::Recorder;
  int64_t aheadMs = 0;
  std::string attribute, value, time;
  bool daily = false;   // forecast type daily (else hourly)
};
Spec specOf(const Widget& w);   // a validated history widget with every default filled in
// Unit and decimals of an attribute / forecast value (emulator Emulator.tsx srcUnit): mm/h for rain, °C for a
// temperature, else none.
const char* sourceUnit(const Spec& s);

Period statsPeriod(int64_t bucketMs);
const char* periodName(Period p);          // "5minute" | "hour" | "day" | ""
const char* statsType(Agg a);              // "mean" | "min" | "max" | "change" (last reads the mean)
inline bool fallbackOk(const Spec& s) { return s.windowMs <= kFallbackMax; }

int64_t bucketStart(int64_t t, int64_t bucketMs, int tz);
struct Span { int64_t start, end; };
// n buckets: without aheadMs the last one holds `now`; with it the bucket holding now starts the last aheadMs (#292)
Span chartSpan(int64_t windowMs, int64_t bucketMs, int64_t now, int tz, int64_t aheadMs = 0);

struct Series {
  int64_t start = 0, bucketMs = 0;
  int n = 0;
  double v[kMaxBars];
};
// Bucket store of every history tile, in PSRAM (≤ kMaxTiles × sizeof(Series)).
using SeriesList = std::vector<Series, PsramAlloc<Series>>;

// A statistics row (start / end ms; end < 0 = absent); NaN = the field is missing or null.
struct StatRow { int64_t start, end; double mean, min, max, change; };
// mean: weighted by row length; min / max: of the rows; change: sum; last: the mean of the latest row.
void fromStatistics(const StatRow* rows, size_t nRows, int64_t windowMs, int64_t bucketMs, Agg agg, int64_t now, int tz,
                    Series& out, int64_t aheadMs = 0);

// ---- attribute / forecast series (#292) ----
constexpr int64_t kNoTime = INT64_MIN;
// An entry's time → epoch ms: ISO 8601 ("…T14:05:00+01:00", "…Z", "2026-10-26 14:05", "2026-10-26"; no offset = local)
int64_t parseTime(const char* s, size_t n, int tz);
int64_t parseTimeNum(double v);   // epoch seconds below 1e11, else ms; kNoTime when not > 0
// A value at a time (not held until the next one).
struct Sample { int64_t t; double v; };
// A sample belongs to the bucket its time falls in. mean: average; min / max; last: the latest; change: the sum.
void fromSamples(const Sample* s, size_t n, const Spec& spec, int64_t now, int tz, Series& out);

// A state change: value from t on; NaN = unavailable / unknown / not a number.
struct Point { int64_t t; double v; };
Point pointOf(const char* s, size_t len, double luSeconds);   // a minimal_response {s, lu} row
void sortPoints(Point* p, size_t n);                           // stable, by t
// Time-weighted step function over sorted points, as HA computes statistics (see history.ts bucketize).
void bucketize(const Point* p, size_t n, int64_t windowMs, int64_t bucketMs, Agg agg, int64_t now, int tz, Series& out);

struct Range { double lo, hi; };
// threshold (#304) counts as data when there is data.
Range yScale(const double* v, int n, Style style, double min = kNone, double max = kNone, double threshold = kNone);

struct Extreme { int i = -1; double v = 0; int64_t t = 0; char time[16] = {}; };
// Lowest and highest bucket (earliest on a tie), with the bucket's start time; false when there is no data.
bool lowHigh(const Series& s, int64_t windowMs, int tz, Lang lang, Extreme& low, Extreme& high);
// The same over one day in n equal buckets from local midnight (the price chart, #260): times "03:00" / "03:15".
bool dayLowHigh(const double* v, int n, Lang lang, Extreme& low, Extreme& high);
void pointTime(int64_t t, int64_t windowMs, int tz, Lang lang, char* out, size_t cap);   // "14:00" / "Tu 14:00"

struct Tick { double x; char text[8]; };
constexpr int kMaxTicks = 8;
// X axis labels, x = 0…1 across the chart span; returns the count (≤ kMaxTicks). aheadMs: "Now +30 +60" (#292).
int axisTicks(int64_t windowMs, int64_t bucketMs, int64_t now, int tz, Lang lang, Tick* out, int64_t aheadMs = 0);

}  // namespace hist
}  // namespace x4
