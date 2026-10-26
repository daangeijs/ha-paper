// App internals shared by the state machine (app.cpp) and the renderers (ui_*.cpp). Not a public interface.
#pragma once
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>
#include "app/app.h"
#include "app/gfx/canvas.h"
#include "core/home.h"
#include "core/locale.h"
#include "core/logic.h"
#include "core/recovery.h"
#include "core/strings.h"

#ifdef X4_FW_VERSION
#define X4_FW_VERSION_STR X4_FW_VERSION
#else
#define X4_FW_VERSION_STR "0.0.0-dev"
#endif

namespace x4 {

enum class Mode : uint8_t { Boot, Main, Updating };
enum class Menu : uint8_t { None, Apps, Pages };
enum class Setup : uint8_t { None, Wifi, Web };
enum class WifiView : uint8_t { List, Pw, Connecting, Phone };
enum class Kb : uint8_t { Lower, Upper, Nums };
enum class HaView : uint8_t { Status, Link };

// Night face values, frozen at night start. asOf: "HH:MM" of the last data, only when it was stale (#27).
struct NightSnap { bool taken = false; std::string inside = "—", batt = "—", cheap = "—", asOf; };

struct LocalTime {
  bool known = false;
  int h = 0, m = 0, minuteOfDay = 0;
  std::string clock = "--:--";   // per 12/24-hour setting
  std::string date;              // "Tuesday 13 October"
  std::string hm = "—";          // always 24 h, for "updated HH:MM"
};

// One redraw region: key, rectangle, painter, z (higher drawn later).
struct RegionDef { std::string key; Rect rect; std::function<void(Canvas&)> draw; int z = 0; };

struct App::Impl {
  Impl(Display& d, Board& b, Services& s);
  Display& display;
  Board& board;
  Services& svc;
  Framebuffer fb{nullptr};
  Config cfg;
  DisplaySettings set;
  EntityStore store;
  std::function<void(const DisplaySettings&)> onSettings;
  std::function<void(const std::string&)> onLog;

  // ---- UI state (emulator `state`) ----
  Mode mode = Mode::Boot;
  std::string bootMsg = "Starting…";
  uint32_t bootUntil = 0;
  bool sleeping = false;
  Menu menu = Menu::None;
  Setup setup = Setup::None;
  int idx = 0, sub = 0;
  uint32_t peekUntil = 0;
  bool prevNight = false, nightKnown = false;
  NightSnap snap;
  WifiView wview = WifiView::List;
  std::string wTarget, wPw, wMsg;
  bool wShow = false, wScanning = false;
  uint32_t scanUntil = 0;
  Kb kb = Kb::Lower;
  HaView haView = HaView::Status;
  bool resetArm = false; uint32_t resetArmUntil = 0;
  RecoveryState recovery;        // hardware-key factory reset / crash-loop offer (core/recovery.h, #21)
  std::string otaMsg;            // local OTA message (blocked/no network)
  bool otaBlocked = false;
  int lastOtaPct = -1;

  // optimistic overrides until Home Assistant acknowledges
  std::map<std::string, double> setOverride;      // zone id → setpoint
  std::map<std::string, uint32_t> pendingSince;   // zone id → time sent (dotted underline)
  Debouncer deb;
  struct LightOv { bool on; int pct; uint32_t until; };
  std::map<std::string, LightOv> lightOv;
  int awayOv = -1; uint32_t awayOvUntil = 0;
  struct SwitchOv { bool on; uint32_t until; };
  std::map<std::string, SwitchOv> switchOv;       // HA entity id (switch.*, input_boolean.*, fan.*, light.*) → expected state

  // ---- refresh bookkeeping ----
  RefreshPolicy policy;
  RegionMap regions;            // last drawn
  std::vector<RegionDef> defs;  // last built
  std::vector<Hit> hits;
  App::Stats stats{0, 0, 0, 0};
  std::vector<std::string> log;   // last refresh/action log lines (tests + serial)
  std::vector<std::string> lastChanged;

  uint32_t lastInput = 0;
  bool idleHomed = false;
  bool ambient = false;   // #27: chrome hidden after kAmbientMs without input; the next input only restores it
  Chrome chr;             // top-bar parts in the frame being built (chromeFor)
  int lastMinute = -1;
  uint32_t lastTick = 0, lastIdle = 0;
  uint32_t lastRev = 0;
  bool pressFeedback = true;
  Lang lang = Lang::En;       // UI language: NetStatus.language (#98)
  std::string cur = "€";          // NetStatus.currency as a symbol (#147); core locale::setCurrency
  NumFmt numFmt = NumFmt::Point;   // NetStatus.numberFormat, else the language (#110); core setNumFormat
  const char* t(S k) const { return tr(lang, k); }
  std::string t(S k, const std::string& a, const std::string& b = "{}") const { return tr(lang, k, a, b); }
  // net status snapshot (detect changes)
  std::string netSig;

  bool held = false;          // glance wake: nothing goes to the panel (App::setPanelHeld)
  uint32_t panelMs = 0;       // last panel refresh call, ms (log line, #197/#200)
  uint32_t renderMs = 0;      // framebuffer draw before it, ms (log line, #212)
  uint32_t buildMs = 0, recordMs = 0;   // renderMs split (#213): region build, signature record; the rest is paint
  std::vector<std::pair<uint32_t, std::string>> paintMs;   // per region painted in the last render, ms (#213)
  bool offscreen = false;     // App::renderScreen is building a preview: no night face
  bool userInput = false;     // a key / touch since boot (power: live mode)
  uint32_t userInputAt = 0;
  void panelFull();
  void panelFast();
  void panelPartial(Rect r);

  bool linkPending = false;   // linked (key stored) but the WebSocket is not up yet
  // fresh data expected (connect, new config, new data source; #151): from freshAt until freshUntil every store change
  // is drawn at once (at most once a second), not after a whole Live data interval
  bool fresh = false;
  uint32_t freshAt = 0, freshUntil = 0;
  void expectData(uint32_t delayMs, uint32_t windowMs) { fresh = true; freshAt = ms() + delayMs; freshUntil = freshAt + windowMs; }

  // ---- derived per frame ----
  HomeData data;
  LocalTime now;

  // ---- core ops ----
  uint32_t ms() { return board.millis(); }
  void note(const std::string& s);
  std::string panelNote() const;
  LocalTime localTime();
  HomeData derive();          // power fields through powerHold (deadband, #85)
  PowerHold powerHold;
  std::map<std::string, EntityValue> heldEnt;   // last shown value of a W/kW stat entity
  const EntityValue* statEntity(const std::string& id);   // store value, or the held one inside the deadband
  PagingInfo paging() const;
  bool linked() const;
  bool neverLinked() const;
  bool revoked() const;
  bool offline() const;
  bool nightHour() const;
  bool nightActive() const;
  bool clockOnPage() const;   // the current page shows a clock tile (ambient drops the bar clock)
  int curSub() const;
  const Screen* curScreen() const;
  std::string appOf() const;
  const std::vector<AppEntry>& appList() const { return cfg.apps.empty() ? defaultApps() : cfg.apps; }
  std::string appTitle(const std::string& id) const;   // title from cfg.apps ("" if unknown)

  std::string drawnLook;   // style|typeface|surface of the last full refresh (a change → one full refresh)
  std::string lookKey() const { return set.style + "|" + set.typeface + "|" + set.surface; }
  void applyLook();        // sets the active look (gfx/style.h) for everything drawn next
  bool sleek() const;
  void build(std::vector<RegionDef>& out);
  RegionMap signatures(std::vector<RegionDef>& defs, std::vector<Hit>* hits);
  void renderAll();
  void fullRefresh(const std::string& reason);   // clean: one short flash
  void navRefresh(const std::string& reason);    // navigation: fast, every kNavClean-th a clean (#197)
  void partialRefresh(const std::string& reason, const RegionMap& next, const std::vector<std::string>& keys);
  void commit(const std::string& reason, bool quiet = false);
  void drawAll();

  // ---- behaviour (emulator methods) ----
  void boot(const std::string& msg);
  void finishBoot();
  void nav(int dir, const char* src);
  void home(const char* src);
  void goTo(int i, const char* src);
  void openApp(const std::string& id);
  void openPage(int i, int sub);
  void setMenu(Menu m, const char* src);
  void doPeek(const char* src);
  void wake(const char* src);
  void power();
  void tap(int x, int y);
  void input();
  void tick();
  void idleCheck();
  void checkNight();
  void netChanged();
  void applyFrontlight();
  void captureSnap();
  void settingsChanged();

  // actions from the UI
  void setZone(const std::string& id, double delta);
  void toggleAway();
  void toggleLight(const std::string& id);
  void toggleEntity(const std::string& entityId);   // switch widget: <domain>.toggle
  // switch widget state: false when unknown (known = false)
  bool entityOn(const std::string& entityId, bool& known) const;
  void dimLight(const std::string& id, int step);
  void roomLights(const std::string& area, const std::vector<std::string>& ids);
  void allOff();
  void runScene(const SceneAction& s);   // scene tile (#146)
  void setCfg(const std::string& key, int dir);
  void wifiPick(const WifiNetwork& n);
  void wifiKey(const std::string& k);
  void wifiConnect(const std::string& ssid, const std::string& pw);
  void wifiCancel();
  void wifiScan();
  void wifiPhone();
  void changeWifi();
  void wifiDisconnect();
  void haReconnect();
  void haUnlink();
  void haOpenLink();
  void haCancel();
  void linkFromCard();
  void otaChannel(const std::string& k);
  void otaAuto(const std::string& k);
  void otaAction();
  void restart();
  void resetTap();
  void recoveryDone(RecoveryAction a);
  void sendService(const std::string& domain, const std::string& service, const std::string& json);
};

// ---- renderers (ui_*.cpp) ----
namespace ui {
using I = App::Impl;
int baseline(int top, Font f, double lineH);            // CSS line box → baseline
void tileFrame(Canvas& c, Rect r, bool ghost = false);
void button(Canvas& c, Rect r, const std::string& label, Font f, bool dark, std::function<void()> fn, int radius = 8);
void roundButton(Canvas& c, int cx, int cy, int d, const std::string& label, int size, std::function<void()> fn);
void label(Canvas& c, int x, int top, const std::string& s, int size = 16, Ink ink = Ink::Black, int maxW = 0);
void kvRow(Canvas& c, int x, int top, int w, const std::string& k, const std::string& v, int size, int padBottom);

void topBar(Canvas& c, I& a);
// Minute-tick regions (issue #38): the clock text drawn on its own so the tick redraws only these boxes.
Rect barTimeRect(I& a);                 // "time" in the top bar
void barTime(Canvas& c, I& a);
Rect faceTimeRect(I& a);                // "time" on the night / standby face
void faceTime(Canvas& c, I& a);
Rect clockTimeRect(I& a, const Widget& w, Rect r);    // "k<i>" inside clock tile r
void clockTime(Canvas& c, I& a, const Widget& w, Rect r);
void menu(Canvas& c, I& a, Rect r);
void bootFace(Canvas& c, I& a);
void nightFace(Canvas& c, I& a);
void standbyFace(Canvas& c, I& a);
void updatingFace(Canvas& c, I& a);
void recoveryFace(Canvas& c, I& a);
void noHaCard(Canvas& c, I& a, Rect card, const Screen& sc);
Rect noHaCardRect(I& a, Rect area, const Screen& sc);
void emptyScreen(Canvas& c, I& a, Rect r);
// Where a phone reaches this display. QR codes use the IP (phones, Android especially, often can't resolve .local;
// the screen is redrawn from live status, so the IP is current); text shows both names.
std::string qrBase(I& a);          // "http://192.168.1.42", or "http://ha-paper-XXXX.local" without an IP
std::string hostOrIp(I& a);        // "ha-paper-XXXX.local or 192.168.1.42", or just the name without an IP
// HA has no value for a tile's entity (#86): a 28 px ring, bottom on the value baseline `bl` (emulator GapRing), and the
// word for it ("Unavailable" / "Unknown").
void gapRing(Canvas& c, int x, int bl);
std::string gapText(I& a, EntityGap g);
// Scene tile (#146, emulator Emulator.tsx scene): the label / HA name / "All lights off", and the line under it.
std::string sceneLabel(I& a, const Widget& w, const SceneAction& s);
std::string sceneSub(I& a, const SceneAction& s);

void tile(Canvas& c, I& a, const Widget& w, int i, Rect r);   // simple (single-region) tiles
std::string tileValue(I& a, const Widget& w);                 // GET /screens/{id}/values (#122)
std::string settingValue(const I& a, const std::string& key);
void rule(Canvas& c, int x, int y, int len, bool vertical);   // divider: Classic 2 px ink, Sleek 1 px dotted ink
void btnBox(Canvas& c, Rect r, bool dark, int radius = 8);    // custom button background: Classic outlined, Sleek pill
// Sleek display style (ui_sleek.cpp)
bool sleek();
void sleekTopBar(Canvas& c, I& a);
Rect sleekBarTimeRect(I& a);
void sleekBarTime(Canvas& c, I& a);
Rect sleekClockTimeRect(Rect card);
void sleekClockTime(Canvas& c, I& a, const Widget& w, Rect card);
bool sleekTile(Canvas& c, I& a, const Widget& w, Rect r, const std::string& settingText);   // false: not redesigned
void sleekListRegions(I& a, const Widget& w, int i, Rect r, std::vector<RegionDef>& out);
void ghost(Canvas& c, const Widget& w, Rect r, Lang l);
void linkCard(Canvas& c, I& a, Rect r);
// lists: frame + header + rows as separate regions
void listRegions(I& a, const Widget& w, int i, Rect r, std::vector<RegionDef>& out);
void systemTile(Canvas& c, I& a, const Widget& w, int i, Rect r);   // ota, wifi, ha, about, setupWeb
bool isSystemTile(const std::string& type);
}  // namespace ui

}  // namespace x4
