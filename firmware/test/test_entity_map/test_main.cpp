// core/entity_map: HA Energy dashboard prefs / raw HA entities → logical ids read by the UI (core/entities.h).
// Fixtures: test/fixtures/ha/*.json — payloads as Home Assistant sends them (energy/get_prefs, render_template,
// recorder/statistics_during_period, entity states of common price integrations).
#include <ArduinoJson.h>
#include <unity.h>
#include <cstdio>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <sstream>
#include <string>
#include "core/entity_map.h"
#include "core/home.h"
#include "core/json.h"

using namespace x4;

// Unity is built without double support here.
#include <cmath>
#undef TEST_ASSERT_DOUBLE_WITHIN
#undef TEST_ASSERT_DOUBLE_WITHIN_MESSAGE
#define TEST_ASSERT_DOUBLE_WITHIN(d, e, a) TEST_ASSERT_TRUE_MESSAGE(std::fabs(double(e) - double(a)) <= (d), (std::to_string(e) + " != " + std::to_string(a)).c_str())
#define TEST_ASSERT_DOUBLE_WITHIN_MESSAGE(d, e, a, m) TEST_ASSERT_TRUE_MESSAGE(std::fabs(double(e) - double(a)) <= (d), (std::string(m) + ": " + std::to_string(e) + " != " + std::to_string(a)).c_str())

#ifndef X4_REPO_ROOT
#define X4_REPO_ROOT "."
#endif

static const int64_t kNoon = 1791885600 + 3600;   // 2026-10-13 13:00 Europe/Amsterdam (11:00 UTC)

static std::string fixture(const char* name) {
  std::ifstream f(std::string(X4_REPO_ROOT) + "/firmware/test/fixtures/ha/" + name, std::ios::binary);
  std::stringstream ss; ss << f.rdbuf();
  TEST_ASSERT_FALSE_MESSAGE(ss.str().empty(), name);
  return ss.str();
}

static std::string toText(const Json& j) {
  switch (j.type) {
    case Json::Type::Null: return "null";
    case Json::Type::Bool: return j.b ? "true" : "false";
    case Json::Type::Number: return jsNumber(j.num);
    case Json::Type::String: return jsonQuote(j.str);
    case Json::Type::Array: { std::string s = "["; for (size_t i = 0; i < j.arr.size(); ++i) s += (i ? "," : "") + toText(j.arr[i]); return s + "]"; }
    case Json::Type::Object: { std::string s = "{"; for (size_t i = 0; i < j.obj.size(); ++i) s += (i ? "," : "") + jsonQuote(j.obj[i].first) + ":" + toText(j.obj[i].second); return s + "}"; }
  }
  return "";
}

// Like HaClient: strings as-is, bools true/false, everything else JSON text.
static EntityValue haValue(const std::string& state, const Json* attrs = nullptr) {
  EntityValue v; v.state = state; v.updatedEpoch = kNoon;
  if (attrs && attrs->isObj())
    for (auto& kv : attrs->obj) v.attrs[kv.first] = kv.second.isStr() ? kv.second.str : toText(kv.second);
  return v;
}

static EntityValue stateFixture(const char* name, std::string* id = nullptr) {
  Json j; TEST_ASSERT_TRUE(parseJson(fixture(name), j));
  if (id) *id = j.get("entity_id")->str;
  return haValue(j.get("state")->str, j.get("attributes"));
}

static const EntityValue* find(const EntityUpdates& u, const std::string& id) {
  const EntityValue* r = nullptr;
  for (auto& x : u) if (x.first == id) r = &x.second;
  return r;
}

static EntityStore apply(const EntityUpdates& u) { EntityStore st; for (auto& x : u) st.set(x.first, x.second); return st; }

void setUp() { setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3", 1); tzset(); }
void tearDown() {}

// ---- HA ≥ 2025.12: power sensors in the Energy dashboard (stat_rate, power[], power_config from − to) ----
void test_prefs_with_power_sensors() {
  EntityAdapter a; a.setNow(kNoon);
  TEST_ASSERT_TRUE(a.setEnergyPrefs(fixture("energy_prefs_power.json")));
  auto w = a.watchIds();
  for (auto* id : {"sensor.p1_meter_power", "sensor.solaredge_current_power", "sensor.homewizard_battery_discharge_power",
                   "sensor.homewizard_battery_charge_power", "sensor.nordpool_kwh_nl_eur_3_10_021"})
    TEST_ASSERT_TRUE_MESSAGE(w.count(id), id);
  EntityUpdates out;
  Json kw; parseJson("{\"unit_of_measurement\":\"kW\",\"device_class\":\"power\"}", kw);
  Json W; parseJson("{\"unit_of_measurement\":\"W\",\"device_class\":\"power\"}", W);
  a.ingest("sensor.solaredge_current_power", haValue("2.84", &kw), out);
  a.ingest("sensor.p1_meter_power", haValue("-1210", &W), out);              // exporting
  a.ingest("sensor.homewizard_battery_discharge_power", haValue("0", &W), out);
  TEST_ASSERT_NULL(find(out, "sensor.battery_power"));                       // needs both halves
  a.ingest("sensor.homewizard_battery_charge_power", haValue("800", &W), out);
  TEST_ASSERT_EQUAL_STRING("2840", find(out, "sensor.solar_power")->state.c_str());
  TEST_ASSERT_EQUAL_STRING("-1210", find(out, "sensor.grid_power")->state.c_str());
  TEST_ASSERT_EQUAL_STRING("800", find(out, "sensor.battery_power")->state.c_str());   // HA −800 (charging) → UI +800
  TEST_ASSERT_EQUAL_STRING("830", find(out, "sensor.home_power")->state.c_str());      // 2840 − 1210 − 800
  TEST_ASSERT_NULL(find(out, "sensor.p1_meter_power"));                       // raw sources are not copied to the store
  {   // …unless a widget shows that sensor directly (stat entity: sensor.p1_meter_power)
    a.setKeep({"sensor.p1_meter_power"});
    EntityUpdates kept;
    a.ingest("sensor.p1_meter_power", haValue("-1100", &W), kept);
    TEST_ASSERT_NOT_NULL(find(kept, "sensor.p1_meter_power"));
    TEST_ASSERT_EQUAL_STRING("-1100", find(kept, "sensor.p1_meter_power")->state.c_str());
    a.setKeep({});
  }

  std::string pid; EntityValue np = stateFixture("price_nordpool.json", &pid);
  a.ingest(pid, np, out);
  EntityStore st = apply(out);
  HomeData d = deriveHome(st);
  TEST_ASSERT_EQUAL_INT(24, int(d.prices.size()));
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 0.231, d.prices[0]);                       // 4 quarter-hours averaged
  TEST_ASSERT_EQUAL_INT(14, int(std::min_element(d.prices.begin(), d.prices.end()) - d.prices.begin()));
  TEST_ASSERT_EQUAL_STRING("13–16", statText("sensor.price_cheap_window", d, 13).value.c_str());
  TEST_ASSERT_EQUAL_STRING("2.84", statText("sensor.solar_power", d, 13).value.c_str());
  TEST_ASSERT_EQUAL_STRING("Out", statText("sensor.grid_power", d, 13).sub.c_str());   // no export-today sensor here
  TEST_ASSERT_EQUAL_STRING("Charging", statText("sensor.battery_power", d, 13).sub.c_str());
  // unmapped → "—" (no sensor.home_battery_soc in this house, no fake numbers)
  TEST_ASSERT_FALSE(d.soc.ok);
  TEST_ASSERT_EQUAL_STRING("—", statText("sensor.energy_today", d, 13).value.c_str());
  TEST_ASSERT_EQUAL_STRING("—", statText("sensor.living_temperature", d, 13).value.c_str());
}

// ---- #148: away only where preset_modes offers it; no climate.living guess for the inside temperature ----
void test_away_presets_and_no_living_guess() {
  TEST_ASSERT_TRUE(presetHasAway("[\"home\",\"away\"]"));
  TEST_ASSERT_FALSE(presetHasAway("[\"none\",\"eco\"]"));
  TEST_ASSERT_FALSE(presetHasAway(""));
  TEST_ASSERT_FALSE(presetHasAway("away"));
  TEST_ASSERT_FALSE(presetHasAway("[\"away"));   // broken JSON
  EntityStore st;
  EntityValue z; z.state = "heat"; z.attrs["current_temperature"] = "20.4"; z.attrs["temperature"] = "21";
  st.set("climate.living", z);
  HomeData d = deriveHome(st);
  TEST_ASSERT_FALSE(d.awayOk());
  TEST_ASSERT_EQUAL_STRING("—", statText("sensor.living_temperature", d, 13).value.c_str());   // was 20.4 (climate.living)
  z.attrs["preset_modes"] = "[\"home\",\"away\"]";
  st.set("climate.kitchen", z);
  d = deriveHome(st);
  TEST_ASSERT_TRUE(d.awayOk());
  TEST_ASSERT_FALSE(d.zone("living")->awayOk);
  TEST_ASSERT_TRUE(d.zone("kitchen")->awayOk);
}

// ---- older HA: meters only → device discovery finds the power sensors (DSMR P1 consumption − production) ----
void test_prefs_meters_device_discovery_and_statistics() {
  EntityAdapter a; a.setNow(kNoon);
  a.setEnergyPrefs(fixture("energy_prefs_meters.json"));
  std::string tpl = a.deviceDiscoveryTemplate();
  TEST_ASSERT_TRUE(tpl.find("device_entities(d)") != std::string::npos);
  TEST_ASSERT_TRUE(tpl.find("\"sensor.powerwall_battery_import\"") != std::string::npos);
  TEST_ASSERT_TRUE(a.setDeviceDiscovery(fixture("device_discovery_meters.json")));
  auto src = a.sources();
  TEST_ASSERT_EQUAL_STRING("sensor.solaredge_current_power", src["sensor.solar_power"].ha.c_str());
  TEST_ASSERT_EQUAL_STRING("sensor.electricity_meter_power_consumption", src["sensor.grid_power"].ha.c_str());
  TEST_ASSERT_EQUAL_STRING("sensor.electricity_meter_power_production", src["sensor.grid_power"].minus.c_str());
  TEST_ASSERT_EQUAL_STRING("sensor.powerwall_battery_power", src["sensor.battery_power"].ha.c_str());
  TEST_ASSERT_EQUAL_STRING("sensor.powerwall_charge", src["sensor.home_battery_soc"].ha.c_str());
  TEST_ASSERT_EQUAL_STRING("sensor.current_electricity_price_all_in", src["sensor.energy_prices"].ha.c_str());

  EntityUpdates out;
  Json kw; parseJson("{\"unit_of_measurement\":\"kW\"}", kw);
  Json W; parseJson("{\"unit_of_measurement\":\"W\"}", W);
  Json pct; parseJson("{\"unit_of_measurement\":\"%\",\"device_class\":\"battery\"}", pct);
  a.ingest("sensor.solaredge_current_power", haValue("640", &W), out);
  a.ingest("sensor.electricity_meter_power_consumption", haValue("0.412", &kw), out);
  a.ingest("sensor.electricity_meter_power_production", haValue("0.0", &kw), out);
  a.ingest("sensor.powerwall_battery_power", haValue("0.25", &kw), out);      // discharging 250 W
  a.ingest("sensor.powerwall_charge", haValue("63", &pct), out);
  TEST_ASSERT_EQUAL_STRING("412", find(out, "sensor.grid_power")->state.c_str());
  TEST_ASSERT_EQUAL_STRING("-250", find(out, "sensor.battery_power")->state.c_str());
  TEST_ASSERT_EQUAL_STRING("1302", find(out, "sensor.home_power")->state.c_str());     // 640 + 412 + 250
  TEST_ASSERT_EQUAL_STRING("63", find(out, "sensor.home_battery_soc")->state.c_str());

  // Frank Energie prices in UTC, incl. yesterday evening and tomorrow → today's 24 local hours
  std::string pid; EntityValue fp = stateFixture("price_frank.json", &pid);
  a.ingest(pid, fp, out);

  auto ids = a.statisticIds();
  TEST_ASSERT_EQUAL_INT(7, int(ids.size()));
  a.setHourlyStatistics(fixture("statistics_today.json"), out);
  EntityStore st = apply(out);
  HomeData d = deriveHome(st);
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 4.85, d.solarToday.v);
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 2.39, d.importToday.v);
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 1.80, d.exportToday.v);
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 4.74, d.usedToday.v);                     // 4.85 + 2.39 − 1.8 + 0.3 − 1.0
  TEST_ASSERT_EQUAL_STRING("kWh", statText("sensor.energy_today", d, 13).unit.c_str());
  TEST_ASSERT_EQUAL_INT(24, int(d.usage.size()));
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 0.31, d.usage[0]);                         // 0.21 import + 0.1 battery
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 1.40, d.solarSeries[12]);
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 0.0, d.solarSeries[20]);                   // not yet
  TEST_ASSERT_EQUAL_INT(24, int(d.prices.size()));
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 0.231, d.prices[0]);
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 0.240, d.prices[23]);
  TEST_ASSERT_EQUAL_STRING("13–16", statText("sensor.price_cheap_window", d, 13).value.c_str());
  TEST_ASSERT_TRUE(d.soc.ok); TEST_ASSERT_DOUBLE_WITHIN(1e-9, 63, d.soc.v);
}

// ---- price attribute formats of common integrations → the same 24 €/kWh ----
void test_price_formats() {
  const double first = 0.231, cheapest = 0.165;
  for (const char* f : {"price_nordpool.json", "price_tibber.json", "price_frank.json", "price_energyzero_ct.json", "price_entsoe_mwh.json"}) {
    EntityValue v = stateFixture(f);
    auto p = hourlyPrices(v, kNoon);
    TEST_ASSERT_EQUAL_INT_MESSAGE(24, int(p.size()), f);
    TEST_ASSERT_DOUBLE_WITHIN_MESSAGE(1e-6, first, p[0], f);
    TEST_ASSERT_DOUBLE_WITHIN_MESSAGE(1e-6, cheapest, p[14], f);
  }
  // unknown day / nothing usable → empty (renders "—")
  EntityValue none; none.state = "0.25"; none.attrs["current_price"] = "0.25";
  TEST_ASSERT_EQUAL_INT(0, int(hourlyPrices(none, kNoon).size()));
  // a 23-hour DST day keeps 24 slots (missing hour repeats the previous one)
  EntityValue dst; dst.attrs["raw_today"] = "[{\"start\":\"2026-03-29T00:00:00+01:00\",\"value\":0.1},{\"start\":\"2026-03-29T01:00:00+01:00\",\"value\":0.2},{\"start\":\"2026-03-29T03:00:00+02:00\",\"value\":0.3}]";
  auto p = hourlyPrices(dst, 0);
  TEST_ASSERT_EQUAL_INT(24, int(p.size()));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.2, p[2]); TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.3, p[3]);
  TEST_ASSERT_EQUAL_INT64(1791842400, parseIsoTime("2026-10-13T00:00:00+02:00"));
  TEST_ASSERT_EQUAL_INT64(1791842400, parseIsoTime("2026-10-12T22:00:00.000Z"));
  TEST_ASSERT_EQUAL_INT64(1791842400, parseIsoTime("2026-10-13 00:00:00"));   // local (TZ above)
}

// ---- quarter-hourly prices (#151): "now" is this quarter, the hourly bars stay averages ----
void test_price_quarters() {
  std::string plain = "[";
  for (int k = 0; k < 96; ++k) plain += (k ? "," : "") + std::to_string(0.20 + 0.001 * k);
  plain += "]";
  EntityValue v; v.attrs["today"] = plain; v.attrs["unit_of_measurement"] = "EUR/kWh";
  PriceSeries p = priceSeries(v, kNoon);
  TEST_ASSERT_EQUAL_INT(24, int(p.hourly.size()));
  TEST_ASSERT_EQUAL_INT(96, int(p.quarters.size()));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.2015, p.hourly[0]);   // mean of 0.200 … 0.203
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.253, p.quarters[53]);  // 13:15
  // Nord Pool raw_today with 15-minute entries
  std::string raw = "[";
  for (int k = 0; k < 96; ++k) {
    char b[96];
    std::snprintf(b, sizeof b, "%s{\"start\":\"2026-10-13T%02d:%02d:00+02:00\",\"value\":%.3f}", k ? "," : "", k / 4, (k % 4) * 15, 0.30 + 0.001 * k);
    raw += b;
  }
  raw += "]";
  EntityValue r; r.attrs["raw_today"] = raw;
  p = priceSeries(r, kNoon);
  TEST_ASSERT_EQUAL_INT(96, int(p.quarters.size()));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.354, p.quarters[54]);
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.3535, p.hourly[13]);
  // hourly sources: no quarters
  EntityValue h; h.attrs["today"] = "[" + std::string("0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1,1.1,1.2,1.3,1.4,1.5,1.6,1.7,1.8,1.9,2,2.1,2.2,2.3,2.4") + "]";
  TEST_ASSERT_EQUAL_INT(0, int(priceSeries(h, kNoon).quarters.size()));
  // through the adapter into HomeData: priceAt picks the quarter, else the hour
  EntityAdapter a; a.setNow(kNoon);
  a.setOverrides({{"sensor.energy_prices", "sensor.nordpool"}});
  EntityUpdates out;
  a.ingest("sensor.nordpool", r, out);
  EntityStore st = apply(out);
  HomeData d = deriveHome(st);
  TEST_ASSERT_TRUE(d.hasQuarters);
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.354, d.priceAt(13, 34));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.3535, d.prices[13]);
  d.hasQuarters = false;
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.3535, d.priceAt(13, 34));
}

// ---- overrides (settings `entities`), travel routes, identity, pass-through ----
void test_overrides_routes_identity() {
  EntityAdapter a; a.setNow(kNoon);
  a.setEnergyPrefs(fixture("energy_prefs_power.json"));
  a.setOverrides({{"sensor.solar_power", "sensor.hoymiles_power"}, {"sensor.battery_power", "-sensor.zendure_output"},
                  {"sensor.x4_route_bus", "sensor.ovapi_bus_52"}, {"sensor.living_temperature", "sensor.living_room_temperature"},
                  {"light.not_logical", "sensor.x"}});
  TEST_ASSERT_FALSE(a.overrides().count("light.not_logical"));
  auto w = a.watchIds();
  TEST_ASSERT_TRUE(w.count("sensor.hoymiles_power")); TEST_ASSERT_FALSE(w.count("sensor.solaredge_current_power"));
  TEST_ASSERT_TRUE(w.count("sensor.ovapi_bus_52"));                           // an older settings route mapping still maps
  EntityUpdates out;
  a.ingest("sensor.hoymiles_power", haValue("512"), out);
  a.ingest("sensor.zendure_output", haValue("300"), out);
  a.ingest("sensor.living_room_temperature", haValue("20.6"), out);
  Json dep; parseJson("{\"departures\":[{\"time\":\"13:07\",\"delay\":2,\"cancelled\":false,\"info\":\"Bus 52 · to the station\"}],\"per_hour\":4}", dep);
  a.ingest("sensor.ovapi_bus_52", haValue("13:07", &dep), out);
  Json tr; parseJson("{\"departures\":[{\"time\":\"13:04\",\"delay\":0,\"cancelled\":false,\"info\":\"Intercity\"}]}", tr);
  a.ingest("sensor.x4_route_work", haValue("13:04", &tr), out);   // unmapped: an HA sensor of that name (#145)
  Json cl; parseJson("{\"friendly_name\":\"Living\",\"current_temperature\":20.5,\"temperature\":21}", cl);
  a.ingest("climate.living", haValue("heat", &cl), out);
  a.ingest("sensor.solaredge_current_power", haValue("2000"), out);           // not the source any more
  EntityStore st = apply(out);
  TEST_ASSERT_EQUAL_STRING("512", st.get("sensor.solar_power")->state.c_str());
  TEST_ASSERT_EQUAL_STRING("-300", st.get("sensor.battery_power")->state.c_str());
  TEST_ASSERT_NOT_NULL(st.get("climate.living"));                             // passes through unchanged
  TEST_ASSERT_NOT_NULL(st.get("sensor.solaredge_current_power"));             // unrelated sensors pass through
  HomeData d = deriveHome(st);
  TEST_ASSERT_EQUAL_STRING("20.6", statText("sensor.living_temperature", d, 13).value.c_str());
  RouteState bus = routeState(st.get("sensor.x4_route_bus"), false);
  TEST_ASSERT_TRUE(bus.has);
  TEST_ASSERT_EQUAL_INT(1, int(bus.deps.size()));
  TEST_ASSERT_EQUAL_STRING("Bus 52 · to the station", bus.deps[0].info.c_str());
  TEST_ASSERT_EQUAL_INT(4, bus.perHour);
  TEST_ASSERT_TRUE(routeState(st.get("sensor.x4_route_work"), false).has);
  TEST_ASSERT_FALSE(routeState(st.get("sensor.x4_route_school"), false).has);   // no such sensor → "—"
  EntityValue drive; drive.state = "34"; drive.attrs["typical"] = "21";
  RouteState car = routeState(&drive, true);
  TEST_ASSERT_TRUE(car.eta.ok && car.typical.ok);
  TEST_ASSERT_EQUAL_INT(34, int(car.eta.v));
  TEST_ASSERT_FALSE(d.home.ok);                                               // grid power unknown → no home total
  // removing the override falls back to the Energy dashboard source
  a.setOverrides({});
  EntityUpdates re; a.remapAll(re);
  TEST_ASSERT_EQUAL_STRING("2000", find(re, "sensor.solar_power")->state.c_str());
}

// ---- no Energy dashboard: entities already named like the logical ids (the fake HA, template sensors) ----
void test_identity_without_prefs() {
  EntityAdapter a;
  a.setEnergyPrefs("{\"energy_sources\":[],\"device_consumption\":[]}");
  EntityUpdates out;
  a.ingest("sensor.solar_power", haValue("1500"), out);
  a.ingest("sensor.home_power", haValue("700"), out);
  EntityValue pr; pr.state = "0.2"; pr.attrs["today"] = "[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]";
  a.ingest("sensor.energy_prices", pr, out);
  a.ingest("x4.areas", haValue("ok"), out);
  EntityStore st = apply(out);
  TEST_ASSERT_EQUAL_STRING("1500", st.get("sensor.solar_power")->state.c_str());
  TEST_ASSERT_EQUAL_STRING("700", st.get("sensor.home_power")->state.c_str());
  TEST_ASSERT_NOT_NULL(st.get("x4.areas"));
  TEST_ASSERT_EQUAL_INT(24, int(deriveHome(st).prices.size()));
  // "unavailable" stays unavailable → "—"
  EntityUpdates o2; a.ingest("sensor.solar_power", haValue("unavailable"), o2);
  TEST_ASSERT_EQUAL_STRING("unavailable", find(o2, "sensor.solar_power")->state.c_str());
}

// #57: the entity picker's render_template answer for 800 entities is one ~75 KB JSON string inside the event.
// ArduinoJson's default 16-bit string length refused it (NoMemory) and the list never arrived.
void test_render_template_answer_over_64k() {
  std::string list = "[";
  for (int i = 0; i < 800; i++) {
    if (i) list += ',';
    list += "[\"sensor.bulk_" + std::to_string(i) + "\",\"Bedroom upstairs (east) temperature " + std::to_string(i) +
            " \\\"Zigbee2MQTT 0x00158d00\\\"\",\"\u00b0C\"]";
  }
  list += ']';
  JsonDocument inner;
  TEST_ASSERT_TRUE(deserializeJson(inner, list) == DeserializationError::Ok);
  JsonDocument ev;
  ev["id"] = 7;
  ev["type"] = "event";
  ev["event"]["result"] = list;
  std::string msg;
  serializeJson(ev, msg);
  TEST_ASSERT_TRUE(msg.size() > 65535);
  JsonDocument d;
  TEST_ASSERT_TRUE(deserializeJson(d, msg) == DeserializationError::Ok);
  const char* res = d["event"]["result"] | "";
  TEST_ASSERT_EQUAL_size_t(list.size(), strlen(res));
  JsonDocument parsed;
  TEST_ASSERT_TRUE(deserializeJson(parsed, res) == DeserializationError::Ok);
  TEST_ASSERT_EQUAL_INT(800, int(parsed.size()));
  TEST_ASSERT_EQUAL_STRING("sensor.bulk_799", parsed[799][0] | "");
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_prefs_with_power_sensors);
  RUN_TEST(test_prefs_meters_device_discovery_and_statistics);
  RUN_TEST(test_price_formats);
  RUN_TEST(test_price_quarters);
  RUN_TEST(test_overrides_routes_identity);
  RUN_TEST(test_identity_without_prefs);
  RUN_TEST(test_render_template_answer_over_64k);
  RUN_TEST(test_away_presets_and_no_living_guess);
  return UNITY_END();
}
