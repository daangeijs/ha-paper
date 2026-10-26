// Port of emulator/src/core/seed.ts (seedConfig; rules there). Keep the two in step: spec/test-vectors/seed.json.
#include "core/seed.h"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <initializer_list>
#include <map>
#include <set>

#include "core/catalog.h"
#include "core/json.h"

namespace x4 {

namespace {

using Words = std::vector<const char*>;

const Words kOutside = {"outdoor", "outside", "buiten", "exterior", "weather", "weer", "buienradar", "openweathermap", "knmi", "forecast"};
const Words kNotARoom = {"cpu", "processor", "battery", "chip", "disk", "nas", "router", "soc", "fridge", "freezer", "koelkast", "vriezer",
                         "water", "boiler", "pomp", "pump"};
const Words kLiving = {"living", "lounge", "woon", "family", "sitting"};
const Words kDay = {"today", "vandaag", "daily", "dag", "day"};   // whole tokens (#136)
const Words kDeviceT = {"device_temperature", "device temperature"};
// whole tokens of a temperature that is no reading of now (#152)
const Words kForecast = {"forecast", "verwachting", "max", "min", "maximum", "minimum", "high", "low", "today", "tomorrow", "vandaag", "morgen",
                         "daily", "day", "dag", "apparent", "feels", "gevoel", "gevoelstemperatuur", "dew", "dewpoint", "dauwpunt"};

// role words (seed.ts has the same lists)
const Words kSolar = {"solar", "pv", "zon", "inverter", "omvormer", "envoy", "enphase"};
const Words kBatt = {"battery", "batterij", "accu", "solarbank", "solix", "powerwall", "storage"};
const Words kHome = {"home", "house", "huis", "load"};
const Words kGrid = {"grid", "p1", "dsmr", "electricity_meter", "netto", "net_power", "elektriciteitsnet"};
const Words kPhase = {"phase", "fase", "_l1", "_l2", "_l3"};
const Words kImport = {"import", "afname", "consum", "deliver"};
const Words kExport = {"export", "produc", "return", "teruglever", "injection"};

Words cat(std::initializer_list<Words> parts) {
  Words o;
  for (auto& p : parts) o.insert(o.end(), p.begin(), p.end());
  return o;
}

struct Role { Words good, bad; };
const Role& roleSolar() {
  static const Role r{cat({kSolar, {"produc"}}), cat({kBatt, kHome, kGrid, kPhase, {"import", "export", "afname", "teruglever", "consum", "verbruik"}})};
  return r;
}
const Role& roleGrid() { static const Role r{kGrid, cat({kSolar, kBatt, kHome, kPhase, kExport})}; return r; }
const Role& roleBatt() { static const Role r{kBatt, cat({kHome, kGrid, kPhase, {"pv", "zon", "inverter", "omvormer"}})}; return r; }
const Role& roleHome() {
  static const Role r{cat({kHome, {"envoy", "enphase"}}),
                      cat({kGrid, kPhase, {"pv", "zon", "inverter", "omvormer", "battery", "batterij", "charg", "import", "export", "afname", "teruglever", "produc"}})};
  return r;
}
const Role& roleSoc() {
  static const Role r{{"soc", "state_of_charge", "charge", "laadniveau", "laadtoestand", "solarbank", "solix", "powerwall", "home_battery", "thuisaccu", "thuisbatterij"},
                      {"phone", "pixel", "iphone", "ipad", "tablet", "watch", "remote", "laptop", "button", "motion", "door", "deur", "window", "raam"}};
  return r;
}
const Role& roleImportDay() { static const Role r{kImport, cat({kSolar, kBatt, kExport})}; return r; }
const Role& roleExportDay() { static const Role r{kExport, cat({kSolar, kBatt, kImport})}; return r; }
// by name, a grid day counter must name the grid, used today the house (#152: an appliance plug's "today consumption")
const Words& gridDay() { static const Words w = cat({kGrid, {"import", "export", "afname", "teruglever", "injection"}}); return w; }
const Words& houseDay() { static const Words w = cat({kHome, {"total", "totaal", "energieverbruik", "stroomverbruik", "elektriciteitsverbruik"}}); return w; }
const Role& roleUsedDay() {
  static const Role r{{"verbruik", "usage", "used", "consumption", "home", "huis", "house"}, cat({kSolar, kBatt, kGrid, {"import", "export", "afname", "teruglever"}})};
  return r;
}

std::string lower(std::string s) {
  for (auto& c : s) c = char(std::tolower(static_cast<unsigned char>(c)));
  return s;
}
// one of `words` as a whole token of the lower-case text (anything but a-z 0-9 separates)
bool hasToken(const std::string& text, const Words& words) {
  auto word = [&](size_t j) { char c = text[j]; return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); };
  size_t i = 0;
  while (i < text.size()) {
    while (i < text.size() && !word(i)) ++i;
    size_t a = i;
    while (i < text.size() && word(i)) ++i;
    for (auto* d : words) if (i > a && std::strlen(d) == i - a && text.compare(a, i - a, d) == 0) return true;
  }
  return false;
}
bool hasAny(const std::string& s, const Words& keys) {
  std::string l = lower(s);
  for (auto* k : keys) if (l.find(k) != std::string::npos) return true;
  return false;
}
int score(const std::string& text, const Role& r) {
  int s = 0;
  for (auto* k : r.good) if (text.find(k) != std::string::npos) s += 2;
  for (auto* k : r.bad) if (text.find(k) != std::string::npos) s -= 3;
  return s;
}

std::string strOf(const Json* j) { return j && j->isStr() ? j->str : std::string(); }
std::string at(const Json& row, size_t i) { return row.isArr() && i < row.arr.size() ? strOf(&row.arr[i]) : std::string(); }

std::vector<std::string> objWords(const std::string& id) {
  size_t d = id.find('.');
  std::string o = d == std::string::npos ? id : id.substr(d + 1);
  std::vector<std::string> w;
  size_t a = 0;
  for (;;) {
    size_t b = o.find('_', a);
    w.push_back(o.substr(a, b == std::string::npos ? std::string::npos : b - a));
    if (b == std::string::npos) return w;
    a = b + 1;
  }
}

// stat_rate | power[0].stat_rate | power_config.stat_rate (one entity, HA's sign)
std::string rateOf(const Json& s) {
  if (auto r = strOf(s.get("stat_rate")); !r.empty()) return r;
  if (const Json* p = s.get("power"); p && p->isArr())
    for (auto& x : p->arr)
      if (x.isObj()) if (auto r = strOf(x.get("stat_rate")); !r.empty()) return r;
  const Json* pc = s.get("power_config");
  return pc && pc->isObj() ? strOf(pc->get("stat_rate")) : std::string();
}

struct Row { std::string id, cls, area, name, unit, text, kind; };

Widget make(const char* type, std::initializer_list<std::pair<const char*, std::string>> fields = {}, int cs = 1, int rs = 1) {
  Widget w;
  w.type = type;
  w.cs = cs;
  w.rs = rs;
  for (auto& f : fields) w.fields[f.first] = f.second;
  return w;
}

Widget stat(const std::string& entity, const char* label = nullptr) {
  std::string t = label ? seedLabel(label) : std::string();
  return t.empty() ? make("stat", {{"entity", entity}}) : make("stat", {{"entity", entity}, {"label", t}});
}

}  // namespace

std::string sensorKind(const std::string& cls, const std::string& unit, const std::string& text) {
  auto in = [&](const Words& w) {
    for (auto* k : w) if (text.find(k) != std::string::npos) return true;
    return false;
  };
  if (cls == "temperature") return in(kDeviceT) ? "" : "t";
  if (cls == "power" || unit == "W" || unit == "kW") return in(kPhase) ? "" : "p";
  if ((cls == "energy" || unit == "kWh" || unit == "Wh") && hasToken(text, kDay)) return "e";
  if (unit == "%" && (cls == "battery" || cls.empty())) return "b";
  return "";
}

int sharedWords(const std::string& a, const std::string& b) {
  auto x = objWords(a), y = objWords(b);
  size_t n = 0;
  while (n < x.size() && n < y.size() && x[n] == y[n]) ++n;
  return int(n);
}

// Same text as SEED_TEMPLATE in emulator/src/core/seed.ts (rules for real HA there, #58); seed.json `template`.
const char* seedTemplate() {
  return "{# x4_seed #}{% set ns = namespace(a=[], l=[], s=[], c=[], v=[], w=[], t=0, p=0, e=0, b=0) %}"
         "{% for a in areas() %}{% set ns.a = ns.a + [[a, area_name(a) or a]] %}{% endfor %}"
         "{% for s in states.light %}{% if ns.l | length < 150 %}"
         "{% set ns.l = ns.l + [[s.entity_id, area_id(s.entity_id) or '', 'g' if s.attributes.get('entity_id') or "
         "s.attributes.get('is_hue_group') or s.attributes.get('is_deconz_group') or s.attributes.get('lights') else '']] %}"
         "{% endif %}{% endfor %}"
         "{% for s in states.sensor %}{% set dc = s.attributes.get('device_class') or '' %}"
         "{% set u = s.attributes.get('unit_of_measurement') or '' %}"
         "{% set n = (s.entity_id ~ ' ' ~ (s.name | string)) | lower %}"
         "{% set k = 't' if dc == 'temperature' and not ('device_temperature' in n or 'device temperature' in n) else "
         "'' if dc == 'temperature' else "
         "'p' if (dc == 'power' or u in ['W', 'kW']) and not ('phase' in n or 'fase' in n or '_l1' in n or '_l2' in n or '_l3' in n) else "
         "'' if dc == 'power' or u in ['W', 'kW'] else "
         "'e' if (dc == 'energy' or u in ['kWh', 'Wh']) and n | regex_search('(^|[^a-z0-9])(today|vandaag|daily|dag|day)([^a-z0-9]|$)') else "
         "'b' if u == '%' and dc in ['battery', ''] else 'r' if s.entity_id.startswith('sensor.x4_route_') else "
         "'' %}{% if k == 't' and (s.state in ['unknown', 'unavailable'] or ns.t >= 60) %}{% set k = '' %}"
         "{% endif %}{% if k == 't' %}{% set ns.t = ns.t + 1 %}{% elif k == 'p' %}{% if ns.p < 100 %}"
         "{% set ns.p = ns.p + 1 %}{% else %}{% set k = '' %}{% endif %}{% elif k == 'e' %}{% if ns.e < 40 %}"
         "{% set ns.e = ns.e + 1 %}{% else %}{% set k = '' %}{% endif %}{% elif k == 'b' %}{% if ns.b < 60 %}"
         "{% set ns.b = ns.b + 1 %}{% else %}{% set k = '' %}{% endif %}{% endif %}{% if k %}"
         "{% set ns.s = ns.s + [[s.entity_id, dc | string, (area_id(s.entity_id) or '') if k == 't' else "
         "'', s.name | string, u | string]] %}{% endif %}{% endfor %}{% for s in states.climate %}"
         "{% set d = device_id(s.entity_id) %}"
         "{% if d and device_entities(d) | select('match', 'device_tracker') | list %}"
         "{% set ns.v = ns.v + [s.entity_id] %}{% else %}"
         "{% set ns.c = ns.c + [[s.entity_id, s.name | string, area_id(s.entity_id) or '', s.state]] %}{% endif %}"
         "{% endfor %}{% for s in states.weather %}{% if s.attributes.get('temperature') is number %}"
         "{% set ns.w = ns.w + [s.entity_id] %}{% endif %}{% endfor %}"
         "{{ {'areas': ns.a, 'climate': ns.c, 'vehicles': ns.v, 'lights': ns.l, 'sensors': ns.s, 'weather': ns.w} | tojson }}";
}

bool seedAnswerOk(const std::string& text) {
  Json j;
  return parseJson(text, j) && j.isObj();
}

bool templateEventFinal(bool hasResult, const char* level) {
  return hasResult || !level || std::strcmp(level, "WARNING") != 0;
}

std::string seedLabel(const std::string& s) {
  std::string o;
  for (char c : s) if (!std::strchr(",:{}[]#\"", c) || c == '\0') o += c;
  size_t a = o.find_first_not_of(" \t\r\n\v\f"), b = o.find_last_not_of(" \t\r\n\v\f");
  return a == std::string::npos ? std::string() : o.substr(a, b - a + 1);
}

std::string seedSnapshot(const std::string& prefsJson, const std::vector<std::string>& live, const std::string& templateJson) {
  Json j;
  std::string o = "{\"energy\":";
  o += !prefsJson.empty() && parseJson(prefsJson, j) && j.isObj() ? prefsJson : std::string("null");
  o += ",\"live\":[";
  for (size_t i = 0; i < live.size(); ++i) o += (i ? "," : "") + jsonQuote(live[i]);
  o += "]";
  if (!templateJson.empty() && parseJson(templateJson, j) && j.isObj() && !j.obj.empty()) {
    size_t a = templateJson.find('{'), b = templateJson.rfind('}');
    o += "," + templateJson.substr(a + 1, b - a - 1);
  }
  return o + "}";
}

Config seedConfig(const std::string& snapshotJson, const std::vector<Screen>& tail, SeedReport* report) {
  Json snap;
  if (!parseJson(snapshotJson, snap)) snap = Json{};
  return seedConfig(snap, tail, report);
}

int SeedReport::filled() const {
  int n = 0;
  for (auto& t : tiles) n += t.why.empty() ? 1 : 0;
  return n;
}

std::string seedReportJson(const SeedReport& r) {
  std::string o = "{\"filled\":" + std::to_string(r.filled()) + ",\"total\":" + std::to_string(r.tiles.size()) + ",\"tiles\":[";
  for (size_t i = 0; i < r.tiles.size(); ++i) {
    const SeedTile& t = r.tiles[i];
    o += (i ? ",{" : "{") + std::string("\"tile\":") + jsonQuote(t.tile) + ",\"screen\":" + jsonQuote(t.screen);
    if (!t.entity.empty()) o += ",\"entity\":" + jsonQuote(t.entity);
    o += t.why.empty() ? ",\"rule\":" + jsonQuote(t.rule) : ",\"why\":" + jsonQuote(t.why);
    o += "}";
  }
  return o + "]}";
}

Config seedConfig(const Json& snap, const std::vector<Screen>& tail, SeedReport* report) {
  auto arr = [&](const char* k) -> const std::vector<Json>& {
    static const std::vector<Json> none;
    const Json* j = snap.isObj() ? snap.get(k) : nullptr;
    return j && j->isArr() ? j->arr : none;
  };
  std::set<std::string> live;
  for (auto& x : arr("live")) if (x.isStr()) live.insert(x.str);

  // ---- Energy dashboard
  bool hasSolar = false, hasBattery = false, solarM = false, importM = false, price = false, energyOn = false;
  std::string rateSolar, rateGrid, rateBatt, priceId;
  std::vector<std::string> mSolar, mGrid, mBatt, mImport, mExport;
  if (const Json* e = snap.isObj() ? snap.get("energy") : nullptr; e && e->isObj())
    if (const Json* srcs = e->get("energy_sources"); srcs && srcs->isArr())
      for (auto& s : srcs->arr) {
        if (!s.isObj()) continue;
        std::string t = strOf(s.get("type"));
        std::string* rate = t == "solar" ? &rateSolar : t == "grid" ? &rateGrid : t == "battery" ? &rateBatt : nullptr;
        if (!rate) continue;
        energyOn = true;
        if (rate->empty()) *rate = rateOf(s);
        if (t == "solar") {
          hasSolar = true;
          if (auto m = strOf(s.get("stat_energy_from")); !m.empty()) { solarM = true; mSolar.push_back(m); }
        } else if (t == "battery") {
          hasBattery = true;
          for (auto* k : {"stat_energy_from", "stat_energy_to"})
            if (auto m = strOf(s.get(k)); !m.empty()) mBatt.push_back(m);
        } else {
          if (const Json* ff = s.get("flow_from"); ff && ff->isArr())
            for (auto& f : ff->arr) {
              if (!f.isObj()) continue;
              if (auto m = strOf(f.get("stat_energy_from")); !m.empty()) {
                importM = true;
                mGrid.push_back(m);
                mImport.push_back(m);
              }
              if (auto p = strOf(f.get("entity_energy_price")); !p.empty()) {
                price = true;
                if (priceId.empty()) priceId = p;
              }
            }
          if (const Json* ft = s.get("flow_to"); ft && ft->isArr())
            for (auto& f : ft->arr)
              if (f.isObj()) if (auto m = strOf(f.get("stat_energy_to")); !m.empty()) {
                mGrid.push_back(m);
                mExport.push_back(m);
              }
        }
      }
  if (live.count("sensor.energy_prices")) price = true;

  // ---- sensors in HA's state list
  const auto& statDomains = *entityDomains("stat");
  std::vector<Row> rows;
  for (auto& s : arr("sensors")) {
    if (!s.isArr() || !entityFits(at(s, 0), statDomains)) continue;
    Row r{at(s, 0), at(s, 1), at(s, 2), at(s, 3), at(s, 4), "", ""};
    r.text = lower(r.id + " " + r.name);
    r.kind = sensorKind(r.cls, r.unit, r.text);
    rows.push_back(std::move(r));
  }
  std::set<std::string> taken;
  std::map<std::string, const char*> how;   // sensor id → the rule that picked it (seed report)
  // one role: identity, then the Energy dashboard's power sensor / meter device, then name words
  auto pick = [&](const char* logical, const char* kind, const Role& role, const std::string& rate,
                  const std::vector<std::string>& meters, bool socBonus = false, const Words* need = nullptr) -> const Row* {
    std::vector<const Row*> cand;
    for (auto& r : rows) if (r.kind == kind && !taken.count(r.id)) cand.push_back(&r);
    auto key = [&](const Row* r) { return 2 * score(r->text, role) + (socBonus && r->cls == "battery" ? 1 : 0); };
    const Row* b = nullptr;
    const char* rule = "id";
    for (auto* r : cand) if (r->id == logical) { b = r; break; }
    if (!b && !rate.empty()) {
      rule = "energy";
      for (auto* r : cand) if (r->id == rate) { b = r; break; }
    }
    if (!b && !meters.empty()) {
      rule = "device";
      int bw = 0, bk = 0;
      for (auto* r : cand) {
        int w = 0;
        for (auto& m : meters) w = std::max(w, sharedWords(m, r->id));
        if (w < 2 || score(r->text, role) < 0) continue;
        if (!b || w > bw || (w == bw && key(r) > bk)) { b = r; bw = w; bk = key(r); }
      }
    }
    if (!b) {
      rule = "name";
      int bk = 0;
      for (auto* r : cand)
        if (score(r->text, role) > 0 && (!need || hasAny(r->text, *need)) && (!b || key(r) > bk)) { b = r; bk = key(r); }
    }
    if (b) {
      taken.insert(b->id);
      how[b->id] = rule;
    }
    return b;
  };
  static const std::vector<std::string> kNone;
  const Row* solarP = pick("sensor.solar_power", "p", roleSolar(), rateSolar, mSolar);
  const Row* gridP = pick("sensor.grid_power", "p", roleGrid(), rateGrid, mGrid);
  const Row* battP = pick("sensor.battery_power", "p", roleBatt(), rateBatt, mBatt);
  const Row* homeP = pick("sensor.home_power", "p", roleHome(), "", kNone);
  const Row* soc = pick("sensor.home_battery_soc", "b", roleSoc(), "", mBatt, true);
  const Row* solarD = pick("sensor.solar_today", "e", roleSolar(), "", kNone);
  const Row* importD = pick("sensor.grid_import_today", "e", roleImportDay(), "", mImport, false, &gridDay());
  const Row* exportD = pick("sensor.grid_export_today", "e", roleExportDay(), "", mExport, false, &gridDay());
  const Row* usedD = pick("sensor.energy_today", "e", roleUsedDay(), "", kNone, false, &houseDay());
  const bool anySolar = hasSolar || solarP || solarD, anyBattery = hasBattery || battP || soc;
  bool gridIsHome = false;
  if (!homeP && gridP && !anySolar && !anyBattery) { homeP = gridP; gridP = nullptr; gridIsHome = true; }

  // ---- rooms: temperature sensors (areas in registry order)
  std::vector<std::pair<std::string, std::string>> areas;
  for (auto& a : arr("areas")) if (!at(a, 0).empty()) areas.emplace_back(at(a, 0), at(a, 1));
  auto areaIdx = [&](const std::string& id) {
    for (size_t i = 0; i < areas.size(); ++i) if (areas[i].first == id) return i;
    return areas.size();
  };
  auto areaName = [&](const std::string& id) {
    size_t i = areaIdx(id);
    return i < areas.size() ? areas[i].second : std::string();
  };
  std::vector<const Row*> temps;
  for (auto& s : rows)
    if (s.kind == "t" && !hasAny(s.id, kNotARoom) && !hasAny(s.name, kNotARoom) && !hasToken(s.text, kForecast)) temps.push_back(&s);
  const Row* outside = nullptr;
  for (auto* s : temps) if (hasAny(s->id, kOutside) || hasAny(s->name, kOutside)) { outside = s; break; }
  static const std::vector<const char*> kWeather{"weather"};
  std::string weather;   // no outdoor thermometer: a weather entity's current temperature (#152)
  if (!outside)
    for (auto& w : arr("weather")) if (w.isStr() && entityFits(w.str, kWeather)) { weather = w.str; break; }
  std::vector<const Row*> inRooms;
  for (auto* s : temps)
    if (s != outside && !hasAny(s->id, kOutside) && !hasAny(s->name, kOutside) && !s->area.empty() && areaIdx(s->area) < areas.size())
      inRooms.push_back(s);
  std::stable_sort(inRooms.begin(), inRooms.end(), [&](const Row* a, const Row* b) { return areaIdx(a->area) < areaIdx(b->area); });
  std::vector<const Row*> perArea;
  for (auto* s : inRooms) {
    bool seen = false;
    for (auto* p : perArea) seen |= p->area == s->area;
    if (!seen) perArea.push_back(s);
  }
  const Row* inside = nullptr;
  for (auto* s : perArea) if (hasAny(s->area, kLiving) || hasAny(areaName(s->area), kLiving)) { inside = s; break; }
  if (!inside && !perArea.empty()) inside = perArea.front();

  Config c;
  auto add = [&](const char* id, const char* app, const char* title, std::vector<Widget> w) {
    if (!w.empty()) c.screens.push_back(Screen{id, app, title, std::move(w)});
  };
  // a role's tile: its logical id keeps the catalog's tile; any other sensor gets the role's label
  auto role = [&](const Row* r, const char* logical, const char* label) { return r->id == logical ? stat(r->id) : stat(r->id, label); };
  auto gauge = [&](const Row* r) {
    return r->id == "sensor.home_battery_soc" ? make("gauge") : make("gauge", {{"entity", r->id}, {"label", "Home battery"}});
  };
  auto homeTile = [&](const Row* r) { return gridIsHome ? stat(r->id, "Home use") : role(r, "sensor.home_power", "Home use"); };

  // ---- Home app
  std::vector<Widget> over{make("clock", {}, 2)};
  std::vector<std::pair<const char*, Widget>> extra;
  if (price) extra.emplace_back("price", make("price"));
  if (inside) extra.emplace_back("inside", stat(inside->id, "Inside"));
  if (solarP) extra.emplace_back("solar_power", role(solarP, "sensor.solar_power", "Solar"));
  if (homeP) extra.emplace_back("home_power", homeTile(homeP));
  if (soc) extra.emplace_back("battery_soc", gauge(soc));
  if (gridP) extra.emplace_back("grid_power", role(gridP, "sensor.grid_power", "Grid"));
  if (outside || !weather.empty()) extra.emplace_back("outside", stat(outside ? outside->id : weather, "Outside"));
  std::set<std::string> full;   // tiles the overview had no cell left for
  for (auto& e : extra) {
    Screen tmp{"", "", "", over};
    if (usedCells(tmp) + 1 <= 8) over.push_back(e.second);
    else full.insert(e.first);
  }
  add("overview", "home", "Home", over);
  if (price) add("prices", "home", "Energy prices", {make("price"), make("bars", {{"series", "prices"}}, 4)});
  std::vector<Widget> energy;
  if (usedD) energy.push_back(role(usedD, "sensor.energy_today", "Used today"));
  if (importD) energy.push_back(role(importD, "sensor.grid_import_today", "Imported"));
  if (exportD) energy.push_back(role(exportD, "sensor.grid_export_today", "Exported"));
  if (homeP) energy.push_back(homeTile(homeP));
  if (solarM || importM) energy.push_back(make("bars", {{"series", "usage"}}, 4));
  if (usedD || importD || exportD || solarM || importM) add("energy", "home", "Energy", energy);   // not for home use alone
  std::vector<Widget> solar;
  if (solarP) solar.push_back(role(solarP, "sensor.solar_power", "Solar"));
  if (solarD) solar.push_back(role(solarD, "sensor.solar_today", "Solar today"));
  if (soc) solar.push_back(gauge(soc));
  if (battP) solar.push_back(role(battP, "sensor.battery_power", "Battery"));
  if (solarM) solar.push_back(make("bars", {{"series", "solar"}}, 4));
  add("solar", "home", anySolar && anyBattery ? "Solar & battery" : anyBattery ? "Battery" : "Solar", solar);

  // ---- House app
  static const std::vector<const char*> kLight{"light"}, kClimate{"climate"};
  // lights (#152): per area its first group or else its bulbs; lights without an area left out (seed.ts)
  struct Light { std::string id, area; bool group; };
  std::vector<Light> lights;
  for (auto& l : arr("lights"))
    if (l.isArr() && entityFits(at(l, 0), kLight)) lights.push_back({at(l, 0), at(l, 1), at(l, 2) == "g"});
  std::vector<std::string> lightAreas;
  for (auto& l : lights)
    if (!l.area.empty() && std::find(lightAreas.begin(), lightAreas.end(), l.area) == lightAreas.end()) lightAreas.push_back(l.area);
  std::stable_sort(lightAreas.begin(), lightAreas.end(), [&](const std::string& a, const std::string& b) { return areaIdx(a) < areaIdx(b); });
  std::vector<std::string> lightPicks;
  bool grouped = false;
  for (auto& a : lightAreas) {
    const Light* g = nullptr;
    size_t n = 0;
    for (auto& l : lights) if (l.area == a) { ++n; if (l.group && !g) g = &l; }
    if (g) { lightPicks.push_back(g->id); grouped |= n > 1; }
    else for (auto& l : lights) if (l.area == a) lightPicks.push_back(l.id);
  }
  auto joined = [](const std::vector<std::string>& v) {
    std::string o;
    for (auto& x : v) o += (o.empty() ? "" : " ") + x;
    return o;
  };
  if (!lights.empty())
    add("lights", "house", "Lights", {lightAreas.empty() || lightPicks.size() == lights.size() ? make("lightList", {}, 4, 2)
                                      : !grouped ? make("lightList", {{"areas", joined(lightAreas)}}, 4, 2)
                                                 : make("lightList", {{"entities", joined(lightPicks)}}, 4, 2)});
  // zones (#152): one per area / friendly name; of duplicates the first that is not off / unavailable
  struct Zone { std::string id, name, area, state; };
  auto idle = [](const Zone& z) { return z.state == "off" || z.state == "unavailable" || z.state == "unknown"; };
  std::vector<Zone> zones;
  bool dupes = false, car = false;
  for (auto& x : arr("climate")) {
    Zone z;
    if (x.isStr()) z.id = x.str;
    else if (x.isArr()) z = {at(x, 0), lower(at(x, 1)), at(x, 2), at(x, 3)};
    else continue;
    size_t a = z.name.find_first_not_of(" \t\r\n\v\f"), b = z.name.find_last_not_of(" \t\r\n\v\f");
    z.name = a == std::string::npos ? std::string() : z.name.substr(a, b - a + 1);
    if (!entityFits(z.id, kClimate)) continue;
    auto o = std::find_if(zones.begin(), zones.end(), [&](const Zone& o) {
      return (!z.area.empty() && o.area == z.area) || (!z.name.empty() && o.name == z.name);
    });
    if (o == zones.end()) { zones.push_back(std::move(z)); continue; }
    dupes = true;
    if (idle(*o) && !idle(z)) *o = std::move(z);
  }
  for (auto& x : arr("vehicles")) car |= x.isStr() && entityFits(x.str, kClimate);   // zoneList's default is every climate
  if (!zones.empty()) {
    std::vector<std::string> ids;
    for (auto& z : zones) ids.push_back(z.id);
    add("climate", "house", "Heating", {car || dupes ? make("zoneList", {{"entities", joined(ids)}}, 4, 2) : make("zoneList", {}, 4, 2)});
  }
  if (perArea.size() >= 2) {
    std::vector<Widget> rooms;
    for (size_t i = 0; i < perArea.size() && i < 8; ++i) {
      std::string n = areaName(perArea[i]->area);
      rooms.push_back(stat(perArea[i]->id, n.c_str()));
    }
    add("rooms", "house", "Rooms", rooms);
  }

  // ---- Travel app
  // Any sensor.x4_route_* in HA (or mapped): a user route on it (#145), sorted by id; car when it reports minutes.
  std::set<std::string> routeIds;
  const std::string rp = "sensor.x4_route_";
  for (auto& id : live) if (id.compare(0, rp.size(), rp) == 0) routeIds.insert(id);
  for (auto& s : rows) if (s.id.compare(0, rp.size(), rp) == 0) routeIds.insert(s.id);
  std::vector<Widget> travel;
  for (auto& id : routeIds) {
    if (travel.size() >= 4) break;
    bool car = false;
    for (auto& s : rows) car |= s.id == id && s.unit == "min";
    travel.push_back(car ? make("route", {{"entity", id}, {"mode", "car"}}, 2) : make("route", {{"entity", id}}, 2));
  }
  add("travel", "travel", "Travel", travel);

  for (auto& s : tail) c.screens.push_back(s);
  for (auto& a : defaultApps()) {
    bool used = false;
    for (auto& s : c.screens) used |= s.app == a.id;
    if (used) c.apps.push_back(a);
  }
  if (!report) return c;

  // ---- seed report (#89, SEED_TILES in the emulator). Only overview tiles can be crowded out.
  auto has = [&](const char* id) {
    for (auto& s : c.screens) if (s.id == id) return true;
    return false;
  };
  auto ok = [](const std::string& entity, const char* rule) { return SeedTile{"", "", entity, rule, ""}; };
  auto drop = [](const char* why) { return SeedTile{"", "", "", "", why}; };
  auto sensorTile = [&](const Row* r, const char* rule = nullptr) { return r ? ok(r->id, rule ? rule : how[r->id]) : drop("no_sensor"); };
  const char* noMeter = energyOn ? "no_meter" : "no_energy";
  static const std::pair<const char*, const char*> kTiles[] = {
      {"price", "overview"}, {"inside", "overview"}, {"outside", "overview"}, {"solar_power", "overview"},
      {"home_power", "overview"}, {"grid_power", "overview"}, {"battery_soc", "overview"}, {"battery_power", "solar"},
      {"solar_today", "solar"}, {"solar_chart", "solar"}, {"energy_today", "energy"}, {"grid_import_today", "energy"},
      {"grid_export_today", "energy"}, {"usage_chart", "energy"}, {"lights", "lights"}, {"heating", "climate"}, {"rooms", "rooms"}};
  report->tiles.clear();
  for (auto& k : kTiles) {
    const std::string key = k.first;
    SeedTile t;
    if (key == "price") t = !price ? drop(noMeter) : !priceId.empty() ? ok(priceId, "energy") : ok("sensor.energy_prices", "id");
    else if (key == "inside") t = sensorTile(inside, "area");
    else if (key == "outside") t = !weather.empty() ? ok(weather, "found") : sensorTile(outside, "name");
    else if (key == "solar_power") t = sensorTile(solarP);
    else if (key == "home_power") t = sensorTile(homeP, gridIsHome ? "grid" : nullptr);
    else if (key == "grid_power") {
      if (gridIsHome) continue;   // the grid meter is the home use tile
      t = sensorTile(gridP);
    } else if (key == "battery_soc") t = sensorTile(soc);
    else if (key == "battery_power") t = sensorTile(battP);
    else if (key == "solar_today") t = sensorTile(solarD);
    else if (key == "solar_chart") t = solarM ? ok("", "energy") : drop(noMeter);
    else if (key == "energy_today") t = sensorTile(usedD);
    else if (key == "grid_import_today") t = sensorTile(importD);
    else if (key == "grid_export_today") t = sensorTile(exportD);
    else if (key == "usage_chart") t = solarM || importM ? ok("", "energy") : drop(noMeter);
    else if (key == "lights") t = has("lights") ? ok("", "found") : drop("none");
    else if (key == "heating") t = has("climate") ? ok("", "found") : drop("none");
    else if (key == "rooms") t = perArea.size() >= 2 ? ok("", "area") : drop("few_rooms");
    if (full.count(key) && (key == "inside" || key == "outside" || key == "grid_power")) t = drop("overview_full");
    t.tile = k.first;
    t.screen = k.second;
    report->tiles.push_back(std::move(t));
  }
  return c;
}

}  // namespace x4
