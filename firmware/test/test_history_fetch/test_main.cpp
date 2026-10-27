// core/history_fetch (#269): streaming scanner + incremental bucketing against spec/test-vectors/history.json, the
// request plan (statistics first, 6 h history slices, one in flight), oversized answers, live append, and the heap:
// nothing outside PsramAlloc stays allocated once an answer is processed.
#include <unity.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <new>
#include <random>
#include <sstream>
#include <string>
#include <vector>
#include "core/config.h"
#include "core/history_chart.h"
#include "core/history_fetch.h"
#include "core/json.h"

using namespace x4;

static long gLive = 0;   // operator new bytes (PsramAlloc counts its own: psramLiveBytes)
void* operator new(size_t n) {
  auto* p = static_cast<size_t*>(std::malloc(n + 16));
  if (!p) throw std::bad_alloc();
  *p = n; gLive += long(n);
  return reinterpret_cast<char*>(p) + 16;
}
void operator delete(void* q) noexcept {
  if (!q) return;
  auto* p = reinterpret_cast<size_t*>(static_cast<char*>(q) - 16);
  gLive -= long(*p);
  std::free(p);
}
void operator delete(void* q, size_t) noexcept { operator delete(q); }

void setUp() {}
void tearDown() {}

static std::string readFile(const std::string& p) {
  std::ifstream f(p);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}
static const Json& vectors() {
  static Json j;
  static bool loaded = false;
  if (!loaded) { TEST_ASSERT_TRUE(parseJson(readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/history.json"), j)); loaded = true; }
  return j;
}
static void assertNear(const Json& want, double got, const std::string& what) {
  if (want.isNull()) { TEST_ASSERT_TRUE_MESSAGE(std::isnan(got), (what + ": want null, got " + jsNumber(got)).c_str()); return; }
  TEST_ASSERT_FALSE_MESSAGE(std::isnan(got), (what + ": got null").c_str());
  TEST_ASSERT_TRUE_MESSAGE(std::fabs(want.num - got) <= 1e-6, (what + ": want " + jsNumber(want.num) + ", got " + jsNumber(got)).c_str());
}
static void sameSeries(const hist::Series& a, const hist::Series& b, const std::string& what) {
  TEST_ASSERT_EQUAL_INT_MESSAGE(a.n, b.n, what.c_str());
  TEST_ASSERT_EQUAL_INT64_MESSAGE(a.start, b.start, what.c_str());
  for (int i = 0; i < a.n; ++i) {
    std::string w = what + " [" + std::to_string(i) + "]";
    TEST_ASSERT_EQUAL_MESSAGE(std::isnan(a.v[i]), std::isnan(b.v[i]), w.c_str());
    if (!std::isnan(a.v[i])) TEST_ASSERT_TRUE_MESSAGE(std::fabs(a.v[i] - b.v[i]) <= 1e-9 * std::max(1.0, std::fabs(a.v[i])), w.c_str());
  }
}

// An HA result frame, sliced into pieces of `chunk` bytes.
struct Rec : hist::RowSink {
  std::vector<std::string> log;
  void row(const char* id) override { log.push_back(std::string("row ") + id); }
  void field(const char* k, const char* v, size_t n, bool str) override { log.push_back(std::string(k) + (str ? "=s:" : "=") + std::string(v, n)); }
  void rowEnd() override { log.push_back("end"); }
};
static void feedChunked(hist::Scanner& s, const std::string& f, size_t chunk) {
  for (size_t i = 0; i < f.size(); i += chunk) s.feed(f.data() + i, std::min(chunk, f.size() - i));
}

void test_scanner_shapes() {
  const std::string f =
      "{\"id\":7,\"type\":\"result\",\"success\":true,\"result\":{\"sensor.a\":[{\"s\":\"1.5\",\"a\":{\"x\":[1,{\"s\":\"no\"}],"
      "\"u\":\"\\\"q\\u00b0\"},\"lu\":1700000000.25},{\"s\":\"unavailable\",\"lu\":1700000001}],\"sensor.b\":[ { \"start\" : 1 ,"
      " \"mean\" : null , \"max\" : -2.5e1 } ]}}";
  for (size_t chunk : {size_t(1), size_t(3), size_t(4096)}) {
    hist::Scanner s;
    Rec r;
    s.begin(&r);
    feedChunked(s, f, chunk);
    TEST_ASSERT_TRUE(s.success());
    TEST_ASSERT_FALSE(s.broken());
    std::string all;
    for (auto& l : r.log) all += l + "|";
    TEST_ASSERT_EQUAL_STRING("row sensor.a|s=s:1.5|lu=1700000000.25|end|row sensor.a|s=s:unavailable|lu=1700000001|end|"
                             "row sensor.b|start=1|mean=null|max=-2.5e1|end|", all.c_str());
  }
  hist::Scanner s;
  Rec r;
  s.begin(&r);
  feedChunked(s, "{\"id\":3,\"type\":\"result\",\"success\":false,\"error\":{\"code\":\"x\",\"message\":\"y\"}}", 5);
  TEST_ASSERT_FALSE(s.success());
  TEST_ASSERT_TRUE(r.log.empty());
  s.begin(&r);
  feedChunked(s, "{\"a\":[}", 5);
  TEST_ASSERT_TRUE(s.broken());
}

// history.json "history": the rows as one HA frame, scanned in chunks into Accum = bucketize's expected series.
void test_vectors_through_scanner() {
  const Json& j = vectors();
  const int64_t now = int64_t(j.get("now")->num);
  static hist::Series out;
  int cases = 0;
  for (auto& c : j.get("history")->arr) {
    const std::string name = c.get("name")->str;
    const int tz = int(c.get("tz")->num);
    const int64_t win = int64_t(c.get("windowMs")->num), bk = int64_t(c.get("bucketMs")->num);
    std::vector<std::pair<int64_t, const Json*>> rows;   // HA order: by last_updated
    for (auto& r : c.get("rows")->arr) rows.push_back({hist::pointOf("", 0, r.get("lu")->num).t, &r});
    std::stable_sort(rows.begin(), rows.end(), [](auto& a, auto& b) { return a.first < b.first; });
    std::string f = "{\"id\":1,\"type\":\"result\",\"success\":true,\"result\":{\"sensor.x\":[";
    for (size_t k = 0; k < rows.size(); ++k)
      f += (k ? "," : "") + std::string("{\"s\":") + jsonQuote(rows[k].second->get("s")->str) + ",\"lu\":" + jsNumber(rows[k].second->get("lu")->num) + "}";
    f += "]}}";
    for (auto& kv : c.get("out")->obj) {
      hist::Agg a;
      TEST_ASSERT_TRUE(hist::aggOf(kv.first, a));
      for (size_t chunk : {size_t(1), size_t(13), size_t(2048)}) {
        hist::Span sp = hist::chartSpan(win, bk, now, tz);
        hist::Accum acc;
        acc.begin(sp.start, bk, int(win / bk), a, sp.start);
        struct Sink : hist::RowSink {
          hist::Accum* acc; std::string s; double lu = NAN;
          void row(const char*) override { s.clear(); lu = NAN; }
          void field(const char* k, const char* v, size_t n, bool) override { if (k[0] == 's') s.assign(v, n); else lu = std::strtod(v, nullptr); }
          void rowEnd() override { acc->add(hist::pointOf(s.data(), s.size(), lu)); }
        } sink;
        sink.acc = &acc;
        hist::Scanner sc;
        sc.begin(&sink);
        feedChunked(sc, f, chunk);
        TEST_ASSERT_TRUE(sc.success());
        acc.output(now, out);
        const auto& want = kv.second.arr;
        TEST_ASSERT_EQUAL_INT(int(want.size()), out.n);
        for (int i = 0; i < out.n; ++i) assertNear(want[size_t(i)], out.v[i], name + " " + kv.first + " [" + std::to_string(i) + "]");
      }
      ++cases;
    }
  }
  TEST_ASSERT_GREATER_THAN(0, cases);
  std::printf("history vectors through the scanner: %d cases × 3 chunkings\n", cases);
}

// Random step series: points fed live (spans shifting as time moves) = bucketize over all points at the end.
void test_accum_live_shift_matches_bucketize() {
  std::mt19937 rng(269);
  static hist::Series a, b;
  for (int round = 0; round < 300; ++round) {
    const hist::Agg agg = hist::Agg(round % 5);
    const int64_t bk = (round % 3 == 0 ? 5 : round % 3 == 1 ? 30 : 60) * hist::kMin;
    const int n = 4 + int(rng() % 40);
    const int64_t win = bk * n, t0 = 1793000000000LL;
    std::vector<hist::Point> pts;
    int64_t t = t0 - win - bk * 2;
    const int64_t fetchNow = t0;
    while (t < t0 + bk * 7) {
      t += 1000 * int64_t(1 + rng() % 1800);
      double v = rng() % 9 == 0 ? NAN : double(int(rng() % 200) - 50) / 4;
      pts.push_back({t, v});
    }
    hist::Accum acc;
    hist::Span sp = hist::chartSpan(win, bk, fetchNow, 0);
    acc.begin(sp.start, bk, n, agg, sp.start);
    size_t k = 0;
    for (; k < pts.size() && pts[k].t <= fetchNow; ++k) acc.add(pts[k]);
    for (; k < pts.size(); ++k) acc.add(pts[k]);   // live, shifting
    const int64_t now = pts.back().t + 1000 * int64_t(rng() % 600);
    acc.shiftFor(now);
    acc.output(now, a);
    hist::bucketize(pts.data(), pts.size(), win, bk, agg, now, 0, b);
    sameSeries(b, a, "round " + std::to_string(round) + " agg " + hist::aggName(agg));
  }
}

// ---- Fetcher ----
static hist::Spec spec(const char* entity, const char* window, const char* bucket, const char* agg) {
  hist::Spec s;
  s.entity = entity;
  s.windowMs = hist::parseSpan(window);
  s.bucketMs = hist::parseSpan(bucket);
  s.n = int(s.windowMs / s.bucketMs);
  hist::aggOf(agg, s.agg);
  return s;
}
static std::string key(const hist::Spec& s) { return s.entity + "|" + std::to_string(s.windowMs) + "|" + std::to_string(s.bucketMs) + "|" + hist::aggName(s.agg); }
static void feedAnswer(hist::Fetcher& f, uint32_t id, const std::string& result, int64_t now, size_t chunk = 997) {
  std::string fr = "{\"id\":" + std::to_string(id) + ",\"type\":\"result\",\"success\":true,\"result\":" + result + "}";
  TEST_ASSERT_TRUE(f.owns(id));
  f.begin(id);
  for (size_t i = 0; i < fr.size(); i += chunk) f.feed(fr.data() + i, std::min(chunk, fr.size() - i));
  f.end(now, uint32_t(fr.size()));
}
static std::string field(const std::string& json, const std::string& k) {   // "k":"v" or "k":v (first match)
  size_t p = json.find("\"" + k + "\":");
  if (p == std::string::npos) return "";
  p += k.size() + 3;
  if (json[p] == '"') return json.substr(p + 1, json.find('"', p + 1) - p - 1);
  size_t e = json.find_first_of(",}]", p);
  return json.substr(p, e - p);
}
static int64_t isoMs(const std::string& iso) {   // "YYYY-MM-DDTHH:MM:SSZ"
  for (int64_t t = 1790000000; t < 1800000000; t += 86400)
    if (hist::isoUtc(t * 1000).substr(0, 10) == iso.substr(0, 10))
      return t * 1000 + (std::stoi(iso.substr(11, 2)) * 3600 + std::stoi(iso.substr(14, 2)) * 60 + std::stoi(iso.substr(17, 2))) * 1000LL -
             (t % 86400) * 1000;
  return -1;
}

// A step series: a change every `stepS` seconds (value from the time), sampled like HA's compressed rows.
struct Sensor {
  int64_t stepMs;
  double at(int64_t t) const { return std::round(10 * std::sin(double(t / stepMs) * 0.7)) / 2 + 20; }
  std::vector<hist::Point> points(int64_t from, int64_t to) const {   // the state at `from`, then every change < to
    std::vector<hist::Point> p{{from, at(from)}};
    for (int64_t t = (from / stepMs + 1) * stepMs; t < to; t += stepMs) p.push_back({t, at(t)});
    return p;
  }
  // history_during_period rows for [s, e): include_start_time_state → a first row at s
  std::string rows(const char* id, int64_t s, int64_t e, bool withStart) const {
    std::string r = std::string("{\"") + id + "\":[";
    bool comma = false;
    for (auto& p : points(s, e)) {
      if (p.t == s && !withStart && s % stepMs) continue;
      r += std::string(comma ? "," : "") + "{\"s\":\"" + jsNumber(p.v) + "\",\"lu\":" + jsNumber(double(p.t) / 1000) + "}";
      comma = true;
    }
    return r + "]}";
  }
};

void test_fetch_statistics_then_tail() {
  const int64_t now = 1793025123456LL;
  const Sensor sen{60 * 1000};
  hist::Spec sp = spec("sensor.t", "24h", "30m", "mean");
  hist::Fetcher f;
  f.setTiles({{sp, key(sp), true}}, true);
  std::string j;
  TEST_ASSERT_TRUE(f.next(now, 0, 10, j));
  TEST_ASSERT_EQUAL_STRING("recorder/statistics_during_period", field(j, "type").c_str());
  TEST_ASSERT_EQUAL_STRING("5minute", field(j, "period").c_str());
  TEST_ASSERT_TRUE(j.find("\"types\":[\"mean\"]") != std::string::npos);
  TEST_ASSERT_TRUE(j.find("\"statistic_ids\":[\"sensor.t\"]") != std::string::npos);
  std::string j2;
  TEST_ASSERT_FALSE(f.next(now, 0, 11, j2));   // one in flight
  // compiled 5-minute rows up to the last full period: their means from the step series
  const hist::Span span = hist::chartSpan(sp.windowMs, sp.bucketMs, now, 0);
  const int64_t covered = now / (5 * hist::kMin) * (5 * hist::kMin);
  TEST_ASSERT_EQUAL_INT64(span.start, isoMs(field(j, "start_time")));
  auto pts = sen.points(span.start - hist::kDay, now);
  auto meanOver = [&](int64_t a, int64_t b) {   // HA's compiled 5-minute mean: time-weighted
    double sum = 0;
    for (size_t k = 0; k < pts.size(); ++k) {
      int64_t s0 = std::max(pts[k].t, a), s1 = std::min(k + 1 < pts.size() ? pts[k + 1].t : now, b);
      if (s1 > s0) sum += pts[k].v * double(s1 - s0);
    }
    return sum / double(b - a);
  };
  std::string rows = "{\"sensor.t\":[";
  for (int64_t s = span.start; s + 5 * hist::kMin <= covered; s += 5 * hist::kMin) {
    rows += std::string(s == span.start ? "" : ",") + "{\"start\":" + std::to_string(s) + ",\"end\":" + std::to_string(s + 5 * hist::kMin) +
            ",\"mean\":" + jsNumber(meanOver(s, s + 5 * hist::kMin)) + "}";
  }
  rows += "]}";
  feedAnswer(f, 10, rows, now);
  // the open part after the last compiled row: one history request from `covered`, with the state at that time
  TEST_ASSERT_TRUE(f.next(now, 0, 12, j));
  TEST_ASSERT_EQUAL_STRING("history/history_during_period", field(j, "type").c_str());
  TEST_ASSERT_EQUAL_INT64(covered, isoMs(field(j, "start_time")));
  TEST_ASSERT_EQUAL_STRING("", field(j, "end_time").c_str());
  TEST_ASSERT_EQUAL_STRING("true", field(j, "include_start_time_state").c_str());
  TEST_ASSERT_EQUAL_STRING("false", field(j, "significant_changes_only").c_str());
  feedAnswer(f, 12, sen.rows("sensor.t", covered, now, true), now);
  TEST_ASSERT_FALSE(f.next(now, 0, 13, j));
  int published = 0;
  static hist::Series want;
  hist::bucketize(pts.data(), pts.size(), sp.windowMs, sp.bucketMs, sp.agg, now, 0, want);
  f.publish(now, [&](const std::string& k, const hist::Series* s, hist::FetchState st) {
    ++published;
    TEST_ASSERT_EQUAL_STRING(key(sp).c_str(), k.c_str());
    TEST_ASSERT_EQUAL(int(hist::FetchState::Ok), int(st));
    TEST_ASSERT_NOT_NULL(s);
    sameSeries(want, *s, "statistics + tail");
  });
  TEST_ASSERT_EQUAL_INT(1, published);
  auto info = f.info();
  TEST_ASSERT_EQUAL_STRING("statistics", hist::sourceName(info[0].source));
  // due again after one bucket (live append fills the gap), at least 10 min
  TEST_ASSERT_FALSE(f.next(now + 29 * hist::kMin, 0, 14, j));
  TEST_ASSERT_TRUE(f.next(now + 30 * hist::kMin, 0, 14, j));
}

void test_fetch_history_slices_and_live() {
  const int64_t now = 1793025123456LL;
  const Sensor sen{97 * 1000};
  hist::Spec sp = spec("sensor.d", "24h", "1h", "max");
  hist::Spec off = spec("sensor.other", "6h", "15m", "mean");
  hist::Fetcher f;
  f.setTiles({{sp, key(sp), true}, {off, key(off), false}}, true);
  std::string j;
  TEST_ASSERT_TRUE(f.next(now, 60, 20, j));
  TEST_ASSERT_TRUE(j.find("sensor.other") == std::string::npos);   // not on the current app: never asked
  TEST_ASSERT_EQUAL_STRING("hour", field(j, "period").c_str());
  TEST_ASSERT_EQUAL_STRING("[\"max\"", field(j, "types").substr(0, 6).c_str());
  feedAnswer(f, 20, "{}", now);   // no statistics: history, 24 h in 6 h slices
  const hist::Span span = hist::chartSpan(sp.windowMs, sp.bucketMs, now, 60);
  uint32_t id = 21;
  int slices = 0;
  int64_t at = span.start;
  while (f.next(now, 60, id, j)) {
    TEST_ASSERT_EQUAL_STRING("history/history_during_period", field(j, "type").c_str());
    TEST_ASSERT_EQUAL_INT64(at, isoMs(field(j, "start_time")));
    const std::string end = field(j, "end_time");
    const int64_t e = end.empty() ? now : isoMs(end);
    TEST_ASSERT_TRUE(e - at <= hist::kSliceMs);
    TEST_ASSERT_EQUAL_STRING(slices == 0 ? "true" : "false", field(j, "include_start_time_state").c_str());
    feedAnswer(f, id, sen.rows("sensor.d", at, e, slices == 0), now, 61);
    at = e;
    ++id;
    ++slices;
  }
  TEST_ASSERT_EQUAL_INT(4, slices);   // 23 h + the part of the current hour so far
  static hist::Series want, got;
  auto pts = sen.points(span.start, now);
  hist::bucketize(pts.data(), pts.size(), sp.windowMs, sp.bucketMs, sp.agg, now, 60, want);
  int published = 0;
  f.publish(now, [&](const std::string&, const hist::Series* s, hist::FetchState st) {
    ++published;
    TEST_ASSERT_EQUAL(int(hist::FetchState::Ok), int(st));
    sameSeries(want, *s, "history slices");
  });
  TEST_ASSERT_EQUAL_INT(1, published);
  TEST_ASSERT_EQUAL_STRING("history", hist::sourceName(f.info()[0].source));
  // live: changes keep coming over the next 3 h; buckets shift; publish at most every 30 s
  TEST_ASSERT_TRUE(f.watches("sensor.d"));
  TEST_ASSERT_FALSE(f.watches("sensor.x"));
  int64_t t = now;
  int64_t lastPub = now;
  for (int k = 0; k < 400; ++k) {
    t += 27 * 1000;
    double v = sen.at(t * 3);
    pts.push_back({t, v});
    f.live("sensor.d", v, t);
    f.tick(t);
    f.publish(t, [&](const std::string&, const hist::Series* s, hist::FetchState) {
      TEST_ASSERT_TRUE(t - lastPub >= hist::kLiveGapMs || s->start != got.start);
      lastPub = t;
      got = *s;
    });
  }
  f.tick(t + 1);
  f.publish(t + hist::kLiveGapMs, [&](const std::string&, const hist::Series* s, hist::FetchState) { got = *s; });
  // the refetch is due (bucket = 1 h); its result equals what live append built
  hist::bucketize(pts.data(), pts.size(), sp.windowMs, sp.bucketMs, sp.agg, t + hist::kLiveGapMs, 60, want);
  sameSeries(want, got, "live append");
}

void test_fetch_oversized_and_orphan() {
  const int64_t now = 1793025123456LL;
  hist::Spec sp = spec("sensor.chatty", "1h", "1m", "mean");   // under 5 min: history only
  hist::Fetcher f;
  f.setTiles({{sp, key(sp), true}}, true);
  std::string j;
  TEST_ASSERT_TRUE(f.next(now, 0, 30, j));
  TEST_ASSERT_EQUAL_STRING("history/history_during_period", field(j, "type").c_str());
  f.dropped(30, now, 2800000);
  TEST_ASSERT_FALSE(f.inFlight());
  hist::FetchState got = hist::FetchState::Loading;
  f.publish(now, [&](const std::string&, const hist::Series* s, hist::FetchState st) { got = st; TEST_ASSERT_NULL(s); });
  TEST_ASSERT_EQUAL(int(hist::FetchState::TooMany), int(got));
  TEST_ASSERT_FALSE(f.next(now + hist::kDay, 0, 31, j));    // no retry …
  f.setTiles({{sp, key(sp), true}}, false);
  TEST_ASSERT_FALSE(f.next(now + hist::kDay, 0, 31, j));    // … not on an app switch either
  f.setTiles({{sp, key(sp), true}}, true);
  TEST_ASSERT_TRUE(f.next(now + hist::kDay, 0, 31, j));     // … until the config changes
  // the tile leaves while its answer is on the way: the answer is still scanned (owns), then ignored
  f.setTiles({}, true);
  TEST_ASSERT_FALSE(f.inFlight());
  TEST_ASSERT_TRUE(f.owns(31));
  feedAnswer(f, 31, "{\"sensor.chatty\":[{\"s\":\"1\",\"lu\":1793000000}]}", now);
  TEST_ASSERT_FALSE(f.owns(31));
  // a window over 24 h without statistics: needs long-term statistics, no history request
  hist::Spec week = spec("sensor.delay", "7d", "6h", "max");
  f.setTiles({{week, key(week), true}}, true);
  TEST_ASSERT_TRUE(f.next(now, 0, 40, j));
  feedAnswer(f, 40, "{}", now);
  TEST_ASSERT_FALSE(f.next(now, 0, 41, j));
  f.publish(now, [&](const std::string&, const hist::Series*, hist::FetchState st) { got = st; });
  TEST_ASSERT_EQUAL(int(hist::FetchState::NeedsStats), int(got));
  // a timeout gives the request up; the tile is asked again on the next pass
  hist::Spec day = spec("sensor.t", "24h", "1h", "mean");
  f.setTiles({{day, key(day), true}}, true);
  TEST_ASSERT_TRUE(f.next(now, 0, 50, j));
  TEST_ASSERT_FALSE(f.timedOut(now + 59000));
  TEST_ASSERT_TRUE(f.timedOut(now + 60000));
  f.abandon();
  TEST_ASSERT_TRUE(f.next(now + 60000, 0, 51, j));
}

// #292: weather.get_forecasts with return_response, streamed; the span follows now; asked again after kForecastMs.
static hist::Spec widgetSpec(std::initializer_list<std::pair<const char*, const char*>> kv, int cs = 1) {
  Widget w; w.type = "history"; w.cs = cs;
  for (auto& p : kv) w.fields[p.first] = p.second;
  return hist::specOf(w);
}
void test_fetch_forecast() {
  const int64_t now = 1793025123456LL;   // 2026-10-26 13:52 UTC
  hist::Spec sp = widgetSpec({{"entity", "weather.home"}, {"window", "24h"}}, 2);
  TEST_ASSERT_EQUAL(int(hist::Kind::Forecast), int(sp.kind));
  TEST_ASSERT_EQUAL_INT64(hist::kHour, sp.bucketMs);   // 24 bars on a 2-wide tile
  hist::Fetcher f;
  const std::string k = hist::seriesKey(sp);
  f.setTiles({{sp, k, true}}, true);
  TEST_ASSERT_FALSE(f.watches("weather.home"));   // no live appends of a weather state
  std::string j;
  TEST_ASSERT_TRUE(f.next(now, 60, 70, j));
  TEST_ASSERT_EQUAL_STRING("call_service", field(j, "type").c_str());
  TEST_ASSERT_EQUAL_STRING("get_forecasts", field(j, "service").c_str());
  TEST_ASSERT_TRUE(j.find("\"service_data\":{\"type\":\"hourly\"}") != std::string::npos);
  TEST_ASSERT_TRUE(j.find("\"target\":{\"entity_id\":\"weather.home\"}") != std::string::npos);
  TEST_ASSERT_TRUE(j.find("\"return_response\":true") != std::string::npos);
  // 30 hourly entries from the current hour; a decoy "forecast" under context must not count
  hist::SampleList want;
  std::string list;
  const int64_t h0 = now / hist::kHour * hist::kHour;
  for (int i = 0; i < 30; ++i) {
    const double v = 10 + (i % 7) * 0.5;
    list += std::string(i ? "," : "") + "{\"datetime\":\"" + hist::isoUtc(h0 + i * hist::kHour) + "\",\"condition\":\"cloudy\",\"temperature\":" + jsNumber(v) + "}";
    want.push_back({h0 + i * hist::kHour, v});
  }
  const std::string fr0 = "{\"id\":70,\"type\":\"result\",\"success\":true,\"result\":{\"context\":{\"id\":\"x\",\"forecast\":"
                          "[{\"datetime\":\"2026-10-26T14:00:00Z\",\"temperature\":99}]},\"response\":{\"weather.home\":{\"forecast\":[" + list + "]}}}}";
  const long heap0 = gLive, psram0 = psramLiveBytes();
  f.begin(70);
  for (size_t i = 0; i < fr0.size(); i += 7) f.feed(fr0.data() + i, std::min<size_t>(7, fr0.size() - i));
  f.end(now, uint32_t(fr0.size()));
  TEST_ASSERT_EQUAL(heap0, gLive);   // streamed into PSRAM samples: no internal heap
  std::printf("forecast: %u B answer, 30 samples, heap +%ld B, PSRAM +%ld B\n", unsigned(fr0.size()), gLive - heap0, psramLiveBytes() - psram0);
  static hist::Series exp, got;
  hist::fromSamples(want.data(), want.size(), sp, now, 60, exp);
  int pub = 0;
  f.publish(now, [&](const std::string& key, const hist::Series* s, hist::FetchState st) {
    ++pub;
    TEST_ASSERT_EQUAL_STRING(k.c_str(), key.c_str());
    TEST_ASSERT_EQUAL(int(hist::FetchState::Ok), int(st));
    sameSeries(exp, *s, "forecast");
  });
  TEST_ASSERT_EQUAL_INT(1, pub);
  TEST_ASSERT_EQUAL_STRING("forecast", hist::sourceName(f.info()[0].source));
  TEST_ASSERT_EQUAL_UINT32(30, f.info()[0].points);
  // two hours later: the span moved, the same samples re-bucketed
  const int64_t later = now + 2 * hist::kHour;
  f.tick(later);
  f.publish(later, [&](const std::string&, const hist::Series* s, hist::FetchState) { got = *s; });
  hist::fromSamples(want.data(), want.size(), sp, later, 60, exp);
  sameSeries(exp, got, "forecast shifted");
  TEST_ASSERT_FALSE(f.next(now + 30 * hist::kMin, 60, 71, j));
  TEST_ASSERT_TRUE(f.next(now + hist::kForecastMs, 60, 71, j));
  // a failed call (the entity has no such forecast): no samples, None
  std::string fr = "{\"id\":71,\"type\":\"result\",\"success\":false,\"error\":{\"code\":\"service_validation_error\"}}";
  f.begin(71); f.feed(fr.data(), fr.size()); f.end(now + hist::kForecastMs, uint32_t(fr.size()));
  hist::FetchState st = hist::FetchState::Loading;
  f.publish(now + hist::kForecastMs, [&](const std::string&, const hist::Series* s, hist::FetchState x) { st = x; TEST_ASSERT_NULL(s); });
  TEST_ASSERT_EQUAL(int(hist::FetchState::None), int(st));
}

// #292: an attribute list from the mirror: parsed when it changes (not when it does not), again at a bucket boundary.
void test_fetch_attribute() {
  const int64_t now = 1793025123456LL;
  hist::Spec sp = widgetSpec({{"entity", "binary_sensor.rain"}, {"attribute", "forecast"}, {"value", "precipitation"},
                              {"window", "2h"}, {"bucket", "5m"}, {"style", "bars"}}, 4);
  TEST_ASSERT_EQUAL(int(hist::Kind::Attribute), int(sp.kind));
  TEST_ASSERT_EQUAL_INT64(2 * hist::kHour, sp.aheadMs);
  hist::Fetcher f;
  f.setTiles({{sp, hist::seriesKey(sp), true}}, true);
  std::string j;
  TEST_ASSERT_FALSE(f.next(now, 60, 80, j));   // nothing to ask HA
  TEST_ASSERT_TRUE(f.wantsAttr("binary_sensor.rain"));
  TEST_ASSERT_FALSE(f.watches("binary_sensor.rain"));
  TEST_ASSERT_EQUAL(1, int(f.pendingAttr().size()));
  TEST_ASSERT_EQUAL_STRING("forecast", f.attrKeys()[0].second.c_str());
  auto text = [&](double peak) {
    std::string s = "[";
    for (int i = 0; i < 49; ++i)
      s += std::string(i ? "," : "") + "{\"datetime\":\"" + hist::isoUtc(now / (5 * hist::kMin) * 5 * hist::kMin + (i - 24) * 5 * hist::kMin) +
           "\",\"precipitation\":" + jsNumber(i == 30 ? peak : 0.1 * (i % 3)) + "}";
    return PStr(s + "]");
  };
  PStr a = text(2.5);
  auto get = [&](const std::string& name) -> const PStr* { return name == "forecast" ? &a : nullptr; };
  const long heap0 = gLive;
  f.feedAttr("binary_sensor.rain", now, 60, get);
  TEST_ASSERT_EQUAL(heap0, gLive);   // parsed into PSRAM samples: no internal heap
  TEST_ASSERT_EQUAL(0, int(f.pendingAttr().size()));
  static hist::Series exp, got;
  static hist::ListScanner sc;
  hist::SampleList smp;
  hist::attrSamples(sc, a.data(), a.size(), sp, now, 60, smp);
  TEST_ASSERT_EQUAL(49, int(smp.size()));
  hist::fromSamples(smp.data(), smp.size(), sp, now, 60, exp);
  int pub = 0;
  f.publish(now, [&](const std::string&, const hist::Series* s, hist::FetchState st) { ++pub; TEST_ASSERT_EQUAL(int(hist::FetchState::Ok), int(st)); got = *s; });
  TEST_ASSERT_EQUAL_INT(1, pub);
  sameSeries(exp, got, "attribute");
  // the chart: Now first, "+30 +60 +90"; the bucket holding now marked
  hist::Chart ch;
  hist::chart(sp, &got, hist::State::Ok, now, 60, Lang::En, ch);
  TEST_ASSERT_EQUAL_STRING("Now", ch.ticks[0].text);
  TEST_ASSERT_EQUAL_STRING("+30", ch.ticks[1].text);
  TEST_ASSERT_EQUAL_INT(0, ch.latest);
  // same text: nothing to publish; a new text: published
  f.feedAttr("binary_sensor.rain", now + 1000, 60, get);
  pub = 0;
  f.publish(now + 1000, [&](const std::string&, const hist::Series*, hist::FetchState) { ++pub; });
  TEST_ASSERT_EQUAL_INT(0, pub);
  a = text(4.0);
  f.feedAttr("binary_sensor.rain", now + 2000, 60, get);
  f.publish(now + 2000, [&](const std::string&, const hist::Series* s, hist::FetchState) { ++pub; got = *s; });
  TEST_ASSERT_EQUAL_INT(1, pub);
  // a bucket boundary: parsed again for the new span
  const int64_t later = now + 5 * hist::kMin;
  f.tick(later);
  TEST_ASSERT_EQUAL(1, int(f.pendingAttr().size()));
  f.feedAttr("binary_sensor.rain", later, 60, get);
  f.publish(later, [&](const std::string&, const hist::Series* s, hist::FetchState) { got = *s; });
  hist::attrSamples(sc, a.data(), a.size(), sp, later, 60, smp);
  hist::fromSamples(smp.data(), smp.size(), sp, later, 60, exp);
  sameSeries(exp, got, "attribute shifted");
  // the attribute gone: None
  f.feedAttr("binary_sensor.rain", later, 60, [](const std::string&) -> const PStr* { return nullptr; });
  hist::FetchState st = hist::FetchState::Ok;
  f.publish(later, [&](const std::string&, const hist::Series* s, hist::FetchState x) { st = x; TEST_ASSERT_NULL(s); });
  TEST_ASSERT_EQUAL(int(hist::FetchState::None), int(st));
}

// Memory: a 6 h answer of a 1 Hz sensor (~0.6 MB) streams through without one heap byte outside PsramAlloc, and the
// tile state is PSRAM only.
void test_fetch_heap() {
  const int64_t now = 1793025123456LL;
  hist::Spec sp = spec("sensor.p", "6h", "1m", "mean");
  hist::Fetcher f;
  long psram0 = psramLiveBytes();
  f.setTiles({{sp, key(sp), true}}, true);
  std::string j;
  TEST_ASSERT_TRUE(f.next(now, 0, 60, j));
  std::string fr = "{\"id\":60,\"type\":\"result\",\"success\":true,\"result\":{\"sensor.p\":[";
  const hist::Span span = hist::chartSpan(sp.windowMs, sp.bucketMs, now, 0);
  for (int64_t t = span.start; t < now; t += 1000)
    fr += std::string(t == span.start ? "" : ",") + "{\"s\":\"" + std::to_string(400 + (t / 1000) % 97) + "\",\"lu\":" + jsNumber(double(t) / 1000) + "}";
  fr += "]}}";
  TEST_ASSERT_TRUE(fr.size() > 512 * 1024);
  const long heap0 = gLive;
  f.begin(60);
  for (size_t i = 0; i < fr.size(); i += 2048) f.feed(fr.data() + i, std::min<size_t>(2048, fr.size() - i));
  TEST_ASSERT_EQUAL(heap0, gLive);   // streaming: no allocation at all
  f.end(now, uint32_t(fr.size()));
  long tile = psramLiveBytes() - psram0;
  std::printf("history fetch: %u B answer streamed, heap +%ld B, tile state %ld B PSRAM\n", unsigned(fr.size()), gLive - heap0, tile);
  TEST_ASSERT_TRUE(tile < 16 * 1024);
  TEST_ASSERT_EQUAL_UINT32(uint32_t(f.info()[0].points), uint32_t((now - span.start + 999) / 1000));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_scanner_shapes);
  RUN_TEST(test_vectors_through_scanner);
  RUN_TEST(test_accum_live_shift_matches_bucketize);
  RUN_TEST(test_fetch_statistics_then_tail);
  RUN_TEST(test_fetch_history_slices_and_live);
  RUN_TEST(test_fetch_oversized_and_orphan);
  RUN_TEST(test_fetch_heap);
  RUN_TEST(test_fetch_forecast);
  RUN_TEST(test_fetch_attribute);
  return UNITY_END();
}
