// Host renderer: drives the real App (src/core + src/app) with fakes and writes PNG snapshots of every default screen
// and state to firmware/test/out/. Build + run: tools/render.sh
// Classic: <name>.png. Sleek (display styles): sleek_<typeface>_<name>.png for every default page in each of the four
// typefaces, plus for Home the "dots" card surface. Every default page also gets *_bw.png: the whole frame thresholded
// the way hw/x4_display.h does for a partial refresh (dark gray → black, light gray → white), i.e. the worst case after
// a ≥ 50 % partial (sub-page turn). Issue eink-ha-os#38: these must read the same as the gray frames.
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>
#include <ctime>
#include "app/app.h"
#include "core/config.h"
#include <cstring>
#include "core/agenda.h"
#include "core/history_chart.h"
#include "core/weather.h"
#include "core/json.h"
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
  { Rig r; r.app.setConfig(parseYamlText(demo::travelYaml()).config); r.step(2000); r.both("travel"); }   // user routes (eink-ha-os#145)
  { Rig r; r.openApp(2); r.both("settings_display"); r.key(Key::Next); r.both("settings_style"); r.key(Key::Next); r.both("settings_power");
    r.key(Key::Next); r.both("settings_updates"); r.key(Key::Next); r.both("settings_wifi"); r.key(Key::Next); r.both("settings_ha");
    r.key(Key::Next); r.both("settings_about"); }
  // ambient idle mode (eink-ha-os#27): 60 s without input, chrome hidden (Home drops the bar clock: it has a clock tile)
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

// Deep sleep (eink-ha-os#299): the frame a sleeping panel keeps. `render_host <dir> asleep`
static void asleepPass(const char* style, const char* prefix) {
  gSet = DisplaySettings(); gSet.style = style; if (std::string(style) == "sleek") gSet.typeface = "geist";
  gPrefix = prefix;
  { Rig r; r.app.prepareSleep(); r.app.markAsleep(true); r.save("asleep_home"); }
  { Rig r; r.openApp(1); r.step(61000); r.app.requestFullRefresh(); r.app.markAsleep(true); r.save("asleep_lights"); }
  { Rig r; r.key(Key::Power); r.app.markAsleep(true); r.save("asleep_standby"); }
  gSet = DisplaySettings(); gPrefix.clear();
}

// Nobody home (eink-ha-os#331): the sleeping glance panel while zone.home says 0. `render_host <dir> empty`
static void emptyPass(const char* prefix) {
  gSet = DisplaySettings(); gSet.emptyHouse = "zone.home"; gPrefix = prefix;
  auto put = [](Rig& r, const char* id, const char* st, const char* name, const char* dc) {
    EntityValue v; v.state = st; v.attrs["friendly_name"] = name; if (*dc) v.attrs["device_class"] = dc;
    r.app.entities().set(id, v);
  };
  { Rig r; put(r, "zone.home", "0", "Home", ""); put(r, "binary_sensor.back_door", "on", "Back door", "door");
    put(r, "binary_sensor.kitchen_window", "off", "Kitchen window", "window"); put(r, "alarm_control_panel.house", "armed_away", "House", "");
    r.step(100); r.app.prepareSleep(); r.app.markAsleep(true); r.save("nobody_home"); }
  { Rig r; put(r, "zone.home", "0", "Home", ""); r.step(100); r.app.prepareSleep(); r.app.markAsleep(true); r.save("nobody_home_inside_only"); }
  { Rig r; put(r, "zone.home", "1", "Home", ""); r.step(100); r.app.prepareSleep(); r.app.markAsleep(true); r.save("somebody_home"); }
  gSet = DisplaySettings(); gPrefix.clear();
}

// Dutch (eink-ha-os#199): the longest UI strings, for text-fit checks
static void dutchPass() {
  gLang = "nl"; gPrefix = "nl_";
  defaultPages();
  { Rig r; r.key(Key::Home); r.save("app_switcher"); }
  { Rig r; r.tap(706, 28); r.save("page_overview"); }
  { Rig r(true, 23, 30); r.save("night"); }
  { Rig r; r.key(Key::Power); r.save("standby"); }
  gLang.clear(); gPrefix.clear();
}

// History tile (eink-ha-os#270): the emulator's render.test.ts screens, with its demo curve (historyChart.ts demoHistory) fed
// through App::setHistory as the HA fetch (eink-ha-os#269) will. 26 Oct 2026 13:00 UTC, TZ UTC0.
static const int64_t kEpochHist = 1793019600;
static std::vector<hist::Point> demoHistory(const std::string& id, const std::string& unit, int64_t from, int64_t now) {
  const int64_t step = 5 * 60000;
  uint32_t seed = 0;
  for (char ch : id) seed = seed * 31 + uint8_t(ch);
  std::vector<hist::Point> out;
  for (int64_t t = from / step * step; t <= now; t += step) {
    double day = std::fmod(std::fmod(t / 86400000.0, 1) + 1, 1);
    double noise = std::fmod(std::fmod(std::sin(double(t / step) * 12.9898 + seed) * 43758.5453, 1) + 1, 1) - 0.5;
    if (day >= 140 / 1440.0 && day < 190 / 1440.0) { out.push_back({t, hist::kNone}); continue; }
    double v = unit == "°C" ? 10 + 5 * std::sin(2 * M_PI * (day - 0.375)) + 0.6 * noise
               : unit == "%" ? 70 - 18 * std::sin(2 * M_PI * (day - 0.375)) + 4 * noise
                             : std::max(0.0, 40 + 35 * std::sin(2 * M_PI * (day - 0.3)) + 15 * noise);
    out.push_back({t, std::round(v * 10) / 10});
  }
  return out;
}
static void historyPage(const std::string& name, const std::string& widgets, const DisplaySettings& set) {
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); b.epoch = kEpochHist;
  App app(d, b, s); app.setPressFeedback(false);
  auto ent = [&](const char* id, const char* name, const char* unit, const char* state, const char* dp) {
    EntityValue e; e.state = state; e.attrs["friendly_name"] = name; e.attrs["unit_of_measurement"] = unit;
    if (*dp) e.attrs["display_precision"] = dp;
    app.entities().set(id, e);
  };
  ent("sensor.outdoor_temperature", "Outdoor temperature", "°C", "11.4", "");
  ent("sensor.outdoor_humidity", "Outdoor humidity", "%", "78.4", "0");
  ent("sensor.garden_temperature", "Garden temperature", "°C", "unavailable", "");
  ent("sensor.power", "Power", "W", "412", "0");
  ParseResult pr = parseConfig("version: 1\nscreens:\n  - id: hist\n    title: History\n    widgets:\n" + widgets);
  if (!pr.ok) { std::fprintf(stderr, "history config: %s\n", pr.message.c_str()); std::exit(1); }
  app.begin(pr.config, set);
  for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
  const int64_t now = kEpochHist * 1000;
  static hist::Series ser;
  for (auto& w : pr.config.screens[0].widgets) {
    // every series of the tile (eink-ha-os#304 wave 2: band min / max, the compare window, made-up: a slow wave off today's curve)
    hist::tileSpecs(hist::specOf(w), [&](const hist::Spec& sp) {
      const EntityValue* v = app.entities().get(sp.entity);
      std::string unit = v ? std::string(v->attrs.at("unit_of_measurement")) : "";
      const int64_t at = hist::seriesNow(sp, now);
      std::vector<hist::Point> pts;
      if (v && v->state != "unavailable") pts = demoHistory(sp.entity, unit, at - sp.windowMs - sp.bucketMs, at);
      if (sp.shiftMs) for (auto& p : pts) if (hist::has(p.v)) p.v += -3 + 6 * std::sin(double(p.t) / 1.08e7);
      hist::bucketize(pts.data(), pts.size(), sp.windowMs, sp.bucketMs, sp.agg, at, 0, ser);
      app.setHistory(hist::seriesKey(sp), &ser, hist::State::Ok);
    });
  }
  app.requestFullRefresh();
  for (int i = 0; i < 5; ++i) { b.now += 100; app.loop(); }
  d.save(outDir + "/" + name + ".png"); std::printf("%s/%s.png\n", outDir.c_str(), name.c_str());
}
static void historyPages() {
  const std::string w3 = "      - {type: history, entity: sensor.outdoor_temperature, cs: 4}\n"
                         "      - {type: history, entity: sensor.outdoor_humidity, window: 6h, agg: max, cs: 2}\n"
                         "      - {type: history, entity: sensor.garden_temperature, cs: 2}\n";
  const std::string w7 = "      - {type: history, entity: sensor.outdoor_temperature, window: 7d, agg: max, cs: 4}\n"
                         "      - {type: history, entity: sensor.outdoor_temperature, window: 1h, cs: 4, label: Last hour}\n";
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  historyPage("history_classic_24h", w3, cl);
  historyPage("history_classic_7d", w7, cl);
  historyPage("sleek_geist_history_24h", w3, sk);
  historyPage("sleek_geist_history_7d", w7, sk);
}

// eink-ha-os#304: area / step / dots with a threshold, labels and the demo's nightly gap (02:20–03:10), Classic and Modern.
// Weather tile (eink-ha-os#318): weather.home with a forecast like the emulator's demo (core/weather.ts), fed through
// App::setWeather as the HA fetch does. 26 Oct 2026 13:00 UTC, TZ UTC0. `render_host <dir> weather`.
static void weatherPage(const std::string& name, const std::string& widgets, const DisplaySettings& set, const char* state = "partlycloudy",
                        bool forecast = true, const char* lang = "") {
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); s.st.language = lang; b.epoch = kEpochHist;
  App app(d, b, s); app.setPressFeedback(false);
  EntityValue e; e.state = state;
  e.attrs["friendly_name"] = "Home"; e.attrs["temperature"] = "11.4"; e.attrs["apparent_temperature"] = "9.2";
  e.attrs["wind_speed"] = "4"; e.attrs["wind_speed_unit"] = "Beaufort"; e.attrs["wind_bearing"] = "225"; e.attrs["precipitation_unit"] = "mm";
  app.entities().set("weather.home", e);
  EntityValue t; t.state = "11.4"; t.attrs["friendly_name"] = "Outdoor temperature"; t.attrs["unit_of_measurement"] = "°C";
  app.entities().set("sensor.outdoor_temperature", t);
  ParseResult pr = parseConfig("version: 1\nscreens:\n  - id: wx\n    title: Weather\n    widgets:\n" + widgets);
  if (!pr.ok) { std::fprintf(stderr, "weather config: %s\n", pr.message.c_str()); std::exit(1); }
  app.begin(pr.config, set);
  for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
  if (forecast) {
    wx::Forecast fc;
    const int64_t day0 = kEpochHist / 86400 * 86400;
    const struct { wx::Icon i; double hi, lo, mm; } D[] = {{wx::Icon::Partly, 13, 6, 0}, {wx::Icon::Cloud, 12, 7, 0.4}, {wx::Icon::Pour, 10, 6, 8},
                                                       {wx::Icon::Rain, 11, 5, 2}, {wx::Icon::Sun, 14, 4, 0}, {wx::Icon::Partly, 13, 6, 0}, {wx::Icon::Fog, 9, 3, 0.2}};
    for (int k = 0; k < wx::kDaily; ++k)
      fc.daily[k] = {uint32_t(day0 + k * 86400 + 11 * 3600), int16_t(D[k].hi * 100), int16_t(D[k].lo * 100), uint16_t(D[k].mm * 100), uint8_t(D[k].i), 0};
    fc.nDaily = wx::kDaily; fc.hasDaily = 1; fc.dailyAt = kEpochHist * 1000;
    for (int k = 0; k < wx::kHourly; ++k)
      fc.hourly[k] = {uint32_t(kEpochHist + k * 3600), int16_t(1100 - k * 25), wx::kNoT, uint16_t(k == 2 ? 30 : k == 3 ? 120 : 0), uint8_t(k == 3 ? wx::Icon::Rain : wx::Icon::Cloud), 0};
    fc.nHourly = wx::kHourly; fc.hasHourly = 1; fc.hourlyAt = kEpochHist * 1000;
    app.setWeather("weather.home", fc);
  }
  app.requestFullRefresh();
  for (int i = 0; i < 5; ++i) { b.now += 100; app.loop(); }
  d.save(outDir + "/" + name + ".png"); std::printf("%s/%s.png\n", outDir.c_str(), name.c_str());
}
static void weatherPages() {
  const std::string full = "      - {type: weather, entity: weather.home, cs: 4, rs: 2}\n";
  const std::string half = "      - {type: weather, entity: weather.home, cs: 4}\n"
                           "      - {type: clock, cs: 2}\n"
                           "      - {type: stat, entity: sensor.outdoor_temperature, cs: 2}\n";
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  weatherPage("weather_classic_full", full, cl);
  weatherPage("weather_classic_half", half, cl);
  weatherPage("weather_modern_full", full, sk);
  weatherPage("weather_modern_half", half, sk);
  weatherPage("weather_classic_full_nl", full, cl, "rainy", true, "nl");
  weatherPage("weather_modern_unavailable", full, sk, "unavailable", false);
}

static void historyStylePages() {
  const std::string p1 = "      - {type: history, entity: sensor.outdoor_temperature, style: area, threshold: 12, labels: true, cs: 4}\n"
                         "      - {type: history, entity: sensor.outdoor_humidity, style: step, agg: max, threshold: 75, labels: true, cs: 4}\n";
  const std::string p2 = "      - {type: history, entity: sensor.outdoor_temperature, style: dots, threshold: 8, labels: true, cs: 4}\n"
                         "      - {type: history, entity: sensor.outdoor_temperature, window: 6h, style: line, threshold: 14, labels: true, cs: 2}\n"
                         "      - {type: history, entity: sensor.outdoor_humidity, window: 6h, style: area, cs: 2}\n";
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  historyPage("history_styles_area_step_classic", p1, cl);
  historyPage("history_styles_dots_line_classic", p2, cl);
  historyPage("history_styles_area_step_modern", p1, sk);
  historyPage("history_styles_dots_line_modern", p2, sk);
}

// eink-ha-os#304 wave 2: band (mean over each bucket's min–max) and compare (a day / week back), Classic and Modern.
// `render_host <dir> band`.
static void historyWave2Pages() {
  const std::string p1 = "      - {type: history, entity: sensor.power, bucket: 1h, style: band, labels: true, cs: 4}\n"
                         "      - {type: history, entity: sensor.outdoor_humidity, window: 6h, style: band, compare: 1d, cs: 4}\n";
  const std::string p2 = "      - {type: history, entity: sensor.outdoor_humidity, agg: max, style: bars, compare: 1d, cs: 4}\n"
                         "      - {type: history, entity: sensor.outdoor_temperature, style: line, compare: 1d, threshold: 12, cs: 2}\n"
                         "      - {type: history, entity: sensor.outdoor_temperature, window: 6h, style: step, compare: 7d, cs: 2}\n";
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  historyPage("history_band_classic", p1, cl);
  historyPage("history_compare_classic", p2, cl);
  historyPage("history_band_modern", p1, sk);
  historyPage("history_compare_modern", p2, sk);
}

// eink-ha-os#307: rain, 1 h of a gauge (recorder) before now and 2 h of a nowcast after it, every style, Classic and Modern.
// `render_host <dir> pastfuture`. 26 Oct 2026 13:00 UTC, TZ UTC0.
static double rainAt(double m) {   // mm/h, m = minutes from now: a shower 35 min ago, the next one in about an hour
  return std::max(0.0, 1.3 * std::exp(-std::pow((m + 35) / 14, 2)) + 2.4 * std::exp(-std::pow((m - 55) / 22, 2)) +
                       0.6 * std::exp(-std::pow((m - 100) / 10, 2)) - 0.05);
}
static void pastFuturePage(const std::string& name, const std::string& widgets, const DisplaySettings& set) {
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); b.epoch = kEpochHist;
  App app(d, b, s); app.setPressFeedback(false);
  EntityValue nc; nc.state = "on"; nc.attrs["friendly_name"] = "Rain"; app.entities().set("binary_sensor.rain_expected", nc);
  EntityValue g; g.state = "0.4"; g.attrs["friendly_name"] = "Rain rate"; g.attrs["unit_of_measurement"] = "mm/h";
  app.entities().set("sensor.rain_rate", g);
  ParseResult pr = parseConfig("version: 1\nscreens:\n  - id: rain\n    title: Rain\n    widgets:\n" + widgets);
  if (!pr.ok) { std::fprintf(stderr, "pastfuture config: %s\n", pr.message.c_str()); std::exit(1); }
  app.begin(pr.config, set);
  for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
  const int64_t now = kEpochHist * 1000, step = 5 * 60000;
  static hist::Series ser;
  for (auto& w : pr.config.screens[0].widgets) {
    hist::Spec sp = hist::specOf(w), ps = hist::pastSpec(sp);
    std::vector<hist::Point> pts;
    for (int64_t t = now - ps.windowMs - ps.bucketMs; t <= now; t += step) pts.push_back({t, std::round(rainAt(double(t - now) / 60000) * 10) / 10});
    hist::bucketize(pts.data(), pts.size(), ps.windowMs, ps.bucketMs, ps.agg, now, 0, ser);
    app.setHistory(hist::seriesKey(ps), &ser, hist::State::Ok);
    std::vector<hist::Sample> sm;
    for (int64_t t = now / step * step - 2 * hist::kHour; t <= now + sp.aheadMs; t += step) sm.push_back({t, std::round(rainAt(double(t - now) / 60000) * 10) / 10});
    hist::fromSamples(sm.data(), sm.size(), sp, now, 0, ser);
    app.setHistory(hist::seriesKey(sp), &ser, hist::State::Ok);
  }
  app.requestFullRefresh();
  for (int i = 0; i < 5; ++i) { b.now += 100; app.loop(); }
  d.save(outDir + "/" + name + ".png"); std::printf("%s/%s.png\n", outDir.c_str(), name.c_str());
}
static void pastFuturePages() {
  const std::string src = "entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, past: sensor.rain_rate, window: 3h, ahead: 2h";
  const std::string p1 = "      - {type: history, " + src + ", bucket: 10m, agg: max, style: bars, label: Rain, cs: 4}\n"
                         "      - {type: history, " + src + ", bucket: 10m, style: area, label: Rain, cs: 4}\n";
  const std::string p2 = "      - {type: history, " + src + ", bucket: 15m, agg: max, style: step, label: Rain, cs: 4}\n"
                         "      - {type: history, " + src + ", bucket: 10m, style: line, label: Rain, cs: 2}\n"
                         "      - {type: history, " + src + ", bucket: 15m, agg: max, style: dots, label: Rain, cs: 2}\n";
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  pastFuturePage("pastfuture_bars_area_classic", p1, cl);
  pastFuturePage("pastfuture_step_line_dots_classic", p2, cl);
  pastFuturePage("pastfuture_bars_area_modern", p1, sk);
  pastFuturePage("pastfuture_step_line_dots_modern", p2, sk);
}

// Car route (eink-ha-os#303): cs 4 (arrival time as a second big value) above cs 2 (one line), Classic and Modern (geist).
// `render_host <dir> route`
static void routePass(const char* style, const char* prefix) {
  gSet = DisplaySettings(); gSet.style = style; if (std::string(style) == "sleek") gSet.typeface = "geist";
  gPrefix = prefix;
  const char* y = "version: 1\nscreens:\n  - id: travel\n    app: travel\n    title: Travel\n    widgets:\n"
                  "      - {type: route, label: Drive to work, mode: car, entity: sensor.demo_drive, cs: 4}\n"
                  "      - {type: route, label: Drive to work, mode: car, entity: sensor.demo_drive, cs: 2}\n"
                  "      - {type: route, label: To work, entity: sensor.demo_train, cs: 2}\n";
  { Rig r; r.app.setConfig(parseYamlText(y).config); r.step(2000); r.save("route_car"); }
  gLang = "nl"; { Rig r; r.app.setConfig(parseYamlText(y).config); r.step(2000); r.save("route_car_nl"); } gLang.clear();
  gSet = DisplaySettings(); gPrefix.clear();
}

// Bin day (eink-ha-os#317): a 2-wide tile with four bins (date and days-to sensors), 1-wide single bins, no sensors, unknown;
// at 19:05 (put out tonight) and 13:00, Classic and Modern (geist), English and Dutch. `render_host <dir> bins`
// eink-ha-os#351: now playing tiles with the volume slider (VOLUME_SET) and − / + (a player without it); 2 × 2, 2 × 1 and 4 × 2.
static void mediaPass(const char* style, const char* prefix) {
  gSet = DisplaySettings(); gSet.style = style; if (std::string(style) == "sleek") gSet.typeface = "geist";
  gPrefix = prefix;
  const char* y = "version: 1\nscreens:\n  - id: music\n    app: home\n    title: Music\n    widgets:\n"
                  "      - {type: media, entity: media_player.living_room, cs: 2, rs: 2, favorites: Radio 1=music:http://x/r1.mp3; Jazz=playlist:j; Bedtime=script.good_night}\n"
                  "      - {type: media, entity: media_player.kitchen, label: Kitchen, cs: 2}\n"
                  "      - {type: media, entity: media_player.living_room, cs: 2, favorites: A=music:1; B=music:2; C=music:3; D=music:4; E=music:5}\n"
                  "  - id: big\n    app: home\n    title: Speaker\n    widgets:\n"
                  "      - {type: media, entity: media_player.living_room, cs: 4, rs: 2, favorites: Radio 1=music:http://x/r1.mp3; Jazz=playlist:j}\n";
  auto put = [](Rig& r) {
    auto set = [&r](const char* id, const char* name, const char* title, const char* vol, const char* features) {
      EntityValue v; v.state = "playing"; v.attrs["friendly_name"] = name; v.attrs["media_title"] = title;
      v.attrs["media_artist"] = "Local station · live"; v.attrs["volume_level"] = vol; v.attrs["supported_features"] = features;
      r.app.entities().set(id, v);
    };
    set("media_player.living_room", "Living room", "Evening Radio Hour", "0.32", "152511");
    set("media_player.kitchen", "Kitchen", "So What", "0.6", "1024");
  };
  { Rig r; put(r); r.app.setConfig(parseYamlText(y).config); r.step(2000); r.save("media_slider");
    r.tap(14 + 14 + 184 + (184 * 2 + 12 - 28 - 184) * 3 / 4, 70 + 192 * 2 + 12 - 12 - 24); r.save("media_slider_75"); }
  { Rig r; put(r); r.app.setConfig(parseYamlText(y).config); r.step(2000); r.key(Key::Next); r.save("media_slider_4x2"); }
  gSet = DisplaySettings(); gPrefix.clear();
}

static void binsPass(const char* style, const char* prefix) {
  gSet = DisplaySettings(); gSet.style = style; if (std::string(style) == "sleek") gSet.typeface = "geist";
  gPrefix = prefix;
  const char* y = "version: 1\nscreens:\n  - id: bins\n    app: home\n    title: Bins\n    widgets:\n"
                  "      - {type: bins, entities: sensor.afval_papier sensor.afval_pmd sensor.waste_gft sensor.waste_restafval, "
                  "labels: sensor.afval_papier=Paper; sensor.afval_pmd=Plastic; sensor.waste_gft=Green; sensor.waste_restafval=Rest, cs: 2}\n"
                  "      - {type: bins, entities: sensor.afval_papier, labels: sensor.afval_papier=Paper}\n"
                  "      - {type: bins, entities: sensor.waste_gft sensor.waste_restafval}\n"
                  "      - {type: clock, cs: 2}\n"
                  "      - {type: bins}\n"
                  "      - {type: bins, entities: sensor.afval_glas, labels: sensor.afval_glas=Glass}\n";
  auto put = [](Rig& r) {   // Tue 13 Oct 2026 (UTC): paper tomorrow, PMD in 6 days, GFT / rest as days-to sensors
    auto set = [&r](const char* id, const char* name, const char* state, const char* daysTo) {
      EntityValue v; v.state = state; v.attrs["friendly_name"] = name; if (daysTo) v.attrs["daysTo"] = daysTo;
      r.app.entities().set(id, v);
    };
    set("sensor.afval_papier", "Afval papier", "2026-10-14", nullptr);
    set("sensor.afval_pmd", "Afval PMD", "19-10-2026", nullptr);
    set("sensor.waste_gft", "GFT", "Green in 7 days", "7");
    set("sensor.waste_restafval", "Restafval", "12", nullptr);
    set("sensor.afval_glas", "Afval glas", "unknown", nullptr);
  };
  for (int pass = 0; pass < 2; ++pass) {
    if (pass) gLang = "nl";
    const std::string sfx = pass ? "_nl" : "";
    { Rig r(true, 19, 5); put(r); r.app.setConfig(parseYamlText(y).config); r.step(2000); r.save("bins_tonight" + sfx); }
    { Rig r(true, 13, 0); put(r); r.app.setConfig(parseYamlText(y).config); r.step(2000); r.save("bins_afternoon" + sfx); }
  }
  gLang.clear();
  gSet = DisplaySettings(); gPrefix.clear();
}
// List from attributes (eink-ha-os#332): sensor.rare_birds_nearby as ha-waarneming 0.2.0 fills it (recipe fields + title / subtitle /
// ts, eink-ha-os#375; made-up places), 13:00 UTC; a 2×2 + 2×1
// + an empty 2×1, and a 4×2; Classic and Modern (geist), English and Dutch. `render_host <dir> list`
static void listPass(const char* style, const char* prefix) {
  gSet = DisplaySettings(); gSet.style = style; if (std::string(style) == "sleek") gSet.typeface = "geist";
  gPrefix = prefix;
  const char* a = "version: 1\nscreens:\n  - id: birds\n    app: home\n    title: Birds\n    widgets:\n"
                  "      - {type: attrList, entity: sensor.rare_birds_nearby, cs: 2, rs: 2}\n"
                  "      - {type: attrList, entity: sensor.rare_birds_nearby, label: Zeldzaam, cs: 2}\n"
                  "      - {type: attrList, entity: sensor.rare_birds_far, empty: Geen zeldzame vogels, cs: 2}\n";
  const char* b = "version: 1\nscreens:\n  - id: birds\n    app: home\n    title: Birds\n    widgets:\n"
                  "      - {type: attrList, entity: sensor.rare_birds_nearby, cs: 4, rs: 2}\n";
  auto put = [](Rig& r) {
    auto iso = [](int64_t t) { char buf[32]; std::time_t tt = std::time_t(t); std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:00Z", std::gmtime(&tt)); return std::string(buf); };
    const int64_t now = r.b.epochSeconds();
    struct B { const char* sp; int n; const char* place; const char* km; const char* kmNl; int min; };
    const B birds[] = {{"Klapekster", 1, "Heideveld Oost", "3.2", "3,2", 95}, {"Grote zilverreiger", 2, "Polder De Weide", "5.8", "5,8", 160},
                       {"Roodkeelduiker", 1, "Plas Noordhoek", "7.4", "7,4", 340}, {"Zwarte ooievaar ?", 1, "Beekdal Zuid", "9.1", "9,1", 1500},
                       {"Taigaboomkruiper", 1, "Landgoed Ter Horst", "6", "6,0", 2900}, {"Kleine zwaan", 6, "Uiterwaard West", "8.7", "8,7", 3900},
                       {"Velduil", 1, "Heideveld Oost", "3.4", "3,4", 4300}};
    std::string list = "[";
    for (const B& x : birds) {
      const int64_t t = now - int64_t(x.min) * 60;
      const std::string title = (x.n > 1 ? std::to_string(x.n) + "× " : std::string()) + x.sp;
      list += std::string(list.size() > 1 ? "," : "") + "{\"species\":\"" + x.sp + "\",\"count\":" + std::to_string(x.n) + ",\"place\":\"" + x.place +
              "\",\"distance_km\":" + x.km + ",\"observed_at\":\"" + iso(t) + "\",\"rarity\":3,\"title\":\"" + title + "\",\"subtitle\":\"" +
              x.place + " · " + x.kmNl + " km\",\"ts\":" + std::to_string(t) + "}";
    }
    list += "]";
    EntityValue v; v.state = "7"; v.attrs["friendly_name"] = "Rare birds nearby"; v.attrs["sightings"] = list;
    v.attrs["attribution"] = "Data: waarneming.nl / observation.org";
    r.app.entities().set("sensor.rare_birds_nearby", v);
    EntityValue e; e.state = "0"; e.attrs["friendly_name"] = "Rare birds far"; e.attrs["sightings"] = "[]";
    r.app.entities().set("sensor.rare_birds_far", e);
  };
  for (int pass = 0; pass < 2; ++pass) {
    if (pass) gLang = "nl";
    const std::string sfx = pass ? "_nl" : "";
    { Rig r; put(r); r.app.setConfig(parseYamlText(a).config); r.step(2000); r.save("list_2x2" + sfx); }
    { Rig r; put(r); r.app.setConfig(parseYamlText(b).config); r.step(2000); r.save("list_4x2" + sfx); }
  }
  gLang.clear();
  gSet = DisplaySettings(); gPrefix.clear();
}
// Agenda and Next tiles (eink-ha-os#316): the demo week of spec/test-vectors/agenda.json (parse[0], Wed 28 Oct 2026 07:42 CET)
// through the streaming scanner, at 07:42 (Next counts down) and 08:40 (Next is on). Run with TZ=CET.
static void agendaPage(const std::string& name, const DisplaySettings& set, int64_t at, const char* lang) {
  std::FILE* fp = std::fopen("../spec/test-vectors/agenda.json", "rb");
  if (!fp) { std::fprintf(stderr, "agenda.json missing\n"); std::exit(1); }
  std::string text;
  char buf[4096];
  for (size_t k; (k = std::fread(buf, 1, sizeof buf, fp)) > 0;) text.append(buf, k);
  std::fclose(fp);
  Json v;
  parseJson(text, v);
  const Json& c = v.get("parse")->arr[0];
  const std::string key = c.get("key")->str, frame = c.get("frame")->str;
  const int64_t t0 = int64_t(c.get("now")->num);
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); b.epoch = at / 1000; s.st.language = lang;
  App app(d, b, s); app.setPressFeedback(false);
  ParseResult pr = parseConfig("version: 1\nscreens:\n  - id: today\n    title: Today\n    widgets:\n"
                               "      - {type: agenda, entities: " + key + ", cs: 2, rs: 2}\n"
                               "      - {type: next, entities: " + key + ", cs: 2}\n"
                               "      - {type: next, entities: " + key + ", label: Next up, cs: 1}\n"
                               "      - {type: agenda, entities: " + key + ", cs: 1}\n");
  if (!pr.ok) { std::fprintf(stderr, "agenda config: %s\n", pr.message.c_str()); std::exit(1); }
  app.begin(pr.config, set);
  for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
  agenda::Fetch f;
  agenda::Scanner sc;
  sc.begin(key, t0, 60, &f);
  sc.feed(frame.data(), frame.size());
  app.setAgenda(key, sc.ok() ? agenda::State::Ok : agenda::State::Error, f);
  app.requestFullRefresh();
  for (int i = 0; i < 5; ++i) { b.now += 100; app.loop(); }
  d.save(outDir + "/" + name + ".png"); std::printf("%s/%s.png\n", outDir.c_str(), name.c_str());
}
static void agendaPages() {
  setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3", 1);
  tzset();
  const int64_t t0 = 1793169720000LL;   // 2026-10-28T06:42:00Z
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  agendaPage("agenda_classic", cl, t0, "en");
  agendaPage("agenda_classic_now_nl", cl, t0 + 58 * 60000, "nl");
  agendaPage("agenda_modern", sk, t0, "en");
  agendaPage("agenda_modern_now_nl", sk, t0 + 58 * 60000, "nl");
}

// Good morning page (eink-ha-os#330): Thu 29 Oct 2026 07:05 UTC (TZ UTC0), the page up. Full: weather + made-up events + bins;
// sparse: a weather tile only. `render_host <dir> morning`
static void morningPage(const std::string& name, bool full, const char* lang) {
  const int64_t now = 1793257500;   // 2026-10-29T07:05:00Z
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); s.st.language = lang; b.epoch = now;
  App app(d, b, s); app.setPressFeedback(false);
  std::string y = "version: 1\nscreens:\n  - id: today\n    title: Today\n    widgets:\n      - {type: weather, entity: weather.home, cs: 4}\n";
  if (full) y += "      - {type: agenda, entities: calendar.family, cs: 2}\n"
                 "      - {type: bins, entities: sensor.paper sensor.plastic sensor.glass, labels: sensor.paper=Paper; sensor.plastic=Plastic; sensor.glass=Glass, cs: 2}\n";
  ParseResult pr = parseConfig(y);
  if (!pr.ok) { std::fprintf(stderr, "morning config: %s\n", pr.message.c_str()); std::exit(1); }
  EntityValue w; w.state = "partlycloudy"; app.entities().set("weather.home", w);
  auto bin = [&](const char* id, const char* st) { EntityValue v; v.state = st; app.entities().set(id, v); };
  bin("sensor.paper", "2026-10-29"); bin("sensor.plastic", "2026-10-30"); bin("sensor.glass", "2026-11-04");
  morning::State m; m.until = (now + 15 * 60) * 1000;
  app.setMorningState(m);
  app.setBootWake("timer");   // the wake at the end of quiet hours (a press would close the page)
  app.begin(pr.config, DisplaySettings());
  for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
  wx::Forecast fc;
  const int64_t day0 = now / 86400 * 86400;
  fc.daily[0] = {uint32_t(day0 + 11 * 3600), 1340, 560, 120, uint8_t(wx::Icon::Partly), 0};
  fc.daily[1] = {uint32_t(day0 + 35 * 3600), 1000, 600, 800, uint8_t(wx::Icon::Rain), 0};
  fc.nDaily = 2; fc.hasDaily = 1; fc.dailyAt = now * 1000;
  for (int k = 0; k < wx::kHourly; ++k)
    fc.hourly[k] = {uint32_t(day0 + (7 + k) * 3600), int16_t(800 + k * 50), wx::kNoT, uint16_t(k == 1 ? 60 : 0), uint8_t(k == 1 ? wx::Icon::Rain : wx::Icon::Cloud), 0};
  fc.nHourly = wx::kHourly; fc.hasHourly = 1; fc.hourlyAt = now * 1000;
  app.setWeather("weather.home", fc);
  if (full) {
    agenda::Fetch f;
    auto ev = [&](int64_t h0, int64_t h1, const char* t, bool allDay = false) {
      agenda::Event e; e.start = (day0 * 1000) + h0 * 60000; e.end = (day0 * 1000) + h1 * 60000; e.allDay = allDay;
      e.len = uint8_t(std::strlen(t)); std::memcpy(e.title, t, e.len); agenda::insert(f, e);
    };
    ev(0, 1440, "School trip", true); ev(8 * 60 + 30, 9 * 60 + 15, "Dentist"); ev(12 * 60, 13 * 60, "Lunch with Sam");
    ev(15 * 60, 16 * 60, "Swimming lessons"); ev(19 * 60 + 30, 21 * 60, "Book club"); ev(20 * 60, 21 * 60, "Call grandma");
    app.setAgenda(agenda::keyOf("calendar.family"), agenda::State::Ok, f);
  }
  app.requestFullRefresh();
  for (int i = 0; i < 5; ++i) { b.now += 100; app.loop(); }
  d.save(outDir + "/" + name + ".png"); std::printf("%s/%s.png\n", outDir.c_str(), name.c_str());
}
static void morningPages() {
  morningPage("morning_full", true, "");
  morningPage("morning_full_nl", true, "nl");
  morningPage("morning_weather_only", false, "");
}

// Guest Wi-Fi (eink-ha-os#329): 2×2 (QR over the text), 2×1 (QR beside it), 1-wide (QR only), a password from HA, an open
// network and a too-long password; Classic and Modern (geist). Made-up networks. `render_host <dir> guest`
static void guestPass(const char* style, const char* prefix) {
  gSet = DisplaySettings(); gSet.style = style; if (std::string(style) == "sleek") gSet.typeface = "geist";
  gPrefix = prefix;
  const char* a = "version: 1\nscreens:\n  - id: guest\n    app: home\n    title: Guest\n    widgets:\n"
                  "      - {type: guestWifi, ssid: Harbor Guest, password: tea%2C please, cs: 2, rs: 2}\n"
                  "      - {type: guestWifi, ssid: Harbor Guest, password_entity: input_text.guest_password, cs: 2}\n"
                  "      - {type: guestWifi, ssid: Lobby, security: nopass}\n"
                  "      - {type: guestWifi, ssid: Attic, password: wren-and-otter-2026}\n";
  const char* b = "version: 1\nscreens:\n  - id: guest\n    app: home\n    title: Guest\n    widgets:\n"
                  "      - {type: guestWifi, cs: 2, rs: 2}\n"
                  "      - {type: guestWifi, ssid: Harbor Guest, password: "
                  "a-very-long-guest-password-that-goes-on-and-on-and-on-until-it-no-longer-fits-in-a-version-6-code, cs: 2}\n"
                  "      - {type: guestWifi, ssid: Harbor Guest, password_entity: input_text.missing, cs: 2}\n";
  auto put = [](Rig& r) { EntityValue v; v.state = "otter-42"; r.app.entities().set("input_text.guest_password", v); };
  { Rig r; put(r); r.app.setConfig(parseYamlText(a).config); r.step(2000); r.save("guest_wifi"); }
  { Rig r; put(r); r.app.setConfig(parseYamlText(b).config); r.step(2000); r.save("guest_wifi_states"); }
  gSet = DisplaySettings(); gPrefix.clear();
}

// Quiet face (eink-ha-os#328): "Back at 07:00", the date and the Tomorrow row from a weather, agenda and bins tile (forecast through
// App::setWeather, events through App::setAgenda, a bin sensor dated tomorrow), and from a config without them. The face
// goes up at 23:00 (Tue 13 Oct 2026, TZ UTC0). `render_host <dir> quiet`. glance (eink-ha-os#356): the glance sleep face at 09:00
// Wed 14 Oct, its Today row from the same data (rain from 09:00, the dentist at 08:30 not over, paper collected today).
static void quietPage(const std::string& name, const DisplaySettings& set, bool items, const char* lang, bool glance = false) {
  fake::FakeDisplay d; fake::FakeBoard b; fake::FakeServices s; s.linked(); s.st.language = lang;
  b.epoch = kEpoch1300 + (glance ? 19 * 3600 : 9 * 3600) + 59 * 60;   // 22:59, or 08:59 the next day
  s.st.haLastDataEpoch = b.epoch - 60;
  App app(d, b, s); app.setPressFeedback(false);
  const std::string key = "calendar.family";
  ParseResult pr = items ? parseConfig("version: 1\nscreens:\n  - id: home\n    title: Home\n    widgets:\n"
                                       "      - {type: weather, entity: weather.home, cs: 4}\n"
                                       "      - {type: agenda, entities: " + key + ", cs: 2}\n"
                                       "      - {type: bins, entities: sensor.afval_papier sensor.afval_pmd, labels: sensor.afval_papier=Paper; sensor.afval_pmd=Plastic, cs: 2}\n")
                         : parseConfig("version: 1\nscreens:\n  - id: home\n    title: Home\n    widgets:\n      - {type: clock, cs: 2}\n      - {type: price, cs: 2}\n");
  if (!pr.ok) { std::fprintf(stderr, "quiet config: %s\n", pr.message.c_str()); std::exit(1); }
  EntityValue w; w.state = "cloudy"; w.attrs["friendly_name"] = "Home"; w.attrs["temperature"] = "9";
  app.entities().set("weather.home", w);
  EntityValue p; p.state = "2026-10-14"; p.attrs["friendly_name"] = "Afval papier"; app.entities().set("sensor.afval_papier", p);
  EntityValue m; m.state = "2026-10-14"; m.attrs["friendly_name"] = "Afval PMD"; app.entities().set("sensor.afval_pmd", m);
  app.begin(pr.config, set);
  for (int i = 0; i < 25; ++i) { b.now += 100; app.loop(); }
  if (items) {
    const int64_t day0 = kEpoch1300 / 86400 * 86400, h23 = kEpoch1300 + 10 * 3600;   // 13 Oct 00:00, 23:00
    wx::Forecast fc;
    fc.daily[0] = {uint32_t(day0), 1300, 700, 0, uint8_t(wx::Icon::Cloud), 0};
    fc.daily[1] = {uint32_t(day0 + 86400), 1160, 440, 320, uint8_t(wx::Icon::Rain), 0};
    fc.nDaily = 2; fc.hasDaily = 1; fc.dailyAt = h23 * 1000;
    for (int k = 0; k < wx::kHourly; ++k)
      fc.hourly[k] = {uint32_t(h23 + k * 3600), int16_t(800 - k * 20), wx::kNoT, uint16_t(k == 9 ? 40 : k == 10 ? 120 : 0), uint8_t(k == 9 || k == 10 ? wx::Icon::Rain : wx::Icon::Cloud), 0};
    fc.nHourly = wx::kHourly; fc.hasHourly = 1; fc.hourlyAt = h23 * 1000;
    app.setWeather("weather.home", fc);
    agenda::Fetch f;
    auto add = [&f](int64_t startS, int64_t endS, bool allDay, const char* title) {
      agenda::Event e; e.start = startS * 1000; e.end = endS * 1000; e.allDay = allDay;
      e.len = uint8_t(std::strlen(title)); std::memcpy(e.title, title, e.len); agenda::insert(f, e);
    };
    add(day0 + 86400, day0 + 2 * 86400, true, "Birthday Sam");
    add(day0 + 86400 + 8 * 3600 + 1800, day0 + 86400 + 9 * 3600 + 900, false, "Dentist");
    add(day0 + 86400 + 14 * 3600, day0 + 86400 + 15 * 3600, false, "Call with the school");
    app.setAgenda(key, agenda::State::Ok, f);
  }
  for (int i = 0; i < 700; ++i) { b.now += 100; app.loop(); }   // past 23:00: the quiet face
  if (glance) app.markAsleep(true);
  d.save(outDir + "/" + name + ".png"); std::printf("%s/%s.png\n", outDir.c_str(), name.c_str());
}
static void quietPages() {
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  for (const char* lang : {"en", "nl"}) {
    const std::string l = lang;
    quietPage("quiet_classic_items_" + l, cl, true, lang);
    quietPage("quiet_modern_items_" + l, sk, true, lang);
    quietPage("quiet_classic_none_" + l, cl, false, lang);
    quietPage("quiet_modern_none_" + l, sk, false, lang);
  }
}
static void glancePages() {
  DisplaySettings cl, sk; sk.style = "sleek"; sk.typeface = "geist";
  for (const char* lang : {"en", "nl"}) {
    const std::string l = lang;
    quietPage("glance_classic_items_" + l, cl, true, lang, true);
    quietPage("glance_modern_items_" + l, sk, true, lang, true);
    quietPage("glance_classic_none_" + l, cl, false, lang, true);
    quietPage("glance_modern_none_" + l, sk, false, lang, true);
  }
}

int main(int argc, char** argv) {
  setenv("TZ", "UTC0", 1);
  tzset();
  if (argc > 1) outDir = argv[1];
  if (argc > 2 && std::string(argv[2]) == "history") { historyPages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "agenda") { agendaPages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "morning") { morningPages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "styles") { historyStylePages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "band") { historyWave2Pages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "weather") { weatherPages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "quiet") { quietPages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "glance") { glancePages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "pastfuture") { pastFuturePages(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "guest") { guestPass("classic", "classic_"); guestPass("sleek", "modern_"); return 0; }
  if (argc > 2 && std::string(argv[2]) == "list") { listPass("classic", "classic_"); listPass("sleek", "modern_"); return 0; }
  if (argc > 2 && std::string(argv[2]) == "media") { mediaPass("classic", "classic_"); mediaPass("sleek", "modern_"); return 0; }
  if (argc > 2 && std::string(argv[2]) == "bins") { binsPass("classic", "classic_"); binsPass("sleek", "modern_"); return 0; }
  if (argc > 2 && std::string(argv[2]) == "route") { routePass("classic", "classic_"); routePass("sleek", "modern_"); return 0; }
  if (argc > 2 && std::string(argv[2]) == "empty") { emptyPass(""); gLang = "nl"; emptyPass("nl_"); gLang.clear(); return 0; }
  if (argc > 2 && std::string(argv[2]) == "asleep") {
    asleepPass("classic", ""); asleepPass("sleek", "sleek_");
    gLang = "nl"; asleepPass("classic", "nl_"); gLang.clear();
    return 0;
  }
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
  historyPages();
  return 0;
}
