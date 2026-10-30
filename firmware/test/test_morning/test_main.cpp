// core/morning (eink-ha-os#330) against spec/test-vectors/morning.json (emulator src/core/morning.ts).
#include <unity.h>
#include <cmath>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include "core/json.h"
#include "core/morning.h"

using namespace x4;

void setUp() {}
void tearDown() {}

static bool load(Json& j) {
  std::ifstream f(std::string(X4_REPO_ROOT) + "/spec/test-vectors/morning.json", std::ios::binary);
  std::stringstream ss; ss << f.rdbuf();
  return !ss.str().empty() && parseJson(ss.str(), j);
}

void test_constants() {
  Json j; TEST_ASSERT_TRUE(load(j));
  TEST_ASSERT_EQUAL_INT64(morning::kMs, int64_t(j.get("morningMs")->num));
  TEST_ASSERT_EQUAL_INT(morning::kEvents, int(j.get("maxEvents")->num));
}

void test_step_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  int n = 0;
  for (auto& c : j.get("steps")->arr) {
    morning::State s;
    for (auto& k : c.get("ticks")->arr) {
      const Json& t = *k.get("tick");
      const Json& o = *k.get("out");
      morning::Step st = morning::step(s, {int64_t(t.get("now")->num), int(t.get("hour")->num), t.get("clockKnown")->b,
                                           t.get("quiet")->str, t.get("enabled")->b});
      const char* name = c.get("name")->str.c_str();
      TEST_ASSERT_EQUAL_MESSAGE(o.get("armed")->b, st.s.armed != 0, name);
      TEST_ASSERT_EQUAL_INT64_MESSAGE(int64_t(o.get("until")->num), st.s.until, name);
      TEST_ASSERT_EQUAL_MESSAGE(o.get("start")->b, st.start, name);
      TEST_ASSERT_EQUAL_MESSAGE(o.get("end")->b, st.end, name);
      s = st.s;
      ++n;
    }
  }
  TEST_ASSERT_GREATER_THAN(15, n);
}

void test_sources_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  for (auto& c : j.get("sources")->arr) {
    std::vector<Screen> scs;
    for (auto& s : c.get("screens")->arr) {
      Screen sc;
      for (auto& w : s.get("widgets")->arr) {
        Widget x;
        for (auto& kv : w.obj) { if (kv.first == "type") x.type = kv.second.str; else x.fields[kv.first] = kv.second.str; }
        sc.widgets.push_back(x);
      }
      scs.push_back(sc);
    }
    quiet::Sources o = quiet::sources(scs);
    const Json& want = *c.get("out");
    auto check = [&](const char* k, const quiet::Ref& r) {
      const Json* w = want.get(k);
      std::string m = c.get("name")->str + " " + k;
      if (w->isNull()) { TEST_ASSERT_TRUE_MESSAGE(r.screen < 0, m.c_str()); return; }
      TEST_ASSERT_EQUAL_INT_MESSAGE(int(w->arr[0].num), r.screen, m.c_str());
      TEST_ASSERT_EQUAL_INT_MESSAGE(int(w->arr[1].num), r.widget, m.c_str());
    };
    check("weather", o.weather);
    check("agenda", o.agenda);
    check("bins", o.bins);
  }
}

static wx::Icon iconOf(const std::string& n) {
  for (int i = 0; i < int(wx::Icon::Count); ++i) if (n == wx::iconName(wx::Icon(i))) return wx::Icon(i);
  return wx::Icon::Cloud;
}
static void entries(const Json* list, wx::Entry* out, uint8_t& n, uint8_t& has) {
  n = 0; has = 0;
  if (!list || list->isNull()) return;
  has = 1;
  for (auto& e : list->arr) {
    wx::Entry x = {};
    x.tS = uint32_t(int64_t(e.get("t")->num) / 1000);
    auto t100 = [](const Json* v) { return v->isNull() ? wx::kNoT : int16_t(std::lround(v->num * 100)); };
    x.temp = t100(e.get("temp"));
    x.low = t100(e.get("low"));
    x.mm = e.get("mm")->isNull() ? wx::kNoMm : uint16_t(std::lround(e.get("mm")->num * 100));
    x.icon = uint8_t(iconOf(e.get("icon")->str));
    out[n++] = x;
  }
}

void test_view_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  int n = 0;
  for (auto& c : j.get("views")->arr) {
    const std::string name = c.get("name")->str + " " + c.get("lang")->str;
    wx::Forecast fc;
    entries(c.get("daily"), fc.daily, fc.nDaily, fc.hasDaily);
    entries(c.get("hourly"), fc.hourly, fc.nHourly, fc.hasHourly);
    const bool hasFc = fc.hasDaily || fc.hasHourly;
    agenda::Fetch f;
    const bool hasEv = !c.get("events")->isNull();
    if (hasEv) {
      for (auto& e : c.get("events")->get("events")->arr) {
        agenda::Event x;
        x.start = int64_t(e.get("start")->num); x.end = int64_t(e.get("end")->num);
        x.allDay = e.get("allDay")->b; x.cal = uint8_t(e.get("cal")->num);
        const std::string t = e.get("title")->str;
        x.len = uint8_t(t.size()); std::memcpy(x.title, t.data(), t.size());
        f.events.push_back(x);
      }
      f.more = int(c.get("events")->get("more")->num);
    }
    std::vector<morning::Bin> bins;
    const bool hasBins = !c.get("bins")->isNull();
    if (hasBins)
      for (auto& b : c.get("bins")->arr) bins.push_back({b.get("label")->str, b.get("days")->isNull() ? -1 : int(b.get("days")->num)});
    morning::View v = morning::view({int64_t(c.get("now")->num), int(c.get("tz")->num), c.get("lang")->str == "nl" ? Lang::Nl : Lang::En,
                                     hasFc ? &fc : nullptr, hasEv ? &f : nullptr, hasBins ? &bins : nullptr});
    const Json& o = *c.get("out");
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("head")->str.c_str(), v.head.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("date")->str.c_str(), v.date.c_str(), name.c_str());
    const Json* w = o.get("weather");
    TEST_ASSERT_EQUAL_MESSAGE(!w->isNull(), v.weather, name.c_str());
    if (!w->isNull()) {
      TEST_ASSERT_EQUAL_STRING_MESSAGE(w->get("temps")->str.c_str(), v.temps.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(w->get("rain")->str.c_str(), v.rain.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(w->get("icon")->str.c_str(), v.hasIcon ? wx::iconName(v.icon) : "", name.c_str());
    }
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(o.get("events")->arr.size()), int(v.events.size()), name.c_str());
    for (size_t k = 0; k < v.events.size(); ++k) {
      TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("events")->arr[k].get("time")->str.c_str(), v.events[k].time.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("events")->arr[k].get("title")->str.c_str(), v.events[k].title.c_str(), name.c_str());
    }
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("more")->str.c_str(), v.more.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(o.get("bins")->arr.size()), int(v.bins.size()), name.c_str());
    for (size_t k = 0; k < v.bins.size(); ++k) {
      TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("bins")->arr[k].get("labels")->str.c_str(), v.bins[k].labels.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("bins")->arr[k].get("when")->str.c_str(), v.bins[k].when.c_str(), name.c_str());
    }
    ++n;
  }
  TEST_ASSERT_EQUAL_INT(14, n);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_constants);
  RUN_TEST(test_step_vectors);
  RUN_TEST(test_sources_vectors);
  RUN_TEST(test_view_vectors);
  return UNITY_END();
}
