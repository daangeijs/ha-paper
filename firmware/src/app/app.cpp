// UI runtime: port of the emulator state machine (Main.dc.html: boot, nav, home, commit/regions, tick, setZone, night,
// standby, idle, setup). Rendering lives in ui_*.cpp; pure rules in core/.
#include "app/app_impl.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include "core/catalog.h"
#include "core/json.h"
#ifndef X4_NATIVE
#include <esp_heap_caps.h>
#endif

namespace x4 {

namespace {
const Screen& setupScreen(Setup s) {
  static Screen wifi, web;
  if (wifi.widgets.empty()) {
    wifi.id = "setup_wifi"; wifi.app = "setup"; wifi.title = "Connect to Wi-Fi";
    Widget w; w.type = "wifi"; w.cs = 4; w.rs = 2; wifi.widgets.push_back(w);
    web.id = "setup_web"; web.app = "setup"; web.title = "Finish in your browser";
    Widget v; v.type = "setupWeb"; v.cs = 4; v.rs = 2; web.widgets.push_back(v);
  }
  return s == Setup::Wifi ? wifi : web;
}
bool after(uint32_t now, uint32_t t) { return int32_t(now - t) >= 0; }
constexpr uint32_t kStandbyLightMs = 50;   // Power → standby: frontlight off, this pause, then the full refresh (#225)
}  // namespace

// ======================= construction =======================
App::Impl::Impl(Display& d, Board& b, Services& s) : display(d), board(b), svc(s) {
#ifdef X4_NATIVE
  fb.data = static_cast<uint8_t*>(std::malloc(Framebuffer::kBytes));
#else
  fb.data = static_cast<uint8_t*>(heap_caps_malloc(Framebuffer::kBytes, MALLOC_CAP_SPIRAM));
  if (!fb.data) fb.data = static_cast<uint8_t*>(std::malloc(Framebuffer::kBytes));
#endif
  // Out of memory: fb.data stays null; Canvas and Display::*Refresh treat that as "no framebuffer" (main.cpp logs).
  if (fb.data) std::memset(fb.data, 0xFF, Framebuffer::kBytes);
}

App::App(Display& display, Board& board, Services& services) : impl_(new Impl(display, board, services)) {}
App::~App() { std::free(impl_->fb.data); delete impl_; }

void App::begin(const Config& config, const DisplaySettings& settings) {
  impl_->cfg = withSettings(config.screens.empty() ? defaultConfig() : config);   // + the built-in Settings pages (#159)
  impl_->set = settings;
  impl_->policy.setCleanEvery(settings.cleanEvery);
  impl_->lastTick = impl_->ms();
  impl_->applyFrontlight();
  auto& st = impl_->svc.status();
  impl_->lang = langOf(st.language);
  impl_->numFmt = numFormatOf(st.numberFormat, impl_->lang == Lang::Nl);
  setNumFormat(impl_->numFmt);
  impl_->cur = locale::currencySymbol(st.currency);
  locale::setCurrency(impl_->cur);
  impl_->boot(impl_->t(st.wifi == WifiState::Connected && st.ha != HaState::NeverLinked ? S::connectingHa : S::starting));
}

void App::setConfig(const Config& config) { setDisplayConfig(withSettings(config)); }

void App::setDisplayConfig(Config display) {
  auto* I = impl_;
  std::string curId = I->curScreen() ? I->curScreen()->id : "";
  I->cfg = std::move(display);
  int idx = 0;
  for (int i = 0; i < int(I->cfg.screens.size()); ++i) if (I->cfg.screens[i].id == curId) { idx = i; break; }
  I->idx = idx; I->sub = 0; I->menu = Menu::None;
  I->fullRefresh("new config");
  I->expectData(300, 15000);   // newly subscribed entities: drawn when their state lands (#151)
}

void App::expectData() { impl_->expectData(300, 15000); }

void App::setSettings(const DisplaySettings& s) {
  impl_->set = s;
  impl_->policy.setCleanEvery(s.cleanEvery);
  impl_->applyFrontlight();
  impl_->commit("setting", true);
}

void App::onNetStatusChanged() { impl_->netChanged(); }
EntityStore& App::entities() { return impl_->store; }
const Config& App::config() const { return impl_->cfg; }
const DisplaySettings& App::settings() const { return impl_->set; }
App::Stats App::stats() const { return impl_->stats; }
void App::requestFullRefresh() { impl_->fullRefresh("manual"); }

void App::Impl::panelFull() {
  panelMs = 0;
  if (held) return;
  const uint32_t t0 = ms();
  display.fullRefresh(fb);
  panelMs = ms() - t0;
  stats.fullRefreshes++;
}
void App::Impl::panelFast() {
  panelMs = 0;
  if (held) return;
  const uint32_t t0 = ms();
  display.fastRefresh(fb);
  panelMs = ms() - t0;
  stats.fastRefreshes++;
}
void App::Impl::panelPartial(Rect r) {
  panelMs = 0;
  if (held) return;
  const uint32_t t0 = ms();
  display.partialRefresh(fb, r);
  panelMs = ms() - t0;
  stats.partialRefreshes++;
}
// " · 1234 ms · render 40 ms" after a refresh line (#197 panel ms, #212 framebuffer draw); "· held" on a glance wake
// " (build 2 · record 3 · paint 20 · slow home.clock 9, home.weather 6)" when the render took ≥ 1 ms (#213)
std::string App::Impl::panelNote() const {
  std::string s = (held ? std::string(" · held") : " · " + std::to_string(panelMs) + " ms") + " · render " +
                  std::to_string(renderMs) + " ms";
  if (!renderMs) return s;
  s += " (build " + std::to_string(buildMs) + " · record " + std::to_string(recordMs) + " · paint " +
       std::to_string(renderMs - std::min(renderMs, buildMs + recordMs));
  auto top = paintMs;
  std::stable_sort(top.begin(), top.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
  for (size_t i = 0; i < top.size() && i < 3 && top[i].first > 0; ++i)
    s += (i ? ", " : " · slow ") + top[i].second + " " + std::to_string(top[i].first);
  return s + ")";
}

void App::setPanelHeld(bool held) { impl_->held = held; }
void App::settle() {
  auto* I = impl_;
  if (!I->held || I->mode != Mode::Main) return;
  I->ambient = I->setup == Setup::None;   // the glance face: ambient chrome, as live mode leaves it
  I->snap.taken = false;                  // night face: values as of now, not as of the boot screen
  I->fullRefresh("glance · render");
}
void App::redraw(const std::string& reason) {
  impl_->held = false;
  impl_->fullRefresh("glance · " + reason);
}
void App::prepareSleep() {
  auto* I = impl_;
  if (I->mode != Mode::Main || I->setup != Setup::None) return;
  const bool away = I->idx != 0 || I->sub != 0 || I->menu != Menu::None || I->sleeping || I->peekUntil || !I->ambient;
  I->idx = 0; I->sub = 0; I->menu = Menu::None; I->sleeping = false; I->peekUntil = 0; I->ambient = true;
  I->applyFrontlight();
  if (away) I->fullRefresh("sleep · home");
}
std::vector<std::string> App::clockRegions() const {
  std::vector<std::string> out;
  for (auto& kv : impl_->regions) {
    const std::string& k = kv.first;
    if (k == "time" || (k.size() > 1 && k[0] == 'k' && std::isdigit(static_cast<unsigned char>(k[1])))) out.push_back(k);
  }
  return out;
}
App::PowerView App::powerView() const {
  auto* I = impl_;
  return {I->mode == Mode::Main, I->setup != Setup::None, I->sleeping, I->peekUntil != 0 && !after(I->ms(), I->peekUntil),
          I->userInput ? int64_t(I->ms() - I->userInputAt) : -1, I->ambient};
}
const Framebuffer& App::framebuffer() const { return impl_->fb; }
std::vector<std::string> App::tileValues(const std::string& screenId) {
  std::vector<std::string> out;
  for (auto& s : impl_->cfg.screens)
    if (s.id == screenId) {
      for (auto& w : s.widgets) out.push_back(ui::tileValue(*impl_, w));
      break;
    }
  return out;
}
void App::onSettingsChanged(std::function<void(const DisplaySettings&)> cb) { impl_->onSettings = std::move(cb); }
void App::setPressFeedback(bool on) { impl_->pressFeedback = on; }
const std::vector<std::string>& App::log() const { return impl_->log; }
void App::onLog(std::function<void(const std::string&)> cb) { impl_->onLog = std::move(cb); }
void App::onPowerStage(std::function<void(const char*)> cb) { impl_->onPowerStage = std::move(cb); }
std::map<std::string, std::string> App::regionSignatures() const {
  std::map<std::string, std::string> m;
  for (auto& kv : impl_->regions) m[kv.first] = kv.second.sig;
  return m;
}
std::map<std::string, Rect> App::regionRects() const {
  std::map<std::string, Rect> m;
  for (auto& kv : impl_->regions) m[kv.first] = kv.second.rect;
  return m;
}

void App::loop() {
  auto* I = impl_;
  uint32_t now = I->ms();
  // Hardware-key factory reset and Power + Prev restart (core/recovery.h): one sample per pass = keys held now + keys pressed since the last
  // pass. Input goes to the reset screen, not the UI, while a hold or the screen is in progress.
  // The whole queue is drained each pass; only the last event is handled (#212, coalesceInput): taps made while a
  // refresh ran are not replayed one by one.
  InputEvent ev{}, e{};
  int n = 0;
  const uint8_t held = I->board.heldKeys();
  uint8_t keys = held;
  while (n < 64 && I->board.pollInput(e)) {
    ++n;
    ev = e;
    I->userInput = true;
    I->userInputAt = now;
    if (e.kind != InputEvent::Kind::KeyDown || e.key == Key::Home) keys |= kKeyOther;
    else keys |= e.key == Key::Prev ? kKeyLeft : e.key == Key::Next ? kKeyRight : kKeyPower;
    if (e.kind == InputEvent::Kind::KeyDown && e.key == Key::Power && I->onPowerStage) I->onPowerStage("key");
  }
  bool swallow = false;
  if (I->mode != Mode::Updating) {
    const bool was = I->recovery.phase != RecoveryPhase::Idle;
    RecoveryAction a = recoveryStep(I->recovery, now, keys);
    // #258: a Power KeyDown already released (remote input, or shorter than a pass) is a press and its release
    if (a == RecoveryAction::None && I->recovery.phase == RecoveryPhase::PowerHold && !(held & kKeyPower))
      a = recoveryStep(I->recovery, now, held);
    swallow = was || I->recovery.phase != RecoveryPhase::Idle || a != RecoveryAction::None;
    if (a != RecoveryAction::None) I->recoveryDone(a);
  }
  if (I->poweredOff) return;   // QEMU / host only: the board stays up; Power (a Press) restarts it
  if (n > 1 && !swallow) I->note("input · " + std::to_string(n - 1) + " stale dropped · last wins");
  if (coalesceInput(n) >= 0 && !swallow) {
    // ambient (#27): the first touch or key (not Power) brings the chrome back and does nothing else
    // light timeout (#220): the same for the first input after the front light went off
    const bool pwr = ev.kind == InputEvent::Kind::KeyDown && ev.key == Key::Power;
    const bool main = I->mode == Mode::Main, night = main && I->nightActive();
    const bool light = main && lightWakeConsumes(I->set.brightness, I->sleeping, night, I->lightOut, pwr);
    bool consume = light || (I->ambient && main && !I->sleeping && !night && !pwr);
    I->input();
    if (consume) { I->note(light ? "input → light on (consumed)" : "input → chrome back (consumed)"); I->commit("chrome"); }
    else switch (ev.kind) {
      case InputEvent::Kind::KeyDown:
        if (ev.key == Key::Prev) I->nav(-1, "BTN_PREV");
        else if (ev.key == Key::Next) I->nav(1, "BTN_NEXT");
        else if (ev.key == Key::Home) I->home("KEY_HOME");
        else if (I->mode != Mode::Updating) I->note("BTN_POWER ignored · a key is still down");   // #258: recoveryStep Press / Off
        break;
      case InputEvent::Kind::Tap: I->tap(ev.x, ev.y); break;
      case InputEvent::Kind::Swipe:
        if (I->mode == Mode::Main && !I->sleeping && I->nightActive()) I->doPeek("SWIPE");
        else if (I->menu == Menu::None) I->nav(ev.dir < 0 ? 1 : -1, ev.dir < 0 ? "SWIPE ←" : "SWIPE →");
        break;
    }
  }
  if (I->mode == Mode::Boot && after(now, I->bootUntil)) I->finishBoot();
  I->netChanged();
  if (I->mode == Mode::Main) {
    // debounced setpoints → one climate.set_temperature per zone
    for (auto& id : I->deb.fire(now)) {
      auto it = I->setOverride.find(id);
      if (it == I->setOverride.end()) continue;
      I->sendService("climate", "set_temperature",
                     "{\"entity_id\":\"climate." + id + "\",\"temperature\":" + toFixed(it->second, 1) + "}");
      I->pendingSince[id] = now;
    }
    I->checkNight();
    I->tick();
    if (after(now, I->lastIdle + 1000)) { I->lastIdle = now; I->idleCheck(); }
    if (I->resetArm && after(now, I->resetArmUntil)) { I->resetArm = false; I->commit("1 tile", true); }
    if (I->wScanning && after(now, I->scanUntil)) { I->wScanning = false; I->commit("scan", true); }
  }
}

// ======================= helpers =======================
void App::Impl::note(const std::string& s) {
  log.push_back(s);
  if (onLog) onLog(s);
  if (log.size() > 200) log.erase(log.begin(), log.begin() + 100);
}

LocalTime App::Impl::localTime() {
  LocalTime t;
  int64_t e = board.epochSeconds();
  if (e <= 0) return t;
  time_t tt = time_t(e);
  struct tm tm;
  localtime_r(&tt, &tm);
  t.known = true; t.h = tm.tm_hour; t.m = tm.tm_min; t.minuteOfDay = t.h * 60 + t.m;
  t.clock = (set.clock == "12" ? std::to_string(t.h % 12 ? t.h % 12 : 12) : pad2(t.h)) + ":" + pad2(t.m);
  t.hm = pad2(t.h) + ":" + pad2(t.m);
  t.date = dateLine(lang, tm.tm_wday, tm.tm_mday, tm.tm_mon);
  return t;
}

HomeData App::Impl::derive() {
  HomeData d = deriveHome(store);
  const std::pair<const char*, OptNum*> power[] = {{"sensor.solar_power", &d.solar}, {"sensor.home_power", &d.home},
                                                   {"sensor.grid_power", &d.grid}, {"sensor.battery_power", &d.batt}};
  for (auto& p : power) {
    if (p.second->ok) p.second->v = powerHold.hold(p.first, p.second->v);
    else powerHold.forget(p.first);
  }
  for (auto& z : d.zones) { auto it = setOverride.find(z.id); if (it != setOverride.end()) z.set = OptNum::of(it->second); }
  for (auto& l : d.lights) { auto it = lightOv.find(l.id); if (it != lightOv.end()) { l.on = it->second.on; l.pct = it->second.pct; } }
  if (awayOv >= 0) d.away = awayOv == 1;
  return d;
}

const EntityValue* App::Impl::statEntity(const std::string& id) {
  const EntityValue* v = store.get(id);
  std::string key = "e:" + id;
  std::string unit;
  if (v) { auto u = v->attrs.find("unit_of_measurement"); if (u != v->attrs.end()) unit = u->second; }
  char* end = nullptr;
  double w = v ? std::strtod(v->state.c_str(), &end) : 0;
  if ((unit != "W" && unit != "kW") || v->state.empty() || *end || !std::isfinite(w)) {
    powerHold.forget(key); heldEnt.erase(id);
    return v;
  }
  if (unit == "kW") w *= 1000;
  if (powerHold.hold(key, w) == w) { heldEnt[id] = *v; return v; }
  auto it = heldEnt.find(id);
  return it != heldEnt.end() ? &it->second : v;
}

PagingInfo App::Impl::paging() const {
  PagingInfo p;
  p.pages = [this](const Widget& w) { return listPages(w, data); };
  return p;
}

bool App::Impl::linked() const { auto h = const_cast<Services&>(svc).status().ha; return h == HaState::Connected || h == HaState::Offline; }
bool App::Impl::neverLinked() const { auto h = const_cast<Services&>(svc).status().ha; return h == HaState::NeverLinked || h == HaState::Linking; }
bool App::Impl::revoked() const { return const_cast<Services&>(svc).status().ha == HaState::KeyRevoked; }
bool App::Impl::offline() const {
  auto& st = const_cast<Services&>(svc).status();
  return !(st.wifi == WifiState::Connected && st.ha == HaState::Connected);
}
bool App::Impl::nightHour() const { return now.known && isNightHour(now.h, set.night); }
bool App::Impl::nightActive() const {
  if (offscreen) return false;
  bool peeking = peekUntil != 0 && int32_t(peekUntil - const_cast<Board&>(board).millis()) > 0;
  return nightHour() && !peeking && !sleeping;
}
bool App::Impl::clockOnPage() const {
  if (setup != Setup::None || menu != Menu::None || cfg.screens.empty()) return false;
  const Screen& sc = *curScreen();
  if (sc.id == "overview" && neverLinked()) return true;   // never linked: clock + link card
  for (auto& w : sc.widgets) if (w.type == "clock") return true;
  return false;
}
const Screen* App::Impl::curScreen() const {
  if (setup != Setup::None) return &setupScreen(setup);
  if (cfg.screens.empty()) return nullptr;
  return &cfg.screens[std::max(0, std::min(int(cfg.screens.size()) - 1, idx))];
}
int App::Impl::curSub() const {
  const Screen* sc = curScreen();
  return sc ? std::min(sub, subPages(*sc, paging()) - 1) : 0;
}
std::string App::Impl::appTitle(const std::string& id) const {
  for (auto& a : appList()) if (a.id == id) return a.title;
  return "";
}
std::string App::Impl::appOf() const {
  if (cfg.screens.empty()) return appList().empty() ? "home" : appList()[0].id;
  const Screen& sc = cfg.screens[std::max(0, std::min(int(cfg.screens.size()) - 1, idx))];
  return sc.app.empty() ? "home" : sc.app;
}

// ======================= regions & refresh =======================
// Display style: Classic or Sleek in one of four typefaces (docs/DISPLAY_STYLES_PLAN.md). The boot, OTA install,
// standby and night faces keep the Classic look in both styles (package EINK_NOTES.md §3).
void App::Impl::applyLook() {
  Look l = lookFromSettings(set.style, set.typeface, set.surface);
  if (mode != Mode::Main || sleeping || nightActive()) l.sleek = false;
  setActiveLook(l);
}
bool App::Impl::sleek() const { return activeLook().sleek; }

void App::Impl::build(std::vector<RegionDef>& out) {
  out.clear();
  data = derive();
  now = localTime();
  applyLook();
  Rect screen = rc(0, 0, kScreenW, kScreenH);
  if (poweredOff) { out.push_back({"off", screen, [this](Canvas& c) { ui::offFace(c, *this); }}); return; }
  if (recovery.phase == RecoveryPhase::Confirm) { out.push_back({"reset", screen, [this](Canvas& c) { ui::recoveryFace(c, *this); }}); return; }
  if (mode == Mode::Boot) { out.push_back({"boot", screen, [this](Canvas& c) { ui::bootFace(c, *this); }}); return; }
  if (mode == Mode::Updating) { out.push_back({"upd", screen, [this](Canvas& c) { ui::updatingFace(c, *this); }}); return; }
  // the clock text of the faces and the top bar is region "time", drawn on top (z 1): the minute tick redraws only it
  Rect face = ui::faceTimeRect(*this);
  if (sleeping) {
    out.push_back({"standby", screen, [this](Canvas& c) { ui::standbyFace(c, *this); }});
    out.push_back({"time", face, [this](Canvas& c) { ui::faceTime(c, *this); }, 1});
    return;
  }
  if (nightActive()) {
    if (!snap.taken) captureSnap();   // booted at night: values as of now (emulator falls back to live values)
    out.push_back({"night", screen, [this](Canvas& c) {
      ui::nightFace(c, *this);
      c.hit(rc(0, 0, kScreenW, kScreenH), [this] { doPeek("TOUCH night face"); });
    }});
    out.push_back({"time", face, [this](Canvas& c) { ui::faceTime(c, *this); }, 1});
    return;
  }
  const GridMetrics& gm = sleek() ? kSleekGrid : kClassicGrid;
  int barH = sleek() ? kSleekBarH : kTopBarH + kTopRule;
  chr = chromeFor(ambient && menu == Menu::None && setup == Setup::None, board.power().batteryPct, clockOnPage());
  if (setup != Setup::None) chr.pager = false;   // "Step N of 2" in the title instead (#183)
  out.push_back({"bar", rc(0, 0, kScreenW, barH), [this](Canvas& c) { ui::topBar(c, *this); }});
  if (chr.clock) out.push_back({"time", ui::barTimeRect(*this), [this](Canvas& c) { ui::barTime(c, *this); }, 1});
  Rect content = rc(0, barH, kScreenW, kScreenH - barH);
  if (menu != Menu::None) { out.push_back({"menu", content, [this, content](Canvas& c) { ui::menu(c, *this, content); }}); return; }
  const Screen* scp = curScreen();
  if (!scp) return;
  const Screen& sc = *scp;
  bool never = neverLinked() && setup == Setup::None;
  bool needsHa = false;
  for (auto& w : sc.widgets) if (!isLocalWidget(w.type)) needsHa = true;
  if (never && sc.id == "overview") {
    Rect a = gridSpan(gm, 0, 0, 2, 2);
    Rect b = gridSpan(gm, 2, 0, 2, 2);
    out.push_back({"t0", a, [this, a](Canvas& c) { Widget w; w.type = "clock"; w.cs = 2; w.rs = 2; ui::tile(c, *this, w, 0, a); }});
    Widget cw; cw.type = "clock"; cw.cs = 2; cw.rs = 2;
    out.push_back({"k0", ui::clockTimeRect(*this, cw, a), [this, a, cw](Canvas& c) { ui::clockTime(c, *this, cw, a); }, 1});
    out.push_back({"t1", b, [this, b](Canvas& c) { ui::linkCard(c, *this, b); }});
    return;
  }
  if (sc.widgets.empty()) {
    Rect g = gridSpan(gm, 0, 0, 4, 2);
    out.push_back({"t", g, [this, g](Canvas& c) { ui::emptyScreen(c, *this, g); }});
    return;
  }
  auto rects = gridRects(sc, gm);
  for (int i = 0; i < int(sc.widgets.size()); ++i) {
    if (!rects[i].ok) continue;
    const Widget& w = sc.widgets[i];
    Rect r = rects[i].r;
    std::string key = "t" + std::to_string(i);
    if (never && needsHa && !isLocalWidget(w.type)) {
      out.push_back({key, r, [&w, r, l = lang](Canvas& c) { ui::ghost(c, w, r, l); }});
    } else if (w.type == "zoneList" || w.type == "lightList") {
      ui::listRegions(*this, w, i, r, out);
    } else if (ui::isSystemTile(w.type)) {
      out.push_back({key, r, [this, &w, i, r](Canvas& c) { ui::systemTile(c, *this, w, i, r); }});
      if (w.type == "ota") out.push_back({"s" + std::to_string(i), ui::otaStatusRect(r), [this, r](Canvas& c) { ui::otaStatus(c, *this, r); }, 1});
    } else {
      out.push_back({key, r, [this, &w, i, r](Canvas& c) { ui::tile(c, *this, w, i, r); }});
      if (w.type == "clock")
        out.push_back({"k" + std::to_string(i), ui::clockTimeRect(*this, w, r), [this, &w, r](Canvas& c) { ui::clockTime(c, *this, w, r); }, 1});
    }
  }
  if (never && needsHa) {
    Rect card = ui::noHaCardRect(*this, gridSpan(gm, 0, 0, 4, 2), sc);
    out.push_back({"noha", card, [this, card, &sc](Canvas& c) { ui::noHaCard(c, *this, card, sc); }, 1});
  }
}

RegionMap App::Impl::signatures(std::vector<RegionDef>& ds, std::vector<Hit>* hs) {
  RegionMap m;
  for (auto& d : ds) {
    Canvas c(nullptr);
    std::string sig;
    c.setRecord(&sig);
    c.setHits(hs, d.key);
    d.draw(c);
    m[d.key] = Region{d.rect, sig};
  }
  return m;
}

static std::vector<const RegionDef*> zOrder(const std::vector<RegionDef>& ds) {
  std::vector<const RegionDef*> v;
  for (auto& d : ds) v.push_back(&d);
  std::stable_sort(v.begin(), v.end(), [](const RegionDef* a, const RegionDef* b) { return a->z < b->z; });
  return v;
}

// times (optional): ms per region, for the slowest-regions note on the refresh line (#213)
static void paint(const std::vector<RegionDef>& ds, Framebuffer& out, Board* board = nullptr,
                  std::vector<std::pair<uint32_t, std::string>>* times = nullptr) {
  if (out.data) std::memset(out.data, 0xFF, Framebuffer::kBytes);
  for (auto* d : zOrder(ds)) {
    const uint32_t t0 = board ? board->millis() : 0;
    Canvas c(&out);
    c.setClip(d->rect);
    d->draw(c);
    if (times) times->emplace_back(board->millis() - t0, d->key);
  }
}

void App::Impl::drawAll() { paintMs.clear(); paint(defs, fb, &board, &paintMs); }

// preview.png (#168): the screen as its first page would look now, drawn into `out`. The panel, its framebuffer, the
// drawn regions and hits stay as they are; the view state is borrowed and put back.
bool App::renderScreen(const std::string& screenId, Framebuffer& out) {
  auto* I = impl_;
  int i = -1;
  for (int k = 0; k < int(I->cfg.screens.size()); ++k) if (I->cfg.screens[k].id == screenId) { i = k; break; }
  if (i < 0 || !out.data) return false;
  const int idx = I->idx, sub = I->sub;
  const Menu menu = I->menu;
  const Setup setup = I->setup;
  const Mode mode = I->mode;
  const bool sleeping = I->sleeping;
  const RecoveryPhase phase = I->recovery.phase;
  HomeData data = I->data;
  LocalTime now = I->now;
  const Chrome chr = I->chr;
  I->idx = i; I->sub = 0; I->menu = Menu::None; I->setup = Setup::None; I->mode = Mode::Main; I->sleeping = false;
  I->recovery.phase = RecoveryPhase::Idle;
  I->offscreen = true;
  {
    std::vector<RegionDef> ds;
    I->build(ds);
    paint(ds, out);
  }
  I->offscreen = false;
  I->idx = idx; I->sub = sub; I->menu = menu; I->setup = setup; I->mode = mode; I->sleeping = sleeping;
  I->recovery.phase = phase;
  I->data = std::move(data); I->now = std::move(now); I->chr = chr;
  I->applyLook();
  return true;
}
std::string App::shownScreen() const {
  auto* I = impl_;
  if (I->mode != Mode::Main || I->setup != Setup::None || I->menu != Menu::None || I->sleeping || I->nightActive() ||
      I->recovery.phase == RecoveryPhase::Confirm || I->curSub() != 0 || !I->curScreen())
    return "";
  return I->curScreen()->id;
}

void App::Impl::renderAll() {
  const uint32_t t0 = ms();
  std::vector<Hit> hs;
  build(defs);
  const uint32_t t1 = ms();
  regions = signatures(defs, &hs);
  const uint32_t t2 = ms();
  buildMs = t1 - t0; recordMs = t2 - t1;
  hits = std::move(hs);
  drawAll();
  drawnLook = lookKey();
  renderMs = ms() - t0;
}

void App::Impl::fullRefresh(const std::string& reason) {
  renderAll();
  panelFull();
  int64_t e = board.epochSeconds();
  policy.onFull(e > 0 ? e / 60 : -1);
  lastRev = store.revision();
  lastChanged.clear();
  note("EPD clean refresh (" + reason + ")" + panelNote());
}

void App::Impl::navRefresh(const std::string& reason) {
  if (policy.requestNav(board.epochSeconds() > 0) == RefreshPolicy::Kind::Clean) {
    fullRefresh(reason + (policy.navSinceClean() + 1 >= kNavClean ? " · nav clean" : " · ghosting limit"));
    return;
  }
  renderAll();
  panelFast();
  lastRev = store.revision();
  lastChanged.clear();
  note("EPD fast refresh (" + reason + ")" + panelNote());
}

void App::Impl::partialRefresh(const std::string& reason, const RegionMap& next, const std::vector<std::string>& keys) {
  if (policy.requestPartial(board.epochSeconds() > 0) == RefreshPolicy::Kind::Clean) { fullRefresh("ghosting limit"); return; }
  const uint32_t t0 = ms();
  paintMs.clear();
  std::vector<std::string> draw = keys;
  RegionMap prev = regions;
  regions = next;
  // overlays (z > 0) intersecting a redrawn region are redrawn on top
  for (auto& d : defs) {
    if (d.z <= 0 || std::find(draw.begin(), draw.end(), d.key) != draw.end()) continue;
    for (auto& k : keys) if (intersects(d.rect, next.at(k).rect)) { draw.push_back(d.key); break; }
  }
  // regions that disappeared: clear their old rectangles
  std::vector<std::string> removed = removedRegions(prev, next);
  for (auto& k : removed) {
    Canvas c(&fb);
    c.fill(prev.at(k).rect, Ink::Paper);
  }
  for (auto* d : zOrder(defs)) {
    if (std::find(draw.begin(), draw.end(), d->key) == draw.end()) continue;
    const uint32_t r0 = ms();
    Canvas c(&fb);
    c.setClip(d->rect);
    c.fill(d->rect, Ink::Paper);
    d->draw(c);
    paintMs.emplace_back(ms() - r0, d->key);
    // re-draw lower regions under an overlay that was cleared? overlays are opaque cards: nothing to do
  }
  RegionMap u = next;
  std::vector<std::string> all = draw;
  for (auto& k : removed) { u[k] = prev.at(k); all.push_back(k); }
  Rect r = unionRect(u, all);
  renderMs = buildMs + recordMs + (ms() - t0);   // build + record: commit() just before (#213)
  panelPartial(r);
  lastChanged = keys;
  lastRev = store.revision();
  note("EPD partial (" + reason + " · " + std::to_string(keys.size() + removed.size()) + (keys.size() + removed.size() == 1 ? " region)" : " regions)") + panelNote());
}

void App::Impl::commit(const std::string& reason, bool quiet) {
  if (mode == Mode::Boot) return;
  if (sleeping && reason != "clock") return;
  if (nightActive() && reason != "clock") { note("night · redraw skipped (" + reason + ")"); return; }
  // display style / typeface / card surface changed: every region looks different → one full refresh, no partial
  if (lookKey() != drawnLook) { fullRefresh("style"); return; }
  std::vector<RegionDef> nd;
  std::vector<Hit> nh;
  const uint32_t t0 = ms();
  build(nd);
  const uint32_t t1 = ms();
  RegionMap next = signatures(nd, &nh);
  buildMs = t1 - t0; recordMs = ms() - t1;
  auto keys = changedRegions(regions, next);
  auto removed = removedRegions(regions, next);
  defs = std::move(nd);
  hits = std::move(nh);
  if (keys.empty() && removed.empty()) {
    lastRev = store.revision();
    if (!quiet) note(reason + " · nothing visible changed · no redraw");
    return;
  }
  partialRefresh(reason, next, keys);
}

// ======================= behaviour =======================
void App::Impl::input() {
  lastInput = ms(); idleHomed = false; ambient = false;
  if (lightOut) { lightOut = false; applyFrontlight(); }
}

void App::Impl::boot(const std::string& msg) {
  input();
  mode = Mode::Boot; sleeping = false; menu = Menu::None; peekUntil = 0;
  bootMsg = msg;
  bootUntil = ms() + 1600;
  fullRefresh("boot");
}

void App::Impl::finishBoot() {
  auto& st = svc.status();
  bool noWifi = st.wifi == WifiState::NotConfigured || st.wifi == WifiState::SoftAP || st.wifi == WifiState::WrongPassword;
  setup = noWifi ? Setup::Wifi : (st.wifi == WifiState::Connected && st.ha == HaState::NeverLinked) ? Setup::Web : Setup::None;
  mode = Mode::Main; idx = 0; sub = 0; wview = WifiView::List;
  nightKnown = false;
  lastMinute = localTime().known ? localTime().m : -1;
  if (setup == Setup::Wifi) { svc.wifiScan(); fullRefresh("setup: Wi-Fi"); }
  else if (setup == Setup::Web) fullRefresh("setup: browser");
  else fullRefresh("home");
}

void App::Impl::nav(int dir, const char* src) {
  if (setup != Setup::None && mode == Mode::Main) { note(std::string(src) + " · finish setup first"); return; }
  if (mode != Mode::Main) { note(std::string(src) + " ignored"); return; }
  if (sleeping) { wake(src); return; }
  if (nightActive()) { doPeek(src); return; }
  if (cfg.screens.empty()) return;
  PageRef t = navTarget(cfg, idx, curSub(), dir, paging());
  bool same = t.screen == idx && menu == Menu::None;
  idx = t.screen; sub = t.sub; menu = Menu::None;
  note(std::string(src) + " → " + cfg.screens[idx].title);
  if (same) commit("page turn");
  else navRefresh("screen change");
}

void App::Impl::goTo(int i, const char* src) {
  int n = int(cfg.screens.size()); if (!n) return;
  idx = ((i % n) + n) % n; sub = 0; menu = Menu::None;
  note(std::string(src) + " → " + cfg.screens[idx].title);
  navRefresh("screen change");
}

void App::Impl::home(const char* src) {
  if (sleeping) { wake(src); return; }
  if (mode != Mode::Main) return;
  if (setup != Setup::None) { note(std::string(src) + " · finish setup first"); return; }
  if (nightActive()) { doPeek(src); return; }
  // Home = first screen of the first app that has screens
  int first = -1;
  for (auto& ap : appList()) if ((first = firstScreenOfApp(cfg, ap.id)) >= 0) break;
  if (idx == first && sub == 0 && menu == Menu::None) { setMenu(Menu::Apps, src); return; }
  goTo(std::max(0, first), src);
}

void App::Impl::setMenu(Menu m, const char* src) {
  if (sleeping || mode != Mode::Main) return;
  if (setup != Setup::None) { note(std::string(src) + " · finish setup first"); return; }
  menu = menu == m ? Menu::None : m;
  navRefresh(menu == Menu::Apps ? "app switcher" : menu == Menu::Pages ? "page overview" : "close overview");
}

void App::Impl::openApp(const std::string& id) {
  int i = firstScreenOfApp(cfg, id); if (i < 0) return;
  idx = i; sub = 0; menu = Menu::None;
  navRefresh("app switch");
}

void App::Impl::openPage(int i, int q) { idx = i; sub = q; menu = Menu::None; navRefresh("page"); }

void App::Impl::doPeek(const char* src) {
  peekUntil = ms() + kPeekMs; if (!peekUntil) peekUntil = 1;
  idx = 0; sub = 0; menu = Menu::None;
  prevNight = false;
  note(std::string(src) + " → dashboard for 60 s");
  fullRefresh("wake from night");
}

void App::Impl::wake(const char* src) { sleeping = false; applyFrontlight(); note(std::string(src) + " → wake"); fullRefresh("wake"); }

void App::Impl::power() {
  if (mode != Mode::Main) return;
  if (sleeping) { wake("BTN_POWER"); return; }
  sleeping = true; menu = Menu::None;
  applyFrontlight();
  board.pause(kStandbyLightMs);   // #225: frontlight off settles before the refresh load, not both at once
  fullRefresh("standby");
  if (onPowerStage) onPowerStage("standby drawn");
}

// #258: Power held 2 s. The face first (the panel keeps it without power), the panel asleep, the trail line, then the
// board switches off (hardware: latch released, no return).
void App::Impl::powerOff() {
  note("BTN_POWER held " + std::to_string(kPowerOffHoldMs / 1000) + " s · turned off");
  poweredOff = true; sleeping = false; menu = Menu::None; peekUntil = 0;
  applyFrontlight();
  board.pause(kStandbyLightMs);
  fullRefresh("turned off");
  display.sleep();
  if (onPowerStage) onPowerStage("off");
  board.powerOff();
}

void App::Impl::tap(int x, int y) {
  if (mode != Mode::Main || sleeping) return;
  applyLook();
  const Hit* h = nullptr;
  for (auto it = hits.rbegin(); it != hits.rend(); ++it) if (contains(it->r, x, y)) { h = &*it; break; }
  if (!h) {   // forgiving: nearest target within 8 px
    for (auto it = hits.rbegin(); it != hits.rend(); ++it)
      if (contains(rc(it->r.x - 8, it->r.y - 8, it->r.w + 16, it->r.h + 16), x, y)) { h = &*it; break; }
  }
  if (!h) return;
  Hit hit = *h;   // hits may be rebuilt by the action
  bool feedback = pressFeedback && hit.region != "night" && hit.r.w < kScreenW;
  auto flash = [&](const char* what) {   // press feedback: one partial of the control, serial only (not in log())
    const uint32_t t0 = ms();
    if (!held) display.partialRefresh(fb, hit.r);
    panelMs = ms() - t0;
    renderMs = 0;
    paintMs.clear();
    stats.feedbackRefreshes++;
    policy.countPartial();
    if (onLog) onLog(std::string("EPD partial (press feedback · ") + what + " " + hit.region + ")" + panelNote());
  };
  // The action runs first (#212): a navigation's fast refresh or a partial that redraws the control is the feedback, so
  // no separate ~565 ms partial goes before it. Only an action with no visible change (scene, script) flashes the control.
  uint32_t fulls = stats.fullRefreshes + stats.fastRefreshes, partials = stats.partialRefreshes;
  hit.fn();
  if (!feedback) return;
  bool redrawn = stats.fullRefreshes + stats.fastRefreshes != fulls ||
                 (stats.partialRefreshes != partials && std::find(lastChanged.begin(), lastChanged.end(), hit.region) != lastChanged.end());
  if (redrawn) return;
  {
    Canvas c(&fb);
    c.invert(hit.r);
    flash("invert");
  }
  for (auto& d : defs) {
    if (d.key != hit.region) continue;
    Canvas c(&fb);
    c.setClip(d.rect);
    c.fill(d.rect, Ink::Paper);
    d.draw(c);
    flash("restore");
    return;
  }
  // region gone without a refresh: restore by inverting back
  Canvas c(&fb);
  c.invert(hit.r);
  flash("restore");
}

void App::Impl::tick() {
  uint32_t t = ms();
  // acknowledgements (entity state caught up with our optimistic value)
  if (store.revision() != lastRev) {
    HomeData raw = deriveHome(store);
    bool changed = false;
    for (auto it = setOverride.begin(); it != setOverride.end();) {
      const ZoneState* z = raw.zone(it->first);
      bool debouncing = deb.pending(it->first);
      if (!debouncing && z && z->set.ok && std::fabs(z->set.v - it->second) < 0.01) {
        pendingSince.erase(it->first); it = setOverride.erase(it); changed = true;
      } else ++it;
    }
    for (auto it = lightOv.begin(); it != lightOv.end();) {
      const LightState* l = raw.light(it->first);
      if (l && l->on == it->second.on && (!l->on || !l->dim || std::abs(l->pct - it->second.pct) <= 1)) { it = lightOv.erase(it); changed = true; }
      else ++it;
    }
    if (awayOv >= 0 && raw.away == (awayOv == 1)) { awayOv = -1; changed = true; }
    for (auto it = switchOv.begin(); it != switchOv.end();) {
      const EntityValue* v = store.get(it->first);
      if (v && (v->state == "on") == it->second.on) { it = switchOv.erase(it); changed = true; }
      else ++it;
    }
    if (changed) commit("ack", true);
  }
  // give up on acks after 30 s / 10 s (show what Home Assistant reports)
  bool expired = false;
  for (auto it = setOverride.begin(); it != setOverride.end();) {
    auto p = pendingSince.find(it->first);
    if (!deb.pending(it->first) && p != pendingSince.end() && after(t, p->second + 30000)) { pendingSince.erase(p); it = setOverride.erase(it); expired = true; }
    else ++it;
  }
  for (auto it = lightOv.begin(); it != lightOv.end();) { if (after(t, it->second.until)) { it = lightOv.erase(it); expired = true; } else ++it; }
  if (awayOv >= 0 && after(t, awayOvUntil)) { awayOv = -1; expired = true; }
  for (auto it = switchOv.begin(); it != switchOv.end();) { if (after(t, it->second.until)) { it = switchOv.erase(it); expired = true; } else ++it; }
  if (expired) commit("ack", true);

  // clock: once a minute
  LocalTime lt = localTime();
  if (lt.known && lt.m != lastMinute) {
    bool first = lastMinute == -1;
    lastMinute = lt.m;
    // scheduled clean (#26): at :00/:30 the minute tick becomes one full refresh if anything was partially drawn
    if (!first && policy.cleanDue(board.epochSeconds() / 60, nightActive())) fullRefresh("clean screen");
    else if (!first) commit("clock", true);
  }
  // first data after (re)connecting: the "linked · live data" redraw happens at auth_ok, before subscribe_entities
  // answered — draw the snapshot once it has landed instead of showing "—" for a whole Live data interval (QEMU find).
  // The same after a new config or data source (#151): the new entity's state arrives a moment after the redraw.
  if (fresh && after(t, freshAt) && !nightActive() && !sleeping) {   // night/standby: keep it pending
    if (after(t, freshUntil)) fresh = false;
    else if (store.revision() != lastRev) {
      lastTick = t; freshAt = t + 1000;
      commit("HA update · new data");
      // done once no tile on the page waits for a value: live data goes back to its interval
      bool waiting = false;
      if (const Screen* sc = curScreen(); sc && menu == Menu::None)
        for (auto& w : sc->widgets) waiting |= ui::tileValue(*this, w) == "—";
      if (!waiting) fresh = false;
    }
  }
  // live data: at most once per interval, only when something arrived
  if (after(t, lastTick + uint32_t(std::max(1, set.intervalSec)) * 1000)) {
    lastTick = t;
    if (store.revision() != lastRev) {
      if (nightActive()) { note("HA update · night · not drawn"); }
      else if (!sleeping) commit("HA update");
    }
  }
}

void App::Impl::idleCheck() {
  if (mode != Mode::Main || sleeping || setup != Setup::None) return;
  int homeIdx = -1;
  for (int i = 0; i < int(cfg.screens.size()); ++i) if (cfg.screens[i].id == "overview") { homeIdx = i; break; }
  bool away = homeIdx >= 0 && (idx != homeIdx || sub != 0 || menu != Menu::None);
  uint32_t idle = ms() - lastInput;
  if (!lightOut && lightTimedOut(idle, set.lightTimeout)) { lightOut = true; applyFrontlight(); note("IDLE → front light off"); }
  bool amb = !ambient && ambientDue(idle, menu != Menu::None, false) && !nightActive();
  IdleDecision d = ::x4::idleCheck(idle, idleMinutes(set.standby), idleMinutes(set.returnHome), idleHomed, away);
  if (d.standby) { sleeping = true; menu = Menu::None; applyFrontlight(); note("IDLE → standby"); fullRefresh("standby"); return; }
  if (d.goHome) {
    idleHomed = true;
    if (amb) ambient = true;   // drawn by the screen change below
    if (nightActive()) { idx = homeIdx; sub = 0; menu = Menu::None; return; }
    goTo(homeIdx, "IDLE");
    return;
  }
  if (amb) { ambient = true; note("IDLE → ambient"); commit("ambient", true); }
}

void App::Impl::checkNight() {
  now = localTime();
  bool n = nightActive();
  if (nightKnown && n != prevNight) {
    if (n) {
      captureSnap();
      menu = Menu::None;
      applyFrontlight();
      note("NIGHT on · frontlight off · data redraws paused");
      fullRefresh("night face");
    } else if (!(peekUntil && int32_t(peekUntil - ms()) > 0)) {
      snap = NightSnap();
      applyFrontlight();
      fullRefresh("night end");
    }
  }
  prevNight = n; nightKnown = true;
}

void App::Impl::captureSnap() {
  HomeData d = derive();
  snap = NightSnap();
  if (d.inside.ok) snap.inside = fmtNum(d.inside.v, "°C") + "°";
  if (d.soc.ok) snap.batt = jsNumber(jsRound(d.soc.v)) + "%";
  int c = d.cheapestStart(3);
  if (c >= 0) snap.cheap = pad2(c) + ":00–" + pad2(c + 3) + ":00";
  int64_t last = svc.status().haLastDataEpoch;
  if (nightStale(board.epochSeconds(), last)) {
    time_t tt = time_t(last); struct tm tm; localtime_r(&tt, &tm);
    snap.asOf = pad2(tm.tm_hour) + ":" + pad2(tm.tm_min);
  }
  snap.taken = true;
}

void App::Impl::applyFrontlight() {
  board.setFrontlight(uint8_t(frontlightPct(set.brightness, sleeping || poweredOff, mode == Mode::Main && nightActive(), lightOut)), set.warmth);
}

void App::Impl::settingsChanged() {
  policy.setCleanEvery(set.cleanEvery);
  applyFrontlight();
  if (onSettings) onSettings(set);
}

void App::Impl::netChanged() {
  auto& st = svc.status();
  const Lang l = langOf(st.language);
  const NumFmt nf = numFormatOf(st.numberFormat, l == Lang::Nl);
  const std::string c = locale::currencySymbol(st.currency);
  // HA told us its language (#98), number format (#110) or currency (#147): redraw all
  const bool langChanged = l != lang || nf != numFmt || c != cur;
  lang = l;
  numFmt = nf;
  cur = c;
  setNumFormat(nf);
  locale::setCurrency(c);
  std::string sig = std::to_string(int(st.wifi)) + "|" + st.ssid + "|" + st.ip + "|" + std::to_string(int(st.ha)) + "|" +
                    std::to_string(int(st.ota)) + "|" + st.otaAvailableVersion + "|" + std::to_string(st.otaProgressPct / 10) + "|" +
                    st.pairingCode + "|" + std::to_string(st.otaNotes.size()) + "|" + st.haUrl + "|" + std::to_string(st.otaChecking) +
                    std::to_string(st.otaChecked) + "|" + std::to_string(st.otaLastCheckEpoch) + "|" + std::to_string(int(st.otaCheckErr)) + "|" + st.otaCheckMsg;
  if (sig == netSig) {
    if (langChanged && mode == Mode::Main) fullRefresh("language");
    return;
  }
  std::string prev = netSig;
  netSig = sig;
  if (prev.empty() || mode == Mode::Boot) return;
  int pw = std::atoi(prev.c_str());
  auto prevWifi = WifiState(pw);
  size_t p3 = 0; for (int k = 0; k < 3; ++k) p3 = prev.find('|', p3) + 1;
  auto prevHa = HaState(std::atoi(prev.c_str() + p3));
  size_t p4 = prev.find('|', p3) + 1;
  auto prevOta = OtaState(std::atoi(prev.c_str() + p4));

  // OTA install screen
  if (st.ota == OtaState::Downloading || st.ota == OtaState::Installing) {
    if (mode != Mode::Updating) {
      mode = Mode::Updating; menu = Menu::None; lastOtaPct = st.otaProgressPct / 10; lastOtaVer = st.otaAvailableVersion;
      fullRefresh("update screen");
    } else if (st.otaProgressPct / 10 != lastOtaPct || st.otaAvailableVersion != lastOtaVer) {
      lastOtaPct = st.otaProgressPct / 10; lastOtaVer = st.otaAvailableVersion; commit("progress", true);
    }
    return;
  }
  if (mode == Mode::Updating) { mode = Mode::Main; fullRefresh(st.ota == OtaState::Failed ? "update failed" : "update"); return; }
  (void)prevOta;

  // Wi-Fi connect results (setup step 1 or Settings › Wi-Fi)
  if (wview == WifiView::Connecting || setup == Setup::Wifi) {
    if (st.wifi == WifiState::Connected) {
      bool inSetup = setup == Setup::Wifi;
      wview = WifiView::List; wPw.clear(); wMsg.clear();
      if (inSetup) setup = st.ha == HaState::NeverLinked ? Setup::Web : Setup::None;
      fullRefresh(inSetup ? "setup: browser" : "wifi connected");
      return;
    }
    if (st.wifi == WifiState::WrongPassword && wview == WifiView::Connecting) {
      wview = WifiView::Pw; wPw.clear(); wMsg = t(S::pwWrong);
      fullRefresh("wifi password");
      return;
    }
  }
  // Home Assistant linked (setup step 2 or re-link)
  // The device goes Linking → Offline (key stored) → Connected (WebSocket up): remember the link across the Offline step.
  bool wasLinked = prevHa == HaState::Connected || prevHa == HaState::Offline;
  if (st.ha == HaState::Offline && !wasLinked) linkPending = true;
  if (st.ha != HaState::Connected && st.ha != HaState::Offline) linkPending = false;
  if (st.ha == HaState::Connected && prevHa != HaState::Connected) expectData(2000, 10000);
  if (st.ha == HaState::Connected && (!wasLinked || linkPending || setup == Setup::Web)) {
    linkPending = false;
    bool inSetup = setup == Setup::Web;
    setup = Setup::None; haView = HaView::Status;
    if (inSetup) { idx = 0; for (int i = 0; i < int(cfg.screens.size()); ++i) if (cfg.screens[i].id == "overview") { idx = i; break; } sub = 0; }
    fullRefresh(inSetup ? "welcome · live data" : "linked · live data");
    return;
  }
  // Wi-Fi came up while never linked → finish in the browser
  if (setup == Setup::None && mode == Mode::Main && st.wifi == WifiState::Connected && prevWifi != WifiState::Connected &&
      st.ha == HaState::NeverLinked) {
    setup = Setup::Web;
    fullRefresh("setup: browser");
    return;
  }
  if (langChanged) fullRefresh("language");
  else commit("status", true);
}

// ======================= actions =======================
void App::Impl::sendService(const std::string& domain, const std::string& service, const std::string& json) {
  note(domain + "." + service + " " + json);
  svc.callService(domain, service, json);
}

void App::Impl::setZone(const std::string& id, double delta) {
  if (offline()) { note("climate." + id + " not sent — offline"); return; }
  const ZoneState* z = data.zone(id);
  if (!z || !z->set.ok) return;
  double cur = setOverride.count(id) ? setOverride[id] : z->set.v;
  double v = std::max(5.0, std::min(25.0, std::round((cur + delta) * 10) / 10));
  setOverride[id] = v;
  pendingSince.erase(id);
  deb.touch(id, ms());
  commit("setpoint");
}

void App::Impl::toggleAway() {
  if (offline()) return;
  std::string ids;
  for (auto& z : data.zones) if (z.awayOk) ids += (ids.empty() ? "" : ",") + jsonQuote("climate." + z.id);   // #148
  if (ids.empty()) return;
  bool away = !data.away;
  awayOv = away; awayOvUntil = ms() + 10000;
  sendService("climate", "set_preset_mode", "{\"entity_id\":[" + ids + "],\"preset_mode\":\"" + (away ? "away" : "home") + "\"}");
  commit("presence");
}

void App::Impl::toggleLight(const std::string& id) {
  if (offline()) { note("light." + id + " not sent — offline"); return; }
  const LightState* l = data.light(id); if (!l) return;
  bool on = !l->on;
  lightOv[id] = LightOv{on, l->pct, ms() + 10000};
  sendService("light", on ? "turn_on" : "turn_off", "{\"entity_id\":\"light." + id + "\"}");
  commit("lights");
}

bool App::Impl::entityOn(const std::string& id, bool& known) const {
  auto ov = switchOv.find(id);
  if (ov != switchOv.end()) { known = true; return ov->second.on; }
  const EntityValue* v = store.get(id);
  known = entityAvailable(v);
  return known && v->state == "on";
}

void App::Impl::toggleEntity(const std::string& id) {
  if (offline()) { note(id + " not sent — offline"); return; }
  bool known = false;
  bool on = entityOn(id, known);
  if (!known) return;
  switchOv[id] = SwitchOv{!on, ms() + 10000};
  sendService(domainOf(id), "toggle", "{\"entity_id\":" + jsonQuote(id) + "}");
  commit("switch");
}

void App::Impl::dimLight(const std::string& id, int step) {
  if (offline()) return;
  const LightState* l = data.light(id); if (!l) return;
  int b = std::max(10, std::min(100, l->pct + step));
  lightOv[id] = LightOv{true, b, ms() + 10000};
  sendService("light", "turn_on", "{\"entity_id\":\"light." + id + "\",\"brightness_pct\":" + std::to_string(b) + "}");
  commit("lights");
}

// A room header's All on / All off: the lights the tile shows there (#127: a pick may show only some of the area).
void App::Impl::roomLights(const std::string& area, const std::vector<std::string>& ids) {
  if (offline()) return;
  bool anyOn = false;
  int inArea = 0;
  std::string list;
  for (auto& l : data.lights) inArea += l.area == area;
  for (auto& id : ids) {
    const LightState* l = data.light(id); if (!l) continue;
    anyOn |= l->on;
    list += (list.empty() ? "" : ",") + jsonQuote("light." + id);
  }
  for (auto& id : ids) if (const LightState* l = data.light(id)) lightOv[id] = LightOv{!anyOn, l->pct, ms() + 10000};
  sendService("light", anyOn ? "turn_off" : "turn_on",
              int(ids.size()) == inArea ? "{\"area_id\":" + jsonQuote(area) + "}" : "{\"entity_id\":[" + list + "]}");
  commit("lights");
}

void App::Impl::allOff() {
  if (offline()) return;
  for (auto& l : data.lights) lightOv[l.id] = LightOv{false, l.pct, ms() + 10000};
  sendService("light", "turn_off", "{\"entity_id\":\"all\"}");
  commit("lights");
}

// Scene tile (#146): scene.turn_on / script.turn_on; nothing on the panel changes. No entity: all lights off.
void App::Impl::runScene(const SceneAction& s) {
  if (s.entityId == "all") { allOff(); return; }
  if (offline()) { note(s.entityId + " not sent — offline"); return; }
  sendService(s.domain, s.service, "{\"entity_id\":" + jsonQuote(s.entityId) + "}");
}

void App::Impl::setCfg(const std::string& key, int dir) {
  auto stepList = [&](std::vector<std::string> steps, std::string& cur) {
    int i = int(std::find(steps.begin(), steps.end(), cur) - steps.begin());
    if (i >= int(steps.size())) i = -1;
    int j = std::max(0, std::min(int(steps.size()) - 1, i + dir));
    if (steps[j] == cur) return false;
    cur = steps[j]; return true;
  };
  bool ch = false;
  if (key == "brightness") { int v = std::max(0, std::min(100, set.brightness + dir * 10)); ch = v != set.brightness; set.brightness = uint8_t(v); }
  else if (key == "warmth") { int v = std::max(0, std::min(100, set.warmth + dir * 10)); ch = v != set.warmth; set.warmth = uint8_t(v); }
  else if (key == "lightTimeout") { std::string c = std::to_string(set.lightTimeout); ch = stepList({"30", "60", "120", "300", "0"}, c); if (ch) set.lightTimeout = std::atoi(c.c_str()); }
  else if (key == "night") ch = stepList({"off", "22-06", "23-07", "00-06"}, set.night);
  else if (key == "returnHome") { std::string c = std::to_string(idleMinutes(set.returnHome)); ch = stepList({"0", "1", "5", "15"}, c); if (ch) set.returnHome = c == "0" ? "never" : c; }
  else if (key == "standby") { std::string c = std::to_string(idleMinutes(set.standby)); ch = stepList({"0", "10", "30", "60"}, c); if (ch) set.standby = c == "0" ? "never" : c; }
  else if (key == "clock") ch = stepList({"24", "12"}, set.clock);
  else if (key == "interval") { std::string c = std::to_string(set.intervalSec); ch = stepList({"5", "10", "30", "60"}, c); if (ch) set.intervalSec = std::atoi(c.c_str()); }
  else if (key == "cleanEvery" || key == "fullEvery") { std::string c = std::to_string(set.cleanEvery); ch = stepList({"30", "60", "120"}, c); if (ch) set.cleanEvery = std::atoi(c.c_str()); }   // fullEvery: legacy tile key (#26)
  else if (key == "style") ch = stepList({"classic", "sleek"}, set.style);
  else if (key == "typeface") ch = stepList({"archivo", "bricolage", "fraunces", "geist"}, set.typeface);
  else if (key == "surface") ch = stepList({"dither", "dots"}, set.surface);
  else if (key == "powerSave") ch = stepList({"glance", "night", "standby", "off"}, set.powerSave);
  else if (key == "wakeEvery") { std::string c = std::to_string(set.wakeEvery); ch = stepList({"15", "30", "60"}, c); if (ch) set.wakeEvery = std::atoi(c.c_str()); }
  else if (key == "liveMin") { std::string c = std::to_string(set.liveMin); ch = stepList({"1", "3", "5", "10"}, c); if (ch) set.liveMin = std::atoi(c.c_str()); }
  if (!ch) return;
  note("SET " + key);
  settingsChanged();
  commit("setting");
}

void App::Impl::wifiPick(const WifiNetwork& n) {
  auto& st = svc.status();
  if (st.wifi == WifiState::Connected && st.ssid == n.ssid) return;
  if (!n.secure || n.saved) { wifiConnect(n.ssid, ""); return; }
  wview = WifiView::Pw; wTarget = n.ssid; wPw.clear(); wMsg.clear(); kb = Kb::Lower; wShow = false;
  navRefresh("keyboard");
}

void App::Impl::wifiConnect(const std::string& ssid, const std::string& pw) {
  bool secure = true, saved = false;
  for (auto& n : svc.wifiNetworks()) if (n.ssid == ssid) { secure = n.secure; saved = n.saved; }
  if (secure && !saved && pw.size() < 8) { wMsg = t(S::pwMin8); commit("field", true); return; }
  wview = WifiView::Connecting; wTarget = ssid; wMsg.clear();
  navRefresh("wifi connecting");
  svc.wifiConnect(ssid, pw);
}

void App::Impl::wifiKey(const std::string& k) {
  if (k == "BACK") {
    if (!wPw.empty()) { size_t i = wPw.size() - 1; while (i > 0 && (wPw[i] & 0xC0) == 0x80) --i; wPw.erase(i); }
    wMsg.clear(); commit("field", true); return;
  }
  if (k == "SHIFT") { kb = kb == Kb::Upper ? Kb::Lower : Kb::Upper; commit("keyboard", true); return; }
  if (k == "NUMS") { kb = kb == Kb::Nums ? Kb::Lower : Kb::Nums; commit("keyboard", true); return; }
  if (k == "SHOW") { wShow = !wShow; commit("field", true); return; }
  if (k == "OK") { wifiConnect(wTarget, wPw); return; }
  if (wPw.size() >= 63) return;
  wPw += k == "SPACE" ? std::string(" ") : k;
  wMsg.clear();
  if (kb == Kb::Upper) kb = Kb::Lower;
  commit("field", true);
}

void App::Impl::wifiCancel() { wview = WifiView::List; wPw.clear(); wMsg.clear(); navRefresh("networks"); }
void App::Impl::wifiScan() { if (wScanning) return; wScanning = true; scanUntil = ms() + 1500; svc.wifiScan(); commit("scan", true); }
void App::Impl::wifiPhone() { wview = WifiView::Phone; svc.startSoftAp(); fullRefresh("phone setup"); }
void App::Impl::changeWifi() { setup = Setup::Wifi; wview = WifiView::List; svc.wifiScan(); fullRefresh("setup: Wi-Fi"); }
void App::Impl::wifiDisconnect() { note("TOUCH wifi disconnect"); svc.wifiDisconnect(); commit("wifi"); }
void App::Impl::haReconnect() { note("TOUCH reconnect HA"); svc.haReconnect(); commit("home assistant", true); }
void App::Impl::haUnlink() { note("TOUCH unlink HA"); svc.haUnlink(); commit("home assistant"); }
void App::Impl::haOpenLink() { haView = HaView::Link; fullRefresh("link"); }
void App::Impl::haCancel() { haView = HaView::Status; fullRefresh("home assistant"); }
void App::Impl::linkFromCard() {
  int hi = -1;
  for (int i = 0; i < int(cfg.screens.size()); ++i) if (cfg.screens[i].id == "ha") { hi = i; break; }
  if (hi < 0) return;
  idx = hi; sub = 0; menu = Menu::None; haView = HaView::Link;
  fullRefresh("link");
}
void App::Impl::otaChannel(const std::string& k) { if (set.otaChannel == k) return; set.otaChannel = k; otaMsg.clear(); otaBlocked = false; otaOffline = false; settingsChanged(); commit("channel", true); }
void App::Impl::otaAuto(const std::string& k) { if (set.otaAuto == k) return; set.otaAuto = k; settingsChanged(); commit("setting", true); }
void App::Impl::otaAction() {
  auto& st = svc.status();
  if (st.ota == OtaState::Available) {
    int batt = board.power().batteryPct;
    if (batt < 30) { otaBlocked = true; otaMsg = t(S::otaLowBatteryMsg, std::to_string(batt)); commit("update status", true); return; }
    if (st.wifi != WifiState::Connected) { otaMsg = t(S::noNetwork); commit("update status", true); return; }
    otaBlocked = false; otaMsg.clear();
    svc.otaInstall();
    return;
  }
  if (st.otaChecksOff) return;   // no button is drawn; nothing to check against
  if (st.otaChecking) { note("TOUCH check · already checking"); return; }
  otaMsg.clear(); otaBlocked = false;
  otaOffline = st.wifi != WifiState::Connected;
  if (!otaOffline) svc.otaCheck();   // "Checking…" arrives with the status change (netChanged → partial)
  commit("update status", true);
}
void App::Impl::restart() { note("TOUCH restart"); board.restart(); }
void App::offerRecovery() {
  impl_->recovery = recoveryOffer(impl_->ms());
  impl_->recoveryDone(RecoveryAction::Show);
}
void App::Impl::recoveryDone(RecoveryAction a) {
  input();
  if (a == RecoveryAction::Show) { note(recovery.crash ? "CRASH LOOP · reset screen" : "BTN_POWER+BTN_NEXT 5 s · reset screen"); fullRefresh("factory reset?"); return; }
  if (a == RecoveryAction::Reset) { note("BTN_NEXT · FACTORY RESET"); svc.factoryReset(); return; }
  if (a == RecoveryAction::Press) {   // #258: a short Power press
    if (poweredOff) { note("BTN_POWER · power on (restart)"); board.restart(); return; }
    power();
    return;
  }
  if (a == RecoveryAction::Off) { powerOff(); return; }
  if (a == RecoveryAction::Restart) {   // #226: the panel says so first (a blocking full refresh), then the touch path
    note("BTN_POWER+BTN_PREV 5 s · restart");
    boot(t(S::bootRestarting));
    board.restart();
    return;
  }
  note(a == RecoveryAction::Timeout ? "reset screen timed out" : "reset screen cancelled");
  fullRefresh("reset cancelled");
}
void App::Impl::resetTap() {
  if (resetArm) { resetArm = false; note("FACTORY RESET"); svc.factoryReset(); return; }
  resetArm = true; resetArmUntil = ms() + 5000;
  commit("1 tile");
}

}  // namespace x4
