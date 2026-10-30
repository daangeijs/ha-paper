// core/agenda (#316) against spec/test-vectors/agenda.json: config rules, the request text, titles, the streaming
// scanner over whole result frames in several chunkings, the tile lines / next view, the fetch plan and the cache.
#include <unity.h>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include "core/agenda.h"
#include "core/config.h"
#include "core/json.h"

using namespace x4;

void setUp() {}
void tearDown() {}

static std::string readFile(const std::string& p) {
  std::ifstream f(p, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}
static Json gV;
static const Json& V() {
  if (gV.isObj()) return gV;
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/agenda.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/agenda.json missing");
  TEST_ASSERT_TRUE(parseJson(t, gV));
  return gV;
}
static int64_t I(const Json* j) { return int64_t(j->num); }
static Lang langOfJ(const Json& j) { return j.get("lang")->str == "nl" ? Lang::Nl : Lang::En; }

void test_config() {
  for (auto& c : V().get("config")->arr) {
    const std::string name = c.get("name")->str;
    ParseResult r = parseConfig(c.get("input")->str);
    const Json* ex = c.get("expect");
    TEST_ASSERT_EQUAL_MESSAGE(ex->get("ok")->b, r.ok, (name + ": " + r.message).c_str());
    if (!r.ok) {
      TEST_ASSERT_EQUAL_INT_MESSAGE(int(ex->get("line")->num), r.line, name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(ex->get("message")->str.c_str(), r.message.c_str(), name.c_str());
    } else {
      TEST_ASSERT_EQUAL_STRING_MESSAGE(ex->get("yaml")->str.c_str(), toYaml(r.config).c_str(), name.c_str());
    }
  }
}

void test_key_request_title() {
  for (auto& c : V().get("key")->arr) TEST_ASSERT_EQUAL_STRING(c.get("key")->str.c_str(), agenda::keyOf(c.get("widget")->get("entities")->str).c_str());
  for (auto& c : V().get("request")->arr)
    TEST_ASSERT_EQUAL_STRING(c.get("out")->str.c_str(), agenda::request(c.get("key")->str, I(c.get("now")), int(c.get("tz")->num), uint32_t(c.get("id")->num)).c_str());
  for (auto& c : V().get("title")->arr) TEST_ASSERT_EQUAL_STRING(c.get("out")->str.c_str(), agenda::cutTitle(c.get("input")->str).c_str());
}

static void expectFetch(const Json* out, const agenda::Fetch& f, const std::string& name) {
  TEST_ASSERT_EQUAL_INT_MESSAGE(int(out->get("events")->arr.size()), int(f.events.size()), name.c_str());
  TEST_ASSERT_EQUAL_INT_MESSAGE(int(out->get("more")->num), f.more, name.c_str());
  for (size_t i = 0; i < f.events.size(); ++i) {
    const Json& e = out->get("events")->arr[i];
    const auto& g = f.events[i];
    const std::string at = name + " #" + std::to_string(i);
    TEST_ASSERT_TRUE_MESSAGE(I(e.get("start")) == g.start, at.c_str());
    TEST_ASSERT_TRUE_MESSAGE(I(e.get("end")) == g.end, at.c_str());
    TEST_ASSERT_EQUAL_MESSAGE(e.get("allDay")->b, g.allDay, at.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(e.get("cal")->num), int(g.cal), at.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(e.get("title")->str.c_str(), g.text().c_str(), at.c_str());
  }
}

void test_scanner_vectors() {
  int n = 0;
  for (auto& c : V().get("parse")->arr) {
    const std::string name = c.get("name")->str, frame = c.get("frame")->str;
    for (size_t chunk : {size_t(1), size_t(7), size_t(64), frame.size()}) {
      agenda::Fetch f;
      agenda::Scanner s;
      s.begin(c.get("key")->str, I(c.get("now")), int(c.get("tz")->num), &f);
      for (size_t i = 0; i < frame.size(); i += chunk) s.feed(frame.data() + i, std::min(chunk, frame.size() - i));
      const Json* out = c.get("out");
      const std::string at = name + " /" + std::to_string(chunk);
      TEST_ASSERT_EQUAL_MESSAGE(!out->isNull(), s.ok(), at.c_str());
      if (!out->isNull()) expectFetch(out, f, at);
      ++n;
    }
  }
  TEST_ASSERT_GREATER_THAN(20, n);
}

static agenda::Fetch fetchOf(const Json* j) {
  agenda::Fetch f;
  f.more = int(j->get("more")->num);
  for (auto& e : j->get("events")->arr) {
    agenda::Event x;
    x.start = I(e.get("start")); x.end = I(e.get("end")); x.allDay = e.get("allDay")->b; x.cal = uint8_t(e.get("cal")->num);
    const std::string t = e.get("title")->str;
    std::snprintf(x.title, sizeof x.title, "%s", t.c_str());
    x.len = uint8_t(t.size());
    f.events.push_back(x);
  }
  return f;
}

static void expectLines(const Json* want, const agenda::Lines& got, const std::string& name) {
  TEST_ASSERT_EQUAL_INT_MESSAGE(int(want->get("more")->num), got.more, name.c_str());
  const auto& L = want->get("lines")->arr;
  TEST_ASSERT_EQUAL_INT_MESSAGE(int(L.size()), int(got.lines.size()), name.c_str());
  for (size_t i = 0; i < L.size(); ++i) {
    const std::string at = name + " line " + std::to_string(i);
    if (const Json* d = L[i].get("day")) {
      TEST_ASSERT_TRUE_MESSAGE(got.lines[i].day, at.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(d->str.c_str(), got.lines[i].text.c_str(), at.c_str());
    } else {
      TEST_ASSERT_FALSE_MESSAGE(got.lines[i].day, at.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(L[i].get("time")->str.c_str(), got.lines[i].time.c_str(), at.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(L[i].get("title")->str.c_str(), got.lines[i].text.c_str(), at.c_str());
      TEST_ASSERT_EQUAL_MESSAGE(L[i].get("allDay")->b, got.lines[i].allDay, at.c_str());
    }
  }
}

void test_view_vectors() {
  for (auto& c : V().get("views")->arr) {
    const agenda::Fetch f = fetchOf(c.get("fetch"));
    const int64_t now = I(c.get("now"));
    const int tz = int(c.get("tz")->num);
    for (auto& o : c.get("out")->arr) {
      const Lang l = langOfJ(o);
      const std::string name = c.get("name")->str + " " + o.get("lang")->str;
      expectLines(o.get("lines4"), agenda::lines(f, now, tz, l, 4), name + " 4");
      expectLines(o.get("lines11"), agenda::lines(f, now, tz, l, 11), name + " 11");
      agenda::Next n = agenda::next(f, now, tz, l);
      const Json* nx = o.get("next");
      TEST_ASSERT_EQUAL_MESSAGE(!nx->isNull(), n.has, name.c_str());
      if (nx->isNull()) continue;
      TEST_ASSERT_EQUAL_STRING_MESSAGE(nx->get("title")->str.c_str(), n.title.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(nx->get("when")->str.c_str(), n.when.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(nx->get("pill")->str.c_str(), n.pill.c_str(), name.c_str());
      TEST_ASSERT_TRUE_MESSAGE(I(nx->get("mins")) == n.mins, name.c_str());
    }
  }
}

// The plan: one call in flight, every 30 min and at the local day change, 5 min after a failure; the cache brings the
// events back without a call while they are fresh.
void test_fetcher_plan_and_cache() {
  const Json& demo = V().get("parse")->arr[0];
  const std::string key = demo.get("key")->str, frame = demo.get("frame")->str;
  const int64_t t0 = I(demo.get("now"));
  const int tz = 60;
  agenda::Fetcher f;
  f.setKeys({key, key});
  TEST_ASSERT_EQUAL_INT(1, int(f.size()));
  std::string j;
  TEST_ASSERT_TRUE(f.next(t0, tz, 5, j));
  TEST_ASSERT_TRUE(j.find("\"id\":5,") != std::string::npos);
  TEST_ASSERT_FALSE(f.next(t0, tz, 6, j));   // one in flight
  TEST_ASSERT_TRUE(f.owns(5));
  f.begin(5);
  f.feed(frame.data(), frame.size());
  TEST_ASSERT_TRUE(f.end(t0 + 500));
  int calls = 0;
  f.publish([&](const std::string& k, agenda::State st, const agenda::Fetch& x) {
    ++calls;
    TEST_ASSERT_EQUAL_STRING(key.c_str(), k.c_str());
    TEST_ASSERT_TRUE(st == agenda::State::Ok);
    expectFetch(demo.get("out"), x, "fetcher");
  });
  TEST_ASSERT_EQUAL_INT(1, calls);
  TEST_ASSERT_FALSE(f.next(t0 + 29 * agenda::kMin, tz, 7, j));
  TEST_ASSERT_TRUE(f.next(t0 + 31 * agenda::kMin, tz, 7, j));
  f.begin(7);
  const std::string bad = "{\"id\":7,\"type\":\"result\",\"success\":false}";
  f.feed(bad.data(), bad.size());
  TEST_ASSERT_FALSE(f.end(t0 + 31 * agenda::kMin));   // keeps the events it had
  TEST_ASSERT_FALSE(f.next(t0 + 33 * agenda::kMin, tz, 8, j));   // retry after 5 min
  TEST_ASSERT_TRUE(f.next(t0 + 37 * agenda::kMin, tz, 8, j));
  f.abandon();
  // cache: a new Fetcher (reboot) gets the events back
  const std::string saved = f.save();
  agenda::Fetcher g;
  g.setKeys({key});
  g.load(saved);
  calls = 0;
  g.publish([&](const std::string&, agenda::State st, const agenda::Fetch& x) { ++calls; TEST_ASSERT_TRUE(st == agenda::State::Ok); expectFetch(demo.get("out"), x, "cache"); });
  TEST_ASSERT_EQUAL_INT(1, calls);
  TEST_ASSERT_FALSE(g.next(t0 + 10 * agenda::kMin, tz, 9, j));   // fresh: no call after the wake
  // the local day changes at 23:00 UTC (tz 60): asked again
  const int64_t midnight = (agenda::dayOf(t0, tz) + 1) * agenda::kDay - tz * agenda::kMin;
  agenda::Fetcher h;
  h.setKeys({key});
  h.load(saved);
  TEST_ASSERT_TRUE(h.next(midnight + 1000, tz, 10, j));
  // another config: its sets only
  g.setKeys({"calendar.work"});
  TEST_ASSERT_EQUAL_INT(1, int(g.size()));
  TEST_ASSERT_TRUE(g.next(t0, tz, 11, j));
  TEST_ASSERT_TRUE(j.find("[\"calendar.work\"]") != std::string::npos);
}

void test_glyphs_in_titles() {
  // é ë ü stay whole when the cut lands inside them
  TEST_ASSERT_EQUAL_STRING("Caf\xc3\xa9 with Zo\xc3\xab", agenda::cutTitle("Caf\xc3\xa9 with Zo\xc3\xab").c_str());
  std::string u = std::string(47, 'a') + "\xc3\xbc";
  TEST_ASSERT_EQUAL_INT(47, int(agenda::cutTitle(u).size()));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_config);
  RUN_TEST(test_key_request_title);
  RUN_TEST(test_scanner_vectors);
  RUN_TEST(test_view_vectors);
  RUN_TEST(test_fetcher_plan_and_cache);
  RUN_TEST(test_glyphs_in_titles);
  return UNITY_END();
}
