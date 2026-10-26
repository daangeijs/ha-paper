// screens.yaml model (spec/SCHEMA.md). Owned by core; parse rules = emulator parseYaml (spec/test-vectors/config).
#pragma once
#include <string>
#include <vector>
#include <map>
#include <utility>

namespace x4 {

struct Widget {
  std::string type;                          // clock, stat, price, gauge, bars, route, lightList, switch, scene, zoneList, thermo, history, setting, ota, wifi, ha, about
  int cs = 1, rs = 1;
  std::map<std::string, std::string> fields; // entity (HA entity_id) / series / route / scene / zone / key / label
  // Added: every key/value exactly as written, in emulator Object.keys order (used by toYaml for 1:1 output).
  // Empty for widgets built in code; toYaml then writes type, fields, cs, rs.
  std::vector<std::pair<std::string, std::string>> kv;
  std::string field(const std::string& k) const { auto it = fields.find(k); return it == fields.end() ? std::string() : it->second; }
};

struct Screen {
  std::string id, app, title;                // app: id of one of Config::apps
  std::vector<Widget> widgets;
};

// A category of screens (the display's app switcher). Without an `apps:` section: defaultApps().
struct AppEntry { std::string id, title; };

struct Config {
  int version = 1;
  std::vector<AppEntry> apps;
  std::vector<Screen> screens;
};

struct ParseResult {
  bool ok = false;
  int line = 0;          // 1-based line of first error (0 if n/a)
  std::string message;   // same wording as the emulator
  Config config;
};

ParseResult parseConfig(const std::string& text);   // YAML (or JSON) → validated Config
std::string toYaml(const Config& c);
Config defaultConfig();                               // == spec/default-screens.yaml

// Added helpers
extern const char* const kDefaultYaml;                // spec/default-screens.yaml verbatim
ParseResult parseYamlText(const std::string& text);   // YAML only (parseConfig also accepts JSON)
std::string toJson(const Config& c);                  // {"version":1,"screens":[{"id","app","title","widgets":[{...}]}]}
int usedCells(const Screen& s);                       // sum of (cs||1)*(rs||1)
const std::vector<AppEntry>& defaultApps();           // catalog apps() without settings: home, house, travel
constexpr int kMaxApps = 8;                           // app switcher slots, the built-in Settings app included
constexpr int kMaxUserApps = kMaxApps - 1;            // apps a screens.yaml may list
// Settings (#159): a fixed, built-in app, always last; never part of screens.yaml. parseConfig skips an `apps:` entry
// `settings` and drops `app: settings` screens and system tiles (setting, ota, wifi, ha, about) after checking them.
extern const char* const kSettingsApp;                // "settings"
bool isSystemTile(const std::string& widgetType);
const std::vector<Screen>& settingsScreens();         // the fixed Settings pages (= emulator settingsScreens())
Config withSettings(const Config& c);                 // what the display runs: user apps + Settings, user screens + pages
Config userConfig(const Config& c);                   // without the Settings app and its screens
// HA domains an entity widget accepts (stat / gauge / switch / route / scene / history); nullptr for other types.
const std::vector<const char*>* entityDomains(const std::string& widgetType);
// Scene tile tap (#146, spec/test-vectors/scene-action.json): its scene / script entity → <domain>.turn_on, none (or
// the older scene: all_off) → light.turn_off all. service_data is {"entity_id": entityId}.
struct SceneAction { std::string domain, service, entityId; };
SceneAction sceneAction(const Widget& w);
bool entityFits(const std::string& entityId, const std::vector<const char*>& domains);
std::string domainOf(const std::string& entityId);
extern const char* const kGaugeDefaultEntity;         // sensor.home_battery_soc
// List tile picks (#127): lightList areas / entities, zoneList entities; space-separated, nothing picked = all.
std::vector<std::string> listOf(const std::string& value);   // split on spaces, empty items dropped
inline std::vector<std::string> listOf(const Widget& w, const std::string& k) { return listOf(w.field(k)); }
// zoneList `labels` (#151, emulator labelPairs): "climate.a=Name; climate.b=Other" → (entity, label) in order, trimmed,
// empty items skipped; an item without "=" has label "" (the parser rejects it).
std::vector<std::pair<std::string, std::string>> labelPairs(const std::string& value);
// field → HA domain of its entity ids (nullptr = HA area ids); nullptr for other widget types.
const std::vector<std::pair<const char*, const char*>>* listPicks(const std::string& widgetType);

}  // namespace x4
