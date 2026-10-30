// History tile chart (#270): port of emulator src/core/historyChart.ts, checked against history.json "chart". What the
// panel draws from a Series, in fractions of the plot area (0 = bottom, 1 = top) so Classic (ui_tiles) and Modern
// (ui_sleek) share one geometry. Pure; no heap except chartKey's string.
#pragma once
#include <algorithm>
#include <string>
#include "core/history.h"

namespace x4 {
namespace hist {

// Ok: draw the series; Loading: frame only (no fetch answered yet); None: no data in the window; TooMany: the history
// answer was over the frame cap; NeedsStats: no statistics and the window is over the 24 h fallback.
enum class State : uint8_t { Ok, Loading, None, TooMany, NeedsStats };
const char* stateName(State s);            // "ok" | "loading" | "none" | "tooMany" | "needsStats"
const char* stateText(State s, Lang l);    // the plot's centred text; "" for Ok / Loading
// #307: a tile with past has two fetches: data from either = Ok; else Loading while either loads; else the forecast's
// verdict, or the recorder's when the forecast has none (emulator joinState).
State joinState(State past, State ahead);

// A value printed on the plot (#304, labels: true): beside bucket i's point, on the side with more room.
enum class LabelKind : uint8_t { Max, Min, Last };
struct Label { LabelKind kind; int i; bool right; };

// Dot diameter of the dots style (#304, emulator dotPx): fits the bucket pitch of a 4-wide tile, 4–8 px.
inline int dotPx(int n) { return n <= 0 ? 8 : std::max(4, std::min(8, 440 / n - 2)); }

struct Chart {
  Style style = Style::Line;
  int n = 0;
  State state = State::Loading;
  const double* v = nullptr;   // the series values (n) when state is Ok, else nullptr (every bucket a gap)
  Range r{0, 1};
  double zero = kNone;         // zero line height, NaN when 0 is outside the range
  int latest = -1;             // the latest bucket with data (bar marked solid / the line's dot)
  int nTicks = 0;
  Tick ticks[kMaxTicks];       // x rounded to 4 decimals
  bool lowHigh = false;
  Extreme low, high;
  double threshold = kNone;    // #304: dashed line height, NaN when unset / outside the range / not Ok
  int nLabels = 0;
  Label labels[3];             // #304: max, then min, then last (each only when it has its own spot)
  // #307 (past): buckets from `split` on are the forecast, drawn lighter (outline bars, dashed line, hollow dots); a
  // dotted Now marker at splitX(). -1 = no past part. A forecast line / step starts at the last past point (joined()).
  int split = -1;
  bool gap(int i) const { return !v || !has(v[i]); }
  bool ahead(int i) const { return split >= 0 && i >= split; }
  bool joined() const { return split > 0 && split < n && !gap(split - 1) && !gap(split); }
  double splitX() const { return edge(split); }
  double y(double val) const;                          // value → height, clamped to 0…1, 4 decimals
  double barB(int i) const { return y(v[i] < 0 ? v[i] : 0); }
  double barT(int i) const { return y(v[i] > 0 ? v[i] : 0); }
  double x(int i) const;                               // bucket centre, 4 decimals
  double edge(int i) const;                            // left edge of bucket i (step, #304), 4 decimals
  bool lineish() const { return style == Style::Line || style == Style::Area || style == Style::Step; }
};

// A series that does not match the spec (another bucket or length: config changed) counts as none yet (Loading).
void chart(const Spec& spec, const Series* s, State st, int64_t now, int tz, Lang lang, Chart& out);

// What a redraw compares (emulator chartKey): bar / point heights at px steps, the state, the axis and the low / high
// buckets with their values at dp decimals. Core values, never the formatted text.
std::string chartKey(const Chart& c, int dp = 1, int px = 200);

// The store key of a tile's series: same entity, window, bucket and agg (and source, #292) = same data.
std::string seriesKey(const Spec& s);

// Local UTC offset in minutes from the broken-down local and UTC times of one instant (no tm_gmtoff on newlib).
int tzMinutes(int lYday, int lYear, int lMinOfDay, int uYday, int uYear, int uMinOfDay);

}  // namespace hist
}  // namespace x4
