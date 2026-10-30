// core/bins (eink-ha-os#317) against spec/test-vectors/bins.json (emulator src/core/bins.ts).
#include <unity.h>
#include <fstream>
#include <sstream>
#include <string>
#include "core/bins.h"
#include "core/json.h"

using namespace x4;

void setUp() {}
void tearDown() {}

static bool load(Json& j) {
  std::ifstream f(std::string(X4_REPO_ROOT) + "/spec/test-vectors/bins.json", std::ios::binary);
  std::stringstream ss; ss << f.rdbuf();
  return !ss.str().empty() && parseJson(ss.str(), j);
}
static EntityValue entity(const Json& c) {
  EntityValue e;
  e.state = c.get("state")->str;
  for (auto& kv : c.get("attrs")->obj) e.attrs[kv.first] = kv.second.str;
  return e;
}

void test_days_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  int n = 0;
  for (auto& c : j.get("days")->arr) {
    EntityValue e = entity(c);
    int want = c.get("out")->isNull() ? bins::kUnknown : int(c.get("out")->num);
    TEST_ASSERT_EQUAL_INT_MESSAGE(want, bins::days(&e, int64_t(c.get("now")->num), int(c.get("tz")->num)), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_THAN(15, n);
}

void test_view_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  int n = 0;
  for (auto& c : j.get("views")->arr) {
    std::vector<EntityValue> ev;
    for (auto& b : c.get("bins")->arr) ev.push_back(entity(b));
    std::vector<bins::In> in;
    for (size_t k = 0; k < ev.size(); ++k) in.push_back({c.get("bins")->arr[k].get("label")->str, &ev[k]});
    std::string name = c.get("name")->str + " " + c.get("lang")->str;
    bins::View v = bins::view(in, int64_t(c.get("now")->num), int(c.get("tz")->num), int(c.get("tonight")->num),
                              c.get("lang")->str == "nl" ? Lang::Nl : Lang::En);
    const Json& o = *c.get("out");
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(o.get("rows")->arr.size()), int(v.rows.size()), name.c_str());
    for (size_t k = 0; k < v.rows.size(); ++k) {
      const Json& r = o.get("rows")->arr[k];
      TEST_ASSERT_EQUAL_STRING_MESSAGE(r.get("label")->str.c_str(), v.rows[k].label.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_INT_MESSAGE(int(r.get("days")->num), v.rows[k].days, name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(r.get("when")->str.c_str(), v.rows[k].when.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(r.get("date")->str.c_str(), v.rows[k].date.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(r.get("short")->str.c_str(), v.rows[k].shortDate.c_str(), name.c_str());
    }
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("head")->str.c_str(), v.head.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("big")->str.c_str(), v.big.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("line")->str.c_str(), v.line.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("foot")->str.c_str(), v.foot.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(o.get("pill")->str.c_str(), v.pill.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_MESSAGE(o.get("tonight")->b, v.tonight, name.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(o.get("rest")->arr.size()), int(v.rows.size() - v.restFrom), name.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_THAN(15, n);
}

void test_inputs_labels_and_tonight() {
  EntityStore st;
  EntityValue a; a.state = "2026-10-29"; a.attrs["friendly_name"] = "Afval papier"; st.set("sensor.a", a);
  auto in = bins::inputs("sensor.a sensor.b", "sensor.b=Plastic", st);
  TEST_ASSERT_EQUAL_INT(2, int(in.size()));
  TEST_ASSERT_EQUAL_STRING("Afval papier", in[0].label.c_str());
  TEST_ASSERT_EQUAL_STRING("Plastic", in[1].label.c_str());
  TEST_ASSERT_NULL(in[1].v);
  TEST_ASSERT_EQUAL_INT(17, bins::tonightHour(""));
  TEST_ASSERT_EQUAL_INT(20, bins::tonightHour("20"));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_days_vectors);
  RUN_TEST(test_view_vectors);
  RUN_TEST(test_inputs_labels_and_tonight);
  return UNITY_END();
}
