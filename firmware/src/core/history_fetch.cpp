#include "core/history_fetch.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace x4 {
namespace hist {

const char* fetchStateName(FetchState s) {
  static const char* const N[] = {"ok", "loading", "none", "tooMany", "needsStats"};
  return N[int(s)];
}
const char* sourceName(Source s) {
  static const char* const N[] = {"", "statistics", "history", "attribute", "forecast"};
  return N[int(s)];
}

std::string isoUtc(int64_t ms) {
  int64_t s = ms >= 0 ? ms / 1000 : (ms - 999) / 1000;
  int64_t days = s >= 0 ? s / 86400 : (s - 86399) / 86400, sec = s - days * 86400;
  // civil from days (H. Hinnant)
  int64_t z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097, yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400, doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  int64_t d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) ++y;
  char b[32];
  std::snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02dZ", int(y), int(m), int(d), int(sec / 3600), int(sec / 60 % 60),
                int(sec % 60));
  return b;
}

// ---------------------------------------------------------------------------------------------------- Scanner
void Scanner::begin(RowSink* sink) {
  sink_ = sink;
  objBits_ = keyBits_ = 0;
  depth_ = 0;
  mode_ = Ws;
  isKey_ = success_ = broken_ = inRow_ = false;
  tokN_ = 0;
  key1_[0] = key4_[0] = id_[0] = 0;
}

void Scanner::put(char c) {
  if (tokN_ < kTok) tok_[tokN_++] = c;
}

void Scanner::open(bool obj) {
  if (depth_ >= 63) { broken_ = true; return; }
  if (depth_ == 3 && obj && !strcmp(key1_, "result")) {   // a row object of result[id]
    inRow_ = true;
    key4_[0] = 0;
    if (sink_) sink_->row(id_);
  }
  ++depth_;
  const uint64_t bit = uint64_t(1) << depth_;
  objBits_ = obj ? objBits_ | bit : objBits_ & ~bit;
  keyBits_ = obj ? keyBits_ | bit : keyBits_ & ~bit;
}

void Scanner::close(bool obj) {
  const uint64_t bit = uint64_t(1) << depth_;
  if (depth_ == 0 || bool(objBits_ & bit) != obj) { broken_ = true; return; }
  --depth_;
  if (depth_ == 3 && inRow_) {
    inRow_ = false;
    if (sink_) sink_->rowEnd();
  }
}

// A string or literal is complete in tok_: a key, or a value at depth_.
void Scanner::value(bool str) {
  tok_[tokN_] = 0;
  const uint64_t bit = uint64_t(1) << depth_;
  if (isKey_) {
    isKey_ = false;
    char* k = depth_ == 1 ? key1_ : depth_ == 2 ? id_ : depth_ == 4 ? key4_ : nullptr;
    size_t cap = depth_ == 2 ? kId : 16;
    if (k) {
      size_t n = std::min(tokN_, cap - 1);
      std::memcpy(k, tok_, n);
      k[n] = 0;
      if (tokN_ >= cap) k[0] = 0;   // too long: matches nothing
    }
    return;
  }
  if (depth_ == 1 && !strcmp(key1_, "success")) success_ = !str && !strcmp(tok_, "true");
  if (depth_ == 4 && inRow_ && sink_ && key4_[0] && tokN_ < kTok) sink_->field(key4_, tok_, tokN_, str);
  if (objBits_ & bit) keyBits_ |= bit;   // after a value in an object: a key next (after the comma)
}

void Scanner::feed(const char* p, size_t n) {
  for (size_t i = 0; i < n && !broken_; ++i) {
    const char c = p[i];
    switch (mode_) {
      case Str:
        if (c == '\\') mode_ = Esc;
        else if (c == '"') { mode_ = Ws; value(true); }
        else put(c);
        continue;
      case Esc:
        if (c == 'u') { mode_ = Uni; uni_ = 4; put('?'); }
        else { mode_ = Str; put(c == 'n' ? '\n' : c == 't' ? '\t' : c); }
        continue;
      case Uni:
        if (--uni_ == 0) mode_ = Str;
        continue;
      case Lit:
        if (c == ',' || c == '}' || c == ']' || c == ' ' || c == '\n' || c == '\r' || c == '\t') {
          mode_ = Ws;
          value(false);
          break;   // the delimiter itself below
        }
        put(c);
        continue;
      case Ws:
        break;
    }
    const uint64_t bit = uint64_t(1) << depth_;
    switch (c) {
      case ' ': case '\n': case '\r': case '\t': case ':': break;
      case ',': if (objBits_ & bit) keyBits_ |= bit; break;
      case '{': keyBits_ &= ~bit; open(true); break;
      case '[': keyBits_ &= ~bit; open(false); break;
      case '}': close(true); break;
      case ']': close(false); break;
      case '"':
        isKey_ = (objBits_ & bit) && (keyBits_ & bit);
        if (isKey_) keyBits_ &= ~bit;
        mode_ = Str;
        tokN_ = 0;
        break;
      default:
        if (depth_ == 0) { broken_ = true; break; }
        keyBits_ &= ~bit;
        mode_ = Lit;
        tokN_ = 0;
        put(c);
    }
  }
}

// ---------------------------------------------------------------------------------------------------- Accum
void Accum::begin(int64_t start, int64_t bucketMs, int n, Agg agg, int64_t from) {
  start_ = start;
  bucketMs_ = bucketMs > 0 ? bucketMs : 1;
  n_ = std::max(0, std::min(n, kMaxBars));
  agg_ = agg;
  from_ = from;
  carried_ = kNone;
  pending_ = false;
  last_ = lastNonGap_ = {0, kNone};
  b_.assign(size_t(n_), Bucket{0, 0, kNone, kNone, kNone, kNone, kNone});
}

namespace {
void seg(Bucket& x, double v, int64_t s0, int64_t s1) {
  if (s1 <= s0) return;
  x.endV = v;
  if (!has(v)) return;
  x.sum += v * double(s1 - s0);
  x.dt += double(s1 - s0);
  x.lastHeld = v;
  if (!has(x.firstHeld)) x.firstHeld = v;
  x.lo = has(x.lo) ? std::min(x.lo, v) : v;
  x.hi = has(x.hi) ? std::max(x.hi, v) : v;
}
}  // namespace

// Segment [p.t, u) of value p.v into the buckets (bucketize's inner loop, in the same order).
void Accum::commit(const Point& p, int64_t u) {
  int64_t s = std::max(std::max(p.t, from_), start_);
  if (u <= s || n_ == 0) return;
  for (int i = int((s - start_) / bucketMs_); i < n_; ++i) {
    int64_t a = start_ + i * bucketMs_, e = a + bucketMs_;
    seg(b_[size_t(i)], p.v, std::max(s, a), std::min(u, e));
    if (u <= e) break;
  }
}

void Accum::shiftOne() {
  const int64_t next = start_ + bucketMs_;
  if (pending_ && has(lastNonGap_.v) && lastNonGap_.t < next) carried_ = lastNonGap_.v;
  else if (n_ && has(b_[0].lastHeld)) carried_ = b_[0].lastHeld;
  if (n_) {
    std::move(b_.begin() + 1, b_.end(), b_.begin());
    b_.back() = Bucket{0, 0, kNone, kNone, kNone, kNone, kNone};
  }
  start_ = next;
}

bool Accum::shiftFor(int64_t t) {
  if (n_ == 0 || t < end()) return false;
  int64_t steps = (t - end()) / bucketMs_ + 1;
  if (steps > n_) {   // a long jump: every bucket starts empty
    if (pending_ && has(lastNonGap_.v)) carried_ = lastNonGap_.v;
    start_ += steps * bucketMs_;
    b_.assign(size_t(n_), Bucket{0, 0, kNone, kNone, kNone, kNone, kNone});
    return true;
  }
  for (int64_t k = 0; k < steps; ++k) shiftOne();   // the pending segment clips to the new start when committed
  return true;
}

void Accum::add(Point p) {
  if (n_ == 0) return;
  if (pending_ && p.t < last_.t) p.t = last_.t;   // HA order; a live time behind the last point holds at it
  shiftFor(p.t);
  if (pending_) commit(last_, p.t);
  if (p.t < start_ && has(p.v)) carried_ = p.v;
  if (has(p.v)) lastNonGap_ = p;
  last_ = p;
  pending_ = true;
}

void Accum::output(int64_t now, Series& out, const Series* stats, int64_t covered) const {
  out.start = start_;
  out.bucketMs = bucketMs_;
  out.n = n_;
  double carried = carried_;
  for (int i = 0; i < n_; ++i) {
    Bucket x = b_[size_t(i)];
    const int64_t a = start_ + i * bucketMs_, e = std::min(a + bucketMs_, now);
    if (pending_) seg(x, last_.v, std::max(std::max(last_.t, from_), a), e);   // the last point holds until now
    double o = kNone;
    if (e > a && x.dt > 0) {
      if (agg_ == Agg::Mean) o = x.sum / x.dt;
      else if (agg_ == Agg::Min) o = x.lo;
      else if (agg_ == Agg::Max) o = x.hi;
      else if (agg_ == Agg::Last) o = x.endV;
      else {
        double base = has(carried) ? carried : x.firstHeld;
        o = x.lastHeld - (has(base) ? base : x.lastHeld);
      }
    }
    if (has(x.lastHeld)) carried = x.lastHeld;
    if (stats && i < stats->n && has(stats->v[i])) {   // statistics cover [a, covered) of this bucket
      const double sv = stats->v[i];
      if (!has(o)) o = sv;
      else if (agg_ == Agg::Mean) {
        double sw = double(std::max<int64_t>(0, std::min(covered, a + bucketMs_) - a));
        o = sw > 0 ? (sv * sw + x.sum) / (sw + x.dt) : o;
      } else if (agg_ == Agg::Min) o = std::min(o, sv);
      else if (agg_ == Agg::Max) o = std::max(o, sv);
      else if (agg_ == Agg::Change) o += sv;
      // last: the live value wins
    }
    out.v[i] = o;
  }
}

// ---------------------------------------------------------------------------------------------------- Fetcher
namespace {
std::string jsonStr(const std::string& s) {
  std::string o = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') o += '\\';
    if (static_cast<unsigned char>(c) >= 0x20) o += c;
  }
  return o + "\"";
}
bool anyData(const Series& s) {
  for (int i = 0; i < s.n; ++i) if (has(s.v[i])) return true;
  return false;
}
}  // namespace

void Fetcher::setTiles(const std::vector<Want>& want, bool configChanged) {
  std::vector<Tile, PsramAlloc<Tile>> next;
  next.reserve(want.size());
  const std::string inFlight = reqTile_ >= 0 && reqTile_ < int(tiles_.size()) ? std::string(tiles_[size_t(reqTile_)].key) : "";
  int nextReq = -1;
  for (auto& w : want) {
    auto same = std::find_if(next.begin(), next.end(), [&](const Tile& t) { return t.key == PStr(w.key); });
    if (same != next.end()) { same->active |= w.active; continue; }   // one series for every tile showing it
    auto it = std::find_if(tiles_.begin(), tiles_.end(), [&](const Tile& t) { return t.key == PStr(w.key); });
    if (it != tiles_.end()) next.push_back(std::move(*it));
    else {
      next.emplace_back();
      next.back().spec = w.spec;
      next.back().key = w.key;
    }
    Tile& t = next.back();
    t.active = w.active;
    if (configChanged && t.state == FetchState::TooMany) {
      t.state = FetchState::Loading;
      t.fetchedAt = 0;
    }
    if (!inFlight.empty() && t.key == PStr(inFlight)) nextReq = int(next.size()) - 1;
  }
  tiles_.swap(next);
  if (reqId_ && reqTile_ >= 0 && nextReq < 0) {   // the tile being fetched left: scan its answer into nothing
    orphanId_ = reqId_;
    reqId_ = 0;
  }
  reqTile_ = nextReq;
}

void Fetcher::reset() {
  reqId_ = orphanId_ = scanId_ = 0;
  reqTile_ = -1;
  rows_.clear();
  for (auto& t : tiles_) {
    t.phase = Phase::Idle;
    if (t.state != FetchState::TooMany) t.fetchedAt = 0;
  }
}

bool Fetcher::watches(const std::string& entity) const {
  for (auto& t : tiles_) if (t.spec.kind == Kind::Recorder && t.spec.entity == entity) return true;
  return false;
}

bool Fetcher::due(const Tile& t, int64_t now) const {
  if (!t.active || t.phase != Phase::Idle || t.state == FetchState::TooMany || t.spec.n <= 0) return false;
  if (t.spec.kind == Kind::Attribute) return false;   // fed from the mirror
  if (t.spec.kind == Kind::Forecast) return t.fetchedAt == 0 || now - t.fetchedAt >= kForecastMs;
  return t.fetchedAt == 0 || now - t.fetchedAt >= std::max(kRefetchMs, t.spec.bucketMs);
}

// ---- attribute / forecast tiles (eink-ha-os#292) ----
namespace {
uint32_t fnv(const char* p, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; ++i) h = (h ^ uint8_t(p[i])) * 16777619u;
  return h;
}
}  // namespace

bool Fetcher::wantsAttr(const std::string& entity) const {
  for (auto& t : tiles_) if (t.spec.kind == Kind::Attribute && t.spec.entity == entity) return true;
  return false;
}

std::vector<std::string> Fetcher::pendingAttr() const {
  std::vector<std::string> v;
  for (auto& t : tiles_)
    if (t.spec.kind == Kind::Attribute && !t.fed && std::find(v.begin(), v.end(), t.spec.entity) == v.end()) v.push_back(t.spec.entity);
  return v;
}

std::vector<std::pair<std::string, std::string>> Fetcher::attrKeys() const {
  std::vector<std::pair<std::string, std::string>> v;
  for (auto& t : tiles_) if (t.spec.kind == Kind::Attribute) v.emplace_back(t.spec.entity, t.spec.attribute);
  return v;
}

void Fetcher::built(Tile& t, int64_t now) {
  t.bucketAt = bucketStart(now, t.spec.bucketMs, tz_);
  Series& s = scratch_.empty() ? (scratch_.resize(1), scratch_[0]) : scratch_[0];
  series(t, now, s);
  t.state = anyData(s) ? FetchState::Ok : FetchState::None;
  t.dirty = t.force = true;
}

void Fetcher::feedTile(Tile& t, const char* text, size_t n, int64_t now, int tz) {
  const uint32_t h = text ? fnv(text, n) : 0;
  if (t.fed && h == t.attrHash && t.state != FetchState::Loading) return;   // same text, same bucket
  tz_ = tz;
  if (text) attrSamples(ascan_, text, n, t.spec, now, tz, t.samples);
  else t.samples.clear();
  t.attrHash = h;
  t.fed = true;
  t.source = Source::Attribute;
  t.fetchedAt = now;
  t.bytes = uint32_t(n);
  t.points = uint32_t(t.samples.size());
  built(t, now);
}

std::string Fetcher::forecastRequest(const Tile& t, uint32_t id) const {
  return "{\"id\":" + std::to_string(id) +
         ",\"type\":\"call_service\",\"domain\":\"weather\",\"service\":\"get_forecasts\",\"service_data\":{\"type\":\"" +
         (t.spec.daily ? "daily" : "hourly") + "\"},\"target\":{\"entity_id\":" + jsonStr(t.spec.entity) + "},\"return_response\":true}";
}

void Fetcher::startHistory(Tile& t, int64_t from, bool tail) {
  t.phase = Phase::Hist;
  t.tail = tail;
  t.sliceAt = from;
  t.covered = tail ? from : INT64_MIN;
  if (!tail) t.hasStats = false;
}

std::string Fetcher::sliceRequest(Tile& t, int64_t now, uint32_t id) {
  const int64_t s = t.sliceAt, e = std::min(s + kSliceMs, seriesNow(t.spec, now));   // eink-ha-os#304: a compare series ends compareMs ago
  const bool first = t.tail ? s == t.covered : s == t.acc.start();
  reqEnd_ = e;
  std::string j = "{\"id\":" + std::to_string(id) + ",\"type\":\"history/history_during_period\",\"start_time\":\"" + isoUtc(s) + "\"";
  if (e < now) j += ",\"end_time\":\"" + isoUtc(e) + "\"";
  j += ",\"entity_ids\":[" + jsonStr(t.spec.entity) +
       "],\"minimal_response\":true,\"no_attributes\":true,\"significant_changes_only\":false,\"include_start_time_state\":";
  j += first ? "true}" : "false}";
  return j;
}

bool Fetcher::next(int64_t now, int tz, uint32_t id, std::string& json) {
  if (reqId_) return false;
  tz_ = tz;
  for (size_t i = 0; i < tiles_.size(); ++i) {   // a fetch under way: its next slice
    if (tiles_[i].phase != Phase::Hist) continue;
    json = sliceRequest(tiles_[i], now, id);
    reqId_ = id; reqAt_ = now; reqTile_ = int(i);
    return true;
  }
  for (size_t i = 0; i < tiles_.size(); ++i) {
    Tile& t = tiles_[i];
    if (!due(t, now)) continue;
    t.bytes = t.points = 0;
    if (t.spec.kind == Kind::Forecast) {   // eink-ha-os#292: weather.get_forecasts with return_response
      t.phase = Phase::Forecast;
      json = forecastRequest(t, id);
      reqId_ = id; reqAt_ = now; reqTile_ = int(i);
      return true;
    }
    const Period p = statsPeriod(t.spec.bucketMs);
    if (p == Period::None) {
      if (!fallbackOk(t.spec)) { done(t, now, FetchState::NeedsStats); continue; }
      Span sp = chartSpan(t.spec.windowMs, t.spec.bucketMs, seriesNow(t.spec, now), tz);
      t.acc.begin(sp.start, t.spec.bucketMs, t.spec.n, t.spec.agg, sp.start);
      t.source = Source::History;
      startHistory(t, sp.start, false);
      json = sliceRequest(t, now, id);
      reqId_ = id; reqAt_ = now; reqTile_ = int(i);
      return true;
    }
    // every due tile of this period (and shift: a compare series asks its own past span, eink-ha-os#304) in one request: the
    // union of ids and types, from the earliest span start
    statIds_.clear();
    bool type[5] = {};
    int64_t start = INT64_MAX;
    const int64_t shift = t.spec.shiftMs;
    for (auto& u : tiles_) {
      if (!due(u, now) || u.spec.kind != Kind::Recorder || statsPeriod(u.spec.bucketMs) != p || u.spec.shiftMs != shift) continue;
      u.phase = Phase::Stats;
      u.bytes = u.points = 0;
      start = std::min(start, chartSpan(u.spec.windowMs, u.spec.bucketMs, now - shift, tz).start);
      if (std::find(statIds_.begin(), statIds_.end(), PStr(u.spec.entity)) == statIds_.end()) statIds_.push_back(u.spec.entity);
      type[u.spec.agg == Agg::Last ? int(Agg::Mean) : int(u.spec.agg)] = true;
    }
    json = "{\"id\":" + std::to_string(id) + ",\"type\":\"recorder/statistics_during_period\",\"start_time\":\"" + isoUtc(start) +
           "\"" + (shift ? ",\"end_time\":\"" + isoUtc(now - shift) + "\"" : std::string()) + ",\"period\":\"" + periodName(p) + "\",\"types\":[";
    bool comma = false;
    for (int a = 0; a < 5; ++a) {
      if (!type[a]) continue;
      json += std::string(comma ? "," : "") + "\"" + statsType(Agg(a)) + "\"";
      comma = true;
    }
    json += "],\"statistic_ids\":[";
    for (size_t k = 0; k < statIds_.size(); ++k) json += (k ? "," : "") + jsonStr(std::string(statIds_[k]));
    json += "]}";
    rows_.clear();
    reqId_ = id; reqAt_ = now; reqTile_ = -1;
    return true;
  }
  return false;
}

void Fetcher::begin(uint32_t id) {
  scanId_ = id;
  rowEntity_ = -1;
  fcScan_ = id == reqId_ && reqTile_ >= 0 && tiles_[size_t(reqTile_)].phase == Phase::Forecast;
  if (fcScan_) {   // result.response.<entity>.forecast: [{datetime, temperature, …}]
    const Tile& t = tiles_[size_t(reqTile_)];
    const char* path[] = {"result", "response", t.spec.entity.c_str(), "forecast"};
    incoming_.clear();
    fscan_.begin(path, 4, t.spec.value, t.spec.time, bucketStart(reqAt_, t.spec.bucketMs, tz_), t.spec.bucketMs, tz_, &incoming_);
    return;
  }
  scan_.begin(id == reqId_ ? this : nullptr);
}

void Fetcher::feed(const char* p, size_t n) {
  if (fcScan_) fscan_.feed(p, n);
  else scan_.feed(p, n);
}

void Fetcher::row(const char* id) {
  rowEntity_ = -1;
  rowOk_ = true;
  rowStat_ = StatRow{INT64_MIN, -1, kNone, kNone, kNone, kNone};
  rowLu_ = kNone;
  rowSN_ = -1;
  if (reqTile_ >= 0) {
    if (reqTile_ < int(tiles_.size()) && tiles_[size_t(reqTile_)].spec.entity == id) rowEntity_ = reqTile_;
    return;
  }
  for (size_t k = 0; k < statIds_.size() && k < 255; ++k)
    if (statIds_[k] == id) rowEntity_ = int(k);
}

void Fetcher::field(const char* key, const char* v, size_t n, bool str) {
  if (rowEntity_ < 0) return;
  auto num = [&]() { return str || !strcmp(v, "null") ? kNone : std::strtod(v, nullptr); };
  if (reqTile_ >= 0) {
    if (!strcmp(key, "s")) {
      if (str && n < sizeof rowS_) { std::memcpy(rowS_, v, n); rowS_[n] = 0; rowSN_ = int(n); }
      else rowSN_ = 0;   // null / too long: not a number
    } else if (!strcmp(key, "lu")) rowLu_ = num();
    return;
  }
  if (!strcmp(key, "start")) { double x = num(); if (has(x)) rowStat_.start = int64_t(x); }
  else if (!strcmp(key, "end")) { double x = num(); if (has(x)) rowStat_.end = int64_t(x); }
  else if (!strcmp(key, "mean")) rowStat_.mean = num();
  else if (!strcmp(key, "min")) rowStat_.min = num();
  else if (!strcmp(key, "max")) rowStat_.max = num();
  else if (!strcmp(key, "change")) rowStat_.change = num();
}

void Fetcher::rowEnd() {
  if (rowEntity_ < 0) return;
  if (reqTile_ >= 0) {
    if (rowSN_ < 0 || !has(rowLu_)) return;
    Tile& t = tiles_[size_t(reqTile_)];
    t.acc.add(pointOf(rowS_, size_t(rowSN_), rowLu_));
    ++t.points;
    return;
  }
  if (rowStat_.start != INT64_MIN) rows_.push_back({uint8_t(rowEntity_), rowStat_});
}

void Fetcher::done(Tile& t, int64_t now, FetchState st) {
  t.phase = Phase::Idle;
  t.fetchedAt = now;
  t.state = st;
  t.dirty = t.force = true;
}

void Fetcher::finishStats(int64_t now) {
  std::vector<StatRow, PsramAlloc<StatRow>> mine;
  for (auto& t : tiles_) {
    if (t.phase != Phase::Stats) continue;
    const auto k = std::find(statIds_.begin(), statIds_.end(), PStr(t.spec.entity)) - statIds_.begin();
    mine.clear();
    int64_t covered = INT64_MIN;
    for (auto& r : rows_)
      if (r.entity == k) { mine.push_back(r.r); covered = std::max(covered, r.r.end >= 0 ? r.r.end : r.r.start); }
    const int64_t tn = seriesNow(t.spec, now);   // eink-ha-os#304 wave 2: a compare series' own now
    if (mine.empty()) {   // no statistics (no state_class): history rows, up to 24 h
      if (!fallbackOk(t.spec)) { done(t, now, FetchState::NeedsStats); continue; }
      Span sp = chartSpan(t.spec.windowMs, t.spec.bucketMs, tn, tz_);
      t.acc.begin(sp.start, t.spec.bucketMs, t.spec.n, t.spec.agg, sp.start);
      t.source = Source::History;
      startHistory(t, sp.start, false);
      continue;
    }
    fromStatistics(mine.data(), mine.size(), t.spec.windowMs, t.spec.bucketMs, t.spec.agg, tn, tz_, t.stats);
    covered = std::max(covered, t.stats.start);
    t.covered = covered;
    t.points = uint32_t(mine.size());
    t.hasStats = true;
    t.source = Source::Statistics;
    t.acc.begin(t.stats.start, t.spec.bucketMs, t.spec.n, t.spec.agg, covered);
    // the open part after the last compiled row: history, when it is short enough to be cheap
    if (covered < tn && tn - covered <= kFallbackMax) startHistory(t, covered, true);
    else done(t, now, anyData(t.stats) ? FetchState::Ok : FetchState::None);
  }
  rows_.clear();
  rows_.shrink_to_fit();
}

void Fetcher::finishSlice(Tile& t, int64_t now) {
  t.sliceAt = reqEnd_;
  if (reqEnd_ < seriesNow(t.spec, reqAt_)) return;   // more slices
  Series& s = scratch_.empty() ? (scratch_.resize(1), scratch_[0]) : scratch_[0];
  series(t, now, s);
  done(t, now, anyData(s) ? FetchState::Ok : FetchState::None);
}

void Fetcher::end(int64_t now, uint32_t bytes) {
  const uint32_t id = scanId_;
  scanId_ = 0;
  if (id == orphanId_) { orphanId_ = 0; return; }
  if (id != reqId_) return;
  reqId_ = 0;
  const bool ok = scan_.success() && !scan_.broken();
  if (reqTile_ < 0) {   // statistics: a failed answer is no statistics (fallback)
    if (!ok) rows_.clear();
    for (auto& t : tiles_) if (t.phase == Phase::Stats) t.bytes += bytes;
    finishStats(now);
    return;
  }
  Tile& t = tiles_[size_t(reqTile_)];
  reqTile_ = -1;
  t.bytes += bytes;
  if (t.phase == Phase::Forecast) {   // eink-ha-os#292: a failed call (no such forecast type) = no samples
    const bool fok = fcScan_ && fscan_.success() && fscan_.complete();
    fcScan_ = false;
    t.samples.clear();
    if (fok) { t.samples.assign(incoming_.begin(), incoming_.end()); sortSamples(t.samples); }
    incoming_.clear();
    incoming_.shrink_to_fit();
    t.phase = Phase::Idle;
    t.fetchedAt = now;
    t.source = Source::Forecast;
    t.points = uint32_t(t.samples.size());
    built(t, now);
    return;
  }
  if (!ok) {
    if (t.tail) done(t, now, anyData(t.stats) ? FetchState::Ok : FetchState::None);
    else done(t, now, FetchState::None);
    return;
  }
  finishSlice(t, now);
}

void Fetcher::dropped(uint32_t id, int64_t now, uint32_t bytes) {
  if (id == orphanId_) { orphanId_ = 0; return; }
  if (id != reqId_) return;
  reqId_ = 0;
  if (reqTile_ < 0) {
    rows_.clear();
    finishStats(now);
    return;
  }
  Tile& t = tiles_[size_t(reqTile_)];
  reqTile_ = -1;
  t.bytes += bytes;
  // a tail over the cap: the statistics alone (live appends fill the open bucket); else too many changes, no retry
  if (t.tail) done(t, now, anyData(t.stats) ? FetchState::Ok : FetchState::None);
  else done(t, now, FetchState::TooMany);
}

void Fetcher::abandon() {
  fcScan_ = false;
  if (!reqId_) return;
  for (auto& t : tiles_) if (t.phase != Phase::Idle) t.phase = Phase::Idle;   // retried on the next pass
  reqId_ = scanId_ = 0;
  reqTile_ = -1;
  rows_.clear();
}

void Fetcher::advance(Tile& t, int64_t at) {
  const int64_t before = t.acc.start();
  if (!t.acc.shiftFor(at)) return;
  const int64_t k = (t.acc.start() - before) / t.spec.bucketMs;
  if (t.hasStats) {
    Series& s = t.stats;
    for (int i = 0; i < s.n; ++i) s.v[i] = i + k < s.n ? s.v[size_t(i + k)] : kNone;
    s.start = t.acc.start();
  }
  t.dirty = t.force = true;
}

void Fetcher::live(const std::string& entity, double v, int64_t at) {
  for (auto& t : tiles_) {
    if (t.spec.kind != Kind::Recorder || t.spec.entity != entity || t.phase != Phase::Idle || t.state != FetchState::Ok) continue;
    if (t.spec.shiftMs) continue;   // a compare series is past: only its refetch moves it
    advance(t, at);
    t.acc.add({at, v});
    t.dirty = true;
  }
}

void Fetcher::tick(int64_t now) {
  for (auto& t : tiles_) {
    if (t.spec.kind == Kind::Recorder) {
      if (t.phase == Phase::Idle && t.state == FetchState::Ok) advance(t, seriesNow(t.spec, now));
      continue;
    }
    // eink-ha-os#292: the span follows now; an attribute is parsed again (plain numbers start at the bucket holding now)
    if (t.state == FetchState::Loading || t.spec.bucketMs <= 0 || bucketStart(now, t.spec.bucketMs, tz_) == t.bucketAt) continue;
    if (t.spec.kind == Kind::Attribute) { t.fed = false; t.bucketAt = bucketStart(now, t.spec.bucketMs, tz_); }
    else if (t.phase == Phase::Idle) built(t, now);
  }
}

void Fetcher::series(const Tile& t, int64_t now, Series& out) const {
  if (t.spec.kind != Kind::Recorder) { fromSamples(t.samples.data(), t.samples.size(), t.spec, now, tz_, out); return; }
  t.acc.output(seriesNow(t.spec, now), out, t.hasStats ? &t.stats : nullptr, t.covered);
}

std::vector<TileInfo> Fetcher::info() const {
  std::vector<TileInfo> v;
  for (auto& t : tiles_) v.push_back({std::string(t.key), t.active, t.state, t.source, t.fetchedAt, t.bytes, t.points});
  return v;
}

}  // namespace hist
}  // namespace x4
