#include "core/home.h"
#include "core/catalog.h"
#include "core/entity_map.h"
#include "core/json.h"
#include "core/locale.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <ctime>
#include <limits>

namespace x4 {

namespace {

bool parseNum(const std::string& s, double& v) {
  if (s.empty() || s == "unknown" || s == "unavailable") return false;
  char* end = nullptr;
  v = std::strtod(s.c_str(), &end);
  return end && *end == '\0' && std::isfinite(v);
}

OptNum stateNum(const EntityStore& st, const std::string& id) {
  OptNum o; auto* e = st.get(id); double v;
  if (e && parseNum(e->state, v)) o = OptNum::of(v);
  return o;
}

OptNum attrNum(const EntityValue* e, const char* k) {
  OptNum o; if (!e) return o;
  auto it = e->attrs.find(k); double v;
  if (it != e->attrs.end() && parseNum(it->second, v)) o = OptNum::of(v);
  return o;
}

std::string attr(const EntityValue* e, const char* k, const std::string& d = "") {
  if (!e) return d;
  auto it = e->attrs.find(k);
  return it == e->attrs.end() ? d : it->second.str();
}

std::vector<double> attrSeries(const EntityStore& st, const std::string& id, const char* k) {
  std::vector<double> out;
  auto* e = st.get(id); if (!e) return out;
  Json j; if (!parseJson(attr(e, k), j) || !j.isArr()) return out;
  for (auto& x : j.arr) out.push_back(x.numOr(0));
  if (out.size() < 24) out.clear();
  if (out.size() > 24) out.resize(24);
  return out;
}

// attr quarters "[0.2512,…]" → 96 × 1/10000 €/kWh without a JSON DOM; false unless exactly 96 numbers
bool quarterSeries(const EntityValue* e, std::array<int32_t, 96>& q) {
  if (!e) return false;
  auto it = e->attrs.find("quarters");
  if (it == e->attrs.end()) return false;
  const char* p = it->second.c_str();   // PSRAM text, no copy
  while (*p == ' ' || *p == '[') ++p;
  size_t n = 0;
  while (*p && *p != ']') {
    char* end = nullptr;
    double v = std::strtod(p, &end);
    if (end == p || !std::isfinite(v) || n >= 96) return false;
    q[n++] = int32_t(std::lround(v * 10000));
    p = end;
    while (*p == ' ' || *p == ',') ++p;
  }
  return n == 96;
}

double orderOf(const EntityValue& e) {
  auto it = e.attrs.find("x4_order"); double v;
  if (it != e.attrs.end() && parseNum(it->second, v)) return v;
  return std::numeric_limits<double>::max();
}

std::string idPart(const std::string& entityId) { auto d = entityId.find('.'); return d == std::string::npos ? entityId : entityId.substr(d + 1); }

int parseHm(const std::string& s) {
  auto c = s.find(':'); if (c == std::string::npos) return -1;
  return std::atoi(s.substr(0, c).c_str()) * 60 + std::atoi(s.substr(c + 1).c_str());
}

}  // namespace

int HomeData::cheapestStart(int len) const {
  if (prices.size() < 24) return -1;
  int best = 0; double bestSum = std::numeric_limits<double>::infinity();
  for (int i = 0; i <= 24 - len; ++i) {
    double s = 0; for (int k = i; k < i + len; ++k) s += prices[k];
    if (s < bestSum) { bestSum = s; best = i; }
  }
  return best;
}

bool presetHasAway(const std::string& modes) {
  if (modes.empty() || modes[0] != '[') return false;
  Json j; if (!parseJson(modes, j) || !j.isArr()) return false;
  for (auto& m : j.arr) if (m.isStr() && m.str == "away") return true;
  return false;
}

HomeData deriveHome(const EntityStore& st) {
  HomeData d;
  d.solar = stateNum(st, "sensor.solar_power");
  d.home = stateNum(st, "sensor.home_power");
  d.grid = stateNum(st, "sensor.grid_power");
  d.batt = stateNum(st, "sensor.battery_power");
  d.soc = stateNum(st, "sensor.home_battery_soc");
  d.usedToday = stateNum(st, "sensor.energy_today");
  d.solarToday = stateNum(st, "sensor.solar_today");
  d.importToday = stateNum(st, "sensor.grid_import_today");
  d.exportToday = stateNum(st, "sensor.grid_export_today");
  d.inside = stateNum(st, "sensor.living_temperature");
  d.prices = attrSeries(st, "sensor.energy_prices", "today");
  d.hasQuarters = !d.prices.empty() && quarterSeries(st.get("sensor.energy_prices"), d.quarters);
  d.usage = attrSeries(st, "sensor.energy_usage_hourly", "today");
  d.solarSeries = attrSeries(st, "sensor.solar_hourly", "today");
  // eink-ha-os#151: only a real forecast; the hourly series is today so far (statistics), its sum is not a forecast
  d.solarForecast = attrNum(st.get("sensor.solar_hourly"), "forecast");

  std::vector<std::pair<const PStr*, const EntityValue*>> climates, lights;
  for (auto& kv : st.all()) {
    if (kv.first.compare(0, 8, "climate.") == 0) climates.emplace_back(&kv.first, &kv.second);
    else if (kv.first.compare(0, 6, "light.") == 0) lights.emplace_back(&kv.first, &kv.second);
  }
  auto byOrder = [](const std::pair<const PStr*, const EntityValue*>& a, const std::pair<const PStr*, const EntityValue*>& b) {
    double oa = orderOf(*a.second), ob = orderOf(*b.second);
    return oa != ob ? oa < ob : *a.first < *b.first;
  };
  std::stable_sort(climates.begin(), climates.end(), byOrder);
  std::stable_sort(lights.begin(), lights.end(), byOrder);
  for (auto& c : climates) {
    ZoneState z;
    z.id = idPart(*c.first);
    z.name = attr(c.second, "friendly_name", z.id);
    z.cur = attrNum(c.second, "current_temperature");
    z.set = attrNum(c.second, "temperature");
    if (attr(c.second, "preset_mode") == "away") d.away = true;
    z.awayOk = presetHasAway(attr(c.second, "preset_modes"));
    d.zones.push_back(z);
  }
  // lights: group by area, area order = first appearance
  std::vector<std::string> areaOrder;
  std::map<std::string, std::vector<LightState>> byArea;
  const EntityValue* lightAreas = st.get("x4.lights");   // net discovery: attrs light.<id> → area_id
  const EntityValue* areaNames = st.get("x4.areas");     // attrs area_id → name
  for (auto& l : lights) {
    LightState s;
    s.id = idPart(*l.first);
    s.area = attr(l.second, "area_id", attr(lightAreas, l.first->c_str(), "other"));
    if (s.area.empty()) s.area = "other";
    s.areaName = attr(l.second, "area_name", attr(areaNames, s.area.c_str(), s.area == "other" ? "Other" : s.area));
    s.name = attr(l.second, "friendly_name", s.id);
    std::string dim = attr(l.second, "dimmable", "");
    if (dim.empty()) {   // HA: supported_color_modes ["onoff"] = switch only
      std::string modes = attr(l.second, "supported_color_modes", "");
      dim = modes.empty() || modes.find("onoff") == std::string::npos || modes.find(',') != std::string::npos ? "true" : "false";
    }
    s.dim = dim == "true" || dim == "1";
    s.on = l.second->state == "on";
    OptNum b = attrNum(l.second, "brightness");
    s.pct = b.ok ? int(jsRound(b.v * 100.0 / 255.0)) : 100;
    if (!byArea.count(s.area)) areaOrder.push_back(s.area);
    d.areaNames[s.area] = s.areaName;
    byArea[s.area].push_back(s);
  }
  for (auto& a : areaOrder) {
    LightGroup g; g.area = a;
    for (auto& l : byArea[a]) { g.ids.push_back(l.id); d.lights.push_back(l); }
    d.lightGroups.push_back(g);
  }
  return d;
}

RouteState routeState(const EntityValue* e, bool car, Lang lang) {
  RouteState rs;
  if (!e) return rs;
  rs.has = true;
  rs.note = attr(e, "note");
  rs.perHour = int(attrNum(e, "per_hour").v);
  if (car) {
    double v; if (parseNum(e->state, v)) rs.eta = OptNum::of(v);
    rs.typical = attrNum(e, "typical");
    return rs;
  }
  Json j;
  if (parseJson(attr(e, "departures"), j) && j.isArr()) {
    for (auto& x : j.arr) {
      DepartureState dep;
      auto* t = x.get("time"); if (!t || !t->isStr()) continue;
      dep.minuteOfDay = parseHm(t->str); if (dep.minuteOfDay < 0) continue;
      if (auto* dl = x.get("delay")) dep.delay = dl->numOr(0);
      if (auto* c = x.get("cancelled")) dep.cancelled = c->type == Json::Type::Bool && c->b;
      if (auto* in = x.get("info")) dep.info = in->strOr("");
      rs.deps.push_back(dep);
    }
    return rs;
  }
  if (!parseJson(attr(e, "upcoming"), j) || !j.isArr()) return rs;
  for (auto& x : j.arr) {   // NS departures integration (eink-ha-os#275): ISO planned/actual, status on_time | delayed | cancelled
    auto iso = [&x](const char* k) { auto* v = x.get(k); return v && v->isStr() ? parseIsoTime(v->str) : int64_t(-1); };
    int64_t planned = iso("planned"), actual = iso("actual"), t = actual >= 0 ? actual : planned;
    if (t < 0) continue;
    time_t tt = time_t(t);
    struct tm tm {};
    localtime_r(&tt, &tm);
    DepartureState dep;
    dep.minuteOfDay = tm.tm_hour * 60 + tm.tm_min;
    auto* dl = x.get("delay");
    if (dl && dl->isNum()) dep.delay = dl->num;
    else if (actual >= 0 && planned >= 0) dep.delay = std::max(0.0, jsRound(double(actual - planned) / 60.0));
    auto str = [&x](const char* k) { auto* v = x.get(k); return v ? v->strOr("") : std::string(); };
    dep.cancelled = str("status") == "cancelled";
    std::string track = str("track"), dir = str("direction");
    dep.info = track.empty() ? dir : tr(lang, S::routeTrack, track) + (dir.empty() ? "" : " · " + dir);
    rs.deps.push_back(dep);
  }
  return rs;
}

std::vector<LightGroup> pickLights(const std::vector<LightGroup>& groups, const Widget& w) {
  auto areas = listOf(w, "areas"), ents = listOf(w, "entities");
  if (areas.empty() && ents.empty()) return groups;
  std::vector<LightGroup> out;
  auto find = [](std::vector<LightGroup>& v, const std::string& area) -> LightGroup* {
    for (auto& g : v) if (g.area == area) return &g;
    return nullptr;
  };
  auto shown = [&out](const std::string& id) {
    for (auto& g : out) for (auto& x : g.ids) if (x == id) return true;
    return false;
  };
  for (auto& a : areas) {
    if (find(out, a)) continue;
    for (auto& g : groups) if (g.area == a) { out.push_back(g); break; }
  }
  for (auto& e : ents) {
    if (e.compare(0, 6, "light.") != 0) continue;
    std::string id = e.substr(6);
    const LightGroup* src = nullptr;
    for (auto& g : groups) for (auto& x : g.ids) if (x == id) src = &g;
    if (!src || shown(id)) continue;
    if (LightGroup* o = find(out, src->area)) o->ids.push_back(id);
    else out.push_back(LightGroup{src->area, {id}});
  }
  return out;
}

std::vector<ZoneState> pickZones(const std::vector<ZoneState>& zones, const Widget& w) {
  auto ents = listOf(w, "entities");
  auto labels = labelPairs(w.field("labels"));
  auto named = [&labels](std::vector<ZoneState> zs) {   // the tile's own room names (eink-ha-os#151)
    for (auto& z : zs)
      for (auto& l : labels)
        if (!l.second.empty() && l.first == "climate." + z.id) { z.name = l.second; break; }
    return zs;
  };
  if (ents.empty()) return labels.empty() ? zones : named(zones);
  std::vector<ZoneState> out;
  for (auto& e : ents) {
    if (e.compare(0, 8, "climate.") != 0) continue;
    std::string id = e.substr(8);
    bool dup = false;
    for (auto& z : out) dup |= z.id == id;
    if (dup) continue;
    for (auto& z : zones) if (z.id == id) { out.push_back(z); break; }
  }
  return labels.empty() ? out : named(std::move(out));
}

int listPages(const Widget& w, const HomeData& d) {
  if (w.type == "zoneList") return int((pickZones(d.zones, w).size() + kPerPage - 1) / kPerPage);
  if (w.type == "lightList") return int(layoutLights(pickLights(d.lightGroups, w)).size());
  return 1;
}

LightSubs lightSubs(const Config& c) {
  LightSubs s;
  bool any = false, unpicked = false;
  for (auto& sc : c.screens)
    for (auto& w : sc.widgets) {
      if (w.type != "lightList") continue;
      any = true;
      auto areas = listOf(w, "areas");
      if (areas.empty() && listOf(w, "entities").empty()) unpicked = true;
      s.areas.insert(areas.begin(), areas.end());
    }
  s.all = !any || unpicked;
  if (s.all) s.areas.clear();
  return s;
}

std::vector<std::string> lightsToWatch(const std::vector<std::pair<std::string, std::string>>& lights, const LightSubs& s, size_t cap) {
  std::vector<std::string> out;
  for (auto& l : lights) {
    if (out.size() >= cap) break;
    if (s.all || s.areas.count(l.second)) out.push_back(l.first);
  }
  return out;
}

ListCounts listCounts(size_t climate, size_t lights, size_t cap) {
  ListCounts c;
  c.climate = {climate, std::min(climate, cap)};
  c.lights = {lights, std::min(lights, cap - c.climate.shown)};
  return c;
}

std::string friendlyName(const std::string& entity, const EntityValue* raw) {
  if (raw) { auto it = raw->attrs.find("friendly_name"); if (it != raw->attrs.end() && !it->second.empty()) return it->second; }
  return entity;
}

bool entityAvailable(const EntityValue* raw) {
  return raw && !raw->state.empty() && raw->state != "unknown" && raw->state != "unavailable";
}

EntityGap entityGap(const EntityValue* raw) {
  if (!raw) return EntityGap::None;
  return raw->state == "unavailable" ? EntityGap::Unavailable : raw->state == "unknown" ? EntityGap::Unknown : EntityGap::None;
}

std::map<std::string, std::string> entityGaps(const Config& cfg, const EntityStore& store) {
  std::map<std::string, std::string> out;
  for (auto& sc : cfg.screens)
    for (auto& w : sc.widgets) {
      if (w.type != "stat" && w.type != "gauge" && w.type != "switch" && w.type != "route" && w.type != "media") continue;
      std::string id = w.field("entity");
      if (id.empty() || findEntity(id) || id == kGaugeDefaultEntity) continue;
      EntityGap g = entityGap(store.get(id));
      if (g != EntityGap::None) out[id] = g == EntityGap::Unavailable ? "unavailable" : "unknown";
    }
  return out;
}

int displayPrecision(const EntityValue* raw) {
  if (!raw) return -1;
  auto it = raw->attrs.find("display_precision");
  double v;
  if (it == raw->attrs.end() || !parseNum(it->second, v) || v < 0 || v > 10 || v != std::floor(v)) return -1;
  return int(v);
}

StatSource statSource(const std::string& entity, const EntityValue& raw) {
  StatSource s;
  auto attr = [&raw](const char* k) { auto it = raw.attrs.find(k); return it == raw.attrs.end() ? std::string() : it->second.str(); };
  const bool climate = entity.compare(0, 8, "climate.") == 0, weather = entity.compare(0, 8, "weather.") == 0;
  if (!climate && !weather) { s.state = raw.state.str(); s.unit = attr("unit_of_measurement"); return s; }
  s.state = attr(climate ? "current_temperature" : "temperature");
  if (s.state.empty()) { s.ok = false; return s; }
  s.unit = weather && !attr("temperature_unit").empty() ? attr("temperature_unit") : "°C";
  return s;
}

StatText statText(const std::string& entity, const HomeData& d, int hour, const EntityValue* raw, Lang l) {
  StatText t;
  auto* def = findEntity(entity);
  if (!def) {   // any HA entity: shown as HA reports it
    t.label = friendlyName(entity, raw);
    t.gap = entityGap(raw);
    if (!entityAvailable(raw)) { t.value = t.gap == EntityGap::None ? "—" : ""; return t; }
    if (entity.compare(0, 14, "binary_sensor.") == 0) { t.value = tr(l, raw->state == "on" ? S::on : S::off); return t; }
    StatSource s = statSource(entity, *raw);
    if (!s.ok) { t.value = "—"; return t; }
    t.unit = s.unit;
    t.value = fmtValue(s.state, t.unit, displayPrecision(raw));
    return t;
  }
  t.label = tr(l, def->label);
  const int dp = displayPrecision(raw);   // HA display_precision of the tile's own entity (eink-ha-os#85)
  // sub: a fact or nothing (issue eink-ha-os#28, spec/test-vectors/stat-sub.json); grid/battery keep the direction (value unsigned)
  auto none = [&]() { t.value = "—"; t.unit = ""; t.sub = ""; return t; };
  auto today = [l](const OptNum& o) { return o.ok ? tr(l, S::kwhToday, fmtNum(o.v, "kWh")) : std::string(); };
  auto with = [](std::string a, const std::string& b) { return b.empty() ? a : a + " · " + b; };
  auto kwh = [&](const OptNum& o, const std::string& sub) {
    if (!o.ok) return none();
    t.value = fmtNum(o.v, "kWh", dp); t.unit = "kWh"; t.sub = sub; return t;
  };
  if (entity == "sensor.solar_power") {
    if (!d.solar.ok) return none();
    ValueUnit vu = kw(d.solar.v, dp); t.value = vu.v; t.unit = vu.u; t.sub = d.solar.v > 0 ? today(d.solarToday) : std::string(tr(l, S::noSun)); return t;
  }
  if (entity == "sensor.home_power") {
    if (!d.home.ok) return none();
    ValueUnit vu = kw(d.home.v, dp); t.value = vu.v; t.unit = vu.u; t.sub = today(d.usedToday); return t;
  }
  if (entity == "sensor.grid_power") {
    if (!d.grid.ok) return none();
    ValueUnit vu = kw(d.grid.v, dp); t.value = vu.v; t.unit = vu.u;
    t.sub = d.grid.v > 30 ? with(tr(l, S::gridIn), today(d.importToday)) : d.grid.v < -30 ? with(tr(l, S::gridOut), today(d.exportToday)) : tr(l, S::balanced);
    return t;
  }
  if (entity == "sensor.battery_power") {
    if (!d.batt.ok) return none();
    ValueUnit vu = kw(d.batt.v, dp); t.value = vu.v; t.unit = vu.u;
    t.sub = with(tr(l, d.batt.v > 30 ? S::batCharging : d.batt.v < -30 ? S::batDischarging : S::idle),
                 d.soc.ok ? fmtNum(d.soc.v, "%") + "%" : "");
    return t;
  }
  if (entity == "sensor.energy_today") return kwh(d.usedToday, "");
  if (entity == "sensor.solar_today")
    return kwh(d.solarToday, d.solarForecast.ok ? tr(l, S::solarForecast, fmtNum(d.solarForecast.v, "kWh")) : "");
  if (entity == "sensor.grid_import_today") return kwh(d.importToday, "");
  if (entity == "sensor.grid_export_today") return kwh(d.exportToday, "");
  if (entity == "sensor.price_min" || entity == "sensor.price_max") {
    if (d.prices.size() < 24) return none();
    auto it = entity == "sensor.price_min" ? std::min_element(d.prices.begin(), d.prices.end())
                                           : std::max_element(d.prices.begin(), d.prices.end());
    t.value = locale::money(*it); t.unit = "";
    t.sub = tr(l, S::atHour, pad2(int(it - d.prices.begin())) + ":00");
    return t;
  }
  if (entity == "sensor.price_cheap_window") {
    int c = d.cheapestStart(3); if (c < 0) return none();
    t.value = pad2(c) + "–" + pad2(c + 3); t.unit = "";
    t.sub = tr(l, S::avgPrice, locale::money((d.prices[c] + d.prices[c + 1] + d.prices[c + 2]) / 3)); return t;
  }
  if (entity == "sensor.living_temperature") {
    OptNum v = d.inside;   // the mapped inside thermometer only (eink-ha-os#148: no climate.living guess)
    if (!v.ok) return none();
    int n = d.heatingCount();
    t.value = fmtNum(v.v, "°C", dp); t.unit = "°C"; t.sub = n == 1 ? tr(l, S::roomHeating1) : tr(l, S::roomsHeating, std::to_string(n), "{}"); return t;
  }
  (void)hour;
  t.value = "—";
  return t;
}

}  // namespace x4
