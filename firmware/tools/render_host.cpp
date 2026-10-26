// Host renderer: drives the real App (src/core + src/app) with fakes and writes PNG snapshots of every default screen
// and state to firmware/test/out/. Build + run: tools/render.sh
// Classic: <name>.png. Sleek (display styles): sleek_<typeface>_<name>.png for every default page in each of the four
// typefaces, plus for Home the "dots" card surface. Every default page also gets *_bw.png: the whole frame thresholded
// the way hw/x4_display.h does for a partial refresh (dark gray → black, light gray → white), i.e. the worst case after
// a ≥ 50 % partial (sub-page turn). Issue #38: these must read the same as the gray frames.
#include <cstdlib>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>
#include <ctime>
#include "app/app.h"
#include "core/config.h"
#include "../test/support/demo.h"
#include "../test/support/fakes.h"

using namespace x4;

static std::string outDir = "test/out";
static DisplaySettings gSet;        // look of the current pass
static std::string gPrefix;         // "" (Classic) or "sleek_<typeface>_"
static std::string gLang;           // HA language of the current pass ("" = English)
static const int64_t kEpoch1300 = 1791896400;   // Tue 13 Oct 2026 13:00 UTC

struct Rig {
  fake::FakeDisplay d;
  fake::FakeBoard b;
  fake::FakeServices s;
  App app{d, b, s};
  Rig(bool linked = true, int hh = 13, int mm = 0) {
    b.epoch = kEpoch1300 + (hh - 13) * 3600 + mm * 60;
    if (linked) { s.linked(); demo::load(app.entities(), hh, mm); }
    s.st.pairingCode = "4F7K";
    s.st.language = gLang;
    app.setPressFeedback(false);
    app.begin(defaultConfig(), gSet);
    step(2000);
  }
  void step(uint32_t ms) { for (uint32_t t = 0; t < ms; t += 100) { b.now += 100; app.loop(); } app.loop(); }
  void key(Key k) { b.key(k); step(100); }
  void tap(int x, int y) { b.tap(x, y); step(100); }
  void save(const std::string& name) {
    std::string p = outDir + "/" + gPrefix + name + ".png";
    d.save(p);
    std::printf("%s\n", p.c_str());
  }
  void saveBw(const std::string& name) {   // B/W threshold of the current frame (partial refresh on this panel)
    std::vector<uint8_t> copy = d.last;
    Framebuffer t{copy.data()};
    for (size_t i = 0; i < Framebuffer::kBytes * 4; ++i) {
      int sh = 6 - 2 * int(i & 3), v = (t.data[i >> 2] >> sh) & 3;
      t.data[i >> 2] = uint8_t((t.data[i >> 2] & ~(3 << sh)) | ((v >= 2 ? 3 : 0) << sh));
    }
    std::string p = outDir + "/" + gPrefix + name + ".png";
    fake::writePng(t, p);
    std::printf("%s\n", p.c_str());
  }
  void both(const std::string& name) { save(name); saveBw(name + "_bw"); }
  void openApp(int k) {   // Home key on Home opens the app switcher
    key(Key::Home);
    tap(14 + k * 196 + 92, 100 + 66);
  }
};

static void defaultPages() {
  { Rig r; r.both("home"); r.key(Key::Next); r.both("prices"); r.key(Key::Next); r.both("energy"); r.key(Key::Next); r.both("solar"); }
  { Rig r; r.openApp(1); r.both("lights_1"); r.key(Key::Next); r.both("lights_2"); r.key(Key::Next); r.both("lights_3"); r.key(Key::Next); r.both("heating"); }
  { Rig r; r.app.setConfig(parseYamlText(demo::travelYaml()).config); r.step(2000); r.both("travel"); }   // user routes (#145)
  { Rig r; r.openApp(2); r.both("settings_display"); r.key(Key::Next); r.both("settings_style"); r.key(Key::Next); r.both("settings_power");
    r.key(Key::Next); r.both("settings_updates"); r.key(Key::Next); r.both("settings_wifi"); r.key(Key::Next); r.both("settings_ha");
    r.key(Key::Next); r.both("settings_about"); }
  // ambient idle mode (#27): 60 s without input, chrome hidden (Home drops the bar clock: it has a clock tile)
  { Rig r; r.step(61000); r.app.requestFullRefresh(); r.both("home_ambient"); }
  { Rig r; r.openApp(1); r.step(61000); r.app.requestFullRefresh(); r.both("lights_ambient"); }
}

static void sleekPasses() {
  static const char* faces[] = {"archivo", "bricolage", "fraunces", "geist"};
  for (const char* tf : faces) {
    gSet = DisplaySettings(); gSet.style = "sleek"; gSet.typeface = tf;
    gPrefix = std::string("sleek_") + tf + "_";
    defaultPages();
    { Rig r; r.key(Key::Home); r.save("app_switcher"); }
    gSet.surface = "dots";
    { Rig r; r.save("home_dots"); r.saveBw("home_dots_bw"); }
  }
  gSet = DisplaySettings(); gPrefix.clear();
}

// Dutch (#199): the longest UI strings, for text-fit checks
static void dutchPass() {
  gLang = "nl"; gPrefix = "nl_";
  defaultPages();
  { Rig r; r.key(Key::Home); r.save("app_switcher"); }
  { Rig r; r.tap(706, 28); r.save("page_overview"); }
  { Rig r(true, 23, 30); r.save("night"); }
  { Rig r; r.key(Key::Power); r.save("standby"); }
  gLang.clear(); gPrefix.clear();
}

int main(int argc, char** argv) {
  setenv("TZ", "UTC0", 1);
  tzset();
  if (argc > 1) outDir = argv[1];
  defaultPages();
  { Rig r; r.key(Key::Home); r.save("app_switcher"); }
  { Rig r; r.tap(706, 28); r.save("page_overview"); }
  { Rig r; r.s.st.ota = OtaState::Available; r.s.st.otaAvailableVersion = "0.4.0";
    r.s.st.otaNotes = {"Swipe left/right to change page", "Lights grouped by room", "Night face keeps time more accurately"};
    r.step(100); r.openApp(2); r.key(Key::Next); r.key(Key::Next); r.key(Key::Next); r.save("settings_updates_available");
    r.s.st.ota = OtaState::Downloading; r.s.st.otaProgressPct = 40; r.step(100); r.save("ota_install"); }
  { Rig r(true, 23, 30); r.both("night"); r.tap(400, 240); r.save("night_peek"); }
  { Rig r(true, 22, 59); r.s.st.haLastDataEpoch = r.b.epochSeconds() - 45 * 60; r.step(61000); r.both("night_stale"); }
  { Rig r; r.key(Key::Power); r.both("standby"); }
  { Rig r(false); r.save("first_install_step1"); r.tap(400, 72 + 2 + 10 + 48 + 27 + 54); r.save("first_install_password");
    for (char ch : std::string("secret12")) { (void)ch; }
    r.s.st.wifi = WifiState::Connected; r.s.st.ssid = "HomeNet-Guest"; r.s.st.ip = "192.168.1.42"; r.step(100); r.save("first_install_step2"); }
  { Rig r(false); r.s.st.wifi = WifiState::Connected; r.s.st.ssid = "HomeNet"; r.step(100);
    // never linked (after setup was left, e.g. unlinked): Home = clock + link card, other pages ghosts
    r.s.st.ha = HaState::NeverLinked; }
  {
    fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s;
    b.epoch = kEpoch1300; s.st.wifi = WifiState::Connected; s.st.ssid = "HomeNet"; s.st.ha = HaState::Connected; s.st.pairingCode = "4F7K";
    App app(d, b, s); app.setPressFeedback(false);
    app.begin(defaultConfig(), DisplaySettings());
    for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
    s.st.ha = HaState::NeverLinked; app.onNetStatusChanged(); app.requestFullRefresh();
    d.save(outDir + "/never_linked_home.png"); std::printf("%s/never_linked_home.png\n", outDir.c_str());
    b.key(Key::Next); b.now += 100; app.loop();
    d.save(outDir + "/never_linked_prices.png"); std::printf("%s/never_linked_prices.png\n", outDir.c_str());
  }
  { Rig r; r.b.now += 0; r.s.st.ha = HaState::NeverLinked; r.s.st.wifi = WifiState::Connected; r.step(100); r.app.requestFullRefresh(); r.save("boot_like"); }
  {
    fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); b.epoch = kEpoch1300;
    App app(d, b, s); app.begin(defaultConfig(), DisplaySettings());
    d.save(outDir + "/boot.png"); std::printf("%s/boot.png\n", outDir.c_str());
  }
  {   // widgets that are not on the default screens
    fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); b.epoch = kEpoch1300;
    App app(d, b, s); app.setPressFeedback(false);
    demo::load(app.entities(), 13, 0);
    ParseResult pr = parseConfig("version: 1\nscreens:\n  - id: favs\n    title: Favourites\n    widgets:\n"
                                 "      - {type: thermo, zone: living, rs: 2}\n      - {type: light, light: living_ceiling}\n"
                                 "      - {type: scene, scene: all_off, cs: 2}\n      - {type: light, light: hall_stairs}\n"
                                 "      - {type: thermo, zone: kitchen}\n      - {type: bars, series: solar}\n");
    app.begin(pr.config, DisplaySettings());
    for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
    d.save(outDir + "/custom_widgets.png"); std::printf("%s/custom_widgets.png\n", outDir.c_str());
  }
  gSet.style = "sleek";   // Sleek on widgets that are not on the default screens + never linked
  gPrefix = "sleek_archivo_";
  {
    fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); b.epoch = kEpoch1300;
    App app(d, b, s); app.setPressFeedback(false);
    demo::load(app.entities(), 13, 0);
    ParseResult pr = parseConfig("version: 1\nscreens:\n  - id: favs\n    title: Favourites\n    widgets:\n"
                                 "      - {type: thermo, zone: living, rs: 2}\n      - {type: light, light: living_ceiling}\n"
                                 "      - {type: scene, scene: all_off, cs: 2}\n      - {type: light, light: hall_stairs}\n"
                                 "      - {type: thermo, zone: kitchen}\n      - {type: bars, series: solar}\n");
    app.begin(pr.config, gSet);
    for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
    d.save(outDir + "/sleek_archivo_custom_widgets.png"); std::printf("%s/sleek_archivo_custom_widgets.png\n", outDir.c_str());
  }
  {
    fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s;
    b.epoch = kEpoch1300; s.st.wifi = WifiState::Connected; s.st.ssid = "HomeNet"; s.st.ha = HaState::Connected; s.st.pairingCode = "4F7K";
    App app(d, b, s); app.setPressFeedback(false);
    app.begin(defaultConfig(), gSet);
    for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
    s.st.ha = HaState::NeverLinked; app.onNetStatusChanged(); app.requestFullRefresh();
    d.save(outDir + "/sleek_archivo_never_linked_home.png"); std::printf("%s/sleek_archivo_never_linked_home.png\n", outDir.c_str());
    b.key(Key::Next); b.now += 100; app.loop();
    d.save(outDir + "/sleek_archivo_never_linked_prices.png"); std::printf("%s/sleek_archivo_never_linked_prices.png\n", outDir.c_str());
  }
  gSet = DisplaySettings(); gPrefix.clear();
  sleekPasses();
  dutchPass();
  return 0;
}
