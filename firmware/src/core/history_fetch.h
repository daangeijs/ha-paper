// History tile fetch (#269, plan in #264): what the device asks HA for, and how the answers become a Series without a
// DOM and without holding the frame. Pure; the net task drives it (net/ha_client.cpp).
//   statistics first: one recorder/statistics_during_period per period for every due tile, then a history tail
//   [last compiled row, now) per tile; no statistics → history/history_during_period in 6 h slices (≤ 24 h window).
//   Answers stream through Scanner into Accum (exact port of bucketize, incremental) / StatRows; one request in flight.
//   Live: every state change of a tile's entity is appended to its open bucket; a bucket boundary shifts the span.
// Attribute / forecast tiles (#292): an attribute list is parsed from the entity mirror whenever the entity changes
//   (feedAttr) and again at each bucket boundary; a weather forecast is asked with call_service weather.get_forecasts
//   (return_response) and its answer streams through ListScanner. Both keep their samples (≤ kMaxSamples) per tile.
// All per-tile state (buckets, rows, samples) lives in PSRAM (PsramAlloc); the object itself is ~1.5 KB, in PSRAM.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>
#include "core/history.h"
#include "core/history_series.h"
#include "core/psram_alloc.h"

namespace x4 {
namespace hist {

constexpr int64_t kSliceMs = 6 * kHour;           // history fallback request span
constexpr int64_t kRefetchMs = 10 * kMin;         // at most this often per tile (or once per bucket, if longer)
constexpr int64_t kLiveGapMs = 30000;             // live appends publish at most this often per tile
constexpr int64_t kTimeoutMs = 60000;             // an unanswered request is given up
constexpr int64_t kForecastMs = kHour;            // a weather forecast is asked again (providers update about hourly)

// What a tile shows (= history_chart State, #270): Loading until the first answer.
enum class FetchState : uint8_t { Ok, Loading, None, TooMany, NeedsStats };
enum class Source : uint8_t { None, Statistics, History, Attribute, Forecast };
const char* fetchStateName(FetchState s);
const char* sourceName(Source s);

// "2026-10-26T13:00:00Z"
std::string isoUtc(int64_t ms);

// ---- streaming scanner for `{"id":N,"type":"result","success":…,"result":{"<id>":[{row},…],…}}` ----
struct RowSink {
  virtual ~RowSink() = default;
  virtual void row(const char* id) = 0;                                         // a row object of result[id] opens
  virtual void field(const char* key, const char* v, size_t n, bool str) = 0;   // a scalar of the row (null: "null")
  virtual void rowEnd() = 0;
};
class Scanner {
 public:
  void begin(RowSink* sink);
  void feed(const char* p, size_t n);   // any chunking
  bool success() const { return success_; }
  bool broken() const { return broken_; }
 private:
  void open(bool obj);
  void close(bool obj);
  void value(bool str);
  void put(char c);
  RowSink* sink_ = nullptr;
  uint64_t objBits_ = 0, keyBits_ = 0;   // per depth: object (vs array), a key comes next
  int depth_ = 0;
  enum Mode : uint8_t { Ws, Str, Esc, Uni, Lit } mode_ = Ws;
  uint8_t uni_ = 0;
  bool isKey_ = false, success_ = false, broken_ = false, inRow_ = false;
  static constexpr size_t kTok = 72, kId = 96;
  char tok_[kTok + 1] = {};
  size_t tokN_ = 0;
  char key1_[16] = {}, key4_[16] = {}, id_[kId] = {};
};

// ---- incremental time-weighted bucketing: same results as bucketize() over the same sorted points ----
struct Bucket { double sum, dt, lo, hi, endV, lastHeld, firstHeld; };
class Accum {
 public:
  // from: no contribution before this time (a statistics tail starts at the last compiled row)
  void begin(int64_t start, int64_t bucketMs, int n, Agg agg, int64_t from);
  void add(Point p);                  // in time order; a point past the span end shifts the span first
  bool shiftFor(int64_t t);           // shift until t is inside the span; true if it moved
  int64_t start() const { return start_; }
  int64_t end() const { return start_ + int64_t(n_) * bucketMs_; }
  int n() const { return n_; }
  bool any() const { return pending_; }
  // stats (optional): the statistics series of the same span, its rows covering [start, covered).
  void output(int64_t now, Series& out, const Series* stats = nullptr, int64_t covered = INT64_MIN) const;
 private:
  void commit(const Point& p, int64_t u);
  void shiftOne();
  int64_t start_ = 0, bucketMs_ = 1, from_ = 0;
  int n_ = 0;
  Agg agg_ = Agg::Mean;
  double carried_ = kNone;
  bool pending_ = false;
  Point last_{0, kNone}, lastNonGap_{0, kNone};
  std::vector<Bucket, PsramAlloc<Bucket>> b_;
};

// ---- per-tile fetch state + request planning ----
struct TileInfo {   // diagnostics (log, /__qemu/state)
  std::string key;
  bool active;
  FetchState state;
  Source source;
  int64_t fetchedAt;
  uint32_t bytes, points;
};

class Fetcher : private RowSink {
 public:
  struct Want { Spec spec; std::string key; bool active; };   // key = hist::seriesKey(spec)
  // The config's history tiles; active = on the current app's screens (only those are fetched). configChanged: forget
  // TooMany verdicts (no retry until the config changes).
  void setTiles(const std::vector<Want>& want, bool configChanged);
  void reset();                                  // new socket: refetch everything, nothing in flight
  // The next request to send (JSON with `id`), if one is due and none is in flight.
  bool next(int64_t now, int tz, uint32_t id, std::string& json);
  bool inFlight() const { return reqId_ != 0; }
  uint32_t requestId() const { return reqId_; }
  // An answer to stream through begin/feed/end: the request in flight, or one whose tile left (scanned, ignored).
  bool owns(uint32_t id) const { return id && (id == reqId_ || id == orphanId_); }
  bool timedOut(int64_t now) const { return reqId_ && now - reqAt_ >= kTimeoutMs; }
  // The answer to requestId(): begin, feed chunks, end. dropped = over the frame cap (never parsed).
  void begin(uint32_t id);
  void feed(const char* p, size_t n);
  void end(int64_t now, uint32_t bytes);
  void dropped(uint32_t id, int64_t now, uint32_t bytes);
  void abandon();                                // no answer (timeout / socket closed)
  // A state change of `entity` at t (HA last_updated); v NaN = unavailable / not a number. Recorder tiles only.
  void live(const std::string& entity, double v, int64_t t);
  bool watches(const std::string& entity) const;
  // Attribute tiles (#292): wantsAttr = a tile reads an attribute of `entity`; feedAttr: its text in the mirror
  // (known = the entity is in the mirror; text nullptr = the attribute is absent). Unchanged text is skipped unless the
  // tile waits for a re-parse (new, or a bucket boundary). pendingAttr: entities whose tiles wait.
  // get(attribute) → the mirror's text (a PStr*), nullptr when the entity has no such attribute. Call only for an entity
  // the mirror knows (else the tile stays Loading).
  bool wantsAttr(const std::string& entity) const;
  template <class Get> void feedAttr(const std::string& entity, int64_t now, int tz, Get get);
  std::vector<std::string> pendingAttr() const;
  std::vector<std::pair<std::string, std::string>> attrKeys() const;   // (entity, attribute) of every attribute tile
  void tick(int64_t now);                        // bucket boundaries: shift spans
  // Tiles whose series changed: f(key, series or nullptr, state). Live-only changes at most every kLiveGapMs.
  template <class F> void publish(int64_t now, F f);
  std::vector<TileInfo> info() const;

 private:
  enum class Phase : uint8_t { Idle, Stats, Hist, Forecast };
  struct Tile {
    Spec spec;
    PStr key;
    bool active = false;
    FetchState state = FetchState::Loading;
    Source source = Source::None;
    Phase phase = Phase::Idle;
    int64_t fetchedAt = 0, sliceAt = 0, covered = INT64_MIN, pubAt = 0;
    bool tail = false, dirty = false, force = false, hasStats = false;
    bool fed = false;            // attribute: parsed for the current bucket
    uint32_t bytes = 0, points = 0, attrHash = 0;
    int64_t bucketAt = 0;        // attribute / forecast: bucket holding now when last built
    Series stats;
    Accum acc;
    SampleList samples;          // attribute / forecast (#292)
  };
  struct RowOf { uint8_t entity; StatRow r; };
  void row(const char* id) override;
  void field(const char* key, const char* v, size_t n, bool str) override;
  void rowEnd() override;
  bool due(const Tile& t, int64_t now) const;
  void advance(Tile& t, int64_t at);
  void startHistory(Tile& t, int64_t from, bool tail);
  void finishStats(int64_t now);
  void finishSlice(Tile& t, int64_t now);
  void done(Tile& t, int64_t now, FetchState st);
  void series(const Tile& t, int64_t now, Series& out) const;
  void feedTile(Tile& t, const char* text, size_t n, int64_t now, int tz);
  void built(Tile& t, int64_t now);                // attribute / forecast samples changed or the span moved
  std::string sliceRequest(Tile& t, int64_t now, uint32_t id);
  std::string forecastRequest(const Tile& t, uint32_t id) const;

  std::vector<Tile, PsramAlloc<Tile>> tiles_;
  std::vector<RowOf, PsramAlloc<RowOf>> rows_;     // statistics answer in flight
  std::vector<PStr, PsramAlloc<PStr>> statIds_;    // its statistic_ids
  std::vector<Series, PsramAlloc<Series>> scratch_;
  uint32_t reqId_ = 0, orphanId_ = 0, scanId_ = 0;
  int64_t reqAt_ = 0, reqEnd_ = 0;
  int reqTile_ = -1;                               // history request: tile index; statistics: -1
  int tz_ = 0;
  Scanner scan_;
  ListScanner fscan_, ascan_;                      // forecast answers; attribute text (#292)
  SampleList incoming_;                            // forecast answer in flight
  bool fcScan_ = false;                            // the answer in flight is a forecast
  // row in progress
  int rowEntity_ = -1;
  bool rowOk_ = false;
  StatRow rowStat_{};
  double rowLu_ = 0;
  char rowS_[32] = {};
  int rowSN_ = -1;                                 // -1 = no "s" / too long
};

template <class Get>
void Fetcher::feedAttr(const std::string& entity, int64_t now, int tz, Get get) {
  for (auto& t : tiles_) {
    if (t.spec.kind != Kind::Attribute || t.spec.entity != entity) continue;
    const PStr* v = get(t.spec.attribute);
    feedTile(t, v ? v->data() : nullptr, v ? v->size() : 0, now, tz);
  }
}

template <class F>
void Fetcher::publish(int64_t now, F f) {
  if (scratch_.empty()) scratch_.resize(1);
  for (auto& t : tiles_) {
    if (!t.dirty || (!t.force && now - t.pubAt < kLiveGapMs)) continue;
    t.dirty = t.force = false;
    t.pubAt = now;
    if (t.spec.kind != Kind::Recorder && t.state == FetchState::Ok) {   // #292: None when the span has no sample
      series(t, now, scratch_[0]);
      bool any = false;
      for (int i = 0; i < scratch_[0].n && !any; ++i) any = has(scratch_[0].v[i]);
      f(std::string(t.key), any ? &scratch_[0] : nullptr, any ? FetchState::Ok : FetchState::None);
    } else if (t.state == FetchState::Ok) {
      series(t, now, scratch_[0]);
      f(std::string(t.key), &scratch_[0], t.state);
    } else {
      f(std::string(t.key), nullptr, t.state);
    }
  }
}

}  // namespace hist
}  // namespace x4
