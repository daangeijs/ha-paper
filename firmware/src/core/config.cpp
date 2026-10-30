// Port of the emulator's parseYaml()/toYaml() (Main.dc.html). Messages, line numbers and quirks are kept 1:1:
// regexes are hand-translated (JS \s = ASCII whitespace here; JS '.' does not match '\r', so CRLF breaks app/title lines
// exactly like in the emulator).
#include "core/config.h"
#include "core/media.h"
#include "core/attr_list.h"
#include "core/catalog.h"
#include "core/agenda.h"
#include "core/bins.h"
#include "core/guest_wifi.h"
#include "core/history.h"
#include "core/weather.h"
#include "core/json.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <memory>

namespace x4 {

const char* const kDefaultYaml = R"YAML(# HA Paper display config
version: 1
apps:
  - id: home
    title: Home
  - id: house
    title: House
screens:
  - id: overview
    app: home
    title: Home
    widgets:
      - {type: clock, cs: 2}
      - {type: price}
      - {type: stat, entity: sensor.living_temperature}
      - {type: stat, entity: sensor.solar_power}
      - {type: stat, entity: sensor.home_power}
      - {type: gauge}
      - {type: stat, entity: sensor.grid_power}
  - id: prices
    app: home
    title: Energy prices
    widgets:
      - {type: price}
      - {type: stat, entity: sensor.price_cheap_window}
      - {type: stat, entity: sensor.price_min}
      - {type: stat, entity: sensor.price_max}
      - {type: bars, series: prices, cs: 4}
  - id: energy
    app: home
    title: Energy
    widgets:
      - {type: stat, entity: sensor.energy_today}
      - {type: stat, entity: sensor.grid_import_today}
      - {type: stat, entity: sensor.grid_export_today}
      - {type: stat, entity: sensor.home_power}
      - {type: bars, series: usage, cs: 4}
  - id: solar
    app: home
    title: Solar & battery
    widgets:
      - {type: stat, entity: sensor.solar_power}
      - {type: stat, entity: sensor.solar_today}
      - {type: gauge}
      - {type: stat, entity: sensor.battery_power}
      - {type: bars, series: solar, cs: 4}
  - id: lights
    app: house
    title: Lights
    widgets:
      - {type: lightList, cs: 4, rs: 2}
  - id: climate
    app: house
    title: Heating
    widgets:
      - {type: zoneList, cs: 4, rs: 2}
)YAML";

namespace {

bool isWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; }
std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && isWs(s[a])) ++a;
  while (b > a && isWs(s[b - 1])) --b;
  return s.substr(a, b - a);
}
bool allWs(const std::string& s, size_t from) {
  for (size_t i = from; i < s.size(); ++i) if (!isWs(s[i])) return false;
  return true;
}
bool startsWith(const std::string& s, const char* p) { return s.compare(0, std::strlen(p), p) == 0; }
bool isDigits(const std::string& v) {
  if (v.empty()) return false;
  for (char c : v) if (c < '0' || c > '9') return false;
  return true;
}
// Number(v) → String for a /^\d+$/ value (leading zeros dropped, JS formatting for huge values)
std::string normNumber(const std::string& v) {
  size_t nz = v.find_first_not_of('0');
  std::string s = nz == std::string::npos ? "0" : v.substr(nz);
  if (s.size() <= 15) return s;
  return jsNumber(std::strtod(s.c_str(), nullptr));
}
// JS array-index-like key ("0".."4294967294", canonical) → sorted first by Object.keys
bool isIndexKey(const std::string& k, double& n) {
  if (!isDigits(k) || (k.size() > 1 && k[0] == '0') || k.size() > 10) return false;
  n = std::strtod(k.c_str(), nullptr);
  return n < 4294967295.0;
}

struct Fail { int line; std::string msg; };

// unq(): trim; a leading quote means JSON.parse (falls back to the trimmed text on error)
std::string unq(const std::string& raw) {
  std::string v = trim(raw);
  if (!v.empty() && v[0] == '"') {
    Json j;
    if (parseJson(v, j) && j.isStr()) return j.str;
    return v;
  }
  return v;
}

// '^\s*#' (comment) or blank
bool skippable(const std::string& raw) {
  if (trim(raw).empty()) return true;
  size_t i = 0; while (i < raw.size() && isWs(raw[i])) ++i;
  return i < raw.size() && raw[i] == '#';
}

// /^key:\s*(\S+)\s*$/
bool matchScalar(const std::string& raw, const char* prefix, std::string& val) {
  if (!startsWith(raw, prefix)) return false;
  size_t i = std::strlen(prefix);
  while (i < raw.size() && isWs(raw[i])) ++i;
  size_t s = i;
  while (i < raw.size() && !isWs(raw[i])) ++i;
  if (i == s) return false;
  if (!allWs(raw, i)) return false;
  val = raw.substr(s, i - s);
  return true;
}

// /^    (app|title):\s*(.+)$/  ('.' excludes \r; '$' = end of string)
bool matchAppTitle(const std::string& raw, std::string& key, std::string& val) {
  const char* keys[] = {"app", "title"};
  for (auto* k : keys) {
    std::string p = std::string("    ") + k + ":";
    if (!startsWith(raw, p.c_str())) continue;
    std::string rest = raw.substr(p.size());
    if (rest.empty()) return false;
    // \s* is greedy but must leave ≥1 char for (.+), and (.+) may not contain '\r'
    size_t i = 0; while (i < rest.size() && isWs(rest[i])) ++i;
    if (i == rest.size()) { if (rest.back() == '\r') return false; i = rest.size() - 1; }
    if (rest.find('\r', i) != std::string::npos) return false;
    key = k; val = rest.substr(i);
    return true;
  }
  return false;
}

// /^    widgets:\s*(\[\])?\s*$/
bool matchWidgets(const std::string& raw) {
  if (!startsWith(raw, "    widgets:")) return false;
  size_t i = 12;
  while (i < raw.size() && isWs(raw[i])) ++i;
  if (raw.compare(i, 2, "[]") == 0) {
    if (allWs(raw, i + 2)) return true;
  }
  return allWs(raw, i);
}

// /^      - \{(.*)\}\s*$/  (greedy: last '}' followed only by whitespace; inner part has no \r)
bool matchWidgetLine(const std::string& raw, std::string& inner) {
  if (!startsWith(raw, "      - {")) return false;
  size_t end = raw.size();
  while (end > 9 && isWs(raw[end - 1])) --end;
  // find the last '}' at position >= 9 such that everything after is whitespace
  for (size_t j = end; j-- > 9;) {
    if (raw[j] == '}') {
      if (!allWs(raw, j + 1)) continue;
      std::string in = raw.substr(9, j - 9);
      if (in.find('\r') != std::string::npos) return false;
      inner = in;
      return true;
    }
    if (!isWs(raw[j])) return false;
  }
  return false;
}

std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> out; size_t a = 0;
  for (;;) { size_t b = s.find(sep, a); if (b == std::string::npos) { out.push_back(s.substr(a)); return out; } out.push_back(s.substr(a, b - a)); a = b + 1; }
}

struct WVal { std::string v; bool num; bool present; };

std::string quoteName(const std::string& s) { return "“" + s + "”"; }
bool isAreaId(const std::string& s) {   // HA area id: ^[a-z0-9_]+$
  if (s.empty()) return false;
  for (char c : s) if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
  return true;
}

}  // namespace

const char* const kGaugeDefaultEntity = "sensor.home_battery_soc";

const char* const kSettingsApp = "settings";

const std::vector<AppEntry>& defaultApps() {
  static const std::vector<AppEntry> v = [] {
    std::vector<AppEntry> o;
    for (auto& a : apps()) if (std::strcmp(a.id, kSettingsApp) != 0) o.push_back({a.id, a.title});
    return o;
  }();
  return v;
}

bool isSystemTile(const std::string& t) { return t == "setting" || t == "ota" || t == "wifi" || t == "ha" || t == "about"; }

// = emulator SETTINGS_SCREENS (config.ts), in order.
const std::vector<Screen>& settingsScreens() {
  static const std::vector<Screen> v = [] {
    auto tile = [](const char* type, const char* key = nullptr, int cs = 1, int rs = 1) {
      Widget w; w.type = type; w.cs = cs; w.rs = rs;
      if (key) w.fields["key"] = key;
      return w;
    };
    auto setting = [&](const char* key, int cs = 1, int rs = 1) { return tile("setting", key, cs, rs); };
    std::vector<Screen> o;
    o.push_back({"display", kSettingsApp, "Display", {setting("brightness"), setting("warmth"), setting("lightTimeout"),
                                                       setting("returnHome"), setting("standby"), setting("interval"), setting("cleanEvery")}});
    // the clock format sits with the look since eink-ha-os#220; night mode left for Power › Quiet hours (eink-ha-os#295)
    o.push_back({"style", kSettingsApp, "Display style", {setting("style"), setting("typeface", 2), setting("surface"), setting("clock")}});
    // power saving two rows tall: room for its hint (eink-ha-os#190); quiet hours (eink-ha-os#295) are a power setting first
    o.push_back({"power", kSettingsApp, "Power", {setting("powerSave", 2, 2), setting("quiet"), setting("morning"), setting("wakeEvery"), setting("liveMin")}});   // morning: eink-ha-os#330
    o.push_back({"updates", kSettingsApp, "Updates", {tile("ota", nullptr, 4, 2)}});
    o.push_back({"wifi", kSettingsApp, "Wi-Fi", {tile("wifi", nullptr, 4, 2)}});
    o.push_back({"ha", kSettingsApp, "Home Assistant", {tile("ha", nullptr, 4, 2)}});
    o.push_back({"about", kSettingsApp, "About", {tile("about", nullptr, 4, 2)}});
    return o;
  }();
  return v;
}

Config userConfig(const Config& c) {
  Config u;
  u.version = c.version;
  for (auto& a : c.apps.empty() ? defaultApps() : c.apps) if (a.id != kSettingsApp) u.apps.push_back(a);
  for (auto& s : c.screens) if (s.app != kSettingsApp) u.screens.push_back(s);
  return u;
}

Config withSettings(const Config& c) {
  Config d = userConfig(c);
  d.apps.push_back({kSettingsApp, "Settings"});
  for (auto& s : settingsScreens()) d.screens.push_back(s);
  return d;
}

const std::vector<const char*>* entityDomains(const std::string& t) {
  static const std::vector<const char*> stat = {"sensor", "binary_sensor", "input_number", "number", "climate", "weather"};   // eink-ha-os#161
  static const std::vector<const char*> gauge = {"sensor", "input_number", "number"};
  static const std::vector<const char*> sw = {"switch", "light", "input_boolean", "fan"};
  static const std::vector<const char*> route = {"sensor"};
  static const std::vector<const char*> scene = {"scene", "script"};   // eink-ha-os#146
  static const std::vector<const char*> history = {"sensor", "input_number", "number"};   // eink-ha-os#268
  static const std::vector<const char*> weather = {"weather"};   // eink-ha-os#318
  static const std::vector<const char*> mediaDoms = {"media_player"};   // eink-ha-os#319
  static const std::vector<const char*> listDoms = {"sensor"};   // eink-ha-os#332
  if (t == "stat") return &stat;
  if (t == "scene") return &scene;
  if (t == "route") return &route;
  if (t == "gauge") return &gauge;
  if (t == "switch") return &sw;
  if (t == "history") return &history;
  if (t == "weather") return &weather;
  if (t == "media") return &mediaDoms;
  if (t == "attrList") return &listDoms;
  return nullptr;
}

std::string domainOf(const std::string& id) { return id.substr(0, id.find('.')); }

SceneAction sceneAction(const Widget& w) {
  std::string e = w.field("entity");
  return e.empty() ? SceneAction{"light", "turn_off", "all"} : SceneAction{domainOf(e), "turn_on", e};
}

std::vector<std::string> listOf(const std::string& v) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < v.size()) {
    size_t j = v.find(' ', i);
    if (j == std::string::npos) j = v.size();
    if (j > i) out.push_back(v.substr(i, j - i));
    i = j + 1;
  }
  return out;
}

std::vector<std::pair<std::string, std::string>> labelPairs(const std::string& v) {
  std::vector<std::pair<std::string, std::string>> out;
  auto trim = [](std::string s) {
    size_t a = s.find_first_not_of(' '), b = s.find_last_not_of(' ');
    return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
  };
  size_t i = 0;
  while (i <= v.size()) {
    size_t j = v.find(';', i);
    if (j == std::string::npos) j = v.size();
    std::string item = trim(v.substr(i, j - i));
    if (!item.empty()) {
      size_t eq = item.find('=');
      if (eq == std::string::npos) out.emplace_back(item, "");
      else out.emplace_back(trim(item.substr(0, eq)), trim(item.substr(eq + 1)));
    }
    i = j + 1;
  }
  return out;
}

const std::vector<std::pair<const char*, const char*>>* listPicks(const std::string& t) {
  static const std::vector<std::pair<const char*, const char*>> lights = {{"areas", nullptr}, {"entities", "light"}};
  static const std::vector<std::pair<const char*, const char*>> zones = {{"entities", "climate"}};
  static const std::vector<std::pair<const char*, const char*>> calendars = {{"entities", "calendar"}};   // eink-ha-os#316
  if (agenda::isAgendaType(t)) return &calendars;
  if (t == "lightList") return &lights;
  if (t == "zoneList") return &zones;
  return nullptr;
}

// /^[a-z0-9_]+\.[a-z0-9_]+$/ and the domain is one of `domains`
bool entityFits(const std::string& id, const std::vector<const char*>& domains) {
  size_t dot = id.find('.');
  if (dot == std::string::npos || dot == 0 || dot + 1 == id.size()) return false;
  for (size_t i = 0; i < id.size(); ++i) {
    char c = id[i];
    if (i == dot) continue;
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
  }
  std::string d = id.substr(0, dot);
  for (auto* x : domains) if (d == x) return true;
  return false;
}

int usedCells(const Screen& s) {
  int n = 0;
  for (auto& w : s.widgets) n += (w.cs ? w.cs : 1) * (w.rs ? w.rs : 1);
  return n;
}

ParseResult parseYamlText(const std::string& text) {
  ParseResult res;
  std::vector<std::unique_ptr<Screen>> store;   // all screens ever started (JS objects)
  std::vector<Screen*> screens;
  bool haveScreens = false, haveApps = false;
  std::vector<AppEntry> appsList;
  AppEntry* curApp = nullptr;
  int appsAt = 0;
  bool sawSettings = false;
  AppEntry skipped;   // the `settings` entry of an older file: built in now, its title goes nowhere (eink-ha-os#159)
  Screen* cur = nullptr;
  bool inW = false;
  int histories = 0, agendas = 0, weathers = 0;
  std::map<std::string, int> at;
  auto appList = [&]() -> const std::vector<AppEntry>& { return haveApps && !appsList.empty() ? appsList : defaultApps(); };
  auto lines = split(text, '\n');
  try {
    for (size_t i = 0; i < lines.size(); ++i) {
      const std::string& raw = lines[i];
      int n = int(i) + 1;
      if (skippable(raw)) continue;
      std::string v, key;
      if (matchScalar(raw, "version:", v)) {
        if (v != "1") throw Fail{n, "Only version 1 is supported"};
      } else if (startsWith(raw, "apps:") && allWs(raw, 5)) {
        if (haveScreens) throw Fail{n, "“apps:” must come before “screens:”"};
        haveApps = true; appsList.clear(); appsAt = n; curApp = nullptr;
      } else if (startsWith(raw, "screens:") && allWs(raw, 8)) {
        haveScreens = true; screens.clear(); curApp = nullptr;
      } else if (matchScalar(raw, "  - id:", v)) {
        if (!haveScreens && haveApps) {
          if (v == kSettingsApp) { sawSettings = true; skipped = {v, v}; curApp = &skipped; continue; }
          for (auto& a : appsList) if (a.id == v) throw Fail{n, "Duplicate app id " + quoteName(v)};
          if (int(appsList.size()) >= kMaxUserApps) throw Fail{n, "At most " + std::to_string(kMaxUserApps) + " apps"};
          appsList.push_back({v, v}); curApp = &appsList.back();
          continue;
        }
        if (!haveScreens) throw Fail{n, "“screens:” must come first"};
        store.emplace_back(new Screen());
        cur = store.back().get();
        cur->id = v; cur->app = appList().empty() ? "home" : appList()[0].id; cur->title = v;
        at[v] = n; screens.push_back(cur); inW = false;
      } else if (matchAppTitle(raw, key, v)) {
        if (curApp && !haveScreens) {
          if (key != "title") throw Fail{n, "Can’t read this line"};
          curApp->title = unq(v);
          continue;
        }
        if (!cur) throw Fail{n, "Belongs to no screen"};
        std::string val = unq(v);
        if (key == "app") {
          cur->app = val;
          bool known = val == kSettingsApp; std::string ids;
          for (auto& a : appList()) { known |= a.id == val; ids += (ids.empty() ? "" : ", ") + a.id; }
          if (!known) throw Fail{n, "Unknown app " + quoteName(cur->app) + " (" + ids + ")"};
        }
        else cur->title = val;
      } else if (matchWidgets(raw)) {
        if (!cur) throw Fail{n, "Belongs to no screen"};
        inW = true;
      } else if (matchWidgetLine(raw, v)) {
        if (!inW) throw Fail{n, "Widget outside a “widgets:” list"};
        std::vector<std::pair<std::string, WVal>> obj;
        for (auto& part : split(v, ',')) {
          auto kvp = split(part, ':');
          if (kvp.size() < 2) throw Fail{n, "Expected key: value"};
          std::string k = trim(kvp[0]);
          std::string rest = kvp[1];
          for (size_t q = 2; q < kvp.size(); ++q) rest += ":" + kvp[q];
          std::string val = trim(rest);
          WVal wv{val, isDigits(val), true};
          if (wv.num) wv.v = normNumber(val);
          bool found = false;
          for (auto& o : obj) if (o.first == k) { o.second = wv; found = true; break; }
          if (!found) obj.emplace_back(k, wv);
        }
        auto get = [&](const char* k) -> WVal { for (auto& o : obj) if (o.first == k) return o.second; return WVal{"undefined", false, false}; };
        WVal type = get("type");
        if (!type.present || type.num || !isWidgetType(type.v)) throw Fail{n, "Unknown widget type " + quoteName(type.v)};
        if (type.v == "light") {   // legacy single light → {type: switch, entity: light.<id>} (same key position)
          for (auto& o : obj) {
            if (o.first == "type") o.second = WVal{"switch", false, true};
            else if (o.first == "light") {
              std::string id = o.second.v;
              o.first = "entity";
              o.second = WVal{id.find('.') != std::string::npos ? id : "light." + id, false, true};
            }
          }
          type = get("type");
        }
        const std::vector<const char*>* doms = entityDomains(type.v);
        if (type.v == "history") doms = &hist::historyDomains(hist::sourceOf(get("attribute").present, get("entity").v));   // eink-ha-os#292
        if (doms) {
          WVal e = get("entity");
          // gauge without entity = home battery; route without entity = an empty user route (old catalog ids, eink-ha-os#145);
          // scene without entity = all lights off (eink-ha-os#146)
          if (((type.v != "gauge" && type.v != "route" && type.v != "scene") || e.present) && (!e.present || e.num || !entityFits(e.v, *doms))) {
            std::string list;
            for (size_t q = 0; q < doms->size(); ++q) list += (q ? " / " : "") + std::string((*doms)[q]);
            throw Fail{n, type.v + ": " + quoteName(e.v) + " is not a " + list + " entity"};
          }
        }
        if (auto* picks = listPicks(type.v)) {
          for (auto& pk : *picks) {
            WVal f = get(pk.first);
            if (!f.present) continue;
            for (auto& id : listOf(f.v)) {
              bool ok = pk.second ? entityFits(id, {pk.second}) : isAreaId(id);
              if (!ok) throw Fail{n, type.v + ": " + quoteName(id) + " is not " + (pk.second ? std::string("a ") + pk.second + " entity" : "an area id")};
            }
          }
        }
        if (type.v == "zoneList") {
          WVal lb = get("labels");
          if (lb.present)
            for (auto& p : labelPairs(lb.v))
              if (!entityFits(p.first, {"climate"}) || p.second.empty()) throw Fail{n, "zoneList: " + quoteName(p.first) + " in labels is not climate.<id>=Name"};
        }
        if (type.v == "media") {   // eink-ha-os#319, emulator media.ts favoritesError
          WVal f = get("favorites");
          std::string err = f.present ? media::favoritesError(f.v) : std::string();
          if (!err.empty()) throw Fail{n, err};
        }
        if (type.v == "attrList") {   // eink-ha-os#332, emulator attrList.ts listError
          std::map<std::string, std::string> f;
          for (auto& o : obj) f[o.first] = o.second.v;
          std::string err = alist::error(f);
          if (!err.empty()) throw Fail{n, err};
        }
        if (type.v == "route") {
          WVal m = get("mode");
          if (m.present && (m.num || (m.v != "train" && m.v != "bus" && m.v != "car"))) throw Fail{n, "route: mode must be train, bus or car"};
        }
        if (type.v == "bins") {   // eink-ha-os#317, emulator config.ts + bins.ts binsError
          WVal ents = get("entities"), lb = get("labels"), tn = get("tonight");
          std::vector<std::string> ids = ents.present ? listOf(ents.v) : std::vector<std::string>();
          for (auto& id : ids) if (!entityFits(id, {"sensor"})) throw Fail{n, "bins: " + quoteName(id) + " is not a sensor entity"};
          if (lb.present)
            for (auto& p : labelPairs(lb.v))
              if (!entityFits(p.first, {"sensor"}) || p.second.empty()) throw Fail{n, "bins: " + quoteName(p.first) + " in labels is not sensor.<id>=Name"};
          if (int(ids.size()) > bins::kMaxBins) throw Fail{n, "bins: at most " + std::to_string(bins::kMaxBins) + " sensors"};
          if (tn.present && !(tn.num && tn.v.size() <= 2 && std::atoi(tn.v.c_str()) <= 23)) throw Fail{n, "bins: tonight must be an hour 0–23"};
        }
        if (type.v == "guestWifi") {   // eink-ha-os#329, emulator config.ts + guestWifi.ts guestError; never quote ssid / password
          WVal pe = get("password_entity"), sec = get("security"), hid = get("hidden");
          if (pe.present && !(entityFits(pe.v, {"input_text", "text", "sensor"}) && !pe.num))
            throw Fail{n, "guestWifi: password_entity is not an input_text / text / sensor entity"};
          if (sec.present && (sec.num || !guest::validSecurity(sec.v))) throw Fail{n, "guestWifi: security must be WPA, WEP or nopass"};
          if (hid.present && (hid.num || (hid.v != "true" && hid.v != "false"))) throw Fail{n, "guestWifi: hidden must be true or false"};
        }
        auto truthy = [](const WVal& w) { return w.present && (w.num ? w.v != "0" : !w.v.empty()); };
        WVal cs = get("cs"), rs = get("rs");
        if (truthy(cs) && !(cs.num && (cs.v == "1" || cs.v == "2" || cs.v == "3" || cs.v == "4"))) throw Fail{n, "cs must be 1–4"};
        if (truthy(rs) && !(rs.num && (rs.v == "1" || rs.v == "2"))) throw Fail{n, "rs must be 1 or 2"};
        if (type.v == "history") {   // eink-ha-os#268, emulator history.ts historyError
          auto f = [&](const char* k) { WVal x = get(k); return hist::Field{x.present, x.v}; };
          hist::Fields hf;
          hf.entity = get("entity").v;
          hf.cs = truthy(cs) ? std::atoi(cs.v.c_str()) : 1;
          hf.window = f("window"); hf.bucket = f("bucket"); hf.agg = f("agg"); hf.style = f("style"); hf.min = f("min");
          hf.max = f("max"); hf.attribute = f("attribute"); hf.value = f("value"); hf.time = f("time"); hf.ahead = f("ahead");
          hf.forecast = f("forecast"); hf.threshold = f("threshold"); hf.labels = f("labels"); hf.compare = f("compare");
          hf.past = f("past");
          std::string err = hist::configError(hf);
          if (!err.empty()) throw Fail{n, err};
          if (++histories > hist::kMaxTiles) throw Fail{n, "At most " + std::to_string(hist::kMaxTiles) + " history tiles"};
        }
        if (type.v == "weather") {   // eink-ha-os#318, emulator weather.ts weatherError
          if ((truthy(cs) ? std::atoi(cs.v.c_str()) : 1) != 4) throw Fail{n, "weather: needs the full width (cs: 4)"};
          if (++weathers > wx::kMaxTiles) throw Fail{n, "At most " + std::to_string(wx::kMaxTiles) + " weather tiles"};
        }
        if (agenda::isAgendaType(type.v)) {   // eink-ha-os#316, emulator agenda.ts agendaError
          std::string err = agenda::configError(type.v, get("entities").present ? get("entities").v : "");
          if (!err.empty()) throw Fail{n, err};
          if (++agendas > agenda::kMaxTiles) throw Fail{n, "At most " + std::to_string(agenda::kMaxTiles) + " agenda or next tiles"};
        }
        Widget w;
        w.type = type.v;
        w.cs = truthy(cs) ? std::atoi(cs.v.c_str()) : 1;
        w.rs = truthy(rs) ? std::atoi(rs.v.c_str()) : 1;
        // Object.keys order: integer-like keys ascending first, then insertion order
        std::vector<std::pair<double, size_t>> idx; std::vector<size_t> rest;
        for (size_t q = 0; q < obj.size(); ++q) { double d; if (isIndexKey(obj[q].first, d)) idx.emplace_back(d, q); else rest.push_back(q); }
        std::sort(idx.begin(), idx.end());
        for (auto& p : idx) w.kv.emplace_back(obj[p.second].first, obj[p.second].second.v);
        for (auto q : rest) w.kv.emplace_back(obj[q].first, obj[q].second.v);
        for (auto& o : obj) if (o.first != "type" && o.first != "cs" && o.first != "rs") w.fields[o.first] = o.second.v;
        cur->widgets.push_back(std::move(w));
      } else {
        throw Fail{n, "Can’t read this line"};
      }
    }
    if (haveApps && appsList.empty() && !sawSettings) throw Fail{appsAt, "No apps found"};
    if (!haveScreens || screens.empty()) throw Fail{1, "No screens found"};
    std::map<std::string, int> ids;
    for (auto* sc : screens) {
      if (ids.count(sc->id)) throw Fail{at[sc->id], "Duplicate screen id " + quoteName(sc->id)};
      ids[sc->id] = 1;
      int cells = usedCells(*sc);
      if (cells > 8) throw Fail{at[sc->id], "“" + sc->title + "” uses " + std::to_string(cells) + " of 8 cells"};
    }
    // Settings is built in (eink-ha-os#159): its screens and tiles were checked like any other, now they go
    bool any = false;
    for (auto* sc : screens) any |= sc->app != kSettingsApp;
    if (!any) throw Fail{1, "No screens found"};
  } catch (const Fail& f) {
    res.ok = false; res.line = f.line; res.message = f.msg;
    return res;
  }
  res.ok = true;
  res.config.apps = haveApps && !appsList.empty() ? appsList : defaultApps();
  for (auto* sc : screens) {
    if (sc->app == kSettingsApp) continue;
    Screen s = *sc;
    s.widgets.erase(std::remove_if(s.widgets.begin(), s.widgets.end(), [](const Widget& w) { return isSystemTile(w.type); }), s.widgets.end());
    res.config.screens.push_back(std::move(s));
  }
  return res;
}

namespace {

// JSON config → same validation by serialising to YAML first (messages identical; line is reported as 0).
bool jsonScalar(const Json& j, std::string& out) {
  if (j.isStr()) { out = j.str; return true; }
  if (j.isNum()) { out = jsNumber(j.num); return true; }
  if (j.type == Json::Type::Bool) { out = j.b ? "true" : "false"; return true; }
  return false;
}

}  // namespace

ParseResult parseConfig(const std::string& text) {
  size_t i = 0; while (i < text.size() && isWs(text[i])) ++i;
  if (i < text.size() && text[i] == '{') {
    ParseResult r;
    Json j;
    if (!parseJson(text, j) || !j.isObj()) { r.message = "Not valid JSON"; return r; }
    Config c;
    c.apps = defaultApps();
    if (const Json* ap = j.get("apps")) {
      if (!ap->isArr()) { r.message = "Can’t read this line"; return r; }
      c.apps.clear();
      for (auto& a : ap->arr) {
        if (!a.isObj()) { r.message = "Can’t read this line"; return r; }
        AppEntry x;
        if (auto* v = a.get("id")) jsonScalar(*v, x.id);
        x.title = x.id;
        if (auto* v = a.get("title")) jsonScalar(*v, x.title);
        c.apps.push_back(x);
      }
    }
    const Json* sc = j.get("screens");
    if (!sc || !sc->isArr()) { r.message = "No screens found"; return r; }
    for (auto& s : sc->arr) {
      Screen x;
      if (!s.isObj()) { r.message = "Can’t read this line"; return r; }
      if (auto* v = s.get("id")) jsonScalar(*v, x.id);
      x.app = "home";
      if (auto* v = s.get("app")) jsonScalar(*v, x.app);
      x.title = x.id;
      if (auto* v = s.get("title")) jsonScalar(*v, x.title);
      if (auto* ws = s.get("widgets")) {
        if (!ws->isArr()) { r.message = "Can’t read this line"; return r; }
        for (auto& wj : ws->arr) {
          if (!wj.isObj()) { r.message = "Can’t read this line"; return r; }
          Widget w;
          for (auto& kv : wj.obj) {
            std::string v; if (!jsonScalar(kv.second, v)) { r.message = "Expected key: value"; return r; }
            w.kv.emplace_back(kv.first, v);
          }
          x.widgets.push_back(w);
        }
      }
      c.screens.push_back(x);
    }
    ParseResult y = parseYamlText(toYaml(c));
    if (!y.ok) y.line = 0;
    return y;
  }
  return parseYamlText(text);
}

namespace {

// yq(): quote when /[:#{}\[\],"]|^\s|\s$/
std::string yq(const std::string& t) {
  bool q = t.find_first_of(":#{}[],\"") != std::string::npos;
  if (!t.empty() && (isWs(t.front()) || isWs(t.back()))) q = true;
  return q ? jsonQuote(t) : t;
}

std::vector<std::pair<std::string, std::string>> widgetKv(const Widget& w) {
  if (!w.kv.empty()) return w.kv;
  std::vector<std::pair<std::string, std::string>> kv;
  kv.emplace_back("type", w.type);
  for (auto& f : w.fields) kv.emplace_back(f.first, f.second);
  if (w.cs != 1) kv.emplace_back("cs", std::to_string(w.cs));
  if (w.rs != 1) kv.emplace_back("rs", std::to_string(w.rs));
  return kv;
}

bool isDefaultApps(const std::vector<AppEntry>& a) {
  auto& d = defaultApps();
  if (a.size() != d.size()) return a.empty();   // built in code without apps → defaults
  for (size_t i = 0; i < a.size(); ++i) if (a[i].id != d[i].id || a[i].title != d[i].title) return false;
  return true;
}

}  // namespace

// `apps:` only when it differs from defaultApps() (the default file stays spec/default-screens.yaml).
std::string toYaml(const Config& c) {
  std::string out = "# HA Paper display config\nversion: 1\n";
  if (!isDefaultApps(c.apps)) {
    out += "apps:\n";
    for (auto& a : c.apps) out += "  - id: " + a.id + "\n    title: " + yq(a.title) + "\n";
  }
  out += "screens:\n";
  for (auto& sc : c.screens) {
    out += "  - id: " + sc.id + "\n";
    out += "    app: " + (sc.app.empty() ? std::string("home") : sc.app) + "\n";
    out += "    title: " + yq(sc.title) + "\n";
    out += std::string("    widgets:") + (sc.widgets.empty() ? " []" : "") + "\n";
    for (auto& w : sc.widgets) {
      out += "      - {";
      bool first = true;
      for (auto& kv : widgetKv(w)) { if (!first) out += ", "; first = false; out += kv.first + ": " + kv.second; }
      out += "}\n";
    }
  }
  return out;
}

std::string toJson(const Config& c) {
  std::string o = "{\"version\":1,\"apps\":[";
  const auto& apps = c.apps.empty() ? defaultApps() : c.apps;
  for (size_t i = 0; i < apps.size(); ++i)
    o += std::string(i ? "," : "") + "{\"id\":" + jsonQuote(apps[i].id) + ",\"title\":" + jsonQuote(apps[i].title) + "}";
  o += "],\"screens\":[";
  for (size_t i = 0; i < c.screens.size(); ++i) {
    auto& sc = c.screens[i];
    if (i) o += ",";
    o += "{\"id\":" + jsonQuote(sc.id) + ",\"app\":" + jsonQuote(sc.app) + ",\"title\":" + jsonQuote(sc.title) + ",\"widgets\":[";
    for (size_t k = 0; k < sc.widgets.size(); ++k) {
      if (k) o += ",";
      o += "{";
      bool first = true;
      for (auto& kv : widgetKv(sc.widgets[k])) {
        if (!first) o += ",";
        first = false;
        bool num = isDigits(kv.second) && (kv.second.size() == 1 || kv.second[0] != '0');
        o += jsonQuote(kv.first) + ":" + (num ? kv.second : jsonQuote(kv.second));
      }
      o += "}";
    }
    o += "]}";
  }
  return o + "]}";
}

Config defaultConfig() {
  static const Config c = parseYamlText(kDefaultYaml).config;
  return c;
}

}  // namespace x4
