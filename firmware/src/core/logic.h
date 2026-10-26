// Pure UI logic from the emulator (Main.dc.html): formatting, severity, grid rects, paging, region diff,
// refresh policy, night window, setpoint debounce, idle timers, swipe. No Arduino, no rendering.
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>
#include "core/config.h"
#include "hw/platform.h"

namespace x4 {

// ---------- formatting ----------
std::string pad2(int n);                         // pad(n)
std::string hhmm(int minutesOfDay);              // hhmm(t), wraps around 24 h
struct ValueUnit { std::string v, u; };
// The one number formatter (#85, spec/test-vectors/format.json): HA display_precision (dp ≥ 0) wins, else per unit
// W 0, kW 2, kWh 1, % 0, °C/°F/V/A 1, else up to 2 decimals with trailing zeros trimmed. Zero never shows "-".
std::string fmtNum(double v, const std::string& unit, int dp = -1);
std::string fmtValue(const std::string& state, const std::string& unit, int dp = -1);   // non-numbers unchanged
ValueUnit kw(double watts, int dp = -1);         // unsigned; |w| ≥ 1000 → kW (2 decimals), else W (dp, else 0)
// Number format (#110, format.json numberFormatOf/localized): fmtNum/fmtValue/kw write in it. Point/Comma (from the
// language, never grouped) or HA's profile number_format: CommaDecimal 1,250.5 · DecimalComma 1.250,5 · SpaceComma 1 250,5.
enum class NumFmt : uint8_t { Point, Comma, CommaDecimal, DecimalComma, SpaceComma };
NumFmt numFormatOf(const std::string& haNumberFormat, bool dutch);   // "" / language / system / unknown → the language
void setNumFormat(NumFmt f);                     // the app task sets it; formatting reads it
NumFmt numFormat();
std::string localNum(const std::string& fixed, NumFmt f);   // a toFixed string ("-1234.5") in a format
std::string fmtFixed(double v, int digits);      // toFixed
// A shown number (fmtNum output, current number format) with one decimal less, rounded like toFixed: "28.30" →
// "28.3" → "28". No decimals or not a number → unchanged. A value + unit that does not fit drops decimals before the
// unit is cut (#151, format.json fewerDecimals).
std::string fewerDecimals(const std::string& shown);
// A value that fits maxW with its unit (#162, format.json fitValue): over the size steps (descending) drop decimals
// while 3 significant digits stay, then while 2 stay ("1.23" steps down, "0.2534" → "0.253", never "0.3"); the first
// fit wins, else the smallest size with decimals dropped until it fits. width(value, size) includes the unit.
struct FitValue { std::string value; int size; };
FitValue fitValue(const std::string& value, const std::vector<int>& sizes, int maxW, const std::function<int(const std::string&, int)>& width);
// A label that fits maxW (#215, format.json fitMiddle): the first size (descending) where it fits whole, else the
// smallest size with the middle cut to "…" (start ceil(k/2), end floor(k/2) codepoints, largest k that fits).
FitValue fitMiddle(const std::string& text, const std::vector<int>& sizes, int maxW, const std::function<int(const std::string&, int)>& width);
// A name cut to maxW keeping its last word (#151): "Bathroom attic" → "Bath… attic", so it stays apart from
// "Bathroom"; one word, or a last word too long → "Bathro…". width: rendered width of a UTF-8 string.
std::string fitKeepTail(const std::string& s, int maxW, const std::function<int(const std::string&)>& width);

// ---------- travel severity (SPEC §6) ----------
struct SevDef { int level; const char* word; const char* car; const char* color; };
const SevDef& sevDef(int level);                 // 1..4
int sevOf(double delayMin, bool cancelled);
struct DepartureSev { double delay; bool cancelled; };
int routeLevel(const std::vector<DepartureSev>& deps);   // worst of the next two, min 1
int carLevel(double etaMin, double typicalMin);          // ratio thresholds 1.15 / 1.4 / 1.75
int carEta(double typicalMin, int level);                // round(typical × factor[level]) (emulator mock)
extern const double kCarFactor[4];

// ---------- grid ----------
constexpr int kTopBarH = 56, kTopRule = 2, kGridPad = 14, kGridGap = 12, kCellW = 184, kCellH = 191;
constexpr int kGridTop = kTopBarH + kTopRule + kGridPad;   // 72
constexpr int kZoneApp = 232, kZonePager = 176;
// CSS-grid sparse row-major auto-placement → fixed rectangles (emulator rects()). ok=false = does not fit.
struct GridRect { bool ok; Rect r; };
// Grid geometry per display style: content top (below the top bar), side and bottom padding, gap. 4 x 2 cells share
// the rest; fractional cell sizes are rounded per column/row edge (Sleek: 185.5 x 195 → widths 186/185/186/185).
struct GridMetrics { int top, side, bottom, gap; };
constexpr GridMetrics kClassicGrid{kGridTop, kGridPad, kGridPad, kGridGap};
constexpr int kSleekBarH = 64;                                  // Sleek top bar: 64 px, no rule
constexpr GridMetrics kSleekGrid{kSleekBarH + 2, 14, 14, 10};   // tokens.json styles.sleek.grid: padding 2/14/14/14, gap 10
Rect gridSpan(const GridMetrics& g, int col, int row, int cs, int rs);
std::vector<GridRect> gridRects(const Screen& s, const GridMetrics& g = kClassicGrid);

// ---------- paging ----------
constexpr int kPerCol = 5, kPerPage = 10;
struct LightCell { enum Kind : uint8_t { Spacer, Header, Light } kind = Spacer; std::string area; std::string id; bool cont = false; };
using LightPage = std::vector<LightCell>;   // 10 cells: column 0 = [0..4], column 1 = [5..9]
struct LightGroup { std::string area; std::vector<std::string> ids; };
// layoutLights(): never end a column on a header; a column that starts mid-room repeats the header (cont.)
std::vector<LightPage> layoutLights(const std::vector<LightGroup>& groups);
int zonePages(int zoneCount);
struct PagingInfo { std::function<int(const Widget&)> pages; };   // pages a widget needs (home.h listPages); empty = 1
int subPages(const Screen& s, const PagingInfo& p);
struct PageRef { int screen; int sub; };
// All pages of the app that screen `idx` belongs to, in order (emulator flat()).
std::vector<PageRef> flatPages(const Config& c, int idx, const PagingInfo& p);
int firstScreenOfApp(const Config& c, const std::string& app);
// Next/prev page within the current app (wraps). Returns the target page.
PageRef navTarget(const Config& c, int idx, int sub, int dir, const PagingInfo& p);

// ---------- regions ----------
// Each region (tile, list header, list row, top bar, …) has a rectangle and a text signature of what it shows.
struct Region { Rect rect; std::string sig; };
using RegionMap = std::map<std::string, Region>;
// Keys whose signature or rectangle changed (or that are new). Empty (and nothing removed) = no refresh.
std::vector<std::string> changedRegions(const RegionMap& before, const RegionMap& after);
std::vector<std::string> removedRegions(const RegionMap& before, const RegionMap& after);
bool sameLayout(const RegionMap& a, const RegionMap& b);   // same keys and rects
Rect unionRect(const RegionMap& m, const std::vector<std::string>& keys);

// Refresh policy (#26, #197, spec/test-vectors/refresh.json). Panel-wide kinds: Fast (whole frame, no flash, B/W only
// since #212) for navigation, every kNavClean-th navigation a Clean (one short flash); the app's other panel-wide redraws (boot, wake,
// standby, night, style, config) are Cleans too. Partials are windowed and B/W only (#38). A scheduled clean runs at the
// first :00/:30 at least `cleanEvery` minutes (30/60/120) after the last clean, only with partial / fast refreshes
// since and not while night mode is active. Clock unset: no schedule, so kCleanCap partials or fasts force a clean
// ("ghosting limit"). Times are epoch minutes.
constexpr int kCleanSlotMin = 30, kCleanCap = 30, kDefaultCleanEvery = 30, kNavClean = 10;
int64_t nextCleanMin(int64_t lastFullMin, int everyMin);
bool cleanDue(int sinceFull, int64_t lastFullMin, int64_t nowMin, int everyMin, bool night);
class RefreshPolicy {
 public:
  enum class Kind { None, Partial, Fast, Clean };
  void setCleanEvery(int min) { everyMin_ = min < kCleanSlotMin ? kCleanSlotMin : min; }
  int sinceFull() const { return sinceFull_; }
  int navSinceClean() const { return navSinceClean_; }
  Kind requestPartial(bool clockKnown);   // Partial; Clean only with the clock unset and kCleanCap partials
  Kind requestNav(bool clockKnown);       // Fast; Clean on the kNavClean-th navigation or at the clock-unset cap
  void countPartial() { ++sinceFull_; }   // tap feedback: counts toward the clean, never forces one
  // Scheduled clean due now? A clean taken without a clock (or a clock stepped back) restarts the wait from nowMin.
  bool cleanDue(int64_t nowMin, bool night);
  void onFull(int64_t nowMin) { sinceFull_ = navSinceClean_ = 0; lastFullMin_ = nowMin; }   // nowMin < 0: clock unset
 private:
  int everyMin_ = kDefaultCleanEvery, sinceFull_ = 0, navSinceClean_ = 0;
  int64_t lastFullMin_ = -1;
};

// Input coalescing (#212, emulator core/refresh.ts coalesceInput, spec/test-vectors/refresh.json "input"): App::loop
// drains every queued event in one pass, so a pass after a refresh holds all taps / keys made while the panel was busy.
// Only the last one is handled: last intent wins, at most one navigation follows a refresh. Index kept, -1 for none.
inline int coalesceInput(int n) { return n > 0 ? n - 1 : -1; }

// Power deadband (#85, spec/test-vectors/deadband.json): formatting shows every watt, but a power tile only takes a
// new value when it moved ≥ 50 W and ≥ 5 % of the shown value, or crosses the W ↔ kW boundary (|w| = 1000). Until
// then it keeps the last shown value, so the region diff sees no change. Other units: the formatted text decides.
bool powerMoved(double shownW, double nowW);
class PowerHold {
 public:
  double hold(const std::string& key, double w);   // value to show; remembers it
  void forget(const std::string& key) { shown_.erase(key); }
 private:
  std::map<std::string, double> shown_;
};

// ---------- night / idle / swipe ----------
bool isNightHour(int hour, const std::string& window);   // "23-07", "off"
int nightEndHour(const std::string& window);              // -1 for off
constexpr uint32_t kPeekMs = 60000;
int idleMinutes(const std::string& setting);              // "5" → 5, "never"/"0"/"" → 0
struct IdleDecision { bool standby = false; bool goHome = false; };
IdleDecision idleCheck(uint32_t idleMs, int standbyMin, int returnHomeMin, bool alreadyHomed, bool awayFromHome);
// Ambient idle mode + night face poster (issue #27, emulator core/ambient.ts, spec/test-vectors/ambient.json).
constexpr uint32_t kAmbientMs = 60000;
constexpr int kBattLow = 20;              // below: battery stays in ambient, top bar adds "NN%"
constexpr int64_t kStaleSec = 30 * 60;    // night face "as of HH:MM" only when data is older
bool ambientDue(uint32_t idleMs, bool menuOpen, bool setup);
struct Chrome { bool app = true, pager = true, battery = true, clock = true; };
Chrome chromeFor(bool ambient, int batteryPct, bool clockTile);
bool nightStale(int64_t nowSec, int64_t lastDataSec);   // 0 = unknown → false
// Front light timeout (#220, emulator core/frontlight.ts, spec/test-vectors/frontlight.json). Seconds, 0 = never.
constexpr int kLightTimeouts[] = {30, 60, 120, 300, 0};
constexpr int kDefaultLightTimeout = 60;
bool validLightTimeout(int sec);
bool lightTimedOut(uint32_t idleMs, int timeoutSec);
int frontlightPct(int brightness, bool standby, bool night, bool lightOut);
// The first key/tap (not Power) after the timeout only turns the light back on.
bool lightWakeConsumes(int brightness, bool standby, bool night, bool lightOut, bool power);
// Swipe: |dx| > 60, mostly horizontal (|dx| > 1.5 |dy|), < 800 ms. Returns nav dir (+1 next / -1 prev) or 0.
int swipeNav(int dx, int dy, uint32_t dtMs);

// ---------- debounce (climate setpoints) ----------
constexpr uint32_t kSetpointDebounceMs = 1500;
class Debouncer {
 public:
  explicit Debouncer(uint32_t ms = kSetpointDebounceMs) : ms_(ms) {}
  void touch(const std::string& key, uint32_t now) { due_[key] = now + ms_; }
  std::vector<std::string> fire(uint32_t now);   // keys whose quiet period ended (removed)
  bool pending(const std::string& key) const { return due_.count(key) != 0; }
  bool empty() const { return due_.empty(); }
 private:
  uint32_t ms_;
  std::map<std::string, uint32_t> due_;
};

}  // namespace x4
