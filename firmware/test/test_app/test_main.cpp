// UI runtime acceptance tests (AGENT_README §5, UI side) against the real App with fake Display/Board/Services.
// Snapshots: firmware/test/out/test_*.pgm
#include <unity.h>
#include <algorithm>
#include "core/glance.h"
#include <algorithm>
#include <cstdlib>
#include <functional>
#include <ctime>
#include <string>
#include "app/app.h"
#include "app/gfx/canvas.h"
#include "core/config.h"
#include "core/recovery.h"
#include "../support/demo.h"
#include "../support/fakes.h"

using namespace x4;

#ifndef X4_REPO_ROOT
#define X4_REPO_ROOT "."
#endif
static const int64_t kEpoch1300 = 1791896400;   // Tue 13 Oct 2026 13:00 UTC

struct Rig {
  fake::FakeDisplay d;
  fake::FakeBoard b;
  fake::FakeServices s;
  App app{d, b, s};
  explicit Rig(bool linked = true, int hh = 13, int mm = 0, int zones = 10, DisplaySettings ds = DisplaySettings()) {
    b.epoch = kEpoch1300 + int64_t(hh - 13) * 3600 + mm * 60;
    s.st.pairingCode = "4F7K";
    if (linked) { s.linked(); demo::load(app.entities(), hh, mm, zones); }
    app.setPressFeedback(false);
    app.begin(defaultConfig(), ds);
    step(1800);
    d.clear();
  }
  void step(uint32_t ms) { for (uint32_t t = 0; t < ms; t += 50) { b.now += 50; app.loop(); } }
  void key(Key k) { b.key(k); step(50); }
  void tap(int x, int y) { b.tap(x, y); step(50); }
  std::string sig(const std::string& k) { auto m = app.regionSignatures(); return m.count(k) ? m[k] : std::string(); }
  bool has(const std::string& k) { return app.regionSignatures().count(k) != 0; }
  bool barHas(const std::string& t) { return sig("bar").find(t) != std::string::npos; }
  void snap(const char* name) { d.save(std::string(X4_REPO_ROOT) + "/firmware/test/out/test_" + name + ".pgm"); }
  void openApp(int k) { key(Key::Home); if (!has("menu")) key(Key::Home); tap(14 + k * 196 + 92, 100 + 66); }
  void setNum(const std::string& id, const std::string& v) { auto e = *app.entities().get(id); e.state = v; app.entities().set(id, e); }
};

void setUp() { setenv("TZ", "UTC0", 1); tzset(); }
void tearDown() {}

// ---- never linked: clock + link card on Home; ghosts + one card elsewhere; no fake numbers ----
void test_never_linked_ghosts() {
  Rig r(false);
  r.s.st.wifi = WifiState::Connected; r.s.st.ssid = "HomeNet"; r.s.st.ha = HaState::NeverLinked;
  // data present in the store must NOT leak onto ghost tiles
  demo::load(r.app.entities(), 13, 0);
  r.step(100);                         // Wi-Fi came up → step 2 (finish in your browser)
  TEST_ASSERT_TRUE(r.barHas("Step 2 of 2"));
  // leave setup the way the emulator's "Never linked" does: HA linked then unlinked
  r.s.st.ha = HaState::Connected; r.step(100);
  r.s.st.ha = HaState::NeverLinked; r.step(100);
  r.app.requestFullRefresh();
  TEST_ASSERT_TRUE(r.sig("k0").find(":13:00;") != std::string::npos);            // big clock stays real
  TEST_ASSERT_TRUE(r.sig("t1").find("Link Home Assistant") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t1").find("Q") != std::string::npos);                 // QR code
  TEST_ASSERT_FALSE(r.has("t2"));
  r.snap("never_linked_home");
  r.key(Key::Next);                                                              // Energy prices
  TEST_ASSERT_TRUE(r.has("noha"));
  TEST_ASSERT_TRUE(r.sig("noha").find("Energy prices needs Home") != std::string::npos);
  for (int i = 0; i < 5; ++i) {
    std::string s = r.sig("t" + std::to_string(i));
    TEST_ASSERT_TRUE_MESSAGE(s.rfind("D", 0) == 0, "ghost tile has a dashed outline");
    TEST_ASSERT_TRUE(s.find(":—;") != std::string::npos);
    TEST_ASSERT_TRUE(s.find("0.18") == std::string::npos && s.find("€") == std::string::npos);
  }
  r.snap("never_linked_prices");
  // a local page (settings) stays normal
  r.openApp(2);
  TEST_ASSERT_FALSE(r.has("noha"));
  TEST_ASSERT_TRUE(r.sig("t0").find("Front light") != std::string::npos || r.sig("t0").find("FRONT LIGHT") != std::string::npos);
}

// ---- HA's language (#98): Dutch clock and our own headings after one full refresh; screen titles stay as written ----
void test_language_from_ha() {
  Rig r(true, 13, 0, 14);
  auto any = [&r](const std::string& t) { for (auto& kv : r.app.regionSignatures()) if (kv.second.find(t) != std::string::npos) return true; return false; };
  TEST_ASSERT_TRUE(any("Tuesday 13 October"));
  uint32_t fulls = r.app.stats().fullRefreshes;
  r.s.st.language = "nl"; r.app.onNetStatusChanged(); r.step(100);
  TEST_ASSERT_EQUAL_UINT32(fulls + 1, r.app.stats().fullRefreshes);
  TEST_ASSERT_TRUE(any("Dinsdag 13 oktober"));
  TEST_ASSERT_FALSE(any("Tuesday"));
  r.openApp(1);
  r.key(Key::Next); r.key(Key::Next); r.key(Key::Next);
  TEST_ASSERT_TRUE(r.barHas("Heating"));                                   // user's screen title, not translated
  TEST_ASSERT_TRUE(r.sig("h0").find("Kamers 1–10 van 14") != std::string::npos);
  r.snap("language_nl_heating");
  r.s.st.language = "de"; r.app.onNetStatusChanged(); r.step(100);         // any other language → English
  TEST_ASSERT_TRUE(r.sig("h0").find("Rooms 1–10 of 14") != std::string::npos);
}

// ---- pager counts pages inside the current app; long lists become extra pages ----
void test_pager_counts_and_long_lists() {
  Rig r(true, 13, 0, 14);
  TEST_ASSERT_TRUE(r.barHas(":1 / 4;"));                  // Home app: 4 pages
  r.key(Key::Prev);
  TEST_ASSERT_TRUE(r.barHas(":4 / 4;"));                  // wraps inside the app
  TEST_ASSERT_TRUE(r.barHas("Solar & battery"));
  r.key(Key::Next);
  TEST_ASSERT_TRUE(r.barHas(":1 / 4;"));
  r.openApp(1);                                           // House: 3 light pages + 2 heating pages (14 zones)
  TEST_ASSERT_TRUE(r.barHas(":1 / 5;"));
  TEST_ASSERT_TRUE(r.barHas(":1 of 3;"));
  r.key(Key::Next); r.key(Key::Next); r.key(Key::Next);
  TEST_ASSERT_TRUE(r.barHas(":4 / 5;"));
  TEST_ASSERT_TRUE(r.barHas("Heating"));
  TEST_ASSERT_TRUE(r.barHas(":1 of 2;"));
  TEST_ASSERT_TRUE(r.sig("h0").find("Rooms 1–10 of 14") != std::string::npos);
  r.b.swipe(-1); r.step(50);                              // swipe left = next
  TEST_ASSERT_TRUE(r.barHas(":5 / 5;"));
  TEST_ASSERT_TRUE(r.sig("h0").find("Rooms 11–14 of 14") != std::string::npos);
  TEST_ASSERT_TRUE(r.has("z:garage"));
  TEST_ASSERT_FALSE(r.has("z:living"));
  r.snap("heating_2");
  r.b.swipe(1); r.step(50);                               // swipe right = previous
  TEST_ASSERT_TRUE(r.barHas(":4 / 5;"));
  // page overview lists parts
  r.tap(706, 28);
  TEST_ASSERT_TRUE(r.has("menu"));
  TEST_ASSERT_TRUE(r.sig("menu").find("part 2 of 3") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("menu").find("HOUSE · 5 PAGES") != std::string::npos);
  r.snap("page_overview_house");
}

// ---- new data that changes nothing visible → no refresh; one changed row → only that row ----
static DisplaySettings fast() { DisplaySettings ds; ds.intervalSec = 5; return ds; }   // stay inside one clock minute

void test_no_visible_change_no_refresh() {
  Rig r(true, 13, 0, 10, fast());
  r.setNum("sensor.home_power", "410");                  // 400 → 410 W: inside the 50 W deadband, still "400 W" (#85)
  r.step(5100);
  TEST_ASSERT_EQUAL_INT(0, int(r.d.events.size()));
  TEST_ASSERT_TRUE(r.app.log().back().find("nothing visible changed") != std::string::npos);
  r.setNum("sensor.home_power", "480");                   // → "480 W": one tile
  r.step(5100);
  TEST_ASSERT_EQUAL_INT(1, int(r.d.events.size()));
  TEST_ASSERT_FALSE(r.d.events[0].full);
  Rect t = r.app.regionRects()["t4"];
  TEST_ASSERT_EQUAL_INT(t.x, r.d.events[0].r.x); TEST_ASSERT_EQUAL_INT(t.y, r.d.events[0].r.y);
  TEST_ASSERT_EQUAL_INT(t.w, r.d.events[0].r.w); TEST_ASSERT_EQUAL_INT(t.h, r.d.events[0].r.h);
}

void test_one_changed_row_only() {
  Rig r(true, 13, 0, 10, fast());
  r.openApp(1); r.key(Key::Prev);                         // House › Heating
  TEST_ASSERT_TRUE(r.barHas("Heating"));
  r.d.clear();
  auto e = *r.app.entities().get("climate.kitchen");
  e.attrs["current_temperature"] = "20.3";
  r.app.entities().set("climate.kitchen", e);
  r.step(5100);
  TEST_ASSERT_EQUAL_INT(1, int(r.d.events.size()));
  Rect row = r.app.regionRects()["z:kitchen"];
  TEST_ASSERT_FALSE(r.d.events[0].full);
  TEST_ASSERT_EQUAL_INT(row.x, r.d.events[0].r.x); TEST_ASSERT_EQUAL_INT(row.y, r.d.events[0].r.y);
  TEST_ASSERT_EQUAL_INT(row.w, r.d.events[0].r.w); TEST_ASSERT_EQUAL_INT(row.h, r.d.events[0].r.h);
  TEST_ASSERT_TRUE(r.app.log().back().find("1 region") != std::string::npos);
  // a light toggled in HA on the Lights page redraws its row + list header/room header only
  r.key(Key::Next);
  r.d.clear();
}

// ---- 5 quick taps on a tado + → one climate.set_temperature ----
void test_five_taps_one_call() {
  Rig r;
  r.openApp(1); r.key(Key::Prev);
  Rect row = r.app.regionRects()["z:living"];
  int px = row.x + row.w - 23, py = row.y + row.h / 2;
  for (int i = 0; i < 5; ++i) { r.b.tap(px, py); r.step(300); }
  TEST_ASSERT_EQUAL_INT(0, int(r.s.calls.size()));        // still debouncing
  TEST_ASSERT_TRUE(r.sig("z:living").find(":23.5°") != std::string::npos);   // shown immediately
  TEST_ASSERT_TRUE(r.sig("z:living").find("d:") != std::string::npos);       // dotted = pending
  TEST_ASSERT_TRUE(r.sig("bar").find("I2,") != std::string::npos);          // sync icon in the top bar
  r.snap("tado_pending");
  r.step(1600);
  TEST_ASSERT_EQUAL_INT(1, int(r.s.calls.size()));
  TEST_ASSERT_EQUAL_STRING("climate", r.s.calls[0].domain.c_str());
  TEST_ASSERT_EQUAL_STRING("set_temperature", r.s.calls[0].service.c_str());
  TEST_ASSERT_EQUAL_STRING("{\"entity_id\":\"climate.living\",\"temperature\":23.5}", r.s.calls[0].json.c_str());
  // ack: HA reports the new setpoint → dotted underline cleared
  auto e = *r.app.entities().get("climate.living");
  e.attrs["temperature"] = "23.5";
  r.app.entities().set("climate.living", e);
  r.step(100);
  TEST_ASSERT_TRUE(r.sig("z:living").find("d:") == std::string::npos);
  TEST_ASSERT_TRUE(r.sig("bar").find("I2,") == std::string::npos);
  TEST_ASSERT_EQUAL_INT(1, int(r.s.calls.size()));
}

// ---- night 23–07: night face, no data redraws, tap = 60 s peek ----
void test_night_mode_and_peek() {
  Rig r(true, 22, 59);
  TEST_ASSERT_TRUE(r.has("bar"));
  r.step(61000);                                          // 23:00 → night face (full refresh)
  TEST_ASSERT_TRUE(r.has("night"));
  TEST_ASSERT_FALSE(r.has("bar"));
  TEST_ASSERT_TRUE(r.d.fulls() >= 1);
  TEST_ASSERT_EQUAL_INT(0, r.b.light);
  r.snap("night");
  r.d.clear();
  r.setNum("sensor.home_power", "2000");                  // data arrives: not drawn at night
  r.setNum("sensor.solar_power", "0");
  r.step(31000);
  int full = r.d.fulls();
  TEST_ASSERT_EQUAL_INT(0, full);
  // clock still ticks once a minute (partial on the night face only)
  for (auto& ev : r.d.events) TEST_ASSERT_FALSE(ev.full);
  r.d.clear();
  r.tap(400, 240);                                        // tap anywhere → dashboard for 60 s
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());
  TEST_ASSERT_TRUE(r.has("bar"));
  TEST_ASSERT_TRUE(r.barHas("Home"));
  TEST_ASSERT_TRUE(r.sig("bar").find("I6,") != std::string::npos);   // moon icon while peeking
  TEST_ASSERT_TRUE(r.sig("t4").find(":2.00;") != std::string::npos);   // fresh data shown on the peek
  r.snap("night_peek");
  r.step(59000);
  TEST_ASSERT_TRUE(r.has("bar"));
  r.step(1500);
  TEST_ASSERT_TRUE(r.has("night"));                       // back to the night face
  TEST_ASSERT_EQUAL_INT(2, r.d.fulls());
}

// ---- refresh policy (#26, #197): fast on screen change, partial otherwise, scheduled clean at :00/:30 ----
static bool logged(Rig& r, const std::string& s) { for (auto& l : r.app.log()) if (l.find(s) != std::string::npos) return true; return false; }
// #197: navigation is a fast refresh (no flash); every kNavClean-th navigation since the last clean is a clean
void test_nav_fast_every_tenth_clean() {
  Rig r;
  for (int i = 0; i < kNavClean; ++i) r.key(Key::Next);       // Home app: every key a different screen
  TEST_ASSERT_TRUE(logged(r, "EPD fast refresh (screen change)"));
  TEST_ASSERT_TRUE(logged(r, "EPD clean refresh (screen change · nav clean)"));
  for (int i = 0; i < kNavClean; ++i) r.key(Key::Next);
  TEST_ASSERT_EQUAL_INT(2, r.d.fulls());
  TEST_ASSERT_EQUAL_INT(2 * kNavClean - 2, r.d.fasts());
  TEST_ASSERT_EQUAL_INT(2 * kNavClean - 2, int(r.app.stats().fastRefreshes));
  TEST_ASSERT_TRUE(r.d.events[kNavClean - 1].full);
  r.d.clear();
  r.key(Key::Next);
  r.key(Key::Home); r.key(Key::Home);                          // home, then the app switcher: fast too
  TEST_ASSERT_TRUE(r.has("menu"));
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());
  TEST_ASSERT_EQUAL_INT(3, r.d.fasts());
}

// #197 acceptance: a tap ~1 s after a page change registers, and one queued while the page change is drawn too
void test_tap_after_page_change_registers() {
  Rig r;
  r.key(Key::Next);
  TEST_ASSERT_FALSE(r.has("menu"));
  r.step(1000);
  r.tap(130, 32);                                              // top bar app label → app switcher
  TEST_ASSERT_TRUE(r.has("menu"));
  r.tap(130, 32);                                              // and closed again
  TEST_ASSERT_FALSE(r.has("menu"));
  r.b.key(Key::Next);                                          // both land in one loop pass: the last (the tap) wins
  r.b.tap(130, 32);
  r.step(50);
  TEST_ASSERT_TRUE(r.has("menu"));
}

// #212: input queued while a refresh ran lands in one loop pass; only the last event is handled
void test_taps_during_refresh_one_navigation() {
  Rig r;
  r.key(Key::Next);                                            // ambient: the first key only brings the chrome back
  r.d.clear();
  std::string before = r.sig("bar");
  for (int i = 0; i < 5; ++i) r.b.key(Key::Next);              // five presses while the panel was busy
  r.step(50);
  TEST_ASSERT_EQUAL_INT(1, r.d.fasts() + r.d.fulls());
  TEST_ASSERT_TRUE(logged(r, "input · 4 stale dropped · last wins"));
  TEST_ASSERT_TRUE(r.sig("bar") != before);
  r.step(1000);
  TEST_ASSERT_EQUAL_INT(1, r.d.fasts() + r.d.fulls());         // nothing replayed afterwards
  r.d.clear();
  for (int i = 0; i < 5; ++i) r.b.tap(130, 32);                // five taps on the app label: one switcher open
  r.step(50);
  TEST_ASSERT_TRUE(r.has("menu"));
  TEST_ASSERT_EQUAL_INT(1, r.d.fasts() + r.d.fulls());
  r.step(1000);
  TEST_ASSERT_TRUE(r.has("menu"));
  TEST_ASSERT_EQUAL_INT(1, r.d.fasts() + r.d.fulls());
}

// #212: press feedback is no separate partial when the action redraws (navigation, a changed control)
void test_press_feedback_folded_into_the_action() {
  Rig r;
  r.app.setPressFeedback(true);
  r.key(Key::Next);
  r.d.clear();
  r.tap(130, 32);                                              // app label → switcher: the fast refresh is the feedback
  TEST_ASSERT_TRUE(r.has("menu"));
  TEST_ASSERT_EQUAL_INT(1, r.d.fasts());
  TEST_ASSERT_EQUAL_INT(0, r.d.partials());
  TEST_ASSERT_EQUAL_INT(0, int(r.app.stats().feedbackRefreshes));
  r.tap(130, 32);
  TEST_ASSERT_FALSE(r.has("menu"));
  r.openApp(1); r.key(Key::Prev);
  r.d.clear();
  Rect row = r.app.regionRects()["z:living"];
  r.tap(row.x + row.w - 23, row.y + row.h / 2);                // tado +: the row's own partial
  TEST_ASSERT_EQUAL_INT(1, r.d.partials());
  TEST_ASSERT_EQUAL_INT(0, int(r.app.stats().feedbackRefreshes));
}

void test_full_every_and_screen_change() {
  DisplaySettings ds = fast(); ds.fullEvery = 3;
  Rig r(true, 13, 0, 10, ds);
  r.key(Key::Next);
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());                  // different screen → fast, no flash (#197)
  TEST_ASSERT_EQUAL_INT(1, r.d.fasts());
  r.key(Key::Prev);
  r.d.clear();
  for (int i = 0; i < 3; ++i) { r.setNum("sensor.home_power", std::to_string(1000 + i * 500)); r.step(5100); }
  TEST_ASSERT_EQUAL_INT(3, r.d.partials());
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());                  // clock known: fullEvery no longer forces a full
  r.step(29 * 60000);                                     // 13:29:17: data + 29 clock partials, still no flash
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());
  r.step(60000);                                          // 13:30 tick → one clean full instead of the clock partial
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());
  TEST_ASSERT_TRUE(logged(r, "EPD clean refresh (clean screen)"));
  r.d.clear();
  r.key(Key::Next);                                       // ambient (#27): the first key only brings the chrome back
  r.key(Key::Next); r.key(Key::Prev);                     // user flashes at 13:30:xx → next clean at 14:00
  r.d.clear();
  r.step(29 * 60000);                                     // 13:59:17
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());
  r.step(60000);
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());
  // Clean screen: hourly (settings tile `cleanEvery`, legacy `fullEvery`, steps 30 → 60)
  DisplaySettings hourly = r.app.settings(); hourly.cleanEvery = 60;
  r.app.setSettings(hourly);
  r.d.clear();
  r.step(59 * 60000);                                     // 14:59:17: no clean at 14:30
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());
  r.step(60000);
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());                  // 15:00
  // clock unset (no SNTP): kCleanCap partials are the only clean; the legacy fullEvery (3) does nothing
  r.b.epoch = 0;
  r.d.clear();
  for (int i = 0; i < kCleanCap; ++i) { r.setNum("sensor.home_power", i % 2 ? "6000" : "7000"); r.step(5100); }   // past the deadband (#85)
  TEST_ASSERT_EQUAL_INT(kCleanCap - 1, r.d.partials());
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());                  // 30th redraw → "ghosting limit"
  TEST_ASSERT_TRUE(logged(r, "EPD clean refresh (ghosting limit)"));
  // config push → one full refresh
  r.d.clear();
  r.app.setConfig(defaultConfig());
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());
  TEST_ASSERT_EQUAL_INT(1, int(r.d.events.size()));
}

// ---- Settings is built in (#159): a config without it still gets the Settings app and its fixed pages ----
void test_settings_built_in() {
  Rig r(true);
  ParseResult p = parseConfig("version: 1\napps:\n  - id: home\nscreens:\n  - id: only\n    app: home\n    widgets:\n      - {type: clock}\n");
  TEST_ASSERT_TRUE(p.ok);
  r.app.setConfig(p.config);
  const Config& c = r.app.config();
  TEST_ASSERT_EQUAL_INT(2, int(c.apps.size()));
  TEST_ASSERT_EQUAL_STRING("settings", c.apps.back().id.c_str());
  TEST_ASSERT_EQUAL_INT(8, int(c.screens.size()));
  TEST_ASSERT_EQUAL_STRING("display", c.screens[1].id.c_str());
  TEST_ASSERT_EQUAL_STRING("about", c.screens.back().id.c_str());
}

// ---- no scheduled clean while night mode is active (#26); night end is a full anyway ----
void test_no_clean_at_night() {
  DisplaySettings ds = fast(); ds.night = "23-07";
  Rig r(true, 22, 0, 10, ds);
  r.setNum("sensor.home_power", "2345"); r.step(5100);
  r.d.clear();
  r.step(30 * 60000);                                     // 22:30:xx: clean
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());
  r.step(31 * 60000);                                     // 23:00 → night face (full), then clock partials
  TEST_ASSERT_TRUE(r.has("night"));
  r.d.clear();
  r.step(90 * 60000);                                     // 00:31: 00:00 and 00:30 pass without a flash
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());
  TEST_ASSERT_GREATER_THAN(80, r.d.partials());
}

// ---- keys, app switcher, back-to-Home and standby timers ----
void test_home_key_and_idle() {
  DisplaySettings ds; ds.returnHome = "1"; ds.standby = "10";
  Rig r(true, 13, 0, 10, ds);
  r.key(Key::Home);                                       // Home on Home → app switcher
  TEST_ASSERT_TRUE(r.has("menu"));
  TEST_ASSERT_TRUE(r.barHas("All apps"));
  r.snap("app_switcher");
  r.tap(14 + 2 * 196 + 92, 166);                          // Settings (the default has no Travel app, #145)
  TEST_ASSERT_TRUE(r.barHas(":Display;"));
  r.step(61000);                                          // idle 1 min → back to Home, drawn ambient (#27)
  TEST_ASSERT_TRUE(r.barHas(":Home;"));
  TEST_ASSERT_FALSE(r.barHas(":1 / 4;"));                 // no pager
  TEST_ASSERT_FALSE(r.has("time"));                       // Home has a clock tile: no bar clock
  r.step(9 * 60000 + 1000);                               // idle 10 min → standby
  TEST_ASSERT_TRUE(r.has("standby"));
  TEST_ASSERT_TRUE(r.sig("standby").find("Standby") != std::string::npos);
  r.snap("standby");
  r.key(Key::Next);                                       // any key wakes
  TEST_ASSERT_TRUE(r.has("bar"));
  r.key(Key::Power);
  TEST_ASSERT_TRUE(r.has("standby"));
  r.key(Key::Power);
  TEST_ASSERT_TRUE(r.has("bar"));
}

// #225 power trail: the "key" stage runs before the App acts, "standby drawn" after the standby clean with the light off
void test_power_stages() {
  Rig r;
  std::vector<std::string> st;
  r.app.onPowerStage([&](const char* s) { st.push_back(std::string(s) + " full=" + std::to_string(r.d.fulls()) + " light=" + std::to_string(r.b.light)); });
  r.key(Key::Power);
  TEST_ASSERT_TRUE(r.has("standby"));
  TEST_ASSERT_EQUAL_UINT32(2, st.size());
  TEST_ASSERT_EQUAL_STRING("key full=0", st[0].substr(0, 10).c_str());
  TEST_ASSERT_EQUAL_STRING("standby drawn full=1 light=0", st[1].c_str());
  st.clear();
  r.key(Key::Power);                                      // wake: only the key stage
  TEST_ASSERT_TRUE(r.has("bar"));
  TEST_ASSERT_EQUAL_UINT32(1, st.size());
}

// ---- hardware-key factory reset (#21, core/recovery.h): Power + Right 5 s → screen → release → Right ----
void test_key_factory_reset() {
  Rig r;
  r.key(Key::Next);
  TEST_ASSERT_TRUE(r.barHas(":2 / 4;"));                  // a plain key still navigates
  r.b.held = kKeyPower | kKeyRight;
  r.b.key(Key::Power); r.b.key(Key::Next);                // both KeyDowns in one pass: taken by the hold
  r.step(4900);
  TEST_ASSERT_FALSE(r.has("reset"));
  TEST_ASSERT_TRUE(r.barHas(":2 / 4;"));                  // no page turn, no standby
  r.step(200);
  TEST_ASSERT_TRUE(r.has("reset"));
  TEST_ASSERT_TRUE(r.sig("reset").find("Factory reset?") != std::string::npos);
  r.snap("factory_reset");
  r.b.held = kKeyRight; r.step(100);                      // Power released first: Right still down, not an answer
  TEST_ASSERT_EQUAL_INT(0, r.s.resets);
  r.b.held = 0; r.step(100);
  r.key(Key::Home); r.step(100);                          // other key cancels, back to the page
  TEST_ASSERT_FALSE(r.has("reset"));
  TEST_ASSERT_TRUE(r.barHas(":2 / 4;"));
  r.b.held = kKeyPower | kKeyRight; r.step(5100);         // again, then let it time out
  TEST_ASSERT_TRUE(r.has("reset"));
  r.step(10000);
  TEST_ASSERT_FALSE(r.has("reset"));
  r.step(20000);                                          // still held (bag): no second screen
  TEST_ASSERT_FALSE(r.has("reset"));
  r.b.held = 0; r.step(100);
  r.b.held = kKeyPower | kKeyRight; r.step(5100);
  r.b.held = 0; r.step(100);
  r.key(Key::Next);                                       // Right confirms
  TEST_ASSERT_EQUAL_INT(1, r.s.resets);
  // crash loop at boot: offered straight away, Right resets
  Rig c;
  c.app.offerRecovery();
  TEST_ASSERT_TRUE(c.sig("reset").find("keeps crashing") != std::string::npos);
  c.snap("factory_reset_crash_loop");
  c.step(100);
  c.key(Key::Next);
  TEST_ASSERT_EQUAL_INT(1, c.s.resets);
}

// ---- hardware-key restart (#226, core/recovery.h): Power + Prev 5 s → "Restarting…" → Board::restart ----
void test_key_restart() {
  Rig r;
  r.key(Key::Next);
  TEST_ASSERT_TRUE(r.barHas(":2 / 4;"));
  r.b.held = kKeyPower | kKeyLeft;
  r.b.key(Key::Power); r.b.key(Key::Prev);                // both KeyDowns in one pass: taken by the hold
  r.step(4900);
  TEST_ASSERT_FALSE(r.b.restarted);
  TEST_ASSERT_TRUE(r.barHas(":2 / 4;"));                  // no page turn back, no standby
  r.b.held = 0; r.step(200);                              // released early: nothing
  TEST_ASSERT_FALSE(r.b.restarted);
  TEST_ASSERT_FALSE(r.has("boot"));
  r.b.held = kKeyPower | kKeyLeft; r.step(100);
  r.step(5000);
  TEST_ASSERT_TRUE(r.b.restarted);
  TEST_ASSERT_TRUE(r.has("boot"));
  TEST_ASSERT_TRUE(r.sig("boot").find("Restarting") != std::string::npos);
  TEST_ASSERT_EQUAL_INT(0, r.s.resets);
}

// ---- Power held 2 s (#258, core/recovery.h): "Turned off" face while still held, then Board::powerOff ----
void test_power_hold_off() {
  Rig r;
  std::vector<std::string> st;
  r.app.onPowerStage([&](const char* s) { st.push_back(s); });
  r.b.held = kKeyPower;
  r.b.key(Key::Power);
  r.step(1900);
  TEST_ASSERT_TRUE(r.has("bar"));                         // no standby on the press: it waits for release or 2 s
  TEST_ASSERT_FALSE(r.has("off"));
  r.step(200);                                            // 2 s, still held
  TEST_ASSERT_TRUE(r.has("off"));
  TEST_ASSERT_TRUE(r.sig("off").find("Turned off") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("off").find("Hold Power to turn on") != std::string::npos);
  TEST_ASSERT_EQUAL_INT(1, r.b.powerOffs);
  TEST_ASSERT_EQUAL_UINT8(0, r.b.light);
  TEST_ASSERT_EQUAL_UINT32(2, st.size());
  TEST_ASSERT_EQUAL_STRING("off", st[1].c_str());         // trail line before the latch goes
  r.snap("turned_off");
  r.b.held = 0; r.step(200);                              // the key-up: no second action
  TEST_ASSERT_TRUE(r.has("off"));
  TEST_ASSERT_FALSE(r.b.restarted);
  r.key(Key::Next); r.tap(400, 240);                      // QEMU / host: only Power does anything
  TEST_ASSERT_TRUE(r.has("off"));
  r.key(Key::Power); r.step(50);                          // a short press: power on = restart
  TEST_ASSERT_TRUE(r.b.restarted);
  TEST_ASSERT_EQUAL_INT(1, r.b.powerOffs);
}

// #258: a short press stays standby (on release); Power held from power-on does nothing until released once
void test_power_short_press_and_boot_hold() {
  Rig r;
  r.b.held = kKeyPower; r.b.key(Key::Power); r.step(300);
  TEST_ASSERT_FALSE(r.has("standby"));
  r.b.held = 0; r.step(50);
  TEST_ASSERT_TRUE(r.has("standby"));
  r.key(Key::Power); r.step(50);                          // remote / short press: KeyDown already released
  TEST_ASSERT_TRUE(r.has("bar"));
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s;
  b.held = kKeyPower;                                     // the hold that switched the board on
  App app{d, b, s};
  app.begin(defaultConfig(), DisplaySettings());
  b.key(Key::Power);
  for (int i = 0; i < 100; ++i) { b.now += 50; app.loop(); }   // 5 s
  TEST_ASSERT_EQUAL_INT(0, b.powerOffs);
  TEST_ASSERT_FALSE(app.powerView().standby);
}

// ---- first install: Wi-Fi on the display → finish in your browser → Home ----
void test_first_install_flow() {
  Rig r(false);
  TEST_ASSERT_TRUE(r.barHas("Step 1 of 2"));
  TEST_ASSERT_FALSE(r.barHas(" / 2;"));                    // #183: a step in the title, no pager
  TEST_ASSERT_TRUE(r.s.scans > 0);
  r.key(Key::Next); r.key(Key::Home);                     // nav does nothing during setup
  TEST_ASSERT_TRUE(r.barHas("Step 1 of 2"));
  TEST_ASSERT_FALSE(r.has("menu"));
  // pick "HomeNet-Guest" (2nd row) → password keyboard
  Rect t = r.app.regionRects()["t0"];
  r.tap(t.x + 450, t.y + 2 + 10 + 48 + 54 + 27);
  TEST_ASSERT_TRUE(r.sig("t0").find("Password for HomeNet-Guest") != std::string::npos);
  // type "abc" then Connect → refused locally (< 8 chars)
  auto keyAt = [&](int row, int col, int cols, int inset) {
    int x0 = t.x + 14 + inset, w = t.w - 28 - 2 * inset;
    double unit = (w - (cols - 1) * 6.0) / cols;
    int kbTop = t.y + 10 + 44 + 8 + 48 + 8, kbH = t.y + t.h - 10 - kbTop, rowH = (kbH - 18) / 4;
    r.tap(int(x0 + col * (unit + 6) + unit / 2), kbTop + row * (rowH + 6) + rowH / 2);
  };
  keyAt(1, 0, 9, 30); keyAt(0, 0, 10, 0);                 // 'a', 'q'
  TEST_ASSERT_TRUE(r.sig("t0").find("2 characters") != std::string::npos);
  int fx = t.x + t.w - 14 - 50, fy = t.y + t.h - 10 - 20;  // Connect
  r.tap(fx, fy);
  TEST_ASSERT_TRUE(r.sig("t0").find("At least 8 characters") != std::string::npos);
  TEST_ASSERT_TRUE(r.s.lastSsid.empty());
  for (int i = 0; i < 6; ++i) keyAt(0, i, 10, 0);         // q w e r t y
  r.snap("keyboard");
  r.tap(fx, fy);
  TEST_ASSERT_EQUAL_STRING("HomeNet-Guest", r.s.lastSsid.c_str());
  TEST_ASSERT_EQUAL_STRING("aqqwerty", r.s.lastPw.c_str());
  TEST_ASSERT_TRUE(r.sig("t0").find("Connecting to HomeNet-Guest") != std::string::npos);
  // wrong password → back to the keyboard with a message
  r.s.st.wifi = WifiState::WrongPassword; r.step(50);
  TEST_ASSERT_TRUE(r.sig("t0").find("Wrong password") != std::string::npos);
  r.s.st.wifi = WifiState::Connected; r.s.st.ssid = "HomeNet-Guest"; r.s.st.ip = "192.168.1.42"; r.step(50);
  TEST_ASSERT_TRUE(r.sig("t0").find("Finish in your browser") != std::string::npos);
  TEST_ASSERT_TRUE(r.barHas("Step 2 of 2"));
  TEST_ASSERT_TRUE(r.sig("t0").find("Q") != std::string::npos);          // QR (http://ha-paper.local)
  TEST_ASSERT_TRUE(r.sig("t0").find("192.168.1.42") != std::string::npos);
  r.snap("setup_step2");
  // one HA sign-in in the browser → display redraws once to Home. The device reports Linking (browser at HA) →
  // Offline (key stored, WebSocket not up yet) → Connected; found under QEMU: the setup page used to stay up.
  r.s.st.ha = HaState::Linking; r.step(50);
  r.s.st.ha = HaState::Offline; r.step(50);
  TEST_ASSERT_TRUE(r.barHas("Step 2 of 2"));
  r.d.clear();
  r.s.st.ha = HaState::Connected; demo::load(r.app.entities(), 13, 0); r.step(50);
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());
  TEST_ASSERT_TRUE(r.barHas(":Home;"));
  TEST_ASSERT_TRUE(r.sig("t1").find("CHEAP") != std::string::npos);
}

// ---- #202: a configured device boots with Wi-Fi saved (Connecting) and HA linked (Offline), the state
// DeviceServices::begin() publishes before the first pump; Wi-Fi + WebSocket come up later → boot + home, no setup ----
void test_configured_boot_no_setup() {
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s;
  App app{d, b, s};
  std::vector<std::string> fulls;
  // "EPD full refresh (boot) · 0 ms" (#200; "EPD clean refresh (…)" after #197) → "boot"
  app.onLog([&](const std::string& m) {
    if (m.rfind("EPD full refresh (", 0) != 0 && m.rfind("EPD clean refresh (", 0) != 0) return;
    const size_t a = m.find('(') + 1;
    fulls.push_back(m.substr(a, m.find(')', a) - a));
  });
  b.epoch = kEpoch1300;
  s.st.wifi = WifiState::Connecting; s.st.ssid = "HomeNet"; s.st.ha = HaState::Offline; s.st.haUrl = "homeassistant.local:8123";
  app.setPressFeedback(false);
  app.begin(defaultConfig(), DisplaySettings());
  auto step = [&](uint32_t ms) { for (uint32_t t = 0; t < ms; t += 50) { b.now += 50; app.loop(); } };
  step(1800);
  s.st.wifi = WifiState::Connected; s.st.ip = "192.168.1.42"; app.onNetStatusChanged(); step(100);
  s.st.ha = HaState::Connected; demo::load(app.entities(), 13, 0); app.onNetStatusChanged(); step(3000);
  std::string all; for (auto& f : fulls) all += f + ";";
  TEST_ASSERT_EQUAL_STRING("boot;home;", all.c_str());
  TEST_ASSERT_EQUAL_INT(2, d.fulls());
}

// ---- glance (#10): a held panel renders without refreshing; the snapshot ignores the clock; redraw = one full ----
void test_glance_hooks() {
  Rig r;
  r.app.setPanelHeld(true);
  r.app.settle();
  TEST_ASSERT_EQUAL(0, r.d.fulls() + r.d.partials());   // rendered, not shown
  auto clocks = r.app.clockRegions();
  TEST_ASSERT_TRUE(std::find(clocks.begin(), clocks.end(), "k0") != clocks.end());   // Overview clock tile
  auto ignore = [&] { std::vector<uint32_t> v; for (auto& k : r.app.clockRegions()) v.push_back(glance::fnv1a(k)); return v; };
  glance::Snapshot a = glance::snapshotOf(r.app.regionSignatures());
  r.b.epoch += 15 * 60; r.step(1000); r.app.settle();          // 15 min later, same values: only the clock moved
  glance::Snapshot b = glance::snapshotOf(r.app.regionSignatures());
  TEST_ASSERT_EQUAL(0, int(glance::snapshotDiff(&a, b, ignore()).size()));
  r.setNum("sensor.home_power", "2000"); r.step(50); r.app.settle();
  glance::Snapshot c = glance::snapshotOf(r.app.regionSignatures());
  TEST_ASSERT_TRUE(glance::snapshotDiff(&b, c, ignore()).size() >= 1);
  TEST_ASSERT_EQUAL(0, r.d.fulls() + r.d.partials());
  r.app.redraw("changed");
  TEST_ASSERT_EQUAL(1, r.d.fulls());
  // live → sleep from another page: back home in ambient chrome, one full refresh; already home + ambient: none
  r.d.clear();
  r.key(Key::Next);
  r.app.prepareSleep();
  TEST_ASSERT_EQUAL(1, r.d.fulls());
  r.app.prepareSleep();
  TEST_ASSERT_EQUAL(1, r.d.fulls());
  TEST_ASSERT_TRUE(r.app.powerView().msSinceUserInput >= 0);
  TEST_ASSERT_TRUE(r.app.powerView().main);
}

// ---- OTA install screen + blocked on low battery ----
void test_ota_screen() {
  Rig r;
  r.s.st.ota = OtaState::Available; r.s.st.otaAvailableVersion = "0.4.0"; r.step(50);
  TEST_ASSERT_TRUE(r.sig("bar").find("I3,") != std::string::npos);   // update icon (notify)
  r.openApp(2); r.key(Key::Next); r.key(Key::Next); r.key(Key::Next);   // Display → Display style → Power → Updates
  TEST_ASSERT_TRUE(r.sig("t0").find("Install v0.4.0") != std::string::npos);
  r.b.battery = 20;
  Rect t = r.app.regionRects()["t0"];
  r.tap(t.x + t.w - 100, t.y + t.h - 14 - 17 - 12 - 28);
  TEST_ASSERT_EQUAL_INT(0, r.s.otaInstalls);
  TEST_ASSERT_TRUE(r.sig("s0").find("charge to 30% first") != std::string::npos);
  r.b.battery = 80;
  r.tap(t.x + t.w - 100, t.y + t.h - 14 - 17 - 12 - 28);
  TEST_ASSERT_EQUAL_INT(1, r.s.otaInstalls);
  r.d.clear();
  r.s.st.ota = OtaState::Downloading; r.s.st.otaProgressPct = 0; r.step(50);
  TEST_ASSERT_TRUE(r.has("upd"));
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls());
  r.s.st.otaProgressPct = 10; r.step(50);
  r.s.st.otaProgressPct = 15; r.step(50);                  // same 10 % step: no redraw
  r.s.st.otaProgressPct = 20; r.step(50);
  TEST_ASSERT_EQUAL_INT(2, r.d.partials());
  r.snap("ota_install");
  r.s.st.ota = OtaState::Failed; r.step(50);
  TEST_ASSERT_TRUE(r.has("bar"));
  TEST_ASSERT_TRUE(r.sig("bar").find("I4,") != std::string::npos);   // alert icon
}

// ---- OTA install screen for an upload: the version line only when the upload named one (#237) ----
void test_ota_upload_version_line() {
  Rig r;
  r.s.st.otaAvailableVersion = ""; r.s.st.ota = OtaState::Installing; r.s.st.otaProgressPct = 0; r.step(50);
  std::string sig = r.sig("upd");
  TEST_ASSERT_TRUE(sig.find(":Updating to;") != std::string::npos);
  TEST_ASSERT_TRUE_MESSAGE(sig.find(":v;") == std::string::npos, sig.c_str());   // no bare "v"
  r.s.st.otaAvailableVersion = "0.5.0"; r.step(50);                                  // manifest part arrived later
  TEST_ASSERT_TRUE(r.sig("upd").find(":v0.5.0;") != std::string::npos);
}

// ---- OTA install screen: a long version gets its own line and fits the panel (#215) ----
void test_ota_long_version() {
  for (const std::string ver : {std::string("0.1.0-alpha.6-devtest-212-199-gbf929d4xy"),                    // 40 chars
                                std::string("0.1.0-alpha.6-devtest-212-199-gbf929d4-and-a-much-longer-tail-that-goes-on-and-on-and-on-xy")}) {
    Rig r;
    r.s.st.otaAvailableVersion = ver; r.s.st.ota = OtaState::Downloading; r.s.st.otaProgressPct = 40; r.step(50);
    std::string sig = r.sig("upd");
    TEST_ASSERT_TRUE(sig.find(":Updating to;") != std::string::npos);
    size_t e = sig.find(":v0.1.0-");
    TEST_ASSERT_TRUE(e != std::string::npos);
    size_t b = sig.rfind('T', e);
    int x = 0, bl = 0, size = 0;
    TEST_ASSERT_EQUAL_INT(3, std::sscanf(sig.c_str() + b, "T%d,%d,%dB", &x, &bl, &size));
    std::string shown = sig.substr(e + 1, sig.find(';', e) - e - 1);
    int w = Canvas(nullptr).textWidth(shown, B(size));
    TEST_ASSERT_TRUE_MESSAGE(x >= 40 && x + w <= kScreenW - 40, shown.c_str());
    TEST_ASSERT_TRUE(size >= 18);
    TEST_ASSERT_EQUAL_STRING("xy", shown.substr(shown.size() - 2).c_str());   // start and end kept
    if (ver.size() == 40) TEST_ASSERT_EQUAL_STRING(("v" + ver).c_str(), shown.c_str());
    else TEST_ASSERT_TRUE(shown.find("…") != std::string::npos);
    if (ver.size() == 40) r.snap("ota_long_version");
  }
}

// ---- Settings › Updates › Check shows that it ran (#250): Checking… → result with its time; partials of the status line only ----
void test_ota_check_feedback() {
  Rig r;
  r.openApp(2); r.key(Key::Next); r.key(Key::Next); r.key(Key::Next);   // Updates
  TEST_ASSERT_TRUE(r.sig("s0").find("Not checked yet") != std::string::npos);
  Rect t = r.app.regionRects()["t0"], s = r.app.regionRects()["s0"];
  TEST_ASSERT_TRUE(s.x >= t.x && s.y >= t.y && s.x + s.w <= t.x + t.w && s.y + s.h <= t.y + t.h);
  auto onlyStatus = [&](const char* what) {   // one partial, and it covers the status line only
    TEST_ASSERT_EQUAL_INT_MESSAGE(0, r.d.fulls(), what);
    TEST_ASSERT_EQUAL_INT_MESSAGE(1, r.d.partials(), what);
    Rect p = r.d.events.back().r;
    TEST_ASSERT_TRUE_MESSAGE(p.x == s.x && p.y == s.y && p.w == s.w && p.h == s.h, what);
  };
  r.d.clear();
  r.tap(t.x + t.w - 100, t.y + t.h - 14 - 17 - 12 - 28);   // Check for updates
  TEST_ASSERT_EQUAL_INT(1, r.s.otaChecks);
  r.s.st.otaChecking = true; r.step(50);                   // net: otaRequestCheck marks the status at once
  onlyStatus("checking");
  TEST_ASSERT_TRUE(r.sig("s0").find("Checking…") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t0").find("Check for updates") != std::string::npos);   // the button stays
  r.tap(t.x + t.w - 100, t.y + t.h - 14 - 17 - 12 - 28);   // pressed again while checking: nothing
  TEST_ASSERT_EQUAL_INT(1, r.s.otaChecks);
  r.d.clear();
  r.s.st.otaChecking = false; r.s.st.otaChecked = true; r.s.st.otaLastCheckEpoch = 1792000000; r.step(50);
  onlyStatus("up to date");
  std::string sig = r.sig("s0");
  TEST_ASSERT_TRUE_MESSAGE(sig.find("Up to date") != std::string::npos && sig.find("Checked ") != std::string::npos, sig.c_str());
  r.snap("ota_checked");
  r.d.clear();
  r.s.st.otaChecking = true; r.step(50);
  r.s.st.otaChecking = false; r.s.st.otaCheckErr = OtaErr::Memory; r.s.st.otaCheckMsg = "Not enough memory right now — try again in a minute"; r.step(50);
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls());
  sig = r.sig("s0");
  TEST_ASSERT_TRUE_MESSAGE(sig.find("Not enough memory") != std::string::npos && sig.find("Try again in a minute") != std::string::npos, sig.c_str());
  TEST_ASSERT_TRUE(sig.find("-100") == std::string::npos);
  // no Wi-Fi: no check queued, "No connection"
  r.s.st.otaCheckErr = OtaErr::None; r.s.st.wifi = WifiState::Offline; r.step(50);
  r.tap(t.x + t.w - 100, t.y + t.h - 14 - 17 - 12 - 28);
  TEST_ASSERT_EQUAL_INT(1, r.s.otaChecks);
  TEST_ASSERT_TRUE(r.sig("s0").find("No connection") != std::string::npos);
}

// ---- OTA checks off in this build (X4_OTA_REPO placeholder): clear state, no check button ----
void test_ota_checks_off() {
  Rig r;
  r.s.st.otaChecksOff = true; r.step(50);
  r.openApp(2); r.key(Key::Next); r.key(Key::Next); r.key(Key::Next);   // Updates
  TEST_ASSERT_TRUE(r.sig("s0").find("Update checks off") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t0").find("Check for updates") == std::string::npos);
}

// ---- lights: toggle sends one call; optimistic row redraw ----
void test_light_toggle() {
  Rig r;
  r.openApp(1);
  Rect row = r.app.regionRects()["l:living_reading"];
  r.d.clear();
  r.tap(row.x + 60, row.y + row.h / 2);
  TEST_ASSERT_EQUAL_INT(1, int(r.s.calls.size()));
  TEST_ASSERT_EQUAL_STRING("turn_on", r.s.calls[0].service.c_str());
  TEST_ASSERT_EQUAL_STRING("{\"entity_id\":\"light.living_reading\"}", r.s.calls[0].json.c_str());
  TEST_ASSERT_EQUAL_INT(1, r.d.partials());
  TEST_ASSERT_TRUE(r.sig("h0").find("6 of 16 lights on") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("l:living_reading").find(":70%;") != std::string::npos);
}

// ---- HA entities on stat / gauge / switch; custom apps ----
static Config cfgOf(const std::string& yaml) {
  ParseResult p = parseConfig(yaml);
  TEST_ASSERT_TRUE_MESSAGE(p.ok, p.message.c_str());
  return p.config;
}

// ---- console Values view (#122, emulator tileValues): each tile's big value on one line, "" without one ----
void test_tile_values() {
  Rig r;
  EntityValue t; t.state = "12.345"; t.attrs["unit_of_measurement"] = "°C";
  r.app.entities().set("sensor.outdoor_temperature", t);
  EntityValue ph; ph.state = "142";
  r.app.entities().set("sensor.phone_battery", ph);
  EntityValue cof; cof.state = "off";
  r.app.entities().set("switch.coffee", cof);
  EntityValue gone; gone.state = "unavailable";
  r.app.entities().set("sensor.garden", gone);
  EntityValue unk; unk.state = "unknown";
  r.app.entities().set("switch.pump", unk);
  r.app.setConfig(cfgOf("version: 1\nscreens:\n  - id: a\n    widgets:\n"
                        "      - {type: stat, entity: sensor.outdoor_temperature}\n"
                        "      - {type: gauge, entity: sensor.phone_battery}\n"
                        "      - {type: switch, entity: switch.coffee}\n"
                        "      - {type: stat, entity: sensor.garden}\n"
                        "      - {type: switch, entity: switch.pump}\n"
                        "      - {type: stat, entity: sensor.missing}\n"
                        "      - {type: clock}\n"
                        "      - {type: bars, series: usage}\n"));
  r.step(200);
  std::vector<std::string> v = r.app.tileValues("a");
  const char* want[] = {"12.3 °C", "100%", "Off", "Unavailable", "Unknown", "—", "13:00", ""};
  TEST_ASSERT_EQUAL_INT(8, int(v.size()));
  for (int i = 0; i < 8; ++i) TEST_ASSERT_EQUAL_STRING(want[i], v[i].c_str());
  TEST_ASSERT_EQUAL_INT(0, int(r.app.tileValues("nope").size()));
  r.s.st.language = "nl"; r.app.onNetStatusChanged(); r.step(100);   // Dutch: decimal comma, Dutch words
  v = r.app.tileValues("a");
  TEST_ASSERT_EQUAL_STRING("12,3 °C", v[0].c_str());
  TEST_ASSERT_EQUAL_STRING("Uit", v[2].c_str());
  TEST_ASSERT_EQUAL_STRING("Niet beschikbaar", v[3].c_str());
  TEST_ASSERT_EQUAL_STRING("Onbekend", v[4].c_str());
}

// #268: a history tile parses; until #270 draws it, both styles show the unknown-tile face (no crash)
void test_history_tile_placeholder() {
  Rig r;
  EntityValue t; t.state = "12.3"; t.attrs["unit_of_measurement"] = "°C";
  r.app.entities().set("sensor.outdoor_temperature", t);
  r.app.setConfig(cfgOf("version: 1\nscreens:\n  - id: a\n    widgets:\n"
                        "      - {type: history, entity: sensor.outdoor_temperature, cs: 4}\n"
                        "      - {type: history, entity: sensor.outdoor_temperature, window: 7d, agg: max, cs: 2}\n"));
  r.step(200);
  TEST_ASSERT_TRUE(r.sig("t0").find(":?;") != std::string::npos);
  TEST_ASSERT_EQUAL_STRING("", r.app.tileValues("a")[0].c_str());
  DisplaySettings ds = r.app.settings(); ds.style = "sleek";
  r.app.setSettings(ds);
  r.step(200);
  TEST_ASSERT_TRUE(r.sig("t1").find(":?;") != std::string::npos);
}

// ---- preview.png of another screen (#168): drawn off-screen, the panel and its frame untouched ----
void test_render_screen_offscreen() {
  Rig r;
  const Config& c = r.app.config();
  TEST_ASSERT_TRUE(c.screens.size() >= 2);
  const std::string a = c.screens[0].id, b = c.screens[1].id;
  TEST_ASSERT_EQUAL_STRING(a.c_str(), r.app.shownScreen().c_str());
  const std::vector<uint8_t> panel(r.app.framebuffer().data, r.app.framebuffer().data + Framebuffer::kBytes);
  const auto sigs = r.app.regionSignatures();
  const App::Stats st = r.app.stats();
  std::vector<uint8_t> buf(Framebuffer::kBytes);
  Framebuffer out{buf.data()};
  TEST_ASSERT_TRUE(r.app.renderScreen(b, out));
  TEST_ASSERT_TRUE(buf != panel);
  TEST_ASSERT_TRUE(std::equal(panel.begin(), panel.end(), r.app.framebuffer().data));
  TEST_ASSERT_TRUE(sigs == r.app.regionSignatures());
  TEST_ASSERT_EQUAL_UINT32(st.fullRefreshes, r.app.stats().fullRefreshes);
  TEST_ASSERT_EQUAL_UINT32(st.partialRefreshes, r.app.stats().partialRefreshes);
  TEST_ASSERT_EQUAL_INT(0, int(r.d.events.size()));
  TEST_ASSERT_TRUE(r.app.renderScreen(a, out));   // the shown screen: what the panel shows
  TEST_ASSERT_TRUE(buf == panel);
  TEST_ASSERT_FALSE(r.app.renderScreen("nope", out));
  r.step(2000);                                    // nothing left to redraw afterwards
  TEST_ASSERT_EQUAL_INT(0, int(r.d.events.size()));
  r.key(Key::Next);
  TEST_ASSERT_EQUAL_STRING(b.c_str(), r.app.shownScreen().c_str());
  r.key(Key::Home);
  if (!r.has("menu")) r.key(Key::Home);            // menu over the page: not a plain screen view
  TEST_ASSERT_TRUE(r.has("menu"));
  TEST_ASSERT_EQUAL_STRING("", r.app.shownScreen().c_str());
}

void test_generic_entities() {
  Rig r;
  EntityValue t; t.state = "12.345"; t.attrs["friendly_name"] = "Outdoor"; t.attrs["unit_of_measurement"] = "°C";
  r.app.entities().set("sensor.outdoor_temperature", t);
  EntityValue door; door.state = "on"; door.attrs["friendly_name"] = "Front door";
  r.app.entities().set("binary_sensor.front_door", door);
  EntityValue ph; ph.state = "142"; ph.attrs["friendly_name"] = "Phone";
  r.app.entities().set("sensor.phone_battery", ph);
  EntityValue cof; cof.state = "off"; cof.attrs["friendly_name"] = "Coffee";
  r.app.entities().set("switch.coffee", cof);
  r.app.setConfig(cfgOf("version: 1\nscreens:\n  - id: a\n    widgets:\n"
                        "      - {type: stat, entity: sensor.outdoor_temperature}\n"
                        "      - {type: stat, entity: binary_sensor.front_door, label: Door}\n"
                        "      - {type: gauge, entity: sensor.phone_battery}\n"
                        "      - {type: switch, entity: switch.coffee}\n"
                        "      - {type: stat, entity: sensor.missing}\n"));
  r.step(200);
  TEST_ASSERT_TRUE(r.sig("t0").find("OUTDOOR") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t0").find(":12.3;") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t0").find("°C") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t1").find("DOOR") != std::string::npos && r.sig("t1").find(":On;") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t2").find("PHONE") != std::string::npos && r.sig("t2").find(":100;") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t3").find("Coffee") != std::string::npos && r.sig("t3").find(":Off;") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t4").find(":—;") != std::string::npos);
  r.snap("generic_entities");
  // tap the switch → switch.toggle, optimistic On
  Rect sw = r.app.regionRects()["t3"];
  r.tap(sw.x + sw.w / 2, sw.y + sw.h / 2);
  TEST_ASSERT_EQUAL_INT(1, int(r.s.calls.size()));
  TEST_ASSERT_EQUAL_STRING("switch", r.s.calls[0].domain.c_str());
  TEST_ASSERT_EQUAL_STRING("toggle", r.s.calls[0].service.c_str());
  TEST_ASSERT_EQUAL_STRING("{\"entity_id\":\"switch.coffee\"}", r.s.calls[0].json.c_str());
  TEST_ASSERT_TRUE(r.sig("t3").find(":On;") != std::string::npos);
  // a known light keeps the light tile (with dimming)
  r.app.setConfig(cfgOf("version: 1\nscreens:\n  - id: a\n    widgets:\n      - {type: light, light: living_reading}\n"));
  r.step(200);
  TEST_ASSERT_TRUE(r.sig("t0").find("Reading lamp") != std::string::npos);
}

// #151: a new data source is drawn when its state lands, not a Live data interval later; the app switcher hides the
// page position; a value + unit that does not fit drops decimals first
void test_new_source_and_fit() {
  Rig r;
  r.app.setConfig(cfgOf("version: 1\nscreens:\n  - id: a\n    widgets:\n"
                        "      - {type: stat, entity: sensor.p1_energy}\n"
                        "      - {type: stat, entity: sensor.other}\n"));
  r.step(200);
  TEST_ASSERT_TRUE(r.sig("t0").find(":—;") != std::string::npos);
  r.step(1000);
  EntityValue e; e.state = "28.30"; e.attrs["friendly_name"] = "Energie"; e.attrs["unit_of_measurement"] = "kWh"; e.attrs["display_precision"] = "2";
  r.app.entities().set("sensor.p1_energy", e);
  r.step(1200);                                            // the default interval is 30 s: this is the fresh-data window
  TEST_ASSERT_TRUE_MESSAGE(r.sig("t0").find(":28.3;") != std::string::npos, "drops a decimal so kWh fits");
  TEST_ASSERT_TRUE(r.sig("t0").find(":kWh;") != std::string::npos);
  TEST_ASSERT_EQUAL_STRING("28.30 kWh", r.app.tileValues("a")[0].c_str());   // the Values view keeps HA's precision
  // after the window: back to the interval
  r.step(16000);
  r.setNum("sensor.p1_energy", "29.10");
  r.step(1200);
  TEST_ASSERT_TRUE(r.sig("t0").find(":28.3;") != std::string::npos);
  // #162: a price keeps 2 significant digits ("0.3" before), the size steps down instead
  EntityValue p; p.state = "0.2534"; p.attrs["unit_of_measurement"] = "€/kWh"; p.attrs["display_precision"] = "4";
  r.app.entities().set("sensor.other", p);
  r.step(31000);                                           // after the fresh-data window: the Live data interval
  TEST_ASSERT_TRUE_MESSAGE(r.sig("t1").find(":0.25") != std::string::npos, r.sig("t1").c_str());
  TEST_ASSERT_TRUE(r.sig("t1").find(":€/kWh;") != std::string::npos);
  // the app switcher: no "1 / 1" from the page behind it
  r.key(Key::Home); if (!r.has("menu")) r.key(Key::Home);
  TEST_ASSERT_TRUE(r.barHas("All apps"));
  TEST_ASSERT_FALSE(r.barHas(" / "));
}

// issue #80: labels are free text (spaces, %, accents); a long one is cut with … inside the tile
static std::string labelText(const std::string& sig, int nth = 0) {   // text of the nth "T…:<text>;" op
  size_t t = sig.find('T');
  for (int k = 0; k < nth && t != std::string::npos; ++k) t = sig.find('T', sig.find(';', t));
  size_t a = sig.find(':', t), b = sig.find(';', a);
  return t == std::string::npos || a == std::string::npos || b == std::string::npos ? std::string() : sig.substr(a + 1, b - a - 1);
}

void test_free_text_labels() {
  Rig r;
  r.app.setConfig(cfgOf("version: 1\nscreens:\n  - id: a\n    title: Energie & café 100%\n    widgets:\n"
                        "      - {type: stat, entity: sensor.phone_battery, label: Batterij %}\n"
                        "      - {type: gauge, entity: sensor.phone_battery, label: Température salle de bains étage}\n"));
  r.step(200);
  TEST_ASSERT_EQUAL_STRING("BATTERIJ %", labelText(r.sig("t0")).c_str());
  // #199: a long label wraps to two B20 lines; the second is cut with …
  TEST_ASSERT_EQUAL_INT(0, int(labelText(r.sig("t1")).find("TEMPÉRATURE")));   // Latin-1 upper-cased like CSS
  std::string cut = labelText(r.sig("t1"), 1);
  TEST_ASSERT_TRUE(cut.size() > 3 && cut.compare(cut.size() - 3, 3, "…") == 0);
  Rect t1 = r.app.regionRects()["t1"];
  TEST_ASSERT_TRUE(Canvas().textWidth(cut, Font{20, FontWeight::Bold}) <= t1.w - 28);
  TEST_ASSERT_TRUE(r.barHas("Energie & café 100%") || r.barHas("ENERGIE & CAFÉ 100%"));
  r.snap("free_text_labels");
  TEST_ASSERT_EQUAL_STRING("ÀÉÎÕÜÞ÷ßÿ ÉTÉ", utf8Upper("àéîõüþ÷ßÿ été").c_str());
}

void test_custom_apps_menu() {
  Rig r;
  r.app.setConfig(cfgOf("version: 1\napps:\n  - id: garden\n    title: Garden\n  - id: home\n    title: Home\n  - id: empty\n    title: Empty\n"
                        "screens:\n  - id: g\n    title: Plants\n    widgets:\n      - {type: clock}\n"
                        "  - id: h\n    app: home\n    title: Main\n    widgets:\n      - {type: price}\n"));
  r.step(200);
  TEST_ASSERT_TRUE(r.barHas("GARDEN") || r.barHas("Garden"));
  r.key(Key::Home);                       // first screen of the first app → app switcher
  if (!r.has("menu")) r.key(Key::Home);
  TEST_ASSERT_TRUE(r.has("menu"));
  std::string m = r.sig("menu");
  TEST_ASSERT_TRUE(m.find("Garden") != std::string::npos);
  TEST_ASSERT_TRUE(m.find("Empty") != std::string::npos);
  TEST_ASSERT_TRUE(m.find("0 pages") != std::string::npos);
  TEST_ASSERT_TRUE(m.find("Garden") < m.find("Home") && m.find("Home") < m.find("Empty"));
  r.snap("custom_apps_menu");
  r.tap(14 + 2 * 196 + 92, 100 + 66);     // empty app: nothing to open, no crash
  r.tap(14 + 1 * 196 + 92, 100 + 66);     // Home
  TEST_ASSERT_TRUE(r.barHas("Main"));
}

// ---- offline: last values kept, offline icon, commands not sent ----
void test_offline_keeps_values() {
  Rig r;
  r.s.st.ha = HaState::Offline; r.step(50);
  TEST_ASSERT_TRUE(r.sig("bar").find("I1,") != std::string::npos);   // offline icon
  TEST_ASSERT_TRUE(r.sig("t1").find("0.18") != std::string::npos);    // last known values stay
  r.openApp(1); r.key(Key::Prev);
  Rect row = r.app.regionRects()["z:living"];
  r.tap(row.x + row.w - 23, row.y + row.h / 2);
  r.step(2000);
  TEST_ASSERT_EQUAL_INT(0, int(r.s.calls.size()));
}

// ---- Settings › Wi-Fi "Disconnect", Settings › HA "Reconnect" / "Unlink" reach Services ----
void test_settings_wifi_ha_buttons() {
  Rig r;
  r.openApp(2); r.key(Key::Next); r.key(Key::Next); r.key(Key::Next); r.key(Key::Next);
  TEST_ASSERT_TRUE(r.sig("t0").find("Disconnect") != std::string::npos);
  Rect t = r.app.regionRects()["t0"];
  r.tap(t.x + 16 + 40, t.y + t.h - 14 - 48 - 8 - 22);
  TEST_ASSERT_EQUAL_INT(1, r.s.disconnects);
  TEST_ASSERT_TRUE(r.sig("t0").find("Disconnect") == std::string::npos);   // not connected any more
  r.s.linked(); r.step(50);
  r.key(Key::Next);
  TEST_ASSERT_TRUE(r.sig("t0").find("Reconnect") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t0").find("Unlink") != std::string::npos);
  t = r.app.regionRects()["t0"];
  int bw = (290 - 32 - 8) / 2, by = t.y + t.h - 14 - 48 - 8 - 22;
  r.tap(t.x + 16 + bw / 2, by);
  TEST_ASSERT_EQUAL_INT(1, r.s.haReconnects);
  r.tap(t.x + 16 + bw + 8 + bw / 2, by);
  TEST_ASSERT_EQUAL_INT(1, r.s.haUnlinks);
  TEST_ASSERT_TRUE(r.sig("t0").find("Unlink") == std::string::npos);
}


// ---- display styles: a style / typeface / surface change is exactly one full refresh; then partials as before ----
static DisplaySettings sleekSet(const char* tf = "archivo") { DisplaySettings ds = fast(); ds.style = "sleek"; ds.typeface = tf; return ds; }

void test_style_switch_one_full_refresh() {
  Rig r(true, 13, 0, 10, fast());
  TEST_ASSERT_EQUAL_INT(58, r.app.regionRects()["bar"].h);
  r.d.clear();
  DisplaySettings ds = r.app.settings(); ds.style = "sleek";
  r.app.setSettings(ds);                                  // PUT /settings path
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls()); TEST_ASSERT_EQUAL_INT(0, r.d.partials());
  TEST_ASSERT_EQUAL_INT(64, r.app.regionRects()["bar"].h);   // Sleek top bar, no rule
  TEST_ASSERT_EQUAL_INT(66, r.app.regionRects()["t0"].y);    // Sleek grid: padding 2 / 14, gap 10
  TEST_ASSERT_EQUAL_INT(186, r.app.regionRects()["t1"].w);
  TEST_ASSERT_TRUE(r.app.log().back().find("clean refresh (style)") != std::string::npos);
  r.step(2000);
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls()); TEST_ASSERT_EQUAL_INT(0, r.d.partials());   // and nothing after it
  // partial refresh works as before: one stat changes → one region
  r.setNum("sensor.grid_power", "-900");
  r.step(5100);
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls()); TEST_ASSERT_EQUAL_INT(1, r.d.partials());
  TEST_ASSERT_TRUE(r.app.log().back().find("1 region") != std::string::npos);
  // on the device: Settings › Display style, typeface + and card surface + (each one full refresh, no partial)
  r.openApp(2); r.key(Key::Next);
  TEST_ASSERT_TRUE(r.barHas("Display style"));
  TEST_ASSERT_TRUE(r.sig("t0").find(":Sleek;") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t1").find(":Archivo;") != std::string::npos);
  int surfaces = 0;
  for (auto& kv : r.app.regionSignatures()) if (kv.second.find("S") != std::string::npos) ++surfaces;
  TEST_ASSERT_TRUE(surfaces >= 3);
  r.d.clear();
  Rect t1 = r.app.regionRects()["t1"];
  r.tap(t1.x + t1.w - 30, t1.y + t1.h - 40);              // typeface +
  TEST_ASSERT_EQUAL_STRING("bricolage", r.app.settings().typeface.c_str());
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls()); TEST_ASSERT_EQUAL_INT(0, r.d.partials());
  TEST_ASSERT_TRUE(r.sig("t1").find(":Bricolage;") != std::string::npos);
  r.d.clear();
  Rect t2 = r.app.regionRects()["t2"];   // (typeface spans two cells)
  r.tap(t2.x + t2.w - 30, t2.y + t2.h - 40);              // surface +
  TEST_ASSERT_EQUAL_STRING("dots", r.app.settings().surface.c_str());
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls()); TEST_ASSERT_EQUAL_INT(0, r.d.partials());
  r.d.clear();
  Rect t0 = r.app.regionRects()["t0"];
  r.tap(t0.x + 30, t0.y + t0.h - 40);                     // style − → Classic
  TEST_ASSERT_EQUAL_STRING("classic", r.app.settings().style.c_str());
  TEST_ASSERT_EQUAL_INT(1, r.d.fulls()); TEST_ASSERT_EQUAL_INT(0, r.d.partials());
  TEST_ASSERT_EQUAL_INT(58, r.app.regionRects()["bar"].h);
  r.d.clear();
  r.tap(t0.x + 30, t0.y + t0.h - 40);                     // already Classic: no change, no refresh
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls()); TEST_ASSERT_EQUAL_INT(0, r.d.partials());
  r.snap("settings_style");
}

// ---- display styles: the same data change redraws the same set of regions in Classic and in Sleek ----
static std::vector<std::string> changedBy(Rig& r, const std::function<void()>& change, uint32_t ms) {
  auto before = r.app.regionSignatures();
  auto rb = r.app.regionRects();
  change();
  r.step(ms);
  auto after = r.app.regionSignatures();
  auto ra = r.app.regionRects();
  std::vector<std::string> keys;
  for (auto& kv : after) {
    auto it = before.find(kv.first);
    if (it == before.end() || it->second != kv.second) keys.push_back(kv.first);
  }
  for (auto& kv : before) if (!after.count(kv.first)) keys.push_back("-" + kv.first);
  (void)rb; (void)ra;
  return keys;
}
static std::string join(const std::vector<std::string>& v) { std::string s; for (auto& k : v) s += k + " "; return s; }

void test_style_region_parity() {
  struct Step { const char* what; std::function<void(Rig&)> fn; uint32_t ms; };
  std::vector<Step> home = {
      {"grid power", [](Rig& r) { r.setNum("sensor.grid_power", "-900"); }, 5100},
      {"inside temperature", [](Rig& r) { r.setNum("sensor.living_temperature", "21.3"); }, 5100},
      {"battery soc", [](Rig& r) { r.setNum("sensor.home_battery_soc", "65"); }, 5100},
      {"minute tick", [](Rig&) {}, 60000},
  };
  for (const char* tf : {"archivo", "bricolage", "fraunces", "geist"}) {
    Rig c(true, 13, 0, 10, fast()), s(true, 13, 0, 10, sleekSet(tf));
    for (auto& st : home) {
      auto kc = changedBy(c, [&] { st.fn(c); }, st.ms), ks = changedBy(s, [&] { st.fn(s); }, st.ms);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(join(kc).c_str(), join(ks).c_str(), st.what);
      TEST_ASSERT_FALSE_MESSAGE(kc.empty(), st.what);
    }
    // House › Lights: a light switched in HA; House › Heating: one room's temperature and setpoint (+ on the device)
    c.openApp(1); s.openApp(1);
    auto light = [](Rig& r) { auto e = *r.app.entities().get("light.living_ceiling"); e.state = "off"; r.app.entities().set("light.living_ceiling", e); };
    auto kc = changedBy(c, [&] { light(c); }, 5100), ks = changedBy(s, [&] { light(s); }, 5100);
    TEST_ASSERT_EQUAL_STRING(join(kc).c_str(), join(ks).c_str());
    TEST_ASSERT_TRUE(join(kc).find("l:living_ceiling") != std::string::npos);
    c.key(Key::Prev); s.key(Key::Prev);
    TEST_ASSERT_TRUE(c.barHas("Heating")); TEST_ASSERT_TRUE(s.barHas("Heating"));
    auto room = [](Rig& r) { auto e = *r.app.entities().get("climate.kitchen"); e.attrs["current_temperature"] = "20.3"; r.app.entities().set("climate.kitchen", e); };
    kc = changedBy(c, [&] { room(c); }, 5100); ks = changedBy(s, [&] { room(s); }, 5100);
    TEST_ASSERT_EQUAL_STRING("z:kitchen ", join(kc).c_str());
    TEST_ASSERT_EQUAL_STRING("z:kitchen ", join(ks).c_str());
    // tap + on the kitchen row/card (different rects per style, same key)
    auto plus = [](Rig& r) {
      Rect z = r.app.regionRects()["z:kitchen"];
      if (r.app.settings().style == "sleek") r.tap(z.x + z.w - 30, z.y + z.h - 30);
      else r.tap(z.x + z.w - 23, z.y + z.h / 2);
    };
    kc = changedBy(c, [&] { plus(c); }, 100); ks = changedBy(s, [&] { plus(s); }, 100);
    TEST_ASSERT_EQUAL_STRING(join(kc).c_str(), join(ks).c_str());
    TEST_ASSERT_TRUE(join(kc).find("z:kitchen") != std::string::npos);
  }
  // The one documented exception (DEVIATIONS.md): on the hour, Sleek also redraws stat cards with spark bars
  // (the "now" bar moves) — Classic shows no hourly bars on stat tiles.
  Rig c(true, 13, 59, 10, fast()), s(true, 13, 59, 10, sleekSet());
  auto kc = changedBy(c, [] {}, 60000), ks = changedBy(s, [] {}, 60000);
  for (auto& k : kc) TEST_ASSERT_TRUE_MESSAGE(join(ks).find(k + " ") != std::string::npos, k.c_str());
  for (auto& k : ks) {
    bool extra = join(kc).find(k + " ") == std::string::npos;
    if (extra) TEST_ASSERT_TRUE_MESSAGE(k == "t3" || k == "t4", k.c_str());   // Solar, Home use (spark bars)
  }
}

// ---- display styles: every Sleek font a painter asks for exists at exactly that size (no silent nearest-size) ----
void test_sleek_fonts_exact() {
  for (Typeface tf : {Typeface::Archivo, Typeface::Bricolage, Typeface::Fraunces, Typeface::Geist}) {
    Look l; l.sleek = true; l.typeface = tf;
    setActiveLook(l);
    auto need = [&](Font f) {
      char msg[64]; std::snprintf(msg, sizeof msg, "face %d weight %d size %d", int(f.face), int(f.weight), int(f.size));
      TEST_ASSERT_NOT_NULL_MESSAGE(findFontExact(f.face, f.weight, f.size), msg);
    };
    for (int t : {62, 56, 48, 40, 104, 150, 58, 34, 38, 30, 27, 24, 22, 20, 18}) need(D(t));
    for (int p : {20, 24}) need(DS(p));
    for (int p : {12, 13, 14, 15, 16}) need(T7(p));
    for (int p : {13, 14, 15, 16, 17}) need(T6(p));
    for (int p : {12, 13, 14}) need(T4(p));
    // Classic B()/R() on the Classic-layout screens resolve to the Sleek text face
    TEST_ASSERT_EQUAL_INT(int(textFace(tf)), int(resolveFont(B(16))->face));
    TEST_ASSERT_EQUAL_INT(int(Face::Classic), int(resolveFont(M(13))->face));
  }
  setActiveLook(Look());
  TEST_ASSERT_EQUAL_INT(int(Face::Classic), int(resolveFont(B(16))->face));
}

// ---- price chart (#260): today's low / high with times under the Classic bars ----
void test_price_chart_low_high() {
  Rig r;
  r.key(Key::Next);
  TEST_ASSERT_TRUE(r.barHas("Energy prices"));
  TEST_ASSERT_TRUE(r.sig("t4").find("Low 0.18 · 13:00") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t4").find("High 0.38 · 18:00") != std::string::npos);
}

// ---- display styles: Sleek renders every default page (render.sh writes the PNGs) and keeps the touch targets ----
void test_sleek_pages_and_targets() {
  Rig r(true, 13, 0, 10, sleekSet());
  TEST_ASSERT_TRUE(r.sig("t0").find("B") == 0);            // clock card: black box first
  r.snap("sleek_home");
  r.tap(800 - 12 - 26, 32);                                 // Next (INK circle in the pager capsule)
  TEST_ASSERT_TRUE(r.barHas("Energy prices"));
  TEST_ASSERT_TRUE(r.sig("t4").find("Low 0.18 · 13:00") != std::string::npos);    // price chart low / high (#260)
  TEST_ASSERT_TRUE(r.sig("t4").find("High 0.38 · 18:00") != std::string::npos);
  r.tap(130, 32);                                           // app + page title → app switcher
  TEST_ASSERT_TRUE(r.has("menu"));
  r.key(Key::Home);
  r.openApp(1);
  TEST_ASSERT_TRUE(r.barHas("Lights"));
  Rect cap = r.app.regionRects()["l:living_ceiling"];
  r.tap(cap.x + 40, cap.y + cap.h / 2);                     // capsule toggles
  TEST_ASSERT_FALSE(r.s.calls.empty());
  TEST_ASSERT_EQUAL_STRING("turn_off", r.s.calls.back().service.c_str());
  TEST_ASSERT_TRUE(r.s.calls.back().json.find("light.living_ceiling") != std::string::npos);
  r.snap("sleek_lights");
}

// ---- reconnect: values that land right after auth_ok are drawn within ~2 s, not after a full Live data interval ----
void test_first_data_after_connect() {
  Rig r;
  r.s.st.ha = HaState::Offline; r.step(50);
  r.app.entities().clear();
  r.step(31000);                                            // past one interval: drawn without data
  TEST_ASSERT_TRUE(r.sig("t1").find("CHEAP") == std::string::npos);
  r.s.st.ha = HaState::Connected; r.step(50);               // auth_ok …
  demo::load(r.app.entities(), 13, 0); r.step(100);         // … subscribe_entities snapshot a moment later
  TEST_ASSERT_TRUE(r.sig("t1").find("CHEAP") == std::string::npos);
  r.step(2000);
  TEST_ASSERT_TRUE(r.sig("t1").find("CHEAP") != std::string::npos);
}

// ---- issue #38: the minute tick redraws only the clock windows; the partial stays well under half the panel ----
static double lastPartialShare(Rig& r) {
  for (auto it = r.d.events.rbegin(); it != r.d.events.rend(); ++it)
    if (!it->full) return double(it->r.w) * it->r.h / (kScreenW * kScreenH);
  return -1;
}
void test_minute_tick_window() {
  for (bool sl : {false, true}) {
    Rig r(true, 13, 0, 10, sl ? sleekSet() : fast());
    auto before = r.app.regionSignatures();
    r.step(58300);                                          // 13:01:00.1, just before ambient (60 s after boot)
    auto after = r.app.regionSignatures();
    std::string changed;
    for (auto& kv : after) if (before[kv.first] != kv.second) changed += kv.first + " ";
    TEST_ASSERT_EQUAL_STRING("k0 time ", changed.c_str());   // was: bar t0 (800 × 263 = 55 % → whole frame)
    double share = lastPartialShare(r);
    const Rect& w = r.d.events.back().r;
    char msg[64]; std::snprintf(msg, sizeof msg, "%s minute window %d,%d %dx%d = %.0f %%", sl ? "sleek" : "classic", w.x, w.y, w.w, w.h, share * 100);
    TEST_MESSAGE(msg);
    TEST_ASSERT_TRUE_MESSAGE(share > 0 && share < (sl ? 0.40 : 0.30), msg);
  }
  Rig n(true, 23, 30);   // night face: only the big clock
  n.d.clear();
  n.step(60000);
  double share = lastPartialShare(n);
  TEST_ASSERT_TRUE(share > 0 && share < 0.25);
}

// ---- issue #220: front light timeout — off after N s without input; the first key/tap only turns it back on ----
void test_light_timeout() {
  DisplaySettings ds = fast(); ds.brightness = 50; ds.lightTimeout = 30; ds.returnHome = "never";
  Rig r(true, 13, 0, 10, ds);
  TEST_ASSERT_EQUAL_INT(50, r.b.light);
  r.step(27000);
  TEST_ASSERT_EQUAL_INT(50, r.b.light);
  r.setNum("sensor.home_power", "2100");
  r.step(2000);                                            // 30 s idle → off; the brightness setting stays
  TEST_ASSERT_EQUAL_INT(0, r.b.light);
  r.setNum("sensor.home_power", "2200");                   // an HA update never wakes it
  r.step(1000);
  TEST_ASSERT_EQUAL_INT(0, r.b.light);
  r.d.clear();
  std::string t0 = r.sig("t0");
  r.key(Key::Next);                                        // consumed: light on, same page, no redraw
  TEST_ASSERT_EQUAL_INT(50, r.b.light);
  TEST_ASSERT_EQUAL_STRING(t0.c_str(), r.sig("t0").c_str());
  TEST_ASSERT_EQUAL_INT(0, r.d.fulls() + r.d.fasts());
  r.key(Key::Next);                                        // the second key turns the page
  TEST_ASSERT_EQUAL_INT(1, r.d.fasts());
  // a tap is consumed the same way: no app switcher
  r.step(31000);
  TEST_ASSERT_EQUAL_INT(0, r.b.light);
  r.tap(130, 32);
  TEST_ASSERT_FALSE(r.has("menu"));
  TEST_ASSERT_EQUAL_INT(50, r.b.light);
  // Power is not consumed: straight to standby, light stays off
  r.step(31000);
  r.key(Key::Power);
  TEST_ASSERT_TRUE(r.has("standby"));
  TEST_ASSERT_EQUAL_INT(0, r.b.light);
  // Never: the light stays on
  DisplaySettings nv = ds; nv.lightTimeout = 0;
  Rig q(true, 13, 0, 10, nv);
  q.step(400000);
  TEST_ASSERT_EQUAL_INT(50, q.b.light);
  // brightness 0: nothing to wake, the first key acts
  DisplaySettings dk = ds; dk.brightness = 0;
  Rig k(true, 13, 0, 10, dk);
  k.step(31000);
  k.d.clear();
  k.key(Key::Next);
  TEST_ASSERT_EQUAL_INT(1, k.d.fasts());
}

// ---- issue #27: ambient idle mode — 60 s without input hides pager, battery, app label; first input only restores ----
void test_ambient_idle() {
  for (bool sl : {false, true}) {
    Rig r(true, 13, 0, 10, sl ? sleekSet() : fast());
    std::string bar = r.sig("bar");
    TEST_ASSERT_TRUE(r.has("time"));
    r.d.clear();
    r.step(57000);
    TEST_ASSERT_EQUAL_STRING(bar.c_str(), r.sig("bar").c_str());
    r.step(2000);                                           // 60 s idle → ambient: one partial, the top bar only
    TEST_ASSERT_TRUE(r.sig("bar") != bar);
    TEST_ASSERT_FALSE(r.has("time"));                       // Home has a clock tile
    TEST_ASSERT_EQUAL_INT(0, r.d.fulls());                  // 13:01 minute tick + the ambient partial
    Rect w = r.d.events.back().r;
    TEST_ASSERT_TRUE(w.y == 0 && w.h <= (sl ? kSleekBarH : kTopBarH + kTopRule));
    TEST_ASSERT_TRUE(r.sig("bar").find(":Home;") != std::string::npos);    // page title stays
    TEST_ASSERT_TRUE(r.sig("bar").find(":1 / 4;") == std::string::npos);
    r.snap(sl ? "sleek_ambient_home" : "ambient_home");
    // a status icon stays (information, not chrome)
    r.s.st.ha = HaState::Offline; r.step(1100);
    std::string off = r.sig("bar");
    TEST_ASSERT_TRUE(off != bar);
    // first key: chrome back, same page, no full refresh
    r.d.clear();
    r.key(Key::Next);
    TEST_ASSERT_TRUE(r.has("time"));
    TEST_ASSERT_TRUE(r.sig("bar").find(":Home;") != std::string::npos);
    if (!sl) TEST_ASSERT_TRUE(r.barHas(":1 / 4;"));
    TEST_ASSERT_EQUAL_INT(0, r.d.fulls());
    std::string t0 = r.sig("t0");
    r.key(Key::Next);                                       // second key turns the page
    TEST_ASSERT_EQUAL_INT(1, r.d.fasts());
    TEST_ASSERT_TRUE(r.sig("t0") != t0);
    // a tap is consumed the same way: no app switcher
    r.step(61000);
    r.tap(130, 32);
    TEST_ASSERT_FALSE(r.has("menu"));
    r.tap(130, 32);
    TEST_ASSERT_TRUE(r.has("menu"));
    r.step(120000);                                         // never ambient with a menu open (returnHome closes it at 5 min)
    TEST_ASSERT_TRUE(r.has("menu"));
  }
  // a page without a clock tile keeps the bar clock; a low battery keeps the battery
  Rig r(true, 13, 0, 10, fast());
  r.b.battery = 12;
  r.openApp(1);                                             // Lights
  r.step(61000);
  TEST_ASSERT_TRUE(r.has("time"));
  TEST_ASSERT_TRUE(r.barHas(":12%;"));
  r.snap("ambient_lights_lowbatt");
  // Power is not consumed: straight to standby
  r.key(Key::Power);
  TEST_ASSERT_TRUE(r.has("standby"));
}

// ---- issue #27: night face as a poster; "as of HH:MM" only when the data was stale at night start ----
void test_night_poster() {
  Rig fresh(true, 22, 59);
  fresh.s.st.haLastDataEpoch = fresh.b.epochSeconds() - 60;
  fresh.step(61000);
  TEST_ASSERT_TRUE(fresh.has("night"));
  std::string n = fresh.sig("night");
  TEST_ASSERT_TRUE(n.find("Night mode") == std::string::npos);
  TEST_ASSERT_TRUE(n.find("tap anywhere") == std::string::npos);
  TEST_ASSERT_TRUE(n.find("as of") == std::string::npos);
  TEST_ASSERT_TRUE(n.find("Inside") != std::string::npos && n.find("Cheapest") != std::string::npos);
  Rig stale(true, 22, 59);
  stale.s.st.haLastDataEpoch = stale.b.epochSeconds() - 45 * 60;   // 22:14
  stale.step(61000);
  TEST_ASSERT_TRUE(stale.sig("night").find("as of 22:14") != std::string::npos);
  stale.snap("night_stale");
}

// ---- #145: user routes. Title = label, else HA's name; an old catalog route asks for a sensor; a gap is #86's ----
void test_user_routes() {
  Rig r;
  const char* y = "version: 1\nscreens:\n  - id: travel\n    app: travel\n    title: Travel\n    widgets:\n"
                  "      - {type: route, label: To work, entity: sensor.demo_train, cs: 2}\n"
                  "      - {type: route, route: renkum_arn, cs: 2}\n"
                  "      - {type: route, mode: car, entity: sensor.drive_gone, cs: 2}\n"
                  "      - {type: route, mode: bus, entity: sensor.demo_bus, cs: 2}\n";
  ParseResult p = parseYamlText(y);
  TEST_ASSERT_TRUE(p.ok);
  EntityValue gone; gone.state = "unavailable"; gone.attrs["friendly_name"] = "Drive";
  r.app.entities().set("sensor.drive_gone", gone);
  r.app.setConfig(p.config); r.step(200);
  TEST_ASSERT_TRUE(r.sig("t0").find("To work") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t0").find("On time") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t1").find("Pick a sensor for this route") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t1").find("Route") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t2").find("Drive") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t2").find("navailable") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t3").find("4 per hour") != std::string::npos);
  r.snap("user_routes");
}

// ---- issue #38: everything a partial refresh can redraw is black/white (boot face + Sleek card surface exempt) ----
void test_bw_only_lint() {
  auto pages = [](Rig& r, const char* look) {
    auto check = [&](const char* where) {
      Canvas::grayPuts = 0;
      r.app.requestFullRefresh();
      r.step(50);
      std::string m = std::string(look) + " " + where;
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(0, Canvas::grayPuts, m.c_str());
    };
    check("home"); for (int k = 0; k < 3; ++k) { r.key(Key::Next); check("home app page"); }
    r.openApp(1); check("lights"); for (int k = 0; k < 3; ++k) { r.key(Key::Next); check("house app page"); }
    r.openApp(2); check("settings"); for (int k = 0; k < 5; ++k) { r.key(Key::Next); check("settings page"); }
    r.key(Key::Home); check("app switcher");
    r.app.setConfig(parseYamlText(demo::travelYaml()).config); r.step(50); check("travel");   // user routes (#145)
  };
  DisplaySettings dots = sleekSet(); dots.surface = "dots";
  { Rig r(true, 13, 0, 10, fast()); pages(r, "classic"); }
  { Rig r(true, 13, 0, 10, dots); pages(r, "sleek"); }
  for (DisplaySettings ds : {fast(), dots}) {
    { Rig r(true, 23, 30, 10, ds); Canvas::grayPuts = 0; r.app.requestFullRefresh(); r.step(60000);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(0, Canvas::grayPuts, "night"); }
    { Rig r(true, 13, 0, 10, ds); r.step(61000); Canvas::grayPuts = 0; r.app.requestFullRefresh(); r.step(50);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(0, Canvas::grayPuts, "ambient"); }
    { Rig r(true, 13, 0, 10, ds); r.key(Key::Power); Canvas::grayPuts = 0; r.app.requestFullRefresh(); r.step(60000);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(0, Canvas::grayPuts, "standby"); }
    { Rig r(false, 13, 0, 10, ds); Canvas::grayPuts = 0; r.app.requestFullRefresh(); r.step(50);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(0, Canvas::grayPuts, "first install"); }
    { Rig r(true, 13, 0, 10, ds); r.s.st.ota = OtaState::Downloading; r.s.st.otaProgressPct = 40; Canvas::grayPuts = 0; r.step(200);
      r.app.requestFullRefresh(); r.step(50); TEST_ASSERT_EQUAL_UINT32_MESSAGE(0, Canvas::grayPuts, "ota"); }
  }
  // the boot face may stay gray (full refresh only): proves the counter sees gray
  Canvas::grayPuts = 0;
  Rig b(true);
  TEST_ASSERT_TRUE(Canvas::grayPuts > 0);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_never_linked_ghosts);
  RUN_TEST(test_pager_counts_and_long_lists);
  RUN_TEST(test_no_visible_change_no_refresh);
  RUN_TEST(test_one_changed_row_only);
  RUN_TEST(test_five_taps_one_call);
  RUN_TEST(test_night_mode_and_peek);
  RUN_TEST(test_full_every_and_screen_change);
  RUN_TEST(test_nav_fast_every_tenth_clean);
  RUN_TEST(test_tap_after_page_change_registers);
  RUN_TEST(test_taps_during_refresh_one_navigation);
  RUN_TEST(test_press_feedback_folded_into_the_action);
  RUN_TEST(test_no_clean_at_night);
  RUN_TEST(test_home_key_and_idle);
  RUN_TEST(test_first_install_flow);
  RUN_TEST(test_configured_boot_no_setup);
  RUN_TEST(test_glance_hooks);
  RUN_TEST(test_ota_screen);
  RUN_TEST(test_ota_long_version);
  RUN_TEST(test_ota_upload_version_line);
  RUN_TEST(test_ota_check_feedback);
  RUN_TEST(test_ota_checks_off);
  RUN_TEST(test_light_toggle);
  RUN_TEST(test_generic_entities);
  RUN_TEST(test_new_source_and_fit);
  RUN_TEST(test_free_text_labels);
  RUN_TEST(test_custom_apps_menu);
  RUN_TEST(test_offline_keeps_values);
  RUN_TEST(test_tile_values);
  RUN_TEST(test_render_screen_offscreen);
  RUN_TEST(test_history_tile_placeholder);
  RUN_TEST(test_settings_wifi_ha_buttons);
  RUN_TEST(test_first_data_after_connect);
  RUN_TEST(test_style_switch_one_full_refresh);
  RUN_TEST(test_style_region_parity);
  RUN_TEST(test_sleek_fonts_exact);
  RUN_TEST(test_price_chart_low_high);
  RUN_TEST(test_sleek_pages_and_targets);
  RUN_TEST(test_minute_tick_window);
  RUN_TEST(test_ambient_idle);
  RUN_TEST(test_light_timeout);
  RUN_TEST(test_night_poster);
  RUN_TEST(test_bw_only_lint);
  RUN_TEST(test_user_routes);
  RUN_TEST(test_key_factory_reset);
  RUN_TEST(test_key_restart);
  RUN_TEST(test_power_hold_off);
  RUN_TEST(test_power_short_press_and_boot_hold);
  RUN_TEST(test_language_from_ha);
  RUN_TEST(test_settings_built_in);
  RUN_TEST(test_power_stages);
  return UNITY_END();
}
