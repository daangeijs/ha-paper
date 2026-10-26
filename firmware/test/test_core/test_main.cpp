// Pure core tests: config parser parity (vectors generated from the emulator's own parseYaml), severity, grid, paging,
// region diff, refresh policy, night window, idle, swipe, debounce, formatting.
#include <unity.h>
#include <cstdio>
#include <cctype>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <vector>
#include "core/battery_history.h"
#include "core/catalog.h"
#include "core/config.h"
#include "core/cw2017.h"
#include "core/diag.h"
#include "core/glance.h"
#include "core/ha_address.h"
#include "core/ha_report.h"
#include "core/input_spec.h"
#include "core/home.h"
#include "core/json.h"
#include "core/locale.h"
#include "core/log_ring.h"
#include "core/logic.h"
#include "core/migrate.h"
#include "core/power.h"
#include "core/recovery.h"
#include "core/seed.h"
#include "core/settings_api.h"
#include "core/strings.h"

using namespace x4;

#ifndef X4_REPO_ROOT
#define X4_REPO_ROOT "."
#endif

static std::string readFile(const std::string& p) {
  std::ifstream f(p, std::ios::binary);
  std::stringstream ss; ss << f.rdbuf();
  return ss.str();
}

void setUp() {}
void tearDown() {}

// ---------- config ----------
static int runVectorFile(const std::string& path) {
  std::string text = readFile(path);
  if (text.empty()) return -1;
  Json j;
  TEST_ASSERT_TRUE_MESSAGE(parseJson(text, j), ("bad JSON: " + path).c_str());
  std::vector<const Json*> cases;
  if (j.isArr()) for (auto& c : j.arr) cases.push_back(&c);
  else if (j.isObj() && j.get("cases") && j.get("cases")->isArr()) for (auto& c : j.get("cases")->arr) cases.push_back(&c);
  else cases.push_back(&j);
  int n = 0;
  for (auto* c : cases) {
    const Json* y = c->get("yaml"); if (!y) y = c->get("input");
    if (!y || !y->isStr()) continue;
    std::string name = c->get("name") ? c->get("name")->strOr("?") : path;
    ParseResult r = parseConfig(y->str);
    const Json* ex = c->get("expect");
    const Json* ok = ex ? ex->get("ok") : c->get("ok");
    bool wantOk = ok && ok->type == Json::Type::Bool && ok->b;
    if (!ok && c->get("error")) wantOk = c->get("error")->isNull();
    TEST_ASSERT_EQUAL_MESSAGE(wantOk, r.ok, (name + ": " + r.message).c_str());
    if (!wantOk) {
      const Json* src = ex ? ex : c;
      const Json* line = src->get("line"); const Json* msg = src->get("message");
      if (line) TEST_ASSERT_EQUAL_INT_MESSAGE(int(line->num), r.line, name.c_str());
      if (msg) TEST_ASSERT_EQUAL_STRING_MESSAGE(msg->str.c_str(), r.message.c_str(), name.c_str());
    } else {
      if (const Json* ty = c->get("toYaml")) TEST_ASSERT_EQUAL_STRING_MESSAGE(ty->str.c_str(), toYaml(r.config).c_str(), name.c_str());
      if (const Json* sc = c->get("screens")) if (sc->isNum()) TEST_ASSERT_EQUAL_INT_MESSAGE(int(sc->num), int(r.config.screens.size()), name.c_str());
      if (const Json* ap = ex ? ex->get("apps") : nullptr) {
        TEST_ASSERT_EQUAL_INT_MESSAGE(int(ap->arr.size()), int(r.config.apps.size()), (name + " apps").c_str());
        for (size_t i = 0; i < ap->arr.size() && i < r.config.apps.size(); ++i) {
          TEST_ASSERT_EQUAL_STRING_MESSAGE(ap->arr[i].get("id")->str.c_str(), r.config.apps[i].id.c_str(), (name + " app id").c_str());
          TEST_ASSERT_EQUAL_STRING_MESSAGE(ap->arr[i].get("title")->str.c_str(), r.config.apps[i].title.c_str(), (name + " app title").c_str());
        }
      }
      if (const Json* sc = ex ? ex->get("screens") : nullptr) {
        TEST_ASSERT_EQUAL_INT_MESSAGE(int(sc->arr.size()), int(r.config.screens.size()), name.c_str());
        for (size_t i = 0; i < sc->arr.size() && i < r.config.screens.size(); ++i) {
          const Json& es = sc->arr[i]; const Screen& gs = r.config.screens[i];
          TEST_ASSERT_EQUAL_STRING_MESSAGE(es.get("id")->str.c_str(), gs.id.c_str(), name.c_str());
          if (es.get("app")) TEST_ASSERT_EQUAL_STRING_MESSAGE(es.get("app")->str.c_str(), gs.app.c_str(), name.c_str());
          if (es.get("title")) TEST_ASSERT_EQUAL_STRING_MESSAGE(es.get("title")->str.c_str(), gs.title.c_str(), name.c_str());
          if (es.get("cells")) TEST_ASSERT_EQUAL_INT_MESSAGE(int(es.get("cells")->num), usedCells(gs), name.c_str());
          const Json* ws = es.get("widgets");
          if (!ws) continue;
          TEST_ASSERT_EQUAL_INT_MESSAGE(int(ws->arr.size()), int(gs.widgets.size()), name.c_str());
          for (size_t k = 0; k < ws->arr.size() && k < gs.widgets.size(); ++k) {
            const Json& ew = ws->arr[k]; const Widget& gw = gs.widgets[k];
            TEST_ASSERT_EQUAL_INT_MESSAGE(int(ew.obj.size()), int(gw.kv.size()), (name + " widget keys").c_str());
            for (size_t q = 0; q < ew.obj.size() && q < gw.kv.size(); ++q) {
              TEST_ASSERT_EQUAL_STRING_MESSAGE(ew.obj[q].first.c_str(), gw.kv[q].first.c_str(), (name + " key order").c_str());
              std::string v = ew.obj[q].second.isNum() ? jsNumber(ew.obj[q].second.num) : ew.obj[q].second.str;
              TEST_ASSERT_EQUAL_STRING_MESSAGE(v.c_str(), gw.kv[q].second.c_str(), (name + " value").c_str());
            }
          }
        }
      }
      if (const Json* ty = ex ? ex->get("yaml") : nullptr) if (ty->isStr()) TEST_ASSERT_EQUAL_STRING_MESSAGE(ty->str.c_str(), toYaml(r.config).c_str(), name.c_str());
    }
    ++n;
  }
  return n;
}

void test_config_vectors_firmware() {
  int n = runVectorFile(std::string(X4_REPO_ROOT) + "/firmware/test/vectors/config.json");
  TEST_ASSERT_GREATER_THAN(40, n);
}

void test_config_vectors_spec() {   // spec/test-vectors/config/*.json (emulator port), when present
  std::string dir = std::string(X4_REPO_ROOT) + "/spec/test-vectors/config";
  DIR* d = opendir(dir.c_str());
  if (!d) { TEST_IGNORE_MESSAGE("spec/test-vectors/config not present"); return; }
  int files = 0, cases = 0;
  while (dirent* e = readdir(d)) {
    std::string n = e->d_name;
    if (n.size() > 5 && n.substr(n.size() - 5) == ".json") { cases += runVectorFile(dir + "/" + n); ++files; }
  }
  closedir(d);
  if (!files) TEST_IGNORE_MESSAGE("no spec config vectors yet");
  std::printf("spec config vectors: %d files, %d cases\n", files, cases);
}

void test_default_config_matches_spec() {
  std::string base = readFile(std::string(X4_REPO_ROOT) + "/spec/default-screens.yaml");
  TEST_ASSERT_FALSE(base.empty());
  TEST_ASSERT_EQUAL_STRING(base.c_str(), kDefaultYaml);
  Config c = defaultConfig();
  TEST_ASSERT_EQUAL_INT(6, int(c.screens.size()));   // Settings is built in (#159): withSettings adds its pages
  Config d = withSettings(c);
  TEST_ASSERT_EQUAL_INT(13, int(d.screens.size()));
  TEST_ASSERT_EQUAL_STRING("settings", d.apps.back().id.c_str());
  TEST_ASSERT_EQUAL_STRING("style", d.screens[7].id.c_str());
  TEST_ASSERT_EQUAL_STRING("typeface", d.screens[7].widgets[1].field("key").c_str());
  TEST_ASSERT_EQUAL_INT(2, d.screens[7].widgets[1].cs);
  TEST_ASSERT_EQUAL_STRING(toYaml(c).c_str(), toYaml(userConfig(withSettings(d))).c_str());
  TEST_ASSERT_EQUAL_INT(13, int(withSettings(d).screens.size()));   // idempotent
  TEST_ASSERT_EQUAL_STRING("overview", c.screens[0].id.c_str());
  TEST_ASSERT_EQUAL_INT(2, c.screens[0].widgets[0].cs);
  TEST_ASSERT_EQUAL_STRING("sensor.living_temperature", c.screens[0].widgets[2].field("entity").c_str());
  // round trip
  ParseResult again = parseConfig(toYaml(c));
  TEST_ASSERT_TRUE(again.ok);
  TEST_ASSERT_EQUAL_STRING(toYaml(c).c_str(), toYaml(again.config).c_str());
}

void test_config_json() {
  Config c = defaultConfig();
  ParseResult r = parseConfig(toJson(c));
  TEST_ASSERT_TRUE_MESSAGE(r.ok, r.message.c_str());
  TEST_ASSERT_EQUAL_STRING(toYaml(c).c_str(), toYaml(r.config).c_str());
  ParseResult bad = parseConfig("{\"screens\":[{\"id\":\"a\",\"widgets\":[{\"type\":\"stat\",\"entity\":\"light.x\"}]}]}");
  TEST_ASSERT_FALSE(bad.ok);
  TEST_ASSERT_EQUAL_STRING("stat: “light.x” is not a sensor / binary_sensor / input_number / number / climate / weather entity", bad.message.c_str());
  // apps survive the JSON path
  ParseResult apps = parseConfig("{\"apps\":[{\"id\":\"g\",\"title\":\"Garden\"}],\"screens\":[{\"id\":\"a\",\"app\":\"g\",\"widgets\":[]}]}");
  TEST_ASSERT_TRUE_MESSAGE(apps.ok, apps.message.c_str());
  TEST_ASSERT_EQUAL_INT(1, int(apps.config.apps.size()));
  TEST_ASSERT_EQUAL_STRING("Garden", apps.config.apps[0].title.c_str());
  ParseResult again = parseConfig(toJson(apps.config));
  TEST_ASSERT_TRUE_MESSAGE(again.ok, again.message.c_str());
  TEST_ASSERT_EQUAL_STRING(toYaml(apps.config).c_str(), toYaml(again.config).c_str());
}

// ---------- severity ----------
void test_severity() {
  TEST_ASSERT_EQUAL_INT(1, sevOf(0, false));
  TEST_ASSERT_EQUAL_INT(1, sevOf(1.9, false));
  TEST_ASSERT_EQUAL_INT(2, sevOf(2, false));
  TEST_ASSERT_EQUAL_INT(2, sevOf(4.9, false));
  TEST_ASSERT_EQUAL_INT(3, sevOf(5, false));
  TEST_ASSERT_EQUAL_INT(3, sevOf(15, false));
  TEST_ASSERT_EQUAL_INT(4, sevOf(15.1, false));
  TEST_ASSERT_EQUAL_INT(4, sevOf(0, true));
  // worst of the NEXT TWO departures
  TEST_ASSERT_EQUAL_INT(1, routeLevel({{0, false}, {1, false}, {30, false}}));
  TEST_ASSERT_EQUAL_INT(3, routeLevel({{8, false}, {6, false}, {0, false}}));
  TEST_ASSERT_EQUAL_INT(4, routeLevel({{0, true}, {18, false}, {25, false}}));
  TEST_ASSERT_EQUAL_INT(1, routeLevel({}));
  TEST_ASSERT_EQUAL_INT(1, carLevel(21, 21));
  TEST_ASSERT_EQUAL_INT(2, carLevel(24.15, 21));
  TEST_ASSERT_EQUAL_INT(3, carLevel(29.4, 21));
  TEST_ASSERT_EQUAL_INT(4, carLevel(37, 21));
  TEST_ASSERT_EQUAL_STRING("Jammed", sevDef(4).car);
  TEST_ASSERT_EQUAL_STRING("Delayed", sevDef(3).word);
}

void test_severity_spec_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/severity.json");
  if (t.empty()) { TEST_IGNORE_MESSAGE("spec/test-vectors/severity.json not present"); return; }
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  auto cancelled = [](const Json& o) { const Json* c = o.get("cancelled"); return c && c->type == Json::Type::Bool && c->b; };
  if (auto* a = j.get("levels")) for (auto& c : a->arr) {
    const SevDef& d = sevDef(int(c.get("level")->num));
    TEST_ASSERT_EQUAL_STRING(c.get("word")->str.c_str(), d.word);
    TEST_ASSERT_EQUAL_STRING(c.get("car")->str.c_str(), d.car);
    TEST_ASSERT_EQUAL_STRING(c.get("color")->str.c_str(), d.color); ++n;
  }
  if (auto* a = j.get("sevOf")) for (auto& c : a->arr) { TEST_ASSERT_EQUAL_INT(int(c.get("level")->num), sevOf(c.get("delay")->num, cancelled(c))); ++n; }
  if (auto* a = j.get("routeLevel")) for (auto& c : a->arr) {
    std::vector<DepartureSev> ds;
    for (auto& d : c.get("deps")->arr) ds.push_back({d.get("delay") ? d.get("delay")->num : 0, cancelled(d)});
    TEST_ASSERT_EQUAL_INT(int(c.get("level")->num), routeLevel(ds)); ++n;
  }
  if (auto* a = j.get("carEta")) for (auto& c : a->arr) { TEST_ASSERT_EQUAL_INT(int(c.get("eta")->num), carEta(c.get("typical")->num, int(c.get("level")->num))); ++n; }
  if (auto* a = j.get("carLevel")) for (auto& c : a->arr) { TEST_ASSERT_EQUAL_INT(int(c.get("level")->num), carLevel(c.get("eta")->num, c.get("typical")->num)); ++n; }
  if (auto* a = j.get("carFactor")) for (size_t i = 0; i < a->arr.size() && i < 4; ++i) TEST_ASSERT_TRUE(a->arr[i].num == kCarFactor[i]);
  TEST_ASSERT_GREATER_THAN(20, n);
}

// ---------- ambient idle mode + night staleness (spec/test-vectors/ambient.json, emulator src/core/ambient.ts) ----------
void test_ambient_spec_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/ambient.json");
  if (t.empty()) { TEST_IGNORE_MESSAGE("spec/test-vectors/ambient.json not present"); return; }
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  TEST_ASSERT_EQUAL_UINT32(kAmbientMs, uint32_t(j.get("ambient_ms")->num));
  TEST_ASSERT_EQUAL_INT(kBattLow, int(j.get("batt_low")->num));
  TEST_ASSERT_TRUE(kStaleSec == int64_t(j.get("stale_s")->num));
  int n = 0;
  for (auto& c : j.get("due")->arr) {
    TEST_ASSERT_EQUAL(c.get("expect")->b, ambientDue(uint32_t(c.get("idleMs")->num), c.get("menu")->b, c.get("setup")->b)); ++n;
  }
  for (auto& c : j.get("chrome")->arr) {
    Chrome ch = chromeFor(c.get("ambient")->b, int(c.get("battery")->num), c.get("clockTile")->b);
    const Json& e = *c.get("expect");
    TEST_ASSERT_EQUAL(e.get("app")->b, ch.app); TEST_ASSERT_EQUAL(e.get("pager")->b, ch.pager);
    TEST_ASSERT_EQUAL(e.get("battery")->b, ch.battery); TEST_ASSERT_EQUAL(e.get("clock")->b, ch.clock); ++n;
  }
  for (auto& c : j.get("stale")->arr) {
    TEST_ASSERT_EQUAL(c.get("expect")->b, nightStale(int64_t(c.get("nowSec")->num), int64_t(c.get("lastDataSec")->num))); ++n;
  }
  TEST_ASSERT_EQUAL_INT(19, n);
}

// ---------- refresh policy (spec/test-vectors/refresh.json, emulator src/core/refresh.ts) ----------
void test_refresh_spec_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/refresh.json");
  if (t.empty()) { TEST_IGNORE_MESSAGE("spec/test-vectors/refresh.json not present"); return; }
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("partial")->arr) {   // standby/night skips live in App::commit, not the policy
    const Json& in = *c.get("input");
    if (in.get("sleeping")->b || in.get("night")->b) continue;
    RefreshPolicy p;
    for (int i = 0; i < int(in.get("sinceFull")->num); ++i) p.countPartial();
    auto k = p.requestPartial(in.get("clockKnown")->b);
    const Json& e = *c.get("expect");
    if (e.get("kind")->str == "clean") TEST_ASSERT_TRUE(k == RefreshPolicy::Kind::Clean);
    else { TEST_ASSERT_TRUE(k == RefreshPolicy::Kind::Partial); TEST_ASSERT_EQUAL_INT(int(e.get("sinceFull")->num), p.sinceFull()); }
    ++n;
  }
  for (auto& c : j.get("navigation")->arr) {   // #197: state = navSinceClean fast navigations + the rest as partials
    const Json& in = *c.get("input");
    const bool clock = in.get("clockKnown")->b;
    RefreshPolicy p;
    const int nav = int(in.get("navSinceClean")->num), since = int(in.get("sinceFull")->num);
    for (int i = 0; i < nav; ++i) TEST_ASSERT_TRUE(p.requestNav(true) == RefreshPolicy::Kind::Fast);
    for (int i = nav; i < since; ++i) p.countPartial();
    auto k = p.requestNav(clock);
    const Json& e = *c.get("expect");
    const char* name = c.get("name")->str.c_str();
    if (e.get("kind")->str == "clean") TEST_ASSERT_TRUE_MESSAGE(k == RefreshPolicy::Kind::Clean, name);
    else {
      TEST_ASSERT_TRUE_MESSAGE(k == RefreshPolicy::Kind::Fast, name);
      TEST_ASSERT_EQUAL_INT_MESSAGE(int(e.get("navSinceClean")->num), p.navSinceClean(), name);
      TEST_ASSERT_EQUAL_INT_MESSAGE(int(e.get("sinceFull")->num), p.sinceFull(), name);
    }
    ++n;
  }
  auto min = [](const Json& c, const char* k) { return int64_t(c.get(k)->num); };
  for (auto& c : j.get("nextClean")->arr) { TEST_ASSERT_TRUE(nextCleanMin(min(c, "lastFullMin"), int(c.get("everyMin")->num)) == min(c, "expect")); ++n; }
  for (auto& c : j.get("cleanDue")->arr) {
    bool due = cleanDue(int(c.get("sinceFull")->num), min(c, "lastFullMin"), min(c, "nowMin"), int(c.get("everyMin")->num), c.get("night")->b);
    TEST_ASSERT_EQUAL_MESSAGE(c.get("expect")->b, due, c.get("name")->str.c_str());
    ++n;
  }
  for (auto& c : j.get("input")->arr) {   // #212: last intent wins
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(c.get("expect")->num), coalesceInput(int(c.get("events")->arr.size())), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_THAN(20, n);
  // stateful: a full without a clock starts the wait when the clock first shows up; a clock step back restarts it
  RefreshPolicy p;
  p.onFull(-1); p.countPartial();
  TEST_ASSERT_FALSE(p.cleanDue(29864950, false));   // 13:10 first seen
  TEST_ASSERT_FALSE(p.cleanDue(29864970, false));   // 13:30: only 20 min
  TEST_ASSERT_FALSE(p.cleanDue(29865000, true));    // 14:00 at night: no
  TEST_ASSERT_TRUE(p.cleanDue(29865000, false));    // 14:00
  p.setCleanEvery(60);
  TEST_ASSERT_FALSE(p.cleanDue(29865000, false));   // hourly: 14:30 at the earliest
  TEST_ASSERT_FALSE(p.cleanDue(29864000, false));   // clock stepped back
  TEST_ASSERT_FALSE(p.cleanDue(-1, false));
}

// ---------- grid ----------
void test_grid_rects() {
  Config c = defaultConfig();
  auto r = gridRects(c.screens[0]);   // clock cs2, price, inside / solar, home, gauge, grid
  TEST_ASSERT_EQUAL_INT(7, int(r.size()));
  TEST_ASSERT_TRUE(r[0].ok);
  TEST_ASSERT_EQUAL_INT(14, r[0].r.x); TEST_ASSERT_EQUAL_INT(72, r[0].r.y);
  TEST_ASSERT_EQUAL_INT(380, r[0].r.w); TEST_ASSERT_EQUAL_INT(191, r[0].r.h);
  TEST_ASSERT_EQUAL_INT(406, r[1].r.x);
  TEST_ASSERT_EQUAL_INT(602, r[2].r.x);
  TEST_ASSERT_EQUAL_INT(14, r[3].r.x); TEST_ASSERT_EQUAL_INT(275, r[3].r.y);
  TEST_ASSERT_EQUAL_INT(602, r[6].r.x); TEST_ASSERT_EQUAL_INT(275, r[6].r.y);
  auto l = gridRects(c.screens[4]);   // lightList 4×2
  TEST_ASSERT_EQUAL_INT(772, l[0].r.w); TEST_ASSERT_EQUAL_INT(394, l[0].r.h);
  // a tall widget after a full row does not fit
  Screen s; Widget a; a.type = "clock"; a.cs = 4; Widget b; b.type = "thermo"; b.rs = 2;
  s.widgets = {a, b};
  auto q = gridRects(s);
  TEST_ASSERT_TRUE(q[0].ok); TEST_ASSERT_FALSE(q[1].ok);
}

// ---------- paging ----------
static std::vector<LightGroup> emulatorLights() {
  return {{"living", {"living_ceiling", "living_floor", "living_reading", "living_tv"}},
          {"kitchen", {"kitchen_spots", "kitchen_island", "kitchen_cabinet"}},
          {"dining", {"dining_pendant"}},
          {"hall", {"hall_ceiling", "hall_stairs"}},
          {"bedroom", {"bedroom_ceiling", "bedroom_left", "bedroom_right"}},
          {"office", {"office_desk"}},
          {"garden", {"garden_terrace", "garden_path"}}};
}

void test_light_pages() {
  auto pages = layoutLights(emulatorLights());
  TEST_ASSERT_EQUAL_INT(3, int(pages.size()));
  for (auto& p : pages) {
    TEST_ASSERT_EQUAL_INT(10, int(p.size()));
    for (int col = 0; col < 2; ++col) {
      // never end a column on a header; a column never starts with a light
      const LightCell& last = p[col * 5 + 4];
      TEST_ASSERT_TRUE(last.kind != LightCell::Header);
      const LightCell& first = p[col * 5];
      TEST_ASSERT_TRUE(first.kind != LightCell::Light);
    }
  }
  // page 1: living (header + 4) | kitchen (header + 3) + spacer
  TEST_ASSERT_EQUAL_INT(LightCell::Header, pages[0][0].kind);
  TEST_ASSERT_EQUAL_STRING("living", pages[0][0].area.c_str());
  TEST_ASSERT_EQUAL_STRING("living_tv", pages[0][4].id.c_str());
  TEST_ASSERT_EQUAL_STRING("kitchen", pages[0][5].area.c_str());
  TEST_ASSERT_EQUAL_INT(LightCell::Spacer, pages[0][9].kind);
  // a column that starts mid-room repeats the header (cont.)
  std::vector<LightGroup> big = {{"a", {"1", "2", "3", "4", "5", "6"}}};
  auto bp = layoutLights(big);
  TEST_ASSERT_EQUAL_INT(1, int(bp.size()));
  TEST_ASSERT_TRUE(bp[0][5].kind == LightCell::Header && bp[0][5].cont);
  TEST_ASSERT_EQUAL_STRING("5", bp[0][6].id.c_str());
}

static PagingInfo pagingOf(int zones, int lightPages) {
  PagingInfo p;
  p.pages = [=](const Widget& w) { return w.type == "zoneList" ? zonePages(zones) : w.type == "lightList" ? lightPages : 1; };
  return p;
}

void test_zone_pages_and_flat() {
  TEST_ASSERT_EQUAL_INT(1, zonePages(0));
  TEST_ASSERT_EQUAL_INT(1, zonePages(10));
  TEST_ASSERT_EQUAL_INT(2, zonePages(11));
  TEST_ASSERT_EQUAL_INT(2, zonePages(14));
  Config c = withSettings(defaultConfig());
  PagingInfo p = pagingOf(10, 3);
  TEST_ASSERT_EQUAL_INT(4, int(flatPages(c, 0, p).size()));    // home
  TEST_ASSERT_EQUAL_INT(4, int(flatPages(c, 4, p).size()));    // house: 3 light pages + heating
  TEST_ASSERT_EQUAL_INT(7, int(flatPages(c, 6, p).size()));    // settings (incl. Display style, Power); no travel (#145)
  PagingInfo p14 = pagingOf(14, 3);
  TEST_ASSERT_EQUAL_INT(5, int(flatPages(c, 5, p14).size()));
  // Prev/Next wrap inside the app
  PageRef t = navTarget(c, 3, 0, 1, p);
  TEST_ASSERT_EQUAL_INT(0, t.screen);
  t = navTarget(c, 0, 0, -1, p);
  TEST_ASSERT_EQUAL_INT(3, t.screen);
  t = navTarget(c, 4, 2, 1, p);
  TEST_ASSERT_EQUAL_INT(5, t.screen); TEST_ASSERT_EQUAL_INT(0, t.sub);
  t = navTarget(c, 4, 0, 1, p);
  TEST_ASSERT_EQUAL_INT(4, t.screen); TEST_ASSERT_EQUAL_INT(1, t.sub);
}

// ---------- regions & refresh ----------
void test_region_diff() {
  RegionMap a, b;
  a["bar"] = {{0, 0, 800, 58}, "T13:00"};
  a["t0"] = {{14, 72, 184, 191}, "x"};
  b = a;
  TEST_ASSERT_EQUAL_INT(0, int(changedRegions(a, b).size()));
  b["t0"].sig = "y";
  auto k = changedRegions(a, b);
  TEST_ASSERT_EQUAL_INT(1, int(k.size()));
  TEST_ASSERT_EQUAL_STRING("t0", k[0].c_str());
  Rect u = unionRect(b, {"bar", "t0"});
  TEST_ASSERT_EQUAL_INT(0, u.y); TEST_ASSERT_EQUAL_INT(263, u.y + u.h);
  b.erase("bar");
  TEST_ASSERT_EQUAL_INT(1, int(removedRegions(a, b).size()));
}

void test_refresh_policy() {
  RefreshPolicy p;
  for (int i = 0; i < kCleanCap - 1; ++i) TEST_ASSERT_TRUE(p.requestPartial(false) == RefreshPolicy::Kind::Partial);
  TEST_ASSERT_TRUE(p.requestPartial(false) == RefreshPolicy::Kind::Clean);   // clock unset: 30th becomes a clean
  TEST_ASSERT_TRUE(p.requestPartial(false) == RefreshPolicy::Kind::Partial);
  for (int i = 0; i < 100; ++i) TEST_ASSERT_TRUE(p.requestPartial(true) == RefreshPolicy::Kind::Partial);   // clock known
  // #197: navigations are fast, the kNavClean-th a clean; a clean (onFull) starts the count over
  RefreshPolicy q;
  for (int i = 0; i < kNavClean - 1; ++i) TEST_ASSERT_TRUE(q.requestNav(true) == RefreshPolicy::Kind::Fast);
  TEST_ASSERT_TRUE(q.requestNav(true) == RefreshPolicy::Kind::Clean);
  TEST_ASSERT_TRUE(q.requestNav(true) == RefreshPolicy::Kind::Clean);   // until the caller's clean
  q.onFull(29864940);
  TEST_ASSERT_TRUE(q.requestNav(true) == RefreshPolicy::Kind::Fast);
  TEST_ASSERT_EQUAL_INT(1, q.sinceFull());   // a fast counts toward the scheduled clean
}

// ---------- behaviour ----------
void test_night_window() {
  TEST_ASSERT_TRUE(isNightHour(23, "23-07"));
  TEST_ASSERT_TRUE(isNightHour(0, "23-07"));
  TEST_ASSERT_TRUE(isNightHour(6, "23-07"));
  TEST_ASSERT_FALSE(isNightHour(7, "23-07"));
  TEST_ASSERT_FALSE(isNightHour(22, "23-07"));
  TEST_ASSERT_TRUE(isNightHour(0, "00-06"));
  TEST_ASSERT_FALSE(isNightHour(6, "00-06"));
  TEST_ASSERT_FALSE(isNightHour(23, "00-06"));
  TEST_ASSERT_FALSE(isNightHour(23, "off"));
  TEST_ASSERT_EQUAL_INT(7, nightEndHour("23-07"));
}

void test_idle_swipe_debounce() {
  TEST_ASSERT_EQUAL_INT(5, idleMinutes("5"));
  TEST_ASSERT_EQUAL_INT(0, idleMinutes("never"));
  IdleDecision d = idleCheck(5 * 60000, 0, 5, false, true);
  TEST_ASSERT_TRUE(d.goHome);
  d = idleCheck(5 * 60000 - 1, 0, 5, false, true);
  TEST_ASSERT_FALSE(d.goHome);
  d = idleCheck(10 * 60000, 10, 5, false, true);
  TEST_ASSERT_TRUE(d.standby);
  d = idleCheck(6 * 60000, 0, 5, true, true);
  TEST_ASSERT_FALSE(d.goHome);
  TEST_ASSERT_EQUAL_INT(1, swipeNav(-80, 10, 300));
  TEST_ASSERT_EQUAL_INT(-1, swipeNav(80, 10, 300));
  TEST_ASSERT_EQUAL_INT(0, swipeNav(50, 0, 300));
  TEST_ASSERT_EQUAL_INT(0, swipeNav(80, 60, 300));
  TEST_ASSERT_EQUAL_INT(0, swipeNav(80, 0, 900));
  TEST_ASSERT_EQUAL_INT(-1, swipeNav(100, 60, 300));   // ratio 1.67: a swipe in the emulator (> 1.5), issue #13
  TEST_ASSERT_EQUAL_INT(1, swipeNav(-100, 60, 300));
  Debouncer db;
  db.touch("living", 1000);
  db.touch("living", 1400);
  TEST_ASSERT_EQUAL_INT(0, int(db.fire(2800).size()));
  auto f = db.fire(2900);
  TEST_ASSERT_EQUAL_INT(1, int(f.size()));
  TEST_ASSERT_TRUE(db.empty());
}

void test_formatting() {
  TEST_ASSERT_EQUAL_STRING("420", kw(420).v.c_str());
  TEST_ASSERT_EQUAL_STRING("W", kw(420).u.c_str());
  TEST_ASSERT_EQUAL_STRING("1.00", kw(999.9 + 0.1).v.c_str());
  TEST_ASSERT_EQUAL_STRING("kW", kw(1000).u.c_str());
  TEST_ASSERT_EQUAL_STRING("1.1", toFixed(1.05, 1).c_str());      // JS: exact binary value 1.0500000000000000444
  TEST_ASSERT_EQUAL_STRING("0.3", toFixed(0.25, 1).c_str());      // ties round up in JS
  TEST_ASSERT_EQUAL_STRING("-0.0", toFixed(-0.04, 1).c_str());
  TEST_ASSERT_EQUAL_STRING("20.0", toFixed(20, 1).c_str());
  TEST_ASSERT_EQUAL_STRING("07:05", hhmm(7 * 60 + 5).c_str());
  TEST_ASSERT_EQUAL_STRING("00:10", hhmm(1450).c_str());
  TEST_ASSERT_EQUAL_STRING("100000000000000000000", jsNumber(1e20).c_str());
  TEST_ASSERT_EQUAL_STRING("0.5", jsNumber(0.5).c_str());
}

void test_home_data_missing_is_dash() {
  EntityStore st;
  HomeData d = deriveHome(st);
  StatText t = statText("sensor.solar_power", d, 12);
  TEST_ASSERT_EQUAL_STRING("—", t.value.c_str());
  TEST_ASSERT_EQUAL_STRING("Solar", t.label.c_str());
  EntityValue v; v.state = "unavailable";
  st.set("sensor.home_power", v);
  d = deriveHome(st);
  TEST_ASSERT_EQUAL_STRING("—", statText("sensor.home_power", d, 12).value.c_str());
  v.state = "1234"; st.set("sensor.home_power", v);
  d = deriveHome(st);
  TEST_ASSERT_EQUAL_STRING("1.23", statText("sensor.home_power", d, 12).value.c_str());
}

void test_stat_text_dutch() {   // #111: our own stat labels and sub lines follow the display language
  EntityStore st;
  EntityValue v; v.state = "0"; st.set("sensor.solar_power", v);
  HomeData d = deriveHome(st);
  StatText t = statText("sensor.solar_power", d, 12, nullptr, Lang::Nl);
  TEST_ASSERT_EQUAL_STRING("Zon", t.label.c_str());
  TEST_ASSERT_EQUAL_STRING("Geen zon", t.sub.c_str());
  TEST_ASSERT_EQUAL_STRING("No sun", statText("sensor.solar_power", d, 12).sub.c_str());
  TEST_ASSERT_EQUAL_STRING("Verbruik", statText("sensor.home_power", d, 12, nullptr, Lang::Nl).label.c_str());
}

void test_deadband_vectors() {   // #85, spec/test-vectors/deadband.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/deadband.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/deadband.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("moved")->arr) {
    bool want = c.get("moved")->type == Json::Type::Bool && c.get("moved")->b;
    TEST_ASSERT_EQUAL_MESSAGE(want, powerMoved(c.get("shown")->num, c.get("now")->num), c.get("name")->str.c_str());
    ++n;
  }
  for (auto& c : j.get("hold")->arr) {
    PowerHold h;
    auto& in = c.get("in")->arr; auto& out = c.get("out")->arr;
    for (size_t i = 0; i < in.size(); ++i)
      TEST_ASSERT_TRUE_MESSAGE(out[i].num == h.hold("k", in[i].num), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(17, n);
}

void test_format_vectors() {   // #85, spec/test-vectors/format.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/format.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/format.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  auto dpOf = [](const Json& c) { const Json* p = c.get("dp"); return p ? int(p->num) : -1; };
  for (auto& c : j.get("cases")->arr) {
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->str.c_str(),
                                     fmtValue(c.get("state")->str, c.get("unit")->str, dpOf(c)).c_str(), c.get("name")->str.c_str());
    ++n;
  }
  for (auto& c : j.get("kw")->arr) {
    ValueUnit vu = kw(c.get("w")->num, dpOf(c));
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("v")->str.c_str(), vu.v.c_str(), c.get("name")->str.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("u")->str.c_str(), vu.u.c_str(), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(40, n);
  // number format (#110)
  auto nfOf = [](const std::string& s) {
    return s == "comma" ? NumFmt::Comma : s == "comma_decimal" ? NumFmt::CommaDecimal : s == "decimal_comma" ? NumFmt::DecimalComma
         : s == "space_comma" ? NumFmt::SpaceComma : NumFmt::Point;
  };
  int m = 0;
  for (auto& c : j.get("numberFormatOf")->arr) {
    TEST_ASSERT_EQUAL_MESSAGE(int(nfOf(c.get("nf")->str)), int(numFormatOf(c.get("ha")->str, c.get("lang")->str == "nl")),
                              c.get("name")->str.c_str());
    ++m;
  }
  for (auto& c : j.get("localized")->arr) {
    setNumFormat(nfOf(c.get("nf")->str));
    std::string out = fmtValue(c.get("state")->str, c.get("unit")->str, dpOf(c));
    setNumFormat(NumFmt::Point);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->str.c_str(), out.c_str(), c.get("name")->str.c_str());
    ++m;
  }
  for (auto& c : j.get("localizedKw")->arr) {
    setNumFormat(nfOf(c.get("nf")->str));
    ValueUnit vu = kw(c.get("w")->num, dpOf(c));
    setNumFormat(NumFmt::Point);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("v")->str.c_str(), vu.v.c_str(), c.get("name")->str.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("u")->str.c_str(), vu.u.c_str(), c.get("name")->str.c_str());
    ++m;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(30, m);
  int fd = 0;   // #151
  for (auto& c : j.get("fewerDecimals")->arr) {
    setNumFormat(nfOf(c.get("nf")->str));
    std::string out = fewerDecimals(c.get("in")->str);
    setNumFormat(NumFmt::Point);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->str.c_str(), out.c_str(), c.get("name")->str.c_str());
    ++fd;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(10, fd);
  int fv = 0;   // #162
  for (auto& c : j.get("fitValue")->arr) {
    setNumFormat(nfOf(c.get("nf")->str));
    std::vector<int> sizes;
    for (auto& z : c.get("sizes")->arr) sizes.push_back(int(z.num));
    const int unit = int(c.get("unit")->num);
    FitValue r = fitValue(c.get("in")->str, sizes, int(c.get("maxW")->num),
                          [unit](const std::string& v, int size) {
                            int n = 0; for (unsigned char ch : v) n += (ch & 0xC0) != 0x80;
                            return n * size / 10 + unit; });
    setNumFormat(NumFmt::Point);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->str.c_str(), r.value.c_str(), c.get("name")->str.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(c.get("size")->num), r.size, c.get("name")->str.c_str());
    ++fv;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(10, fv);
  int fm = 0;   // #215
  for (auto& c : j.get("fitMiddle")->arr) {
    std::vector<int> sizes;
    for (auto& z : c.get("sizes")->arr) sizes.push_back(int(z.num));
    FitValue r = fitMiddle(c.get("in")->str, sizes, int(c.get("maxW")->num), [](const std::string& v, int size) {
      int n = 0; for (unsigned char ch : v) n += (ch & 0xC0) != 0x80;
      return n * size / 10; });
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->str.c_str(), r.value.c_str(), c.get("name")->str.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(c.get("size")->num), r.size, c.get("name")->str.c_str());
    ++fm;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(6, fm);
  // stat tiles: any HA entity and a logical one both go through it; display_precision comes as an attribute
  HomeData d; d.home = OptNum::of(390);
  EntityValue raw; raw.state = "390.0"; raw.attrs["unit_of_measurement"] = "W";
  TEST_ASSERT_EQUAL_STRING("390", statText("sensor.p1_power", d, 12, &raw).value.c_str());
  TEST_ASSERT_EQUAL_STRING("390", statText("sensor.home_power", d, 12, &raw).value.c_str());
  raw.attrs["display_precision"] = "1";
  TEST_ASSERT_EQUAL_STRING("390.0", statText("sensor.p1_power", d, 12, &raw).value.c_str());
  TEST_ASSERT_EQUAL_STRING("390.0", statText("sensor.home_power", d, 12, &raw).value.c_str());
  raw.attrs["display_precision"] = "x";
  TEST_ASSERT_EQUAL_STRING("390", statText("sensor.p1_power", d, 12, &raw).value.c_str());
  raw.state = "heat"; raw.attrs.erase("unit_of_measurement");
  TEST_ASSERT_EQUAL_STRING("heat", statText("sensor.p1_power", d, 12, &raw).value.c_str());
}

// ---------- diagnostics ring (spec/test-vectors/diag.json, GET /api/v1/diagnostics) ----------
static std::string dumpJson(const Json& j) {
  switch (j.type) {
    case Json::Type::Null: return "null";
    case Json::Type::Bool: return j.b ? "true" : "false";
    case Json::Type::Number: return jsNumber(j.num);
    case Json::Type::String: return jsonQuote(j.str);
    case Json::Type::Array: { std::string o = "["; for (size_t i = 0; i < j.arr.size(); i++) o += (i ? "," : "") + dumpJson(j.arr[i]); return o + "]"; }
    case Json::Type::Object: { std::string o = "{"; for (size_t i = 0; i < j.obj.size(); i++) o += (i ? "," : "") + jsonQuote(j.obj[i].first) + ":" + dumpJson(j.obj[i].second); return o + "}"; }
  }
  return "";
}
static std::string canon(const std::string& text) { Json j; TEST_ASSERT_TRUE_MESSAGE(parseJson(text, j), text.c_str()); return dumpJson(j); }

void test_diag_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/diag.json");
  Json j;
  TEST_ASSERT_TRUE(parseJson(t, j));
  const Json* cases = j.get("cases");
  TEST_ASSERT_TRUE(cases && cases->isArr() && cases->arr.size() >= 8);
  for (const Json& c : cases->arr) {
    const std::string name = c.get("name")->str;
    diag::Ring r;
    diag::clear(r);
    for (const Json& op : c.get("ops")->arr) {
      const std::string kind = op.get("op")->str;
      if (kind == "boot") {
        const Json* p = op.get("panic");
        diag::push(r, op.get("reason")->str.c_str(), op.get("version")->str.c_str(), p && p->isStr() ? p->str.c_str() : nullptr);
      } else if (kind == "touch") {
        diag::touch(r, uint32_t(op.get("uptime_s")->num), uint32_t(op.get("min_free_heap")->num), int64_t(op.get("epoch")->num));
      } else {
        diag::clear(r);
      }
    }
    TEST_ASSERT_EQUAL_STRING_MESSAGE(dumpJson(*c.get("boots")).c_str(), canon(diag::bootsJson(r)).c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(dumpJson(*c.get("last_crash")).c_str(), canon(diag::lastCrashJson(r)).c_str(), name.c_str());
    // the LittleFS form round-trips
    diag::Ring back;
    TEST_ASSERT_TRUE_MESSAGE(diag::fromJson(diag::toJson(r), back), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(diag::bootsJson(r).c_str(), diag::bootsJson(back).c_str(), name.c_str());
    TEST_ASSERT_TRUE(diag::valid(r));
  }
}

// ---------- device log ring (spec/test-vectors/logs.json, GET /api/v1/logs, #200) ----------
void test_log_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/logs.json");
  Json j;
  TEST_ASSERT_TRUE(parseJson(t, j));
  const Json* cases = j.get("cases");
  TEST_ASSERT_TRUE(cases && cases->isArr() && cases->arr.size() >= 5);
  for (const Json& c : cases->arr) {
    const std::string name = c.get("name")->str;
    auto build = [&](uint32_t cap, logs::Hdr& h, std::vector<uint8_t>& buf) {
      buf.assign(cap, 0xA5);
      logs::Ring r(&h, buf.data());
      r.init(cap);
      for (const Json& op : c.get("ops")->arr)
        r.push(uint32_t(op.get("ms")->num), uint32_t(op.get("epoch")->num), op.get("level")->str[0], op.get("tag")->str,
               logs::redact(op.get("msg")->str));
      TEST_ASSERT_TRUE_MESSAGE(r.valid(cap), name.c_str());
      return r;
    };
    logs::Hdr h, th;
    std::vector<uint8_t> buf, tbuf;
    logs::Ring r = build(uint32_t(c.get("cap")->num), h, buf);
    for (const Json& res : c.get("results")->arr) {
      const Json& qj = *res.get("query");
      logs::Query q;
      if (const Json* v = qj.get("since")) q.since = uint32_t(v->num);
      if (const Json* v = qj.get("level")) q.level = v->str[0];
      if (const Json* v = qj.get("tags")) for (const Json& tg : v->arr) q.tags += (q.tags.empty() ? "," : "") + tg.str + ",";
      if (const Json* v = qj.get("limit")) q.limit = int(v->num);
      for (auto& ch : q.tags) ch = char(std::toupper(static_cast<unsigned char>(ch)));
      std::string out;
      r.queryJson(q, "current", out);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(dumpJson(*res.get("response")).c_str(), canon(out).c_str(), (name + " " + dumpJson(qj)).c_str());
    }
    logs::Ring tail = build(uint32_t(c.get("tail_cap")->num), th, tbuf);
    std::string out;
    tail.queryJson(logs::Query(), "previous", out);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(dumpJson(*c.get("tail")).c_str(), canon(out).c_str(), (name + " tail").c_str());
  }
  for (const Json& rc : j.get("redact")->arr)
    TEST_ASSERT_EQUAL_STRING_MESSAGE(rc.get("out")->str.c_str(), logs::redact(rc.get("in")->str).c_str(), rc.get("in")->str.c_str());
}

void test_log_ring_wrap_and_garbage() {
  // thousands of lines through a small ring: always valid, used never above cap, seq continuous
  logs::Hdr h;
  std::vector<uint8_t> buf(700);
  logs::Ring r(&h, buf.data());
  r.init(700);
  for (int i = 0; i < 5000; i++) {
    r.push(uint32_t(i), 0, "EWI"[i % 3], "T" + std::to_string(i % 7), std::string(size_t(i * 37 % 260), char('a' + i % 26)));
    TEST_ASSERT_TRUE(r.valid(700));
    TEST_ASSERT_TRUE(r.hdr().used <= 700);
  }
  TEST_ASSERT_EQUAL_UINT32(5001, r.hdr().next);
  // RTC memory after a cold boot: random bytes are rejected
  int accepted = 0;
  uint32_t seed = 12345;
  for (int k = 0; k < 200; k++) {
    for (auto& b : buf) { seed = seed * 1103515245u + 12345u; b = uint8_t(seed >> 16); }
    std::memcpy(&h, buf.data(), sizeof h);
    accepted += r.valid(700) ? 1 : 0;
  }
  TEST_ASSERT_EQUAL_INT(0, accepted);
  // query parsing = logsQueryOf
  logs::Query q;
  std::string err;
  TEST_ASSERT_TRUE(logs::parseQuery("12", "w", "ha, epd", "5", q, err));
  TEST_ASSERT_EQUAL_UINT32(12, q.since);
  TEST_ASSERT_EQUAL('W', q.level);
  TEST_ASSERT_EQUAL_STRING(",HA,EPD,", q.tags.c_str());
  TEST_ASSERT_EQUAL_INT(5, q.limit);
  TEST_ASSERT_FALSE(logs::parseQuery(nullptr, "debug", nullptr, nullptr, q, err));
  TEST_ASSERT_EQUAL_STRING("level must be E, W or I", err.c_str());
  TEST_ASSERT_FALSE(logs::parseQuery(nullptr, nullptr, nullptr, "0", q, err));
  TEST_ASSERT_EQUAL_STRING("limit must be 1 to 1000", err.c_str());
  TEST_ASSERT_FALSE(logs::parseQuery("-1", nullptr, nullptr, nullptr, q, err));
  TEST_ASSERT_FALSE(logs::parseQuery("99999999999", nullptr, nullptr, nullptr, q, err));
}

void test_diag_merge_and_report() {
  // RTC memory lost (power off): the file copy goes behind this boot, 8 kept.
  diag::Ring file, rtc;
  diag::clear(file);
  for (int i = 0; i < 8; i++) diag::push(file, i == 7 ? "PANIC" : "SW", "0.3.0", i == 7 ? "boom" : nullptr);
  diag::touch(file, 77, 1000, 0);
  diag::clear(rtc);
  diag::push(rtc, "POWERON", "0.3.1", nullptr);
  diag::appendOlder(rtc, file);
  TEST_ASSERT_EQUAL(8, rtc.count);
  TEST_ASSERT_EQUAL_STRING("POWERON", diag::at(rtc, 0)->reason);
  TEST_ASSERT_EQUAL_STRING("PANIC", diag::at(rtc, 1)->reason);
  TEST_ASSERT_EQUAL_STRING("boom", diag::at(rtc, 1)->panic);
  TEST_ASSERT_EQUAL_UINT32(77, diag::at(rtc, 1)->uptimeS);
  TEST_ASSERT_NULL(diag::at(rtc, 8));
  // garbage RTC memory is rejected
  diag::Ring junk;
  memset(&junk, 0xA5, sizeof junk);
  TEST_ASSERT_FALSE(diag::valid(junk));
  TEST_ASSERT_FALSE(diag::fromJson("{\"boots\":3}", junk));
  // the whole report is valid JSON with the spec fields
  diag::Report rep;
  rep.firmware = "0.3.0"; rep.uptimeS = 5400; rep.resetReason = "PANIC";
  rep.heap = {184320, 151552, 110592, 7340032};
  rep.panel.controller = "UC8179"; rep.panel.source = "probe"; rep.panel.probed = true; rep.panel.verdict = 1; rep.panel.promoted = true;
  rep.panel.verBytes = 5; rep.panel.ver[2] = 0x01; rep.panel.ver[3] = 0xFF; rep.panel.ver[4] = 0xFF; rep.panel.nvsScreenType = 1;
  rep.core.present = true; rep.core.task = "loopTask"; rep.core.pc = 0x4201a3c4; rep.core.btDepth = 2; rep.core.bt[0] = 0x4201a3c4; rep.core.bt[1] = 0x42009f10;
  rep.core.elfSha256 = "a3f1c2d4"; rep.core.size = 9472;
  Json j;
  TEST_ASSERT_TRUE(parseJson(diag::reportJson(rtc, rep), j));
  TEST_ASSERT_EQUAL_STRING("PANIC", j.get("reset_reason")->str.c_str());
  TEST_ASSERT_EQUAL_STRING("00 00 01 FF FF", j.get("panel")->get("ver")->str.c_str());
  TEST_ASSERT_EQUAL_STRING("ultrachip", j.get("panel")->get("verdict")->str.c_str());
  TEST_ASSERT_EQUAL_STRING("0x4201a3c4", j.get("coredump")->get("pc")->str.c_str());
  TEST_ASSERT_EQUAL(2, int(j.get("coredump")->get("backtrace")->arr.size()));
  TEST_ASSERT_TRUE(j.get("touch_recoveries")->isNull());
  TEST_ASSERT_TRUE(j.get("deep_sleep")->get("armed")->b);   // #10 first-boot safety: default 0 boots left
  TEST_ASSERT_TRUE(j.get("deep_sleep")->get("armed_by")->isNull());
  TEST_ASSERT_TRUE(j.get("battery")->isNull());
  TEST_ASSERT_EQUAL_STRING("PANIC", j.get("last_crash")->get("reason")->str.c_str());
  TEST_ASSERT_FALSE(j.get("panel")->get("failed")->b);
  TEST_ASSERT_TRUE(j.get("panel")->get("failure")->isNull());
  TEST_ASSERT_TRUE(j.get("heap")->get("low_point")->isNull());   // #198: no checkpoint yet
  rep.heap.lowPoint.set = true; rep.heap.lowPoint.minFreeInternal = 11264; rep.heap.lowPoint.where = "tls";
  rep.heap.lowPoint.lastPath = "/api/v1/ha/entities"; rep.heap.lowPoint.tlsSlots = 2; rep.heap.lowPoint.ws = true;
  TEST_ASSERT_TRUE(parseJson(diag::reportJson(rtc, rep), j));
  const Json* lp = j.get("heap")->get("low_point");
  TEST_ASSERT_EQUAL(11264, int(lp->get("min_free_internal")->num));
  TEST_ASSERT_EQUAL_STRING("tls", lp->get("where")->str.c_str());
  TEST_ASSERT_EQUAL_STRING("/api/v1/ha/entities", lp->get("last_path")->str.c_str());
  TEST_ASSERT_TRUE(lp->get("ws")->b);
  TEST_ASSERT_TRUE(lp->get("rssi")->isNull());
  rep.core = {};
  rep.panel = {};
  rep.panel.failure = "BUSY stuck 20 s (init)";   // #181: the panel was given up
  TEST_ASSERT_TRUE(parseJson(diag::reportJson(rtc, rep), j));
  TEST_ASSERT_TRUE(j.get("coredump")->isNull());
  TEST_ASSERT_TRUE(j.get("panel")->get("verdict")->isNull());
  TEST_ASSERT_TRUE(j.get("panel")->get("failed")->b);
  TEST_ASSERT_EQUAL_STRING("BUSY stuck 20 s (init)", j.get("panel")->get("failure")->str.c_str());
  rep.sleepArmedBy = "uptime";   // #231
  rep.batteryJson = batt::History().json();
  TEST_ASSERT_TRUE(parseJson(diag::reportJson(rtc, rep), j));
  TEST_ASSERT_EQUAL_STRING("uptime", j.get("deep_sleep")->get("armed_by")->str.c_str());
  TEST_ASSERT_EQUAL(300, int(j.get("battery")->get("interval_s")->num));
  TEST_ASSERT_EQUAL(0, int(j.get("battery")->get("history")->arr.size()));
}

// ---------- power (spec/test-vectors/power, emulator src/core/power.ts) ----------
static void applyPowerInput(const Json& o, PowerInputs& i) {
  for (auto& kv : o.obj) {
    const std::string& k = kv.first; const Json& v = kv.second;
    auto flag = [&] { return v.type == Json::Type::Bool && v.b; };
    if (k == "nowEpoch") i.nowEpoch = int64_t(v.num);
    else if (k == "localSec") i.localSec = int32_t(v.num);
    else if (k == "powerSave") TEST_ASSERT_TRUE(parsePowerSave(v.str, i.powerSave));
    else if (k == "wakeEvery") i.wakeEvery = int(v.num);
    else if (k == "night") i.night = v.str;
    else if (k == "peeking") i.peeking = flag();
    else if (k == "standby") i.standby = flag();
    else if (k == "charging") i.charging = flag();
    else if (k == "usb") i.usb = flag();
    else if (k == "chargedAgoMin") i.chargedAgoMin = v.isNull() ? -1 : v.num;
    else if (k == "voltage") i.voltage = v.isNull() ? -1 : v.num;
    else if (k == "battery") i.battery = v.isNull() ? -1 : int(v.num);
    else if (k == "otaPendingVerify") i.otaPendingVerify = flag();
    else if (k == "otaBusy") i.otaBusy = flag();
    else if (k == "otaAuto") i.otaAuto = v.str == "off" ? OtaAuto::Off : v.str == "night" ? OtaAuto::Night : OtaAuto::Notify;
    else if (k == "otaDue") i.otaDue = flag();
    else if (k == "setup") i.setup = flag();
    else if (k == "msSinceApi") i.msSinceApi = v.isNull() ? -1 : int64_t(v.num);
    else if (k == "live") i.live = flag();
    else if (k == "glanceFails") i.glanceFails = int(v.num);
    else if (k == "armBootsLeft") i.armBootsLeft = int(v.num);
    else TEST_FAIL_MESSAGE(("unknown power input " + k).c_str());
  }
}

void test_cpu_mhz_for() {   // emulator CPU_MHZ (#177)
  TEST_ASSERT_EQUAL(240, cpuMhzFor(CpuProfile::Full));
  TEST_ASSERT_EQUAL(80, cpuMhzFor(CpuProfile::Auto));
}

void test_power_spec_vectors() {
  std::string dir = std::string(X4_REPO_ROOT) + "/spec/test-vectors/power";
  DIR* dp = opendir(dir.c_str());
  TEST_ASSERT_NOT_NULL_MESSAGE(dp, "spec/test-vectors/power missing");
  int files = 0, cases = 0;
  while (dirent* e = readdir(dp)) {
    std::string fn = e->d_name;
    if (fn.size() < 6 || fn.substr(fn.size() - 5) != ".json") continue;
    Json j; TEST_ASSERT_TRUE_MESSAGE(parseJson(readFile(dir + "/" + fn), j), fn.c_str());
    ++files;
    for (auto& c : j.get("cases")->arr) {
      PowerInputs in; applyPowerInput(*j.get("base"), in); applyPowerInput(*c.get("input"), in);
      PowerDecision d = powerDecision(in);
      std::string name = fn + ": " + c.get("name")->str;
      for (auto& kv : c.get("expect")->obj) {
        const std::string& k = kv.first; const Json& v = kv.second;
        if (k == "deepSleepNow") TEST_ASSERT_EQUAL_MESSAGE(v.b, d.deepSleepNow, name.c_str());
        else if (k == "buttonWakeOnly") TEST_ASSERT_EQUAL_MESSAGE(v.b, d.buttonWakeOnly, name.c_str());
        else if (k == "external") TEST_ASSERT_EQUAL_MESSAGE(v.b, d.external, name.c_str());
        else if (k == "wakeAtEpoch") TEST_ASSERT_EQUAL_INT64_MESSAGE(v.isNull() ? 0 : int64_t(v.num), d.wakeAtEpoch, name.c_str());
        else if (k == "reason") TEST_ASSERT_EQUAL_STRING_MESSAGE(v.str.c_str(), d.reason, name.c_str());
        else if (k == "cpuProfile") TEST_ASSERT_EQUAL_STRING_MESSAGE(v.str.c_str(), cpuProfileName(d.cpuProfile), name.c_str());
        else if (k == "wifiPs") TEST_ASSERT_EQUAL_STRING_MESSAGE(v.str.c_str(), wifiPsName(d.wifiPs), name.c_str());
        else TEST_FAIL_MESSAGE(("unknown power expect " + k).c_str());
      }
      if (d.deepSleepNow && !d.buttonWakeOnly) {
        TEST_ASSERT_TRUE_MESSAGE(d.wakeAtEpoch > in.nowEpoch && d.wakeAtEpoch - in.nowEpoch <= kMaxSleepS, name.c_str());
      }
      ++cases;
    }
  }
  closedir(dp);
  TEST_ASSERT_GREATER_OR_EQUAL(8, files);
  std::printf("spec power vectors: %d files, %d cases\n", files, cases);
}

// ---------- glance (spec/test-vectors/glance.json, emulator src/core/glance.ts, #10) ----------
static glance::Snapshot snapOf(const Json& o) {   // vectors give region key → hash; the device hashes region text
  std::map<std::string, std::string> m;
  for (auto& kv : o.obj) m[kv.first] = std::to_string(int64_t(kv.second.num));
  return glance::snapshotOf(m);
}

// ---------- battery history (spec/test-vectors/battery-history.json, #231) ----------
void test_battery_history_vectors() {
  Json j;
  TEST_ASSERT_TRUE(parseJson(readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/battery-history.json"), j));
  int cases = 0;
  for (auto& c : j.get("cases")->arr) {
    const char* name = c.get("name")->str.c_str();
    batt::History h;
    std::vector<std::string> log;
    for (auto& o : c.get("ops")->arr) {
      batt::In i;
      i.ms = uint32_t(o.get("ms")->num);
      i.epoch = int64_t(o.get("epoch")->num);
      i.pct = int(o.get("pct")->num);
      i.mv = o.get("mv")->isNull() ? -1 : int(o.get("mv")->num);
      i.chg = o.get("chg")->b;
      i.usb = o.get("usb")->b;
      i.power = o.get("power")->str.c_str();
      i.rssi = o.get("rssi")->isNull() ? batt::kNoRssi : int(o.get("rssi")->num);
      const std::string l = h.step(i);
      if (!l.empty()) log.push_back(l);
    }
    const auto& want = c.get("log")->arr;
    TEST_ASSERT_EQUAL_MESSAGE(int(want.size()), int(log.size()), name);
    for (size_t k = 0; k < log.size(); k++) TEST_ASSERT_EQUAL_STRING_MESSAGE(want[k].str.c_str(), log[k].c_str(), name);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(dumpJson(*c.get("battery")).c_str(), canon(h.json()).c_str(), name);
    ++cases;
  }
  TEST_ASSERT_EQUAL(5, cases);
}

void test_glance_vectors() {
  Json j;
  TEST_ASSERT_TRUE(parseJson(readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/glance.json"), j));
  int cases = 0;
  for (auto& c : j.get("snapshotDiff")->arr) {
    const glance::Snapshot next = snapOf(*c.get("next"));
    glance::Snapshot prev{};
    const bool hasPrev = !c.get("prev")->isNull();
    if (hasPrev) prev = snapOf(*c.get("prev"));
    std::vector<uint32_t> ignore, want;
    for (auto& k : c.get("ignore")->arr) ignore.push_back(glance::fnv1a(k.str));
    for (auto& k : c.get("changed")->arr) want.push_back(glance::fnv1a(k.str));
    std::vector<uint32_t> got = glance::snapshotDiff(hasPrev ? &prev : nullptr, next, ignore);
    std::sort(got.begin(), got.end()); std::sort(want.begin(), want.end());
    TEST_ASSERT_TRUE_MESSAGE(got == want, c.get("name")->str.c_str());
    ++cases;
  }
  for (auto& c : j.get("glanceStep")->arr) {
    const Json& in = *c.get("in"); const Json& out = *c.get("out");
    glance::StepOut o = glance::step({in.get("ok")->b, int(in.get("changed")->arr.size()), in.get("hadSnapshot")->b,
                                      int(in.get("fails")->num), in.get("drawnOffline")->b, in.get("minSinceDraw")->num});
    const char* n = c.get("name")->str.c_str();
    TEST_ASSERT_EQUAL_MESSAGE(out.get("redraw")->b, o.redraw, n);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(out.get("reason")->str.c_str(), o.reason, n);
    TEST_ASSERT_EQUAL_MESSAGE(int(out.get("fails")->num), o.fails, n);
    TEST_ASSERT_EQUAL_MESSAGE(out.get("drawnOffline")->b, o.drawnOffline, n);
    ++cases;
  }
  for (auto& c : j.get("wifiFast")->arr) {
    const Json& w = *c.get("cache");
    glance::WifiCache wc{};
    wc.valid = w.get("valid")->b; wc.ssidHash = uint32_t(w.get("ssidHash")->num); wc.channel = uint8_t(w.get("channel")->num);
    wc.fails = uint8_t(w.get("fails")->num); wc.ipAtEpoch = int64_t(w.get("ipAtEpoch")->num);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("fast")->str.c_str(),
        glance::wifiFastName(glance::wifiFast(wc, uint32_t(c.get("saved")->num), int64_t(c.get("now")->num))), c.get("name")->str.c_str());
    ++cases;
  }
  for (auto& c : j.get("liveNow")->arr) {
    const int64_t ms = c.get("msSinceInput")->isNull() ? -1 : int64_t(c.get("msSinceInput")->num);
    TEST_ASSERT_EQUAL_MESSAGE(c.get("live")->b, glance::liveNow(ms, int(c.get("liveMin")->num)), c.get("name")->str.c_str());
    ++cases;
  }
  for (auto& c : j.get("arm")->arr) {
    glance::ArmRecord stored;
    const Json* s = c.get("stored");
    if (!s->isNull()) {
      stored.version = s->get("version")->str;
      stored.boots = int(s->get("boots")->num);
      stored.uptime = s->get("uptime") && s->get("uptime")->b;
    }
    glance::ArmRecord r = glance::armFor(s->isNull() ? nullptr : &stored, c.get("version")->str);
    for (int n = 0; n < int(c.get("ops")->num); ++n) r = glance::armCount(r);
    if (const Json* up = c.get("up")) r = glance::armUptime(r, up->arr[0].num, up->arr[1].b);   // #231
    const char* name = c.get("name")->str.c_str();
    TEST_ASSERT_EQUAL_MESSAGE(int(c.get("boots")->num), r.boots, name);
    TEST_ASSERT_EQUAL_MESSAGE(c.get("uptime")->b, r.uptime, name);
    TEST_ASSERT_EQUAL_MESSAGE(int(c.get("left")->num), glance::armBootsLeft(r), name);
    const char* by = glance::armedBy(r);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("by")->isNull() ? "null" : c.get("by")->str.c_str(), by ? by : "null", name);
    ++cases;
  }
  for (auto& c : j.get("tally")->arr) {   // #178
    glance::Tally t{};
    auto ms = [](const Json& v) { return v.isNull() ? glance::kNoMs : uint32_t(v.num); };
    for (auto& o : c.get("ops")->arr) {
      const std::string& op = o.arr[0].str;
      if (op == "wake") glance::tallyWake(t, glance::sleptSeconds(int64_t(o.arr[1].num), int64_t(o.arr[2].num), int64_t(o.arr[3].num)));
      else if (op == "glance") glance::tallyGlance(t, o.arr[1].b, o.arr[2].b, ms(o.arr[3]), ms(o.arr[4]), uint32_t(o.arr[5].num));
      else glance::tallySleep(t, uint32_t(o.arr[1].num), uint32_t(o.arr[2].num), uint32_t(o.arr[3].num));
    }
    const Json& e = *c.get("expect");
    const char* n = c.get("name")->str.c_str();
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(uint32_t(e.get("wakes")->num), t.wakes, n);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(uint32_t(e.get("redraws")->num), t.redraws, n);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(uint32_t(e.get("failedWakes")->num), t.failedWakes, n);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(uint32_t(e.get("asleepS")->num), t.asleepS, n);
    TEST_ASSERT_EQUAL_UINT64_MESSAGE(uint64_t(e.get("awakeMs")->num), t.awakeMs, n);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(uint32_t(e.get("fullRefreshes")->num), t.fullRefreshes, n);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(uint32_t(e.get("partialRefreshes")->num), t.partialRefreshes, n);
    const Json& last = *e.get("last");
    TEST_ASSERT_EQUAL_MESSAGE(!last.isNull(), t.hasLast, n);
    if (!last.isNull()) {
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(ms(*last.get("wifiMs")), t.lastWifiMs, n);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(ms(*last.get("haMs")), t.lastHaMs, n);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(uint32_t(last.get("totalMs")->num), t.lastTotalMs, n);
    }
    ++cases;
  }
  std::printf("spec glance vectors: %d cases\n", cases);
  // backoff (emulator glanceWaitS): 15 min doubled per failed wake, 2 h cap
  const int64_t waits[] = {900, 1800, 3600, 7200, 7200, 7200};
  const int fails[] = {0, 1, 2, 3, 4, 9};
  for (int i = 0; i < 6; ++i) TEST_ASSERT_EQUAL_INT64(waits[i], glanceWaitS(15, fails[i]));
}

void test_glance_snapshot_and_rtc() {
  // more regions than RTC entries: the rest folds into one entry, so a change there still counts
  std::map<std::string, std::string> m;
  for (int i = 0; i < 60; ++i) m["r" + std::to_string(i)] = "v";
  glance::Snapshot a = glance::snapshotOf(m);
  TEST_ASSERT_EQUAL(glance::kMaxEntries, int(a.n));
  m["r59"] = "w";
  glance::Snapshot b = glance::snapshotOf(m);
  TEST_ASSERT_EQUAL(1, int(glance::snapshotDiff(&a, b, {}).size()));
  TEST_ASSERT_EQUAL(0, int(glance::snapshotDiff(&a, a, {}).size()));
  // RTC record: garbage (power-on) is rejected; reset + seal is valid; a field written without seal is rejected
  glance::Rtc r;
  memset(&r, 0xA5, sizeof r);
  TEST_ASSERT_FALSE(glance::valid(r));
  glance::reset(r);
  TEST_ASSERT_TRUE(glance::valid(r));
  TEST_ASSERT_FALSE(r.hasSnap);
  r.snap = a; r.hasSnap = true; r.fails = 2;
  TEST_ASSERT_FALSE(glance::valid(r));
  glance::seal(r);
  TEST_ASSERT_TRUE(glance::valid(r));
  r.snap.n = glance::kMaxEntries + 1; glance::seal(r);
  TEST_ASSERT_FALSE(glance::valid(r));   // count out of range even with a good checksum
  // another layout version (#178 added the tally): same checksum, other magic → rejected, reset zeroes the counters
  glance::reset(r);
  r.tally.wakes = 7; glance::seal(r);
  r.magic ^= 1u;
  TEST_ASSERT_FALSE(glance::valid(r));
  glance::reset(r);
  TEST_ASSERT_EQUAL_UINT32(0, r.tally.wakes);
  TEST_ASSERT_FALSE(r.tally.hasLast);
}

// ---------- POST /device/sleep (spec/test-vectors/sleep-now.json, emulator sleepNowCheck, #178) ----------
void test_sleep_now_vectors() {
  Json j;
  TEST_ASSERT_TRUE(parseJson(readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/sleep-now.json"), j));
  int cases = 0;
  for (auto& c : j.get("cases")->arr) {
    PowerInputs in; applyPowerInput(*j.get("base"), in); applyPowerInput(*c.get("input"), in);
    const Json& sec = *c.get("seconds");
    const SleepNowCheck r = sleepNowCheck(sec.type == Json::Type::Number, sec.num, in);
    const char* n = c.get("name")->str.c_str();
    TEST_ASSERT_EQUAL_MESSAGE(int(c.get("expect")->get("status")->num), r.status, n);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("expect")->get("error")->str.c_str(), r.error.c_str(), n);
    ++cases;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(10, cases);
}

// ---------- schema migrations (spec/test-vectors/migrations, issue #12) ----------
void test_migration_spec_vectors() {
  std::string dir = std::string(X4_REPO_ROOT) + "/spec/test-vectors/migrations";
  DIR* dp = opendir(dir.c_str());
  TEST_ASSERT_NOT_NULL_MESSAGE(dp, "spec/test-vectors/migrations missing");
  int files = 0, cases = 0;
  while (dirent* e = readdir(dp)) {
    std::string fn = e->d_name;
    if (fn.size() < 6 || fn.substr(fn.size() - 5) != ".json") continue;
    Json j; TEST_ASSERT_TRUE_MESSAGE(parseJson(readFile(dir + "/" + fn), j), fn.c_str());
    ++files;
    for (auto& c : j.get("cases")->arr) {
      std::string name = fn + ": " + c.get("name")->str, op = c.get("op")->str;
      const Json& ex = *c.get("expect");
      const Json* raw = c.get("raw");
      const Json* stored = c.get("stored");
      std::string text = raw ? raw->str : stored ? migrate::toText(*stored) : "";
      if (op == "device") {
        TEST_ASSERT_EQUAL_STRING_MESSAGE(ex.get("status")->str.c_str(),
                                         migrate::statusName(migrate::schemaStatus(int(stored->num), migrate::kDeviceSchema)), name.c_str());
      } else if (op == "persist") {
        std::string out = migrate::persistSettings(raw || stored ? &text : nullptr, migrate::toText(*c.get("known")));
        TEST_ASSERT_EQUAL_STRING_MESSAGE(migrate::toText(*ex.get("output")).c_str(), out.c_str(), name.c_str());
      } else {
        TEST_ASSERT_EQUAL_STRING_MESSAGE("migrate", op.c_str(), name.c_str());
        migrate::Result r = migrate::migrateSettings(text);
        TEST_ASSERT_EQUAL_STRING_MESSAGE(ex.get("status")->str.c_str(), migrate::statusName(r.status), name.c_str());
        TEST_ASSERT_EQUAL_INT_MESSAGE(int(ex.get("from")->num), r.from, name.c_str());
        TEST_ASSERT_EQUAL_INT_MESSAGE(int(ex.get("version")->num), r.version, name.c_str());
        if (const Json* o = ex.get("output")) TEST_ASSERT_EQUAL_STRING_MESSAGE(migrate::toText(*o).c_str(), r.text.c_str(), name.c_str());
      }
      ++cases;
    }
  }
  closedir(dp);
  TEST_ASSERT_GREATER_OR_EQUAL(6, files);
  std::printf("spec migration vectors: %d files, %d cases\n", files, cases);
}

// ---------- scene tile tap (#146, spec/test-vectors/scene-action.json, emulator src/core/config.ts sceneAction) ----------
void test_scene_action_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/scene-action.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/scene-action.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("cases")->arr) {
    std::string name = c.get("name")->str;
    Widget w;
    for (auto& kv : c.get("widget")->obj) {
      if (kv.first == "type") w.type = kv.second.str;
      else if (kv.second.isStr()) w.fields[kv.first] = kv.second.str;
    }
    SceneAction a = sceneAction(w);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("domain")->str.c_str(), a.domain.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("service")->str.c_str(), a.service.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("data")->get("entity_id")->str.c_str(), a.entityId.c_str(), name.c_str());
    ++n;
  }
  TEST_ASSERT_EQUAL_INT(5, n);
}

// ---------- lightList / zoneList picks (#127, spec/test-vectors/list-pick.json, emulator src/core/paging.ts) ----------
void test_list_pick_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/list-pick.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/list-pick.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  HomeData d;
  for (auto& g : j.get("groups")->arr) {
    LightGroup lg; lg.area = g.get("area")->str;
    for (auto& id : g.get("ids")->arr) { lg.ids.push_back(id.str); d.lights.push_back(LightState{id.str, lg.area, lg.area, id.str}); }
    d.lightGroups.push_back(lg);
  }
  for (auto& z : j.get("zones")->arr) { ZoneState zs; zs.id = z.str; d.zones.push_back(zs); }
  int n = 0;
  for (auto& c : j.get("cases")->arr) {
    std::string name = c.get("name")->str;
    Widget w;
    for (auto& kv : c.get("widget")->obj) {
      if (kv.first == "type") w.type = kv.second.str;
      else w.fields[kv.first] = kv.second.str;
    }
    if (auto* gs = c.get("groups")) {
      auto got = pickLights(d.lightGroups, w);
      TEST_ASSERT_EQUAL_INT_MESSAGE(int(gs->arr.size()), int(got.size()), name.c_str());
      for (size_t k = 0; k < got.size(); ++k) {
        TEST_ASSERT_EQUAL_STRING_MESSAGE(gs->arr[k].get("area")->str.c_str(), got[k].area.c_str(), name.c_str());
        std::string want, have;
        for (auto& id : gs->arr[k].get("ids")->arr) want += id.str + " ";
        for (auto& id : got[k].ids) have += id + " ";
        TEST_ASSERT_EQUAL_STRING_MESSAGE(want.c_str(), have.c_str(), name.c_str());
      }
    }
    if (auto* zs = c.get("zones")) {
      std::string want, have;
      for (auto& z : zs->arr) want += z.str + " ";
      for (auto& z : pickZones(d.zones, w)) have += z.id + " ";
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want.c_str(), have.c_str(), name.c_str());
    }
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(c.get("pages")->num), listPages(w, d), name.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(9, n);
}

void test_light_subs() {
  ParseResult r = parseConfig("version: 1\nscreens:\n  - id: a\n    widgets:\n      - {type: clock}\n");
  TEST_ASSERT_TRUE(r.ok);
  TEST_ASSERT_TRUE(lightSubs(r.config).all);                 // no lightList: all lights, as before
  TEST_ASSERT_TRUE(lightSubs(defaultConfig()).all);          // lightList without a pick
  r = parseConfig("version: 1\nscreens:\n  - id: a\n    widgets:\n      - {type: lightList, areas: kitchen hall, cs: 2}\n"
                  "      - {type: lightList, entities: light.porch, cs: 2}\n");
  TEST_ASSERT_TRUE(r.ok);
  LightSubs s = lightSubs(r.config);
  TEST_ASSERT_FALSE(s.all);
  TEST_ASSERT_EQUAL_INT(2, int(s.areas.size()));
  std::vector<std::pair<std::string, std::string>> lights = {{"light.a", "kitchen"}, {"light.b", ""}, {"light.c", "hall"}, {"light.d", "kitchen"}};
  auto w = lightsToWatch(lights, s, 80);
  TEST_ASSERT_EQUAL_INT(3, int(w.size()));
  TEST_ASSERT_EQUAL_STRING("light.c", w[1].c_str());
  TEST_ASSERT_EQUAL_INT(2, int(lightsToWatch(lights, LightSubs{}, 2).size()));   // all, capped
  r = parseConfig("version: 1\nscreens:\n  - id: a\n    widgets:\n      - {type: lightList, areas: kitchen, cs: 2}\n      - {type: lightList, cs: 2}\n");
  TEST_ASSERT_TRUE(lightSubs(r.config).all);                 // one unpicked lightList wants every light
}

// emulator core.test.ts 'list counts (#134)'
void test_list_counts() {
  ListCounts c = listCounts(14, 149, 80);
  TEST_ASSERT_EQUAL_INT(14, int(c.climate.shown));
  TEST_ASSERT_EQUAL_INT(66, int(c.lights.shown));
  TEST_ASSERT_EQUAL_INT(149, int(c.lights.total));
  c = listCounts(90, 5, 80);
  TEST_ASSERT_EQUAL_INT(80, int(c.climate.shown));
  TEST_ASSERT_EQUAL_INT(0, int(c.lights.shown));
  c = listCounts(3, 12);
  TEST_ASSERT_EQUAL_INT(12, int(c.lights.shown));
}

// ---------- first-run screens from HA (#23, spec/test-vectors/seed.json, emulator src/core/seed.ts) ----------
void test_seed_spec_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/seed.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/seed.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("cases")->arr) {
    std::string name = c.get("name")->str;
    SeedReport rep;
    Config cfg = seedConfig(*c.get("snapshot"), {}, &rep);
    std::string y = toYaml(cfg);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("yaml")->str.c_str(), y.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(dumpJson(*c.get("report")).c_str(), seedReportJson(rep).c_str(), name.c_str());   // #89
    ParseResult r = parseConfig(y);   // what gets saved must read back the same
    TEST_ASSERT_TRUE_MESSAGE(r.ok, (name + ": " + r.message).c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(y.c_str(), toYaml(r.config).c_str(), name.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(5, n);
  // #58: the template the firmware sends, which answers count as a seed, which template events end the wait
  TEST_ASSERT_EQUAL_STRING(j.get("template")->str.c_str(), seedTemplate());
  TEST_ASSERT_EQUAL(std::string::npos, std::string(seedTemplate()).find("attributes.device_class"));
  int a = 0, e = 0;
  for (auto& c : j.get("answers")->arr) {
    TEST_ASSERT_EQUAL_MESSAGE(c.get("ok")->b, seedAnswerOk(c.get("text")->str), c.get("text")->str.c_str());
    ++a;
  }
  for (auto& c : j.get("events")->arr) {
    const Json* lv = c.get("level");
    const char* level = lv && lv->type == Json::Type::String ? lv->str.c_str() : nullptr;
    TEST_ASSERT_EQUAL(c.get("final")->b, templateEventFinal(c.get("has_result")->b, level));
    ++e;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(6, a);
  TEST_ASSERT_GREATER_OR_EQUAL(4, e);
  std::printf("spec seed vectors: %d cases, %d answers, %d events\n", n, a, e);
}

void test_seed_glue() {
  // seedSnapshot() = what ha_client hands to seedConfig(): prefs + live + the template answer's members
  std::string prefs = R"({"energy_sources":[{"type":"grid","flow_from":[{"stat_energy_from":"sensor.imp"}],"flow_to":[],"stat_rate":"sensor.p1"}]})";
  std::string tpl = R"({"areas":[["k","Kitchen: back"],["b","Bed"]],"climate":[],"lights":[["light.a",""]],"sensors":[["sensor.k_t","temperature","k","K"],["sensor.b_t","temperature","b","B"],["sensor.p1","power","","P1","W"]]})";
  std::string snap = seedSnapshot(prefs, {"sensor.grid_power"}, tpl);
  Json j; TEST_ASSERT_TRUE_MESSAGE(parseJson(snap, j), snap.c_str());
  Config c = seedConfig(snap, {});
  std::string y = toYaml(c);
  TEST_ASSERT_TRUE_MESSAGE(parseConfig(y).ok, y.c_str());
  TEST_ASSERT_NOT_EQUAL(std::string::npos, y.find("{type: stat, entity: sensor.k_t, label: Kitchen back}"));
  TEST_ASSERT_NOT_EQUAL(std::string::npos, y.find("{type: stat, entity: sensor.p1, label: Home use}"));
  TEST_ASSERT_EQUAL(std::string::npos, y.find("app: settings"));   // Settings is built in (#159)
  TEST_ASSERT_EQUAL(std::string::npos, y.find("travel"));
  // template failed / prefs missing: still a valid clock-only config
  Config e = seedConfig(seedSnapshot("", {}, "not json"), {});
  TEST_ASSERT_EQUAL_STRING("overview", e.screens.front().id.c_str());
  TEST_ASSERT_EQUAL_INT(1, int(e.screens.front().widgets.size()));
  TEST_ASSERT_EQUAL_INT(1, int(e.apps.size()));
  TEST_ASSERT_EQUAL_STRING("Kids 1 east", seedLabel(" Kids {1}: \"east\" ").c_str());
  // #82: role helpers
  TEST_ASSERT_EQUAL_INT(2, sharedWords("sensor.p1_meter_power", "sensor.p1_meter_energy_import"));
  TEST_ASSERT_EQUAL_INT(0, sharedWords("sensor.a", "sensor.b"));
  TEST_ASSERT_EQUAL_STRING("e", sensorKind("energy", "kWh", "sensor.solaredge_zon_vandaag zon vandaag").c_str());
  TEST_ASSERT_EQUAL_STRING("", sensorKind("energy_storage", "kWh", "sensor.anker_solix_battery_capacity").c_str());
  TEST_ASSERT_EQUAL_STRING("", sensorKind("humidity", "%", "sensor.living_room_humidity").c_str());
  TEST_ASSERT_EQUAL_STRING("b", sensorKind("", "%", "sensor.p1_meter_wifi_strength").c_str());
}

// ---------- hardware-key factory reset (#21, spec/test-vectors/recovery.json, emulator src/core/recovery.ts) ----------
void test_recovery_spec_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/recovery.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/recovery.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  TEST_ASSERT_EQUAL_UINT32(kResetHoldMs, uint32_t(j.get("hold_ms")->num));
  TEST_ASSERT_EQUAL_UINT32(kResetConfirmMs, uint32_t(j.get("confirm_ms")->num));
  TEST_ASSERT_EQUAL_UINT32(kRestartHoldMs, uint32_t(j.get("restart_hold_ms")->num));
  int steps = 0, cases = 0;
  for (auto& c : j.get("cases")->arr) {
    std::string name = c.get("name")->str;
    const Json* offer = c.get("offer");
    RecoveryState s = offer ? recoveryOffer(uint32_t(offer->num)) : RecoveryState{};
    int i = 0;
    for (auto& st : c.get("steps")->arr) {
      uint8_t keys = 0;
      for (char k : st.get("keys")->str)
        keys |= k == 'P' ? kKeyPower : k == 'R' ? kKeyRight : k == 'L' ? kKeyLeft : kKeyOther;
      RecoveryAction a = recoveryStep(s, uint32_t(st.get("t")->num), keys);
      std::string at = name + " step " + std::to_string(i++);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(st.get("action")->str.c_str(), recoveryActionName(a), at.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(st.get("phase")->str.c_str(), recoveryPhaseName(s.phase), at.c_str());
      ++steps;
    }
    ++cases;
  }
  for (auto& c : j.get("crash_loops")->arr) {
    std::vector<const char*> r;
    for (auto& x : c.get("reasons")->arr) r.push_back(x.str.c_str());
    TEST_ASSERT_EQUAL_INT(int(c.get("streak")->num), crashStreak(r.data(), int(r.size())));
    TEST_ASSERT_EQUAL(c.get("loop")->b, isCrashLoop(r.data(), int(r.size())));
  }
  TEST_ASSERT_GREATER_OR_EQUAL(10, cases);
  std::printf("spec recovery vectors: %d cases, %d steps\n", cases, steps);
}

void test_battery_label_vectors() {   // #11, spec/test-vectors/battery-label.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/battery-label.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/battery-label.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("cases")->arr) {
    const bool ch = c.get("charging")->b, usb = c.get("usb")->b;
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("source")->str.c_str(), powerSource(ch, usb), c.get("name")->str.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("label")->str.c_str(), batteryLabel(int(c.get("pct")->num), ch, usb).c_str(), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(5, n);
}

// #86: unavailable / unknown in HA → no value, a gap (ring + reason); absent stays "—"; entity_gaps lists only tile
// entities that are HA entities (not our logical ids, not the gauge's home battery)
void test_entity_gaps() {
  HomeData d;
  EntityValue un; un.state = "unavailable";
  EntityValue uk; uk.state = "unknown";
  StatText a = statText("sensor.garden_temperature", d, 12, &un);
  TEST_ASSERT_TRUE(a.gap == EntityGap::Unavailable);
  TEST_ASSERT_EQUAL_STRING("", a.value.c_str());
  TEST_ASSERT_TRUE(statText("sensor.garden_temperature", d, 12, &uk).gap == EntityGap::Unknown);
  StatText n = statText("sensor.garden_temperature", d, 12, nullptr);
  TEST_ASSERT_TRUE(n.gap == EntityGap::None);
  TEST_ASSERT_EQUAL_STRING("—", n.value.c_str());
  ParseResult r = parseConfig(
      "screens:\n  - id: s\n    title: S\n    widgets:\n"
      "      - { type: stat, entity: sensor.garden_temperature }\n"
      "      - { type: switch, entity: switch.pump }\n"
      "      - { type: gauge, entity: sensor.phone_battery }\n"
      "      - { type: stat, entity: sensor.solar_power }\n");
  TEST_ASSERT_TRUE_MESSAGE(r.ok, r.message.c_str());
  EntityStore st;
  st.set("sensor.garden_temperature", un);
  st.set("switch.pump", uk);
  EntityValue ok; ok.state = "57";
  st.set("sensor.phone_battery", ok);
  st.set("sensor.solar_power", un);
  auto g = entityGaps(r.config, st);
  TEST_ASSERT_EQUAL(2, int(g.size()));
  TEST_ASSERT_EQUAL_STRING("unavailable", g["sensor.garden_temperature"].c_str());
  TEST_ASSERT_EQUAL_STRING("unknown", g["switch.pump"].c_str());
}

void test_stat_raw_vectors() {   // #161, spec/test-vectors/stat-raw.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/stat-raw.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/stat-raw.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("cases")->arr) {
    EntityValue v;
    v.state = c.get("state")->str;
    for (auto& kv : c.get("attrs")->obj) v.attrs[kv.first] = kv.second.str;
    StatSource s = statSource(c.get("entity")->str, v);
    const char* name = c.get("name")->str.c_str();
    TEST_ASSERT_EQUAL_MESSAGE(c.get("ok")->b, s.ok, name);
    if (s.ok) TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->get("state")->str.c_str(), s.state.c_str(), name);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("out")->get("unit")->str.c_str(), s.unit.c_str(), name);
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(10, n);
  // the tile: Living room 20.8 °C, not "auto"; no temperature → "—"
  EntityValue v; v.state = "auto"; v.attrs["current_temperature"] = "20.83"; v.attrs["friendly_name"] = "Living room";
  StatText st = statText("climate.living_room", HomeData{}, 12, &v);
  TEST_ASSERT_EQUAL_STRING("20.8", st.value.c_str()); TEST_ASSERT_EQUAL_STRING("°C", st.unit.c_str()); TEST_ASSERT_EQUAL_STRING("Living room", st.label.c_str());
  v.attrs.erase("current_temperature");
  TEST_ASSERT_EQUAL_STRING("—", statText("climate.living_room", HomeData{}, 12, &v).value.c_str());
}

void test_stat_sub_vectors() {   // #28, spec/test-vectors/stat-sub.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/stat-sub.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/stat-sub.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("cases")->arr) {
    auto num = [&](const char* k) {
      const Json* o = c.get("data") ? c.get("data")->get(k) : nullptr;
      return OptNum::of((o ? o : j.get("data")->get(k))->num);
    };
    HomeData d;
    d.solar = num("solar"); d.home = num("home"); d.grid = num("grid"); d.batt = num("batt"); d.soc = num("soc");
    d.usedToday = num("usedToday"); d.solarToday = num("solarToday"); d.importToday = num("importToday"); d.exportToday = num("exportToday");
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("sub")->str.c_str(), statText(c.get("entity")->str, d, 12).sub.c_str(), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(10, n);
  // firmware-only: a missing fact drops out instead of showing a fake number
  HomeData d; d.solar = OptNum::of(500); d.grid = OptNum::of(900); d.batt = OptNum::of(-200);
  TEST_ASSERT_EQUAL_STRING("", statText("sensor.solar_power", d, 12).sub.c_str());
  TEST_ASSERT_EQUAL_STRING("In", statText("sensor.grid_power", d, 12).sub.c_str());
  TEST_ASSERT_EQUAL_STRING("Discharging", statText("sensor.battery_power", d, 12).sub.c_str());
  for (int h = 0; h < 24; ++h) d.prices.push_back(h >= 3 && h < 6 ? 0.1 + 0.01 * h : 0.3);
  StatText w = statText("sensor.price_cheap_window", d, 12);
  TEST_ASSERT_EQUAL_STRING("03–06", w.value.c_str());
  TEST_ASSERT_EQUAL_STRING("Avg €0.14", w.sub.c_str());
}

void test_locale_vectors() {   // #147, spec/test-vectors/locale.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/locale.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/locale.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  const auto& zones = j.get("zones")->arr;
  TEST_ASSERT_EQUAL_INT_MESSAGE(int(zones.size()), locale::kZoneCount, "firmware zone table = emulator TZ_TABLE");
  for (size_t i = 0; i < zones.size(); ++i) {
    const std::string& name = zones[i].arr[0].str;
    TEST_ASSERT_EQUAL_STRING_MESSAGE(name.c_str(), locale::kZones[i].name, "same order");
    const char* p = locale::ianaToPosix(name);
    TEST_ASSERT_NOT_NULL_MESSAGE(p, name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(zones[i].arr[1].str.c_str(), p, name.c_str());
    TEST_ASSERT_TRUE_MESSAGE(settings_api::validPosixTz(p), p);
  }
  for (auto& c : j.get("tzFor")->arr) {
    std::string want = c.get("posix")->strOr("");
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want.c_str(), locale::tzFor(c.get("override")->str, c.get("ha")->str).c_str(),
                                     (c.get("override")->str + " | " + c.get("ha")->str).c_str());
  }
  for (auto& c : j.get("validTz")->arr)
    TEST_ASSERT_EQUAL_MESSAGE(c.get("ok")->b, locale::validTzSetting(c.get("tz")->str), c.get("tz")->str.c_str());
  for (auto& c : j.get("currency")->arr)
    TEST_ASSERT_EQUAL_STRING(c.get("symbol")->str.c_str(), locale::currencySymbol(c.get("code")->strOr("")).c_str());
  setNumFormat(NumFmt::Point);
  for (auto& c : j.get("money")->arr)
    TEST_ASSERT_EQUAL_STRING(c.get("text")->str.c_str(), locale::money(c.get("v")->num, c.get("sym")->str).c_str());
}

void test_settings_put_vectors() {   // #43, spec/test-vectors/settings-put.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/settings-put.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/settings-put.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("tz")->arr) {
    TEST_ASSERT_EQUAL_MESSAGE(c.get("ok")->b, settings_api::validPosixTz(c.get("tz")->str), c.get("tz")->str.c_str());
    ++n;
  }
  for (auto& c : j.get("put")->arr) {
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("error")->strOr("").c_str(), settings_api::putError(*c.get("body")).c_str(), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_TRUE(n > 40);
}

void test_strings_vectors() {   // #98, spec/test-vectors/strings.json = core/strings_gen.h (both from emulator strings.ts)
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/strings.json");
  if (t.empty()) { TEST_IGNORE_MESSAGE("spec/test-vectors/strings.json not present"); return; }
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  const Json& tab = *j.get("strings");
  TEST_ASSERT_EQUAL_INT(int(S::count), int(tab.obj.size()));
  for (int k = 0; k < int(S::count); ++k) {
    const Json* e = tab.get(kStrKeys[k]);
    TEST_ASSERT_NOT_NULL_MESSAGE(e, kStrKeys[k]);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(e->get("en")->str.c_str(), tr(Lang::En, S(k)), kStrKeys[k]);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(e->get("nl")->str.c_str(), tr(Lang::Nl, S(k)), kStrKeys[k]);
  }
  for (auto& c : j.get("langOf")->arr)
    TEST_ASSERT_EQUAL_STRING(c.get("lang")->str.c_str(), langCode(langOf(c.get("input")->strOr(""))));
  auto key = [](const std::string& name) {
    for (int k = 0; k < int(S::count); ++k) if (name == kStrKeys[k]) return S(k);
    return S::count;
  };
  for (auto& c : j.get("tr")->arr) {
    Lang l = langOf(c.get("lang")->str);
    const auto& a = c.get("args")->arr;
    std::string out = a.empty() ? std::string(tr(l, key(c.get("key")->str)))
                                : tr(l, key(c.get("key")->str), a[0].str, a.size() > 1 ? a[1].str : "{}");
    TEST_ASSERT_EQUAL_STRING(c.get("out")->str.c_str(), out.c_str());
  }
  for (auto& c : j.get("dateLine")->arr)
    TEST_ASSERT_EQUAL_STRING(c.get("out")->str.c_str(), dateLine(langOf(c.get("lang")->str), int(c.get("wday")->num),
                                                                 int(c.get("mday")->num), int(c.get("month")->num)).c_str());
  TEST_ASSERT_EQUAL_STRING("{} x", tr(Lang::En, S::cheapestAt, "{} x").substr(9).c_str());   // an arg is not re-scanned
}

void test_ha_address_vectors() {   // #54, spec/test-vectors/ha-address.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/ha-address.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/ha-address.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("parse")->arr) {
    const std::string in = c.get("input")->str;
    ha_address::Parsed p = ha_address::parse(in);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("error") ? c.get("error")->str.c_str() : "", p.error.c_str(), in.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("url") ? c.get("url")->str.c_str() : "", p.url.c_str(), in.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("alt") ? c.get("alt")->str.c_str() : "", p.alt.c_str(), in.c_str());
    TEST_ASSERT_EQUAL_MESSAGE(c.get("typed") && c.get("typed")->b, p.typed, in.c_str());
    ++n;
  }
  for (auto& c : j.get("resolve")->arr) {
    const char* name = c.get("name")->str.c_str();
    const Json* answers = c.get("answers");
    std::vector<std::string> probed;
    ha_address::Resolved r = ha_address::resolve(c.get("input")->str, [&](const std::string& url) {
      probed.push_back(url);
      ha_address::Answer a;
      if (const Json* x = answers->get(url)) {
        a.status = static_cast<int>(x->get("status")->num);
        if (const Json* b = x->get("body")) a.body = b->str;
        if (const Json* l = x->get("location")) a.location = l->str;
      }
      return a;
    });
    const Json* exp = c.get("result");
    TEST_ASSERT_EQUAL_STRING_MESSAGE(exp->get("url") ? exp->get("url")->str.c_str() : "", r.url.c_str(), name);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(exp->get("error") ? exp->get("error")->str.c_str() : "", r.error.c_str(), name);
    TEST_ASSERT_EQUAL_MESSAGE(exp->get("status") ? static_cast<int>(exp->get("status")->num) : 200, r.status, name);
    const Json* want = c.get("probed");
    TEST_ASSERT_EQUAL_MESSAGE(want->arr.size(), probed.size(), name);
    for (size_t i = 0; i < probed.size(); ++i) TEST_ASSERT_EQUAL_STRING_MESSAGE(want->arr[i].str.c_str(), probed[i].c_str(), name);
    ++n;
  }
  TEST_ASSERT_TRUE(n > 60);
}

void test_ha_report_vectors() {   // #32, spec/test-vectors/ha-report.json
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/ha-report.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/ha-report.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("states")->arr) {
    const Json& in = *c.get("input");
    ha_report::Health h;
    h.hostname = in.get("hostname")->str; h.name = in.get("name")->str; h.firmware = in.get("firmware")->str;
    h.resetReason = in.get("resetReason")->str; h.battery = int(in.get("battery")->num);
    h.charging = in.get("charging")->b; h.usb = in.get("usb")->b;
    h.hasRssi = in.get("rssi")->isNum(); h.rssi = int(in.get("rssi")->numOr(0));
    h.lastFullEpoch = int64_t(in.get("lastFullEpoch")->numOr(0)); h.bootEpoch = int64_t(in.get("bootEpoch")->numOr(0));
    auto got = ha_report::states(h);
    const auto& want = c.get("expect")->arr;
    TEST_ASSERT_EQUAL_MESSAGE(want.size(), got.size(), c.get("name")->str.c_str());
    for (size_t i = 0; i < want.size(); ++i) {
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want[i].get("entity_id")->str.c_str(), got[i].entityId.c_str(), c.get("name")->str.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want[i].get("state")->str.c_str(), got[i].state.c_str(), got[i].entityId.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(migrate::toText(*want[i].get("attributes")).c_str(), got[i].attributes.c_str(), got[i].entityId.c_str());
      Json b; TEST_ASSERT_TRUE(parseJson(ha_report::body(got[i]), b));
      TEST_ASSERT_EQUAL_STRING(want[i].get("state")->str.c_str(), b.get("state")->str.c_str());
    }
    ++n;
  }
  for (auto& c : j.get("due")->arr) {
    ha_report::Last last;
    const Json* l = c.get("last");
    if (!l->isNull()) { last.atMs = uint32_t(l->get("atMs")->num); last.battery = int(l->get("battery")->num); last.charging = l->get("charging")->b;
                         last.retry = l->get("retry") && l->get("retry")->b; }
    TEST_ASSERT_EQUAL_MESSAGE(c.get("expect")->b, ha_report::due(l->isNull() ? nullptr : &last, c.get("force")->b, uint32_t(c.get("nowMs")->num),
                                                                  int(c.get("battery")->num), c.get("charging")->b), c.get("name")->str.c_str());
    ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(10, n);
  // device only: millis() wraps after 49.7 days; 30 s across the wrap is still inside the minimum gap
  ha_report::Last w; w.atMs = 0xFFFFFFFFu - 10000; w.battery = 50;
  TEST_ASSERT_FALSE(ha_report::due(&w, true, 20000, 49, false));
  TEST_ASSERT_TRUE(ha_report::due(&w, true, 60000, 50, false));
}

// ---------- CW2017 gauge state machine (#11): one short bus step per call, never a wait ----------
struct FakeGauge : Cw2017Bus {
  uint8_t reg[0x60] = {};
  bool nak = false;
  int versionStartPolls = 0, socStartPolls = 0;   // after a restart: polls until VERSION / SoC are valid
  int ops = 0, writes = 0, restarts = 0;
  bool read(uint8_t r, uint8_t& v) override {
    ++ops;
    if (nak) return false;
    if (r == 0x00 && versionStartPolls > 0) { --versionStartPolls; v = 0xA0; return true; }
    if (r == 0x04 && socStartPolls > 0) { --socStartPolls; v = 0xFF; return true; }
    v = reg[r];
    return true;
  }
  bool write(uint8_t r, uint8_t v) override {
    ++ops; ++writes;
    if (nak) return false;
    if (r == 0x08 && v == 0x00 && reg[0x08] == 0x30) ++restarts;
    reg[r] = v;
    return true;
  }
};

void test_cw2017_gauge() {
  FakeGauge g;   // fresh gauge: no profile, mode 0xF0 (sleep); VERSION/SoC invalid for a while after the restart
  g.reg[0x08] = 0xF0; g.reg[0x00] = 0x0D; g.reg[0x04] = 57; g.reg[0x02] = 0x2E; g.reg[0x03] = 0x40;   // 3700 mV
  g.versionStartPolls = 10; g.socStartPolls = 5;
  Cw2017 c;
  uint32_t now = 1000;
  int steps = 0, maxOps = 0;
  bool got = false;
  while (!got && steps < 200) {
    TEST_ASSERT_EQUAL_UINT32(0, c.msUntilDue(now));
    g.ops = 0;
    got = c.step(g, now);
    maxOps = std::max(maxOps, g.ops);
    ++steps;
    if (got) break;
    TEST_ASSERT_TRUE(c.msUntilDue(now) <= 100);   // a recovery step is never more than 100 ms away
    now += c.msUntilDue(now);
  }
  TEST_ASSERT_TRUE(got);
  TEST_ASSERT_EQUAL_UINT8(57, c.soc());
  TEST_ASSERT_EQUAL_UINT16(3700, c.mv());
  TEST_ASSERT_EQUAL_INT(1, g.restarts);
  TEST_ASSERT_EQUAL_UINT8(0x80, g.reg[0x0B]);
  TEST_ASSERT_EQUAL_UINT8(0x50, g.reg[0x10]);   // profile written
  TEST_ASSERT_FALSE(c.recovering());
  TEST_ASSERT_EQUAL_UINT32(Cw2017::kPollMs, c.msUntilDue(now));
  TEST_ASSERT_TRUE(maxOps <= 3 + 81);   // the longest step: profile check (first byte differs) + 81 writes

  // Steady: 5 reads per poll (MODE, VERSION, SoC, VCELL hi/lo), no writes.
  now += Cw2017::kPollMs; g.reg[0x04] = 56; g.reg[0x02] = 0x34; g.reg[0x03] = 0x80; g.writes = 0; g.ops = 0;
  TEST_ASSERT_TRUE(c.step(g, now));
  TEST_ASSERT_EQUAL_UINT8(56, c.soc());
  TEST_ASSERT_EQUAL_UINT16(4200, c.mv());
  TEST_ASSERT_EQUAL_INT(5, g.ops);
  TEST_ASSERT_EQUAL_INT(0, g.writes);

  // Gauge restarted itself (mode not normal): one soft reset, profile kept.
  now += Cw2017::kPollMs; g.reg[0x08] = 0x30; g.writes = 0;
  TEST_ASSERT_FALSE(c.step(g, now));
  int guard = 0;
  while (!c.step(g, now += c.msUntilDue(now)) && ++guard < 100) {}
  TEST_ASSERT_EQUAL_INT(2, g.restarts);
  TEST_ASSERT_EQUAL_INT(3, g.writes);   // MODE F0, 30, 00 only

  // Bus gone: back off to the poll cadence, keep the last SoC.
  now += Cw2017::kPollMs; g.nak = true;
  TEST_ASSERT_FALSE(c.step(g, now));    // Read fails → Init now
  TEST_ASSERT_EQUAL_UINT32(0, c.msUntilDue(now));
  TEST_ASSERT_FALSE(c.step(g, now));    // Init fails → retry in 30 s
  TEST_ASSERT_EQUAL_UINT32(Cw2017::kPollMs, c.msUntilDue(now));
  TEST_ASSERT_EQUAL_UINT8(56, c.soc());

  // Never ready after a reset: gives up after ~1 s of VERSION polls and falls back to the poll cadence.
  FakeGauge s; s.reg[0x08] = 0x30; s.reg[0x0B] = 0x80; s.versionStartPolls = 1000;
  Cw2017 d;
  now = 0xFFFFFF00u;   // across the millis() wrap
  const uint32_t t0 = now;
  d.step(s, now);
  guard = 0;
  while (d.recovering() && ++guard < 200) { now += d.msUntilDue(now); d.step(s, now); }
  TEST_ASSERT_FALSE(d.recovering());
  TEST_ASSERT_TRUE(now - t0 < 1500);
  TEST_ASSERT_EQUAL_UINT32(Cw2017::kPollMs, d.msUntilDue(now));

  // VCELL NAKs after a good SoC: the SoC counts, the voltage is unknown (0), not the previous 4200.
  struct VcellNak : FakeGauge {
    bool read(uint8_t r, uint8_t& v) override { return r != 0x03 && FakeGauge::read(r, v); }
  } n;
  n.reg[0x00] = 0x0D; n.reg[0x04] = 55;
  guard = 0;   // c is in Init after the bus loss above: profile + reset, then the SoC
  while (!c.step(n, now += c.msUntilDue(now)) && ++guard < 200) {}
  TEST_ASSERT_EQUAL_UINT8(55, c.soc());
  TEST_ASSERT_EQUAL_UINT16(0, c.mv());
}

void test_cw2017_vcell_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/cw2017-vcell.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/cw2017-vcell.json missing");
  Json j; TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("cases")->arr) {
    const uint16_t mv = cw2017Millivolts(uint8_t(c.get("reg02")->num), uint8_t(c.get("reg03")->num));
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(uint16_t(c.get("mv")->num), mv, c.get("name")->str.c_str()); ++n;
  }
  TEST_ASSERT_GREATER_OR_EQUAL(8, n);
}

// ---- #151: large example house tile fixes ----
void test_real_house_tiles() {
  // a name cut to fit keeps its last word, so "Bathroom attic" stays apart from "Bathroom"
  auto chars = [](const std::string& x) { int n = 0; for (unsigned char ch : x) n += (ch & 0xC0) != 0x80; return n; };
  TEST_ASSERT_EQUAL_STRING("Bathroom", fitKeepTail("Bathroom", 10, chars).c_str());
  TEST_ASSERT_EQUAL_STRING("Bathro… attic", fitKeepTail("Bathroom attic", 13, chars).c_str());
  TEST_ASSERT_EQUAL_STRING("B… attic", fitKeepTail("Bathroom attic", 8, chars).c_str());
  TEST_ASSERT_EQUAL_STRING("Bath…", fitKeepTail("Bathroom attic", 5, chars).c_str());      // the last word alone does not fit
  TEST_ASSERT_EQUAL_STRING("Conserv…", fitKeepTail("Conservatory", 8, chars).c_str());
  TEST_ASSERT_EQUAL_STRING("Playroom… Study", fitKeepTail("Playroom & Study", 15, chars).c_str());
  // zoneList labels rename rooms, picked or not
  std::vector<ZoneState> zs(2);
  zs[0].id = "bathroom"; zs[0].name = "Bathroom"; zs[1].id = "bathroom_attic"; zs[1].name = "Bathroom attic";
  Widget w; w.type = "zoneList"; w.fields["labels"] = "climate.bathroom_attic=Attic ; climate.x=Y;";
  auto all = pickZones(zs, w);
  TEST_ASSERT_EQUAL_STRING("Bathroom", all[0].name.c_str());
  TEST_ASSERT_EQUAL_STRING("Attic", all[1].name.c_str());
  w.fields["entities"] = "climate.bathroom_attic";
  all = pickZones(zs, w);
  TEST_ASSERT_EQUAL_INT(1, int(all.size()));
  TEST_ASSERT_EQUAL_STRING("Attic", all[0].name.c_str());
  auto lp = labelPairs(" climate.a=Living room ; ; climate.b ");
  TEST_ASSERT_EQUAL_INT(2, int(lp.size()));
  TEST_ASSERT_EQUAL_STRING("Living room", lp[0].second.c_str());
  TEST_ASSERT_EQUAL_STRING("", lp[1].second.c_str());
  // solar today: no forecast attribute → no forecast line (the hourly series is today so far, not a forecast)
  EntityStore st;
  EntityValue t; t.state = "8.4"; st.set("sensor.solar_today", t);
  EntityValue h; h.state = "ok"; h.attrs["today"] = "[0,0,0,0,0,0,0,0.2,0.8,1.4,1.9,2.1,2,0,0,0,0,0,0,0,0,0,0,0]"; st.set("sensor.solar_hourly", h);
  HomeData d = deriveHome(st);
  TEST_ASSERT_FALSE(d.solarForecast.ok);
  TEST_ASSERT_EQUAL_STRING("", statText("sensor.solar_today", d, 13).sub.c_str());
  h.attrs["forecast"] = "14.2"; st.set("sensor.solar_hourly", h);
  d = deriveHome(st);
  TEST_ASSERT_EQUAL_STRING("Of 14.2 kWh forecast", statText("sensor.solar_today", d, 13).sub.c_str());
}

// Remote input spec (#214): shared by /__qemu/input and /api/v1/debug/input.
void test_input_spec() {
  InputEvent e;
  TEST_ASSERT_TRUE(parseInputSpec("tap=400,240", e));
  TEST_ASSERT_TRUE(e.kind == InputEvent::Kind::Tap);
  TEST_ASSERT_EQUAL(400, e.x);
  TEST_ASSERT_EQUAL(240, e.y);
  TEST_ASSERT_TRUE(parseInputSpec("key=next", e));
  TEST_ASSERT_TRUE(e.kind == InputEvent::Kind::KeyDown && e.key == Key::Next);
  TEST_ASSERT_TRUE(parseInputSpec("key=power", e) && e.key == Key::Power);
  TEST_ASSERT_TRUE(parseInputSpec("swipe=-1", e));
  TEST_ASSERT_TRUE(e.kind == InputEvent::Kind::Swipe && e.dir == -1);
  TEST_ASSERT_TRUE(parseInputSpec("swipe=1", e) && e.dir == 1);
  TEST_ASSERT_FALSE(parseInputSpec("key=up", e));
  TEST_ASSERT_FALSE(parseInputSpec("tap=400", e));
  TEST_ASSERT_FALSE(parseInputSpec("", e));
  TEST_ASSERT_FALSE(parseInputSpec("hold=1", e));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_list_pick_vectors);
  RUN_TEST(test_real_house_tiles);
  RUN_TEST(test_scene_action_vectors);
  RUN_TEST(test_list_counts);
  RUN_TEST(test_light_subs);
  RUN_TEST(test_seed_spec_vectors);
  RUN_TEST(test_seed_glue);
  RUN_TEST(test_config_vectors_firmware);
  RUN_TEST(test_config_vectors_spec);
  RUN_TEST(test_default_config_matches_spec);
  RUN_TEST(test_config_json);
  RUN_TEST(test_severity);
  RUN_TEST(test_severity_spec_vectors);
  RUN_TEST(test_refresh_spec_vectors);
  RUN_TEST(test_ambient_spec_vectors);
  RUN_TEST(test_grid_rects);
  RUN_TEST(test_light_pages);
  RUN_TEST(test_zone_pages_and_flat);
  RUN_TEST(test_region_diff);
  RUN_TEST(test_refresh_policy);
  RUN_TEST(test_night_window);
  RUN_TEST(test_idle_swipe_debounce);
  RUN_TEST(test_formatting);
  RUN_TEST(test_home_data_missing_is_dash);
  RUN_TEST(test_format_vectors);
  RUN_TEST(test_deadband_vectors);
  RUN_TEST(test_diag_vectors);
  RUN_TEST(test_log_vectors);
  RUN_TEST(test_log_ring_wrap_and_garbage);
  RUN_TEST(test_diag_merge_and_report);
  RUN_TEST(test_power_spec_vectors);
  RUN_TEST(test_cpu_mhz_for);
  RUN_TEST(test_glance_vectors);
  RUN_TEST(test_battery_history_vectors);
  RUN_TEST(test_glance_snapshot_and_rtc);
  RUN_TEST(test_sleep_now_vectors);
  RUN_TEST(test_migration_spec_vectors);
  RUN_TEST(test_recovery_spec_vectors);
  RUN_TEST(test_battery_label_vectors);
  RUN_TEST(test_stat_sub_vectors);
  RUN_TEST(test_stat_raw_vectors);
  RUN_TEST(test_stat_text_dutch);
  RUN_TEST(test_entity_gaps);
  RUN_TEST(test_ha_report_vectors);
  RUN_TEST(test_settings_put_vectors);
  RUN_TEST(test_locale_vectors);
  RUN_TEST(test_ha_address_vectors);
  RUN_TEST(test_strings_vectors);
  RUN_TEST(test_cw2017_gauge);
  RUN_TEST(test_cw2017_vcell_vectors);
  RUN_TEST(test_input_spec);
  return UNITY_END();
}
