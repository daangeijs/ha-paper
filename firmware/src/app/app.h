// On-device UI runtime: state machine from emulator Main.dc.html (boot, setup, nav, paging, night, standby, region diff).
#pragma once
#include "core/config.h"
#include "core/entities.h"
#include "core/agenda.h"
#include "core/history_chart.h"
#include "core/morning.h"
#include "core/weather.h"
#include "hw/platform.h"
#include "app/services.h"
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace x4 {

struct DisplaySettings {   // Settings › Display (SPEC §8); persisted by net/storage
  uint8_t brightness = 0, warmth = 40;
  std::string quiet = "23-07", returnHome = "5", standby = "never", clock = "24";   // quiet: kDefaultQuiet (#295)
  int intervalSec = 30, fullEvery = 8;   // fullEvery: legacy (#26), stored and served, unused
  int cleanEvery = 30;                    // scheduled clean refresh interval, minutes: 30 | 60 | 120
  int lightTimeout = 60;                  // front light off after s without input (#220): 30 | 60 | 120 | 300 | 0 = never
  // Added: Settings › Updates choices and the device name shown on About.
  std::string otaChannel = "stable", otaAuto = "notify";   // stable|beta, off|notify|night
  std::string deviceName = "Living room display";
  // Display styles (docs/DISPLAY_STYLES_PLAN.md, owner decisions 2026-10-14): a device setting, not screens.yaml.
  std::string style = "classic";      // classic | sleek
  std::string typeface = "archivo";   // archivo | bricolage | fraunces | geist (Sleek only)
  std::string surface = "dither";     // dither | dots: how the Sleek card surface is drawn on the panel
  bool haReport = true;               // push device health to HA as entities (#32, net/ha_report)
  // Power saving on battery (#10; glance by default per #18). On USB always live. New keys: no schema bump.
  std::string powerSave = "glance";   // off | standby | glance
  int wakeEvery = 15;                  // minutes between glance / standby timer wakes: 15 | 30 | 60
  int liveMin = 3;                     // glance: live minutes after a key press: 1 | 3 | 5 | 10
  std::string emptyHouse;              // #331: presence entity for empty-house sleep, "" = off (web console only)
  bool debugInput = false;             // POST /api/v1/debug/input allowed (#214, measuring on hardware)
  bool morning = true;                 // Good morning page on the first wake after quiet hours (#330)
};

class App {
 public:
  App(Display& display, Board& board, Services& services);
  void begin(const Config& config, const DisplaySettings& settings);
  void loop();                                  // call continuously; handles input, ticks, redraws
  void setConfig(const Config& config);         // PUT /config → one full refresh
  void setDisplayConfig(Config display);        // the same, already withSettings(): moved in, no copy (#160)
  void setSettings(const DisplaySettings& s);
  void expectData();                            // a data source changed: draw new states as they land (15 s, #151)
  void onNetStatusChanged();                    // wifi/HA/OTA state changed
  EntityStore& entities();
  // History tile data (#270; fed by the HA fetch, #269): the series of hist::seriesKey(spec) and its state, then the
  // visible tiles redraw if a pixel changed. App task only. false = store full (kMaxTiles keys of the current config).
  bool setHistory(const std::string& key, const hist::Series* series, hist::State state);
  // Weather tile forecasts (#318; fed by the HA fetch): daily + hourly of a weather entity. App task only.
  void setWeather(const std::string& entity, const wx::Forecast& fc);
  // Agenda / next tile events (#316; fed by the HA fetch) of agenda::keyOf(entities). App task only.
  void setAgenda(const std::string& key, agenda::State state, const agenda::Fetch& f);
  const Config& config() const;               // what the display runs: withSettings(screens.yaml)
  const DisplaySettings& settings() const;
  // full = cleans (one flash), fast = navigations without a flash (#197), feedback = tap inversion (added)
  // renderMs / panelMs (#327): this boot's time drawing the framebuffer / in panel refresh calls
  struct Stats { uint32_t fullRefreshes, partialRefreshes; uint32_t feedbackRefreshes; uint32_t fastRefreshes; uint32_t renderMs = 0, panelMs = 0; };
  Stats stats() const;

  // ---- added ----
  ~App();
  App(const App&) = delete;                                           // owns impl_ (raw): never copied
  App& operator=(const App&) = delete;
  void requestFullRefresh();                                          // POST /display/refresh
  const Framebuffer& framebuffer() const;                             // the panel's frame
  bool renderScreen(const std::string& screenId, Framebuffer& out);   // preview.png (#168): off-screen; false = unknown id
  std::string shownScreen() const;   // screen the panel shows as renderScreen draws it (first page, nothing over it), or ""
  std::vector<std::string> tileValues(const std::string& screenId);   // GET /screens/{id}/values (#122); {} = unknown id
  void onSettingsChanged(std::function<void(const DisplaySettings&)> cb);  // persist after on-device change
  void setPressFeedback(bool on);                                     // invert pressed control before the action (default on)
  const std::vector<std::string>& log() const;                        // recent refresh/action log (tests, serial)
  void onLog(std::function<void(const std::string&)> cb);            // each new log line as it happens (serial, #71)
  // Power key stages (#225 power trail): "key" on each Power KeyDown before the App acts, "standby drawn" after the
  // standby full refresh of a Power press
  void onPowerStage(std::function<void(const char* stage)> cb);
  std::map<std::string, std::string> regionSignatures() const;        // key → text signature of what is on screen
  std::map<std::string, Rect> regionRects() const;
  void offerRecovery();                                               // crash loop at boot: factory reset screen (#21)

  // ---- glance (#10, net/power.cpp) ----
  void setPanelHeld(bool held);           // glance wake: render as usual, but leave the panel showing what it shows
  void setBootWake(const std::string& wake);   // net powerWakeName(); before begin(): not "timer" = boot opens with a peek (#295)
  // Good morning page (#330): its state from RTC memory before begin(); cb on each change (to RTC memory)
  void setMorningState(const morning::State& s);
  void onMorningState(std::function<void(const morning::State&)> cb);
  void settle();                          // while held: render everything the store holds now (ambient chrome)
  void redraw(const std::string& reason); // release the panel + one full refresh (a visible value changed)
  void prepareSleep();                    // before deep sleep from live mode: home page, ambient chrome, no standby face
  void markAsleep(bool on);               // #299: clocks drawn as "asleep · updated HH:MM" (on = before deep sleep)
  std::vector<std::string> clockRegions() const;   // regions that only show the time ("time", clock tiles "k<i>")
  struct PowerView { bool main, setup, standby, peeking; int64_t msSinceUserInput; bool ambient; bool emptyHouse; };   // emptyHouse: #331   // -1 = no key/touch since boot
  PowerView powerView() const;
 public:
  struct Impl;   // internal; shared by src/app renderers
 private:
  Impl* impl_;
};

}  // namespace x4
