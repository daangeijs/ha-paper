// Derived, display-ready home data from the EntityStore (entity conventions documented in core/entities.h).
// Missing entities stay "absent" so the UI shows "—" — never fake numbers.
#pragma once
#include <array>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>
#include "core/config.h"
#include "core/entities.h"
#include "core/logic.h"
#include "core/strings.h"

namespace x4 {

struct OptNum {
  bool ok = false; double v = 0;
  static OptNum of(double x) { OptNum o; o.ok = true; o.v = x; return o; }
};

// awayOk: HA preset_modes lists "away" (#148: the away button and set_preset_mode only for those zones)
struct ZoneState { std::string id, name; OptNum cur, set; bool awayOk = false; bool heating() const { return cur.ok && set.ok && set.v > cur.v + 0.05; } };
struct LightState { std::string id, area, areaName, name; bool dim = false, on = false; int pct = 100; };
struct DepartureState { int minuteOfDay = 0; double delay = 0; bool cancelled = false; std::string info; };
struct RouteState {
  bool has = false;
  std::vector<DepartureState> deps;      // upcoming, absolute times
  OptNum eta, typical;                    // car: state (minutes), attr typical
  std::string note;                       // attr note: replaces the generic severity note
  int perHour = 0;                        // bus: departures per hour (0 = unknown)
};

struct HomeData {
  OptNum solar, home, grid, batt, soc;                 // W, W, W (+import), W (+charge), %
  OptNum usedToday, solarToday, importToday, exportToday, solarForecast, inside;
  std::vector<double> prices, usage, solarSeries;      // 24 hourly values or empty
  // quarter-hourly price source (#151): attr quarters, in 1/10000 €/kWh, no heap (derived on every redraw)
  bool hasQuarters = false;
  std::array<int32_t, 96> quarters{};
  std::vector<ZoneState> zones;                         // ordered
  std::vector<LightState> lights;                       // ordered (areas contiguous)
  std::vector<LightGroup> lightGroups;
  std::map<std::string, std::string> areaNames;
  bool away = false;

  int heatingCount() const { int n = 0; for (auto& z : zones) n += z.heating(); return n; }
  bool awayOk() const { for (auto& z : zones) if (z.awayOk) return true; return false; }
  int lightsOn() const { int n = 0; for (auto& l : lights) n += l.on; return n; }
  const ZoneState* zone(const std::string& id) const { for (auto& z : zones) if (z.id == id) return &z; return nullptr; }
  const LightState* light(const std::string& id) const { for (auto& l : lights) if (l.id == id) return &l; return nullptr; }
  int cheapestStart(int len = 3) const;               // -1 if no prices
  // the price now: this quarter-hour's when the source has them, else the hour's (prices[h]); needs prices
  double priceAt(int h, int m) const { return hasQuarters ? quarters[size_t(h * 4 + m / 15) % 96] / 10000.0 : prices[size_t(h) % 24]; }
};

HomeData deriveHome(const EntityStore& store);
// Does a climate's preset_modes attribute (JSON text of a list) offer "away"? (emulator core/format.ts presetHasAway)
bool presetHasAway(const std::string& modes);
// A route tile's entity (spec/SCHEMA.md, #145): train/bus = attr departures, car = state minutes + attr typical.
RouteState routeState(const EntityValue* e, bool car);

// What a lightList / zoneList tile shows (#127, spec/test-vectors/list-pick.json, emulator core/paging.ts): the picked
// areas then entities (order follows the pick, unknown ids skipped); nothing picked = everything.
std::vector<LightGroup> pickLights(const std::vector<LightGroup>& groups, const Widget& w);
std::vector<ZoneState> pickZones(const std::vector<ZoneState>& zones, const Widget& w);
int listPages(const Widget& w, const HomeData& d);   // zoneList / lightList pages of its pick (0 = empty), others 1
// Lights the display subscribes to: all (capped) unless every lightList tile has a pick, then the lights of the picked
// areas. Picked light / climate entities come with the config's entity ids (DeviceServices::entityIdsOf).
struct LightSubs {
  bool all = true;
  std::set<std::string> areas;
  bool operator==(const LightSubs& o) const { return all == o.all && areas == o.areas; }
};
LightSubs lightSubs(const Config& c);
// lights: HA discovery (entity_id, area_id) in HA order → the ones to subscribe, at most `cap`
std::vector<std::string> lightsToWatch(const std::vector<std::pair<std::string, std::string>>& lights, const LightSubs& s, size_t cap);
constexpr size_t kMaxWatched = 80;   // climate + lights subscribed when nothing narrows them (emulator MAX_WATCHED)
// What an unpicked zoneList / lightList can show (#134, GET /ha/entities `lists`, emulator core/paging.ts listCounts):
// climate first, then lights, kMaxWatched in total.
struct ListCount { size_t total = 0, shown = 0; };
struct ListCounts { ListCount climate, lights; };
ListCounts listCounts(size_t climate, size_t lights, size_t cap = kMaxWatched);

// Display text for a stat entity (emulator ENT[..].get). hour = local hour (prices).
// Logical ids (catalog entities()) use HomeData; any other HA entity is shown from its raw state `raw`
// (label = friendly_name, value = state, unit = unit_of_measurement; binary_sensor → On/Off; missing → "—").
// gap: HA has the entity but no value (unavailable / unknown, #86): value and unit are empty, the tile draws a ring and
// the reason; the emulator's core/format.ts entityGap.
enum class EntityGap { None, Unavailable, Unknown };
struct StatText { std::string label, value, unit, sub; EntityGap gap = EntityGap::None; };
// What a stat tile shows for a raw HA entity (#161, emulator core/format.ts statSource, stat-raw.json): climate →
// current_temperature in °C, weather → temperature in its temperature_unit (absent = °C), else state + unit. ok false =
// a climate / weather without a temperature ("—").
struct StatSource { bool ok = true; std::string state, unit; };
StatSource statSource(const std::string& entity, const EntityValue& raw);
StatText statText(const std::string& entity, const HomeData& d, int hour, const EntityValue* raw = nullptr, Lang l = Lang::En);

// Generic HA entity helpers (stat / gauge / switch widgets on non-logical entities).
std::string friendlyName(const std::string& entity, const EntityValue* raw);   // friendly_name or the entity id
bool entityAvailable(const EntityValue* raw);                                  // present and not unknown/unavailable
int displayPrecision(const EntityValue* raw);                                  // attr display_precision (#85), -1 = none
EntityGap entityGap(const EntityValue* raw);                                   // unavailable / unknown; absent = None ("—")
// Entities of stat / gauge / switch tiles HA has no value for (GET /console/state entity_gaps, emulator core/config.ts
// entityGaps): id → "unavailable" | "unknown". Logical ids (catalog) and the gauge's home battery are never listed.
std::map<std::string, std::string> entityGaps(const Config& cfg, const EntityStore& store);

}  // namespace x4
