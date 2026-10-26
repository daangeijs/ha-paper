// Mock Home Assistant data identical to the emulator's (Main.dc.html: PRICES, USAGE, SOLAR, ZONE_LIST, LIGHT_LIST,
// ROUTES + travel "mixed"), expressed with the entity conventions of core/entities.h.
#pragma once
#include <cmath>
#include <string>
#include <vector>
#include <algorithm>
#include "core/entities.h"
#include "core/json.h"
#include "core/logic.h"

namespace x4 {
namespace demo {

inline const std::vector<double>& prices() {
  static const std::vector<double> v = {0.22, 0.21, 0.20, 0.20, 0.21, 0.23, 0.27, 0.33, 0.35, 0.30, 0.26, 0.22,
                                        0.19, 0.18, 0.19, 0.22, 0.27, 0.34, 0.38, 0.36, 0.31, 0.27, 0.25, 0.23};
  return v;
}
inline const std::vector<double>& usage() {
  static const std::vector<double> v = {0.25, 0.2, 0.2, 0.2, 0.2, 0.25, 0.45, 0.8, 0.6, 0.4, 0.35, 0.4,
                                        0.5, 0.4, 0.35, 0.4, 0.6, 1.1, 1.3, 0.9, 0.7, 0.6, 0.4, 0.3};
  return v;
}
inline std::vector<double> solar() {
  std::vector<double> v;
  for (int h = 0; h < 24; ++h) v.push_back(std::round(std::max(0.0, std::sin((h + 0.5 - 8) / 10.5 * M_PI)) * 2.4 * 100) / 100);
  return v;
}
inline std::string arr(const std::vector<double>& v) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); ++i) s += (i ? "," : "") + jsNumber(v[i]);
  return s + "]";
}
inline EntityValue val(const std::string& state) { EntityValue e; e.state = state; return e; }

struct Zone { const char* id; const char* name; double cur, set; };
inline const std::vector<Zone>& zones() {
  static const std::vector<Zone> z = {{"living", "Living room", 20.4, 21}, {"kitchen", "Kitchen", 20.1, 20}, {"dining", "Dining room", 19.6, 20},
                                      {"hall", "Hallway", 17.5, 17},      {"office", "Office", 19.1, 20},   {"bedroom", "Bedroom", 17.8, 18},
                                      {"kids", "Kids room", 18.6, 19},    {"guest", "Guest room", 15.2, 15}, {"bathroom", "Bathroom", 21.2, 22},
                                      {"attic", "Attic", 14.8, 15},       {"laundry", "Laundry", 16.0, 16}, {"studio", "Studio", 18.0, 19},
                                      {"toilet", "Toilet", 17.0, 17},     {"garage", "Garage", 10.5, 10}};
  return z;
}
struct Light { const char* id; const char* room; const char* name; bool dim, on; int b; };
inline const std::vector<Light>& lights() {
  static const std::vector<Light> l = {
      {"living_ceiling", "living", "Ceiling", 1, 1, 80}, {"living_floor", "living", "Floor lamp", 1, 1, 60}, {"living_reading", "living", "Reading lamp", 1, 0, 70},
      {"living_tv", "living", "TV backlight", 0, 0, 100}, {"kitchen_spots", "kitchen", "Spots", 1, 1, 100}, {"kitchen_island", "kitchen", "Island pendants", 1, 1, 70},
      {"kitchen_cabinet", "kitchen", "Under-cabinet", 0, 0, 100}, {"dining_pendant", "dining", "Pendant", 1, 0, 60}, {"hall_ceiling", "hall", "Ceiling", 1, 0, 40},
      {"hall_stairs", "hall", "Stairs", 0, 0, 100}, {"bedroom_ceiling", "bedroom", "Ceiling", 1, 0, 50}, {"bedroom_left", "bedroom", "Bedside left", 1, 0, 30},
      {"bedroom_right", "bedroom", "Bedside right", 1, 0, 30}, {"office_desk", "office", "Desk lamp", 1, 1, 100}, {"garden_terrace", "garden", "Terrace", 0, 0, 100},
      {"garden_path", "garden", "Path", 0, 0, 100}};
  return l;
}
inline const char* roomName(const std::string& r) {
  static const char* R[][2] = {{"living", "Living room"}, {"kitchen", "Kitchen"}, {"dining", "Dining"}, {"hall", "Hallway"},
                               {"bedroom", "Bedroom"},    {"office", "Office"},   {"garden", "Garden"}};
  for (auto& x : R) if (r == x[0]) return x[1];
  return "Other";
}

inline void setZone(EntityStore& st, const Zone& z, int order) {
  EntityValue e = val("heat");
  e.attrs["friendly_name"] = z.name;
  e.attrs["current_temperature"] = jsNumber(z.cur);
  e.attrs["temperature"] = jsNumber(z.set);
  e.attrs["x4_order"] = std::to_string(order);
  if (std::string(z.id) != "garage") e.attrs["preset_modes"] = "[\"home\",\"away\"]";   // tado (emulator ZONE_LIST presets, #148)
  st.set(std::string("climate.") + z.id, e);
}

inline void setLight(EntityStore& st, const Light& l, int order, bool on, int pct) {
  EntityValue e = val(on ? "on" : "off");
  e.attrs["friendly_name"] = l.name;
  e.attrs["area_id"] = l.room;
  e.attrs["area_name"] = roomName(l.room);
  e.attrs["dimmable"] = l.dim ? "true" : "false";
  e.attrs["brightness"] = std::to_string(int(std::round(pct * 255.0 / 100)));
  e.attrs["x4_order"] = std::to_string(order);
  st.set("light." + std::string(l.id), e);
}

// Loads everything for local time hh:mm. zoneCount = emulator "tado zones" (4, 10, 14).
inline void load(EntityStore& st, int hh, int mm, int zoneCount = 10) {
  double frac = mm / 60.0;
  auto S = solar();
  double used = 0, sol = 0;
  for (int h = 0; h < hh; ++h) { used += usage()[h]; sol += S[h]; }
  used += usage()[hh] * frac; sol += S[hh] * frac;
  double sun = std::max(0.0, std::sin((hh + mm / 60.0 - 8) / 10.5 * M_PI));
  double solarW = std::round(sun * 3400 * 0.9), home = std::round(usage()[hh] * 1000);
  double batt = 0, surplus = solarW - home;
  if (surplus > 0) batt = std::min(surplus, 2500.0); else if (surplus < 0) batt = -std::min(-surplus, 2500.0);
  double grid = home - solarW + batt;
  st.set("sensor.solar_power", val(jsNumber(solarW)));
  st.set("sensor.home_power", val(jsNumber(home)));
  st.set("sensor.grid_power", val(jsNumber(grid)));
  st.set("sensor.battery_power", val(jsNumber(batt)));
  st.set("sensor.home_battery_soc", val("64"));
  st.set("sensor.energy_today", val(toFixed(used, 2)));
  st.set("sensor.solar_today", val(toFixed(sol, 2)));
  st.set("sensor.grid_import_today", val(toFixed(std::max(0.0, used - sol * 0.6), 2)));
  st.set("sensor.grid_export_today", val(toFixed(std::max(0.0, sol - used * 0.55) * 0.4, 2)));
  EntityValue p = val("ok"); p.attrs["today"] = arr(prices()); st.set("sensor.energy_prices", p);
  EntityValue u = val("ok"); u.attrs["today"] = arr(usage()); st.set("sensor.energy_usage_hourly", u);
  EntityValue so = val("ok"); so.attrs["today"] = arr(S);
  double fc = 0; for (double v : S) fc += v;
  so.attrs["forecast"] = jsNumber(fc); st.set("sensor.solar_hourly", so);   // the emulator's mock forecast (#151)
  for (int i = 0; i < zoneCount && i < int(zones().size()); ++i) setZone(st, zones()[i], i);
  st.set("sensor.living_temperature", val(jsNumber(zones()[0].cur)));
  for (int i = 0; i < int(lights().size()); ++i) setLight(st, lights()[i], i, lights()[i].on, lights()[i].b);
  // travel "mixed" (#145: user routes on their own sensors, see travelConfig()): train 1, bus 2, train 3, car 4
  struct Rt { const char* id; std::vector<int> offsets; std::vector<const char*> info; int lvl; };
  std::vector<Rt> rts = {{"sensor.demo_train", {4, 11, 19, 26, 34, 41, 49, 56}, {"Intercity · platform 5", "Sprinter · platform 4"}, 1},
                         {"sensor.demo_bus", {7, 22, 37, 52}, {"Bus 52 · to the station"}, 2},
                         {"sensor.demo_city", {13, 43}, {"Intercity · 1 transfer"}, 3}};
  static const int delays[4][3] = {{0, 0, 0}, {3, 0, 2}, {8, 6, 0}, {0, 18, 25}};
  int nowMin = hh * 60 + mm;
  for (auto& r : rts) {
    std::vector<int> times;
    for (int h = hh; h <= hh + 2 && times.size() < 3; ++h)
      for (int o : r.offsets) { int t = h * 60 + o; if (t > nowMin && times.size() < 3) times.push_back(t); }
    std::string deps = "[";
    for (size_t j = 0; j < times.size(); ++j) {
      bool canc = r.lvl == 4 && j == 0;
      deps += std::string(j ? "," : "") + "{\"time\":\"" + hhmm(times[j]) + "\",\"delay\":" + std::to_string(canc ? 0 : delays[r.lvl - 1][j]) +
              ",\"cancelled\":" + (canc ? "true" : "false") + ",\"info\":" + jsonQuote(r.info[j % r.info.size()]) + "}";
    }
    EntityValue e = val("ok"); e.attrs["departures"] = deps + "]";
    if (std::string(r.id) == "sensor.demo_bus") e.attrs["per_hour"] = "4";
    st.set(r.id, e);
  }
  EntityValue car = val("37"); car.attrs["typical"] = "21";
  st.set("sensor.demo_drive", car);
}

// A Travel screen of user routes on the sensors above (the default config has none, #145).
inline const char* travelYaml() {
  return "version: 1\nscreens:\n  - id: travel\n    app: travel\n    title: Travel\n    widgets:\n"
         "      - {type: route, label: To work, entity: sensor.demo_train, cs: 2}\n"
         "      - {type: route, label: Bus 52, mode: bus, entity: sensor.demo_bus, cs: 2}\n"
         "      - {type: route, label: To the city, entity: sensor.demo_city, cs: 2}\n"
         "      - {type: route, label: Drive to work, mode: car, entity: sensor.demo_drive, cs: 2}\n";
}

}  // namespace demo
}  // namespace x4
