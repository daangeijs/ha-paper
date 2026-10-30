// core/attr_list + the ingest cap in core/ha_stream (eink-ha-os#332) against spec/test-vectors/attr-list.json (emulator
// src/core/attrList.ts).
#include <unity.h>
#include <ArduinoJson.h>
#include <fstream>
#include <sstream>
#include <string>
#include "core/attr_list.h"
#include "core/config.h"
#include "core/ha_stream.h"
#include "core/json.h"

using namespace x4;

void setUp() {}
void tearDown() {}

static bool load(Json& j) {
  std::ifstream f(std::string(X4_REPO_ROOT) + "/spec/test-vectors/attr-list.json", std::ios::binary);
  std::stringstream ss; ss << f.rdbuf();
  return !ss.str().empty() && parseJson(ss.str(), j);
}
static Lang langOf(const Json& c) { return c.get("lang")->str == "nl" ? Lang::Nl : Lang::En; }

void test_ago_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  const int64_t now = int64_t(j.get("now")->num);
  const int tz = int(j.get("tz")->num);
  int n = 0;
  for (auto& c : j.get("ago")->arr) {
    const Json& v = *c.get("v");
    std::string got = alist::ago(v.str, v.isNum(), v.num, now, tz, langOf(c));
    std::string name = (v.isNum() ? std::to_string(int64_t(v.num)) : v.str) + " " + c.get("lang")->str;
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->str.c_str(), got.c_str(), name.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_THAN(30, n);
}

void test_rows_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  for (auto& c : j.get("rows")->arr) {
    alist::Rows r = alist::rowsFor(int(c.get("cs")->num), int(c.get("rs")->num));
    TEST_ASSERT_EQUAL_INT(int(c.get("rows")->num), r.rows);
    TEST_ASSERT_EQUAL(c.get("oneLine")->b, r.oneLine);
  }
}

void test_view_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  const int64_t now = int64_t(j.get("now")->num);
  const int tz = int(j.get("tz")->num);
  int n = 0;
  for (auto& c : j.get("views")->arr) {
    Widget w;
    w.type = "attrList";
    for (auto& kv : c.get("w")->obj) w.fields[kv.first] = kv.second.str;
    const std::string name = c.get("name")->str + " " + c.get("lang")->str;
    alist::View v = alist::view(c.get("value")->str.c_str(), alist::specOf(w), now, tz, langOf(c), int(c.get("max")->num));
    const Json& o = *c.get("out");
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(o.get("rows")->arr.size()), int(v.rows.size()), name.c_str());
    for (size_t k = 0; k < v.rows.size(); ++k) {
      const Json& r = o.get("rows")->arr[k];
      TEST_ASSERT_EQUAL_STRING_MESSAGE(r.get("title")->str.c_str(), v.rows[k].title.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(r.get("sub")->str.c_str(), v.rows[k].sub.c_str(), name.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(r.get("ago")->str.c_str(), v.rows[k].ago.c_str(), name.c_str());
    }
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(o.get("more")->num), v.more, name.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_THAN(10, n);
}

void test_cap_vectors() {
  Json j; TEST_ASSERT_TRUE(load(j));
  for (auto& c : j.get("cap")->arr) {
    ArduinoJson::JsonDocument d;
    TEST_ASSERT_FALSE(deserializeJson(d, c.get("value")->str));
    const std::string out = capListText(d.as<ArduinoJson::JsonVariantConst>(), alist::kMaxItems, alist::kMaxBytes);
    const int kept = int(c.get("kept")->num);
    if (kept < 0) { TEST_ASSERT_EQUAL_STRING(c.get("value")->str.c_str(), out.c_str()); continue; }
    Json o; TEST_ASSERT_TRUE(parseJson(out, o));
    TEST_ASSERT_EQUAL_INT_MESSAGE(kept, int(o.arr.size()), c.get("name")->str.c_str());
    TEST_ASSERT_TRUE(out.size() <= alist::kMaxBytes);
  }
}

// The stream keeps a list tile's attribute only for its entity, capped; another entity's list is dropped.
void test_ingest_keeps_capped_list() {
  setListAttrs({{"sensor.rare_birds_nearby", "sightings"}, {"sensor.rare_birds_nearby", "attribution"}});
  std::string big = "[";
  for (int k = 0; k < 30; ++k) big += std::string(k ? "," : "") + "{\"species\":\"Soort " + std::to_string(k) + "\",\"notes\":\"" + std::string(300, 'x') + "\"}";
  big += "]";
  const std::string ev = "{\"a\":{\"sensor.rare_birds_nearby\":{\"s\":\"30\",\"a\":{\"sightings\":" + big +
                         ",\"attribution\":\"Data: example\",\"icon\":\"mdi:bird\"}},\"sensor.other\":{\"s\":\"1\",\"a\":{\"sightings\":" + big + "}}}}";
  ArduinoJson::JsonDocument d;
  TEST_ASSERT_FALSE(deserializeJson(d, ev));
  PMap<EntityValue> mirror;
  EntityUpdates out;
  applyEntityEvent(d.as<ArduinoJson::JsonObjectConst>(), mirror, out);
  const EntityValue& b = mirror["sensor.rare_birds_nearby"];
  TEST_ASSERT_EQUAL_INT(2, int(b.attrs.size()));
  TEST_ASSERT_EQUAL_STRING("Data: example", b.attrs.at("attribution").c_str());
  TEST_ASSERT_TRUE(b.attrs.at("sightings").size() <= alist::kMaxBytes);
  Json kept; TEST_ASSERT_TRUE(parseJson(b.attrs.at("sightings").c_str(), kept));
  TEST_ASSERT_EQUAL_INT(9, int(kept.arr.size()));   // 9 × ~330 B fit in 3072
  TEST_ASSERT_EQUAL_INT(0, int(mirror["sensor.other"].attrs.size()));
  TEST_ASSERT_FALSE(setListAttrs({{"sensor.rare_birds_nearby", "sightings"}, {"sensor.rare_birds_nearby", "attribution"}}));
  TEST_ASSERT_TRUE(setListAttrs({}));
}

void test_config_keys() {
  ParseResult r = parseYamlText("version: 1\nscreens:\n  - id: a\n    widgets:\n"
                                "      - {type: attrList, entity: sensor.rare_birds_nearby, cs: 2, rs: 2}\n"
                                "      - {type: attrList, entity: sensor.board, attribute: trains, cs: 2, rs: 2}\n");
  TEST_ASSERT_TRUE(r.ok);
  auto k = alist::attrKeys(r.config);
  TEST_ASSERT_EQUAL_INT(4, int(k.size()));
  TEST_ASSERT_EQUAL_STRING("sightings", k[0].second.c_str());
  TEST_ASSERT_EQUAL_STRING("trains", k[2].second.c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_ago_vectors);
  RUN_TEST(test_rows_vectors);
  RUN_TEST(test_view_vectors);
  RUN_TEST(test_cap_vectors);
  RUN_TEST(test_ingest_keeps_capped_list);
  RUN_TEST(test_config_keys);
  return UNITY_END();
}
