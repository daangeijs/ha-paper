// core/ha_stream: subscribe_entities events → entity mirror, attribute whitelist (eink-ha-os#76). Also measures what the mirror
// costs on the heap for a big house, before (every attribute) and after (whitelist).
#include <ArduinoJson.h>
#include <unity.h>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <set>
#include <string>
#include "core/ha_stream.h"

using namespace x4;

// ---- heap accounting: every operator new / delete in this binary (PsramAlloc counts its own: psramLiveBytes) ----
static long gLive = 0, gBlocks = 0;
void* operator new(size_t n) {
  auto* p = static_cast<size_t*>(std::malloc(n + 16));
  if (!p) throw std::bad_alloc();
  *p = n; gLive += long(n); ++gBlocks;
  return reinterpret_cast<char*>(p) + 16;
}
void operator delete(void* q) noexcept {
  if (!q) return;
  auto* p = reinterpret_cast<size_t*>(static_cast<char*>(q) - 16);
  gLive -= long(*p); --gBlocks;
  std::free(p);
}
void operator delete(void* q, size_t) noexcept { operator delete(q); }

void setUp() {}
void tearDown() {}

// One entity as the fake HA's big house sends it (emulator/server/fake-ha-big.ts): 6–10 attributes; `extra` adds the
// five more a Zigbee2MQTT / camera entity often has (13 for a light).
static void bigEntity(JsonObject a, int i, std::string& id, bool extra = false) {
  static const char* rooms[] = {"Living room", "Kitchen", "Bedroom upstairs (east)", "Garage", "Garden shed", "Attic", "Hallway"};
  static const char* doms[] = {"sensor", "sensor", "sensor", "binary_sensor", "switch", "light", "number"};
  static const char* dcs[] = {"temperature", "power", "signal_strength", "motion", nullptr, nullptr, nullptr};
  static const char* units[] = {"°C", "W", "dBm", nullptr, nullptr, nullptr, "%"};
  const int k = i % 7;
  id = std::string(doms[k]) + ".bulk_" + std::to_string(i);
  JsonObject o = a[id].to<JsonObject>();
  o["s"] = std::to_string(i % 100);
  o["c"] = "";
  o["lc"] = 1791885600 + i;
  JsonObject at = o["a"].to<JsonObject>();
  char hex[16]; std::snprintf(hex, sizeof hex, "%x", 0x1000 + i);
  at["friendly_name"] = std::string(rooms[i % 7]) + " " + (dcs[k] ? dcs[k] : doms[k]) + " " + std::to_string(i) +
                        " — Zigbee2MQTT 0x00158d00" + hex + " \"" + doms[k] + "\"";
  at["attribution"] = "Data provided by a very long integration name that some custom components like to put here";
  at["icon"] = std::string("mdi:") + (dcs[k] ? dcs[k] : doms[k]);
  at["linkquality"] = 100 + i % 155;
  at["last_seen"] = "2026-10-16T09:" + std::to_string(10 + i % 50) + ":00+02:00";
  JsonArray opts = at["options"].to<JsonArray>();
  for (int j = 0; j < 6; ++j) opts.add("option " + std::to_string(j) + " for entity " + std::to_string(i));
  if (dcs[k]) at["device_class"] = dcs[k];
  if (units[k]) { at["unit_of_measurement"] = units[k]; at["state_class"] = "measurement"; }
  if (k == 5) {
    JsonArray m = at["supported_color_modes"].to<JsonArray>(); m.add("brightness"); m.add("color_temp");
    at["brightness"] = i % 255;
  }
  if (!extra) return;
  at["restored"] = false;
  at["entity_picture"] = "/api/image_proxy/" + id + "?token=0123456789abcdef0123456789abcdef";
  at["assumed_state"] = false;
  at["supported_features"] = 0;
  at["integration"] = "zigbee2mqtt";
}

// pre-eink-ha-os#76 ingest: every attribute
static void mirrorAll(JsonObjectConst ev, PMap<EntityValue>& m) {
  for (JsonPairConst kv : ev["a"].as<JsonObjectConst>()) {
    EntityValue v;
    v.state = scalarText(kv.value()["s"]);
    for (JsonPairConst a : kv.value()["a"].as<JsonObjectConst>()) v.attrs[a.key().c_str()] = scalarText(a.value());
    m[kv.key().c_str()] = v;
  }
}

// ESP32 (32-bit libstdc++) estimate of one mirror: map node 16 B + std::string 2 × 24 B (SSO up to 15 chars), plus a
// heap block per long string; ~8 B allocator overhead per block. Host bytes differ (64-bit), this is the device view.
static size_t espBytes(const PMap<EntityValue>& m, size_t& blocks) {
  size_t b = 0; blocks = 0;
  auto str = [&](const std::string& s) { if (s.size() > 15) { b += ((s.size() + 1 + 3) & ~size_t(3)) + 8; ++blocks; } };
  for (auto& e : m) {
    b += 16 + 24 + 24 + 4 + 8 + 8; ++blocks;   // outer node: key + EntityValue (state, map header ~24, epoch)
    str(e.first); str(e.second.state);
    for (auto& a : e.second.attrs) { b += 16 + 48 + 8; ++blocks; str(a.first); str(a.second); }
  }
  return b;
}

void test_big_house_mirror_bytes() {
  const int n = 97;   // the seed's subscription on the big house (eink-ha-os#76)
  JsonDocument d;
  JsonObject a = d["a"].to<JsonObject>();
  std::string id;
  for (int i = 0; i < n; ++i) bigEntity(a, i, id);
  JsonObjectConst ev = d.as<JsonObjectConst>();

  size_t allBlocks = 0, keptBlocks = 0, allEsp = 0, keptEsp = 0;
  long allHost = 0, keptHost = 0, allAttrs = 0, keptAttrs = 0, keptHeap = 0;
  {
    PMap<EntityValue> m;
    const long before = psramLiveBytes();
    mirrorAll(ev, m);
    allHost = psramLiveBytes() - before;
    allEsp = espBytes(m, allBlocks);
    for (auto& e : m) allAttrs += long(e.second.attrs.size());
  }
  {
    PMap<EntityValue> m;
    EntityUpdates out;
    const long before = psramLiveBytes(), heapBefore = gLive;
    applyEntityEvent(ev, m, out);
    out.clear(); out.shrink_to_fit();
    keptHost = psramLiveBytes() - before;
    keptHeap = gLive - heapBefore;
    keptEsp = espBytes(m, keptBlocks);
    for (auto& e : m) keptAttrs += long(e.second.attrs.size());
    TEST_ASSERT_EQUAL(n, int(m.size()));
  }
  std::printf("mirror of %d big-house entities, one copy (device keeps 2: EntityAdapter raw, EntityStore):\n"
              "  every attribute: %ld attrs, host %ld B, ESP32 est. %zu B in %zu blocks\n"
              "  whitelist:       %ld attrs, host %ld B, ESP32 est. %zu B in %zu blocks\n",
              n, allAttrs, allHost, allEsp, allBlocks, keptAttrs, keptHost, keptEsp, keptBlocks);
  TEST_ASSERT_EQUAL_MESSAGE(0, int(keptHeap), "mirror holds default-heap (internal RAM) bytes");
  TEST_ASSERT_TRUE(keptHost > 0);
  TEST_ASSERT_TRUE(keptAttrs * 4 < allAttrs);
  TEST_ASSERT_TRUE(keptEsp * 3 < allEsp);
}

void test_entity_with_many_attributes_keeps_whitelist() {
  JsonDocument d;
  std::string id;
  bigEntity(d["a"].to<JsonObject>(), 5, id, true);   // a light: 13 attributes
  TEST_ASSERT_EQUAL_STRING("light.bulk_5", id.c_str());
  TEST_ASSERT_TRUE(d["a"][id]["a"].size() >= 12);
  PMap<EntityValue> m;
  EntityUpdates out;
  applyEntityEvent(d.as<JsonObjectConst>(), m, out);
  TEST_ASSERT_EQUAL(1, int(out.size()));
  const EntityValue& v = m.at(id);
  TEST_ASSERT_EQUAL(3, int(v.attrs.size()));
  TEST_ASSERT_EQUAL_STRING("5", v.attrs.at("brightness").c_str());
  TEST_ASSERT_EQUAL_STRING("[\"brightness\",\"color_temp\"]", v.attrs.at("supported_color_modes").c_str());
  TEST_ASSERT_TRUE(v.attrs.at("friendly_name").find("Zigbee2MQTT") != std::string::npos);
  TEST_ASSERT_EQUAL(1791885605, int(v.updatedEpoch));
  TEST_ASSERT_TRUE(out[0].second.attrs.size() == 3);
}

void test_whitelist_covers_readers() {
  for (const char* k : {"friendly_name", "unit_of_measurement", "display_precision", "today", "raw_today", "prices_today", "prices", "unit",
                        "price_in_cents", "forecast", "current_temperature", "temperature", "preset_mode", "area_id",
                        "area_name", "brightness", "dimmable", "supported_color_modes", "x4_order", "departures",
                        "upcoming", "per_hour", "note", "typical", "preset_modes"})
    TEST_ASSERT_TRUE_MESSAGE(keepAttr(k), k);
  for (const char* k : {"icon", "attribution", "options", "device_class", "state_class", "entity_picture", "last_seen", ""})
    TEST_ASSERT_FALSE_MESSAGE(keepAttr(k), k);
}

void test_door_class_kept() {   // eink-ha-os#331: device_class of door / window binary_sensors only
  PMap<EntityValue> m;
  EntityUpdates out;
  JsonDocument d;
  deserializeJson(d, R"({"a":{"binary_sensor.front":{"s":"on","a":{"friendly_name":"Front","device_class":"door"}},
    "binary_sensor.hall":{"s":"on","a":{"device_class":"motion"}},"sensor.t":{"s":"3","a":{"device_class":"window"}}}})");
  applyEntityEvent(d.as<JsonObjectConst>(), m, out);
  TEST_ASSERT_EQUAL_STRING("door", m["binary_sensor.front"].attrs.at("device_class").c_str());
  TEST_ASSERT_EQUAL(0, int(m["binary_sensor.hall"].attrs.count("device_class")));
  TEST_ASSERT_EQUAL(0, int(m["sensor.t"].attrs.count("device_class")));
}

void test_changed_and_removed() {
  PMap<EntityValue> m;
  EntityUpdates out;
  JsonDocument d;
  deserializeJson(d, R"({"a":{"climate.living":{"s":"heat","a":{"friendly_name":"Living","temperature":20.5,
    "current_temperature":19,"hvac_modes":["off","heat"],"icon":"mdi:x","preset_mode":"home"},"lu":100}}})");
  applyEntityEvent(d.as<JsonObjectConst>(), m, out);
  TEST_ASSERT_EQUAL(4, int(m["climate.living"].attrs.size()));

  out.clear();
  deserializeJson(d, R"({"c":{"climate.living":{"+":{"s":"off","a":{"temperature":21,"min_temp":7,"icon":"mdi:y"},
    "lc":200},"-":{"a":["preset_mode","hvac_modes"]}},"climate.unknown":{"+":{"s":"on"}}}})");
  applyEntityEvent(d.as<JsonObjectConst>(), m, out);
  TEST_ASSERT_EQUAL(1, int(out.size()));   // diff for an entity never added is ignored
  const EntityValue& v = m["climate.living"];
  TEST_ASSERT_EQUAL_STRING("off", v.state.c_str());
  TEST_ASSERT_EQUAL_STRING("21", v.attrs.at("temperature").c_str());
  TEST_ASSERT_EQUAL(0, int(v.attrs.count("min_temp")));
  TEST_ASSERT_EQUAL(0, int(v.attrs.count("preset_mode")));
  TEST_ASSERT_EQUAL(3, int(v.attrs.size()));
  TEST_ASSERT_EQUAL(200, int(v.updatedEpoch));

  out.clear();
  deserializeJson(d, R"({"r":["climate.living"]})");
  applyEntityEvent(d.as<JsonObjectConst>(), m, out);
  TEST_ASSERT_EQUAL(0, int(m.size()));
  TEST_ASSERT_EQUAL(1, int(out.size()));
  TEST_ASSERT_EQUAL_STRING("unavailable", out[0].second.state.c_str());
}

// HaClient applies diffs to the adapter's raw states (no second mirror): a diff after ingest sees the ingested state.
void test_diff_on_adapter_raw() {
  EntityAdapter ad;
  EntityUpdates touched, out;
  JsonDocument d;
  deserializeJson(d, R"({"a":{"light.desk":{"s":"on","a":{"friendly_name":"Desk","brightness":128,"icon":"mdi:l"}}}})");
  applyEntityEvent(d.as<JsonObjectConst>(), ad.raw(), touched);
  for (auto& t : touched) ad.ingest(t.first, t.second, out);
  touched.clear(); out.clear();
  deserializeJson(d, R"({"c":{"light.desk":{"+":{"a":{"brightness":200}}}}})");
  applyEntityEvent(d.as<JsonObjectConst>(), ad.raw(), touched);
  for (auto& t : touched) ad.ingest(t.first, t.second, out);
  TEST_ASSERT_EQUAL(1, int(out.size()));
  TEST_ASSERT_EQUAL_STRING("light.desk", out[0].first.c_str());
  TEST_ASSERT_EQUAL_STRING("on", out[0].second.state.c_str());
  TEST_ASSERT_EQUAL_STRING("200", out[0].second.attrs.at("brightness").c_str());
  TEST_ASSERT_EQUAL_STRING("Desk", out[0].second.attrs.at("friendly_name").c_str());
  TEST_ASSERT_EQUAL(2, int(ad.raw().at("light.desk").attrs.size()));
}

// eink-ha-os#292: a history tile's attribute is kept for its entity only
void test_extra_attr_per_entity() {
  TEST_ASSERT_TRUE(setExtraAttrs({{"sensor.rain", "nowcast"}}));
  TEST_ASSERT_FALSE(setExtraAttrs({{"sensor.rain", "nowcast"}}));
  PMap<EntityValue> mirror;
  EntityUpdates touched;
  JsonDocument d;
  deserializeJson(d, R"({"a":{"sensor.rain":{"s":"0","a":{"nowcast":[{"t":1,"v":2}],"icon":"x"}},
                             "sensor.other":{"s":"1","a":{"nowcast":[1,2,3]}}}})");
  applyEntityEvent(d.as<JsonObjectConst>(), mirror, touched);
  TEST_ASSERT_EQUAL_STRING("[{\"t\":1,\"v\":2}]", mirror.at("sensor.rain").attrs.at("nowcast").c_str());
  TEST_ASSERT_EQUAL(1, int(mirror.at("sensor.rain").attrs.size()));
  TEST_ASSERT_EQUAL(0, int(mirror.at("sensor.other").attrs.size()));
  TEST_ASSERT_TRUE(setExtraAttrs({}));
  TEST_ASSERT_FALSE(keepAttrFor("sensor.rain", "nowcast"));
}

// eink-ha-os#85: display_precision from config/entity_registry/get_entries survives full "a" events and reaches logical ids.
void test_registry_precision() {
  JsonDocument d;
  deserializeJson(d, R"({"a":{"options":{"sensor":{"display_precision":1,"suggested_display_precision":2}}},
    "b":{"options":{"sensor":{"display_precision":null,"suggested_display_precision":0}}},"c":{"options":{}},"d":null,
    "e":{"options":{"sensor":{"display_precision":"2"}}}})");
  TEST_ASSERT_EQUAL(1, registryPrecision(d["a"]));
  TEST_ASSERT_EQUAL(0, registryPrecision(d["b"]));
  TEST_ASSERT_EQUAL(-1, registryPrecision(d["c"]));
  TEST_ASSERT_EQUAL(-1, registryPrecision(d["d"]));
  TEST_ASSERT_EQUAL(-1, registryPrecision(d["e"]));

  EntityAdapter ad;
  ad.setOverrides({{"sensor.home_power", "sensor.p1_power"}});
  ad.setKeep({"sensor.p1_power", "sensor.outside"});
  EntityUpdates touched, out;
  auto add = [&](const char* ev) {
    touched.clear(); out.clear();
    deserializeJson(d, ev);
    applyEntityEvent(d.as<JsonObjectConst>(), ad.raw(), touched);
    for (auto& t : touched) ad.ingest(t.first, t.second, out);
  };
  auto find = [&](const char* id) -> const EntityValue* {
    for (auto& o : out) if (o.first == id) return &o.second;
    return nullptr;
  };
  add(R"({"a":{"sensor.p1_power":{"s":"390.0","a":{"unit_of_measurement":"W"}},"sensor.outside":{"s":"11.42","a":{"unit_of_measurement":"°C"}}}})");
  TEST_ASSERT_EQUAL(0, int(find("sensor.p1_power")->attrs.count("display_precision")));
  out.clear();
  ad.setPrecision("sensor.p1_power", 1, out);
  ad.setPrecision("sensor.outside", -1, out);   // nothing known, nothing to do
  ad.setPrecision("sensor.not_seen", 2, out);   // state not known yet: remembered, nothing emitted
  TEST_ASSERT_EQUAL_STRING("1", find("sensor.p1_power")->attrs.at("display_precision").c_str());
  TEST_ASSERT_EQUAL_STRING("1", find("sensor.home_power")->attrs.at("display_precision").c_str());
  TEST_ASSERT_NULL(find("sensor.outside"));
  out.clear();
  ad.setPrecision("sensor.p1_power", 1, out);   // unchanged: no re-emit
  TEST_ASSERT_EQUAL(0, int(out.size()));
  add(R"({"a":{"sensor.p1_power":{"s":"401.5","a":{"unit_of_measurement":"W"}}}})");   // full replace keeps it
  TEST_ASSERT_EQUAL_STRING("1", find("sensor.p1_power")->attrs.at("display_precision").c_str());
  TEST_ASSERT_EQUAL_STRING("1", find("sensor.home_power")->attrs.at("display_precision").c_str());
  TEST_ASSERT_EQUAL(0, int(ad.raw().at("sensor.p1_power").attrs.count("display_precision")));   // not in the mirror
  add(R"({"a":{"sensor.p1_power":{"s":"0.4","a":{"unit_of_measurement":"kW"}}}})");   // converted: W precision no longer holds
  TEST_ASSERT_EQUAL(0, int(find("sensor.home_power")->attrs.count("display_precision")));
  add(R"({"a":{"sensor.not_seen":{"s":"3.1","a":{"display_precision":"0"}}}})");   // HA's own attribute wins
  TEST_ASSERT_EQUAL_STRING("0", find("sensor.not_seen")->attrs.at("display_precision").c_str());
}

// eink-ha-os#81: a re-subscribe only when the watched set changed; collection order does not matter
void test_resubscribe_only_on_change() {
  std::set<std::string> subscribed;
  for (const char* id : {"sensor.solar_power", "sensor.grid_power", "light.kitchen", "climate.living"})
    subscribed.insert(id);
  std::set<std::string> same;
  for (const char* id : {"climate.living", "light.kitchen", "sensor.grid_power", "sensor.solar_power", "light.kitchen"})
    same.insert(id);
  TEST_ASSERT_FALSE(resubscribeNeeded(subscribed, 5, same));
  TEST_ASSERT_EQUAL_UINT32(idSetHash(subscribed), idSetHash(same));
  TEST_ASSERT_EQUAL_STRING("", idSetDiff(subscribed, same).c_str());
  TEST_ASSERT_TRUE(resubscribeNeeded(subscribed, 0, same));   // new socket: nothing live
  TEST_ASSERT_FALSE(resubscribeNeeded({}, 0, {}));
  auto grown = same;
  grown.insert("sensor.home_power");
  grown.erase("light.kitchen");
  TEST_ASSERT_TRUE(resubscribeNeeded(subscribed, 5, grown));
  TEST_ASSERT_NOT_EQUAL(idSetHash(subscribed), idSetHash(grown));
  TEST_ASSERT_EQUAL_STRING("+sensor.home_power -light.kitchen", idSetDiff(subscribed, grown).c_str());
  std::set<std::string> many;
  for (int i = 0; i < 6; i++) many.insert("sensor.s" + std::to_string(i));
  TEST_ASSERT_EQUAL_STRING("+sensor.s0 +sensor.s1 +sensor.s2 +sensor.s3 …", idSetDiff({}, many).c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_big_house_mirror_bytes);
  RUN_TEST(test_entity_with_many_attributes_keeps_whitelist);
  RUN_TEST(test_whitelist_covers_readers);
  RUN_TEST(test_door_class_kept);
  RUN_TEST(test_changed_and_removed);
  RUN_TEST(test_diff_on_adapter_raw);
  RUN_TEST(test_registry_precision);
  RUN_TEST(test_resubscribe_only_on_change);
  RUN_TEST(test_extra_attr_per_entity);
  return UNITY_END();
}
