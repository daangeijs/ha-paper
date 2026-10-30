#include "net/power.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_attr.h>
#include <esp_sleep.h>
#include <esp_system.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <ctime>
#include <mutex>
#include <string>
#include <vector>

#include "Logging.h"
#include "core/battery_history.h"
#include "core/phases.h"
#include "core/power.h"
#include "core/power_profile.h"
#include "core/power_trail.h"
#include "core/recovery.h"
#include "net/diag.h"
#include "net/ha_client.h"
#include "net/health.h"
#include "net/hub.h"
#include "net/ota.h"
#include "net/storage.h"
#include "net/util.h"
#include "net/wifi_mgr.h"

namespace x4::net {

namespace {
RTC_NOINIT_ATTR glance::Rtc g_rtc;   // survives deep sleep and esp_restart(); garbage after power-on (checksum)
std::mutex g_rtcMu;

WakeKind g_wake = WakeKind::Cold;
bool g_simWake = false;
bool g_glance = false;                // this boot is a glance wake: the panel is held until the decision
bool g_wakeHold = false;              // #299: key wake from glance sleep: no boot screen, panel held until the data is in
std::atomic<const char*> g_mode{"awake"};
std::atomic<int> g_armLeft{glance::kArmBoots};
glance::ArmRecord g_arm;
bool g_armCounted = false;
std::atomic<const char*> g_armedBy{nullptr};   // glance::armedBy(g_arm), for the web task
uint32_t g_netUpMs = 0, g_netSeenMs = 0;       // this boot's time with the network up (#231 uptime arming)
std::mutex g_battMu;                           // g_batt: main task writes, web task reads (/diagnostics)
batt::History g_batt;
std::function<void(int64_t)> g_sleepFn;

uint32_t g_bootMs = 0, g_lastCheckMs = 0, g_holdUntilMs = 0;
bool g_holdChecked = false, g_hold = false;
const char* g_lastReason = "";
uint32_t g_applied = 0, g_appliedAtMs = 0;
ChargeMemory g_charged;                // STAT last on; a USB host unplug forgets it (#249)
uint32_t g_wifiAtMs = glance::kNoMs, g_haAtMs = glance::kNoMs;   // glance wake: since the reset (#178 timings)
std::atomic<int64_t> g_sleepReqS{0};   // POST /device/sleep: seconds, picked up by powerLoop (#178)
std::atomic<uint32_t> g_sleepReqMs{0};
std::mutex g_inMu;                     // last inputs(), for the web task's sleep check
PowerInputs g_lastIn;
bool g_lastInOk = false;
uint32_t g_lastInMs = 0;
std::atomic<uint32_t> g_bootFull{0}, g_bootPartial{0}, g_bootFast{0};   // App::Stats of this boot, for /status (web task)
std::string g_trail;                   // contents of kTrailFile (main task only)
std::mutex g_trailMu;                  // g_trailLines / g_trailBefore: main task writes, web task reads (/diagnostics)
std::vector<std::string> g_trailLines;
std::string g_trailBefore;             // last trail line when this boot started
bool g_standbyLogged = false;          // last standby face state logged
uint32_t g_powerDownMs = 0;            // Power key held since (heldKeys), valid when g_powerDown
bool g_powerDown = false;
uint32_t g_resetMs = 0;                // QEMU: millis() keeps counting through esp_restart; hardware: 0
uint32_t sinceReset() { return millis() - g_resetMs; }

ProfileGate g_profile;                 // CPU / Wi-Fi profile in force (#177), switched after 2 s steady (#249)
std::atomic<int> g_cpuMhz{240};
std::atomic<bool> g_psMin{true};

// #327 awake phases: marks since the reset (main task writes, web task reads), this boot's draw time and gauge
std::atomic<uint32_t> g_markBoot{phases::kNoMs}, g_markWifi{phases::kNoMs}, g_markHa{phases::kNoMs}, g_drawAtHa{0};
std::atomic<uint32_t> g_renderMs{0}, g_panelMs{0};
std::atomic<int> g_pct{-1}, g_raw{-1}, g_mv{-1};

constexpr uint32_t kCheckMs = 1000;         // live mode: power rules once a second
constexpr uint32_t kAwakeMinMs = 5000;      // awake at least this long after a boot (same pacing as the emulator)
constexpr uint32_t kArmUpMs = 60000;        // a boot counts once it ran 60 s with the network up (OTA confirm rule)
constexpr uint32_t kArmUptimeMs = uint32_t(glance::kArmUptimeMin * 60000);   // #231: or 30 min online in one boot
constexpr uint32_t kSettleQuietMs = 1500;   // glance: HA data is in once no entity update came for this long
constexpr uint32_t kWakeHoldMaxMs = 8000;   // #299 key wake: the panel waits at most this long for the data
constexpr int64_t kWakeKeyMs = 1500;        // #299 key wake: a press after this releases the panel (not the wake press)
constexpr uint32_t kHoldWindowMs = 3000;    // a Right key held this early in the boot keeps it live
constexpr int64_t kSaneEpoch = 1700000000;
constexpr uint32_t kLongPressLogMs = 1000;  // Power held this long or more: logged on release (#225)
constexpr size_t kTrailShown = 8;           // /diagnostics power_trail.lines and the POWERON log line
constexpr const char* kTrailFile = "/power.txt";   // core/power_trail.h: last power transition, survives a power loss
constexpr uint32_t kSleepReqDelayMs = 500;  // POST /device/sleep: let the 202 leave before Wi-Fi goes off
#if X4_QEMU
constexpr uint32_t kQemuSleepMaxMs = 8000;  // simulated deep sleep: real waits would be minutes (sim/qemu/glance-test.sh)
#endif

void seal() { glance::seal(g_rtc); }

char wakeChar(WakeKind w) {
  switch (w) {
    case WakeKind::Timer: return 't';
    case WakeKind::Button: return 'b';
    case WakeKind::Charger: return 'h';
    case WakeKind::Other: return 'o';
    default: return 'c';
  }
}

// #327: this boot so far (any task)
phases::Rec phasesNow(int64_t epoch) {
  phases::Marks m;
  m.bootMs = g_markBoot;
  m.wifiMs = g_markWifi;
  m.haMs = g_markHa;
  m.drawAtHaMs = g_drawAtHa;
  phases::Rec r = phases::measure(m, sinceReset(), g_renderMs, g_panelMs);
  r.epoch = epoch > kSaneEpoch ? uint32_t(epoch) : 0;
  r.pct = int8_t(g_pct.load());
  r.raw = int8_t(g_raw.load());
  r.mv = int16_t(g_mv.load());
  r.wake = wakeChar(g_wake);
  return r;
}

// #327: phase marks, every powerLoop pass until all are set
void markPhases(App& app) {
  const App::Stats st = app.stats();
  g_renderMs = st.renderMs;
  g_panelMs = st.panelMs;
  if (g_markHa != phases::kNoMs) return;
  const uint32_t t = sinceReset();
  if (g_markBoot == phases::kNoMs) g_markBoot = t;   // first pass: setup() is done
  if (g_markWifi == phases::kNoMs) {
    if (!netConnected()) return;
    g_markWifi = t;
  }
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  if (hub().status.ha != HaState::Connected || hub().entitiesApplied == 0) return;
  g_drawAtHa = st.renderMs + st.panelMs;
  g_markHa = t;
}

const char* reasonOf(WakeKind w) {
  switch (w) {
    case WakeKind::Timer: return "timer";
    case WakeKind::Button: return "button";
    case WakeKind::Charger: return "charger";
    case WakeKind::Other: return "other";
    default: return "cold";
  }
}

void loadArm() {
  std::string text;
  glance::ArmRecord stored;
  bool have = false;
  if (storage().readFile("/arm.json", text)) {
    JsonDocument d;
    if (!deserializeJson(d, text) && d["version"].is<const char*>() && d["boots"].is<int>()) {
      stored.version = d["version"].as<const char*>();
      stored.boots = d["boots"].as<int>();
      stored.uptime = d["uptime"] | false;
      have = true;
    }
  }
  g_arm = glance::armFor(have ? &stored : nullptr, firmwareVersion());
  g_armLeft = glance::armBootsLeft(g_arm);
  g_armedBy = glance::armedBy(g_arm);
}

// Stores g_arm (userdata, at most kArmBoots + 1 writes per firmware version) and logs the moment it arms.
void saveArm(const glance::ArmRecord& next) {
  const bool arms = glance::armBootsLeft(g_arm) > 0 && glance::armBootsLeft(next) == 0;
  g_arm = next;
  JsonDocument d;
  d["version"] = g_arm.version;
  d["boots"] = g_arm.boots;
  if (g_arm.uptime) d["uptime"] = true;
  std::string out;
  serializeJson(d, out);
  storage().writeFile("/arm.json", out);
  g_armLeft = glance::armBootsLeft(g_arm);
  g_armedBy = glance::armedBy(g_arm);
  if (arms) LOG_INF("POWER", "sleep armed · %s", glance::armReason(g_arm).c_str());
}

void countArm() {
  g_armCounted = true;
  if (glance::armBootsLeft(g_arm) == 0) return;
  saveArm(glance::armCount(g_arm));
  LOG_INF("POWER", "confirmed boot %d/%d with network · %s", g_arm.boots, glance::kArmBoots,
          g_armLeft ? "deep sleep not armed yet" : "deep sleep armed");
}

// #231: a fresh flash or OTA that never restarts arms after 30 min online with the image confirmed.
void uptimeArm(uint32_t now) {
  if (netConnected()) g_netUpMs += now - g_netSeenMs;
  g_netSeenMs = now;
  if (g_netUpMs < kArmUptimeMs || glance::armBootsLeft(g_arm) == 0) return;
  const glance::ArmRecord next = glance::armUptime(g_arm, g_netUpMs / 60000.0, otaPendingVerify());
  if (next.uptime != g_arm.uptime) saveArm(next);
}

// #231: battery history + [BATT] line, once per power-rules pass (inputs() already read the gauge).
void battSample(const PowerInputs& in, uint32_t now) {
  batt::In b;
  b.ms = now;
  b.epoch = in.nowEpoch;
  b.pct = in.battery;
  b.mv = in.voltage > 0 ? int(in.voltage * 1000 + 0.5) : -1;
  b.chg = in.charging;
  b.usb = in.usb;
  b.power = g_glance ? "glance" : powerDecision(in).reason;
  int dbm = 0;
  if (wifiRssi(dbm)) b.rssi = dbm;
  std::string line;
  {
    std::lock_guard<std::mutex> l(g_battMu);
    line = g_batt.step(b);
  }
  if (!line.empty()) LOG_INF("BATT", "%s", line.c_str());
}

int armLeftNow() {
#if X4_QEMU
  if (g_rtc.simArmed) return 0;
#endif
  return g_armLeft;
}

PowerInputs inputs(App& app, Board& board) {
  const uint32_t now = millis();
  const DisplaySettings& s = app.settings();
  const App::PowerView v = app.powerView();
  const PowerInfo p = board.power();
  PowerInputs i;
  const int64_t epoch = board.epochSeconds();
  i.nowEpoch = epoch;
  if (epoch > kSaneEpoch) {
    const time_t t = time_t(epoch);
    struct tm lt;
    localtime_r(&t, &lt);
    i.localSec = lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec;
  } else {
    i.localSec = 12 * 3600;   // clock unknown: noon (no quiet hours, no OTA hour); the timer still counts seconds
  }
  parsePowerSave(s.powerSave, i.powerSave);
  i.wakeEvery = s.wakeEvery;
  i.quiet = s.quiet;
  i.peeking = v.peeking;
  i.standby = v.standby;
  i.charging = p.charging;
  i.usb = p.usb;   // USB host seen (HWCDC): external power, never sleeps
  i.battery = p.known ? int(p.batteryPct) : -1;
  // STAT drops when the cell is full: charged within 30 min and VCELL ≥ 4.15 V still counts as a charger (#73).
  // Since boot only; a deep-sleep wake starts at "not charged". Unplugging a USB host forgets it (#249).
  g_charged.step(p.charging, p.usb, now);
  i.chargedAgoMin = g_charged.agoMin(now);
  i.voltage = p.mv ? p.mv / 1000.0 : -1;
  g_pct = i.battery;
  g_raw = p.known ? int(p.rawPct) : -1;
  g_mv = p.mv ? int(p.mv) : -1;
  i.otaPendingVerify = otaPendingVerify();
  i.otaBusy = otaBusy();
  i.otaAuto = s.otaAuto == "off" ? OtaAuto::Off : s.otaAuto == "night" ? OtaAuto::Night : OtaAuto::Notify;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    i.otaDue = hub().status.ota == OtaState::Available && i.otaAuto == OtaAuto::Night && !hub().status.otaChecksOff;
    i.setup = v.setup || hub().softAp;
    i.msSinceApi = hub().apiUsed ? int64_t(now - hub().lastApiMs) : -1;
  }
  // a boot that is not a timer wake (power-on, Power/Right key, charger) counts as a key press: live for liveMin
  const int64_t sinceInput = v.msSinceUserInput >= 0 || g_wake == WakeKind::Timer ? v.msSinceUserInput : int64_t(now - g_bootMs);
  i.live = glance::liveNow(sinceInput, s.liveMin) || (g_hold && int32_t(now - g_holdUntilMs) < 0);
  i.glanceFails = g_rtc.fails;
  i.armBootsLeft = armLeftNow();
  i.emptyHouse = v.emptyHouse;   // #331: the presence source says nobody is home
  return i;
}

std::vector<uint32_t> clockKeys(App& app) {
  std::vector<uint32_t> v;
  for (auto& k : app.clockRegions()) v.push_back(glance::fnv1a(k));
  return v;
}

// #177: CPU clock and Wi-Fi modem sleep from the power rules, live mode only (a glance wake keeps 240 MHz / min: it
// is seconds long and most of it is TLS). 240 ↔ 80 MHz leaves APB at 80 MHz, so a peripheral mid-transfer on another
// task (SPI to the panel, I2C, UART, LEDC) keeps its clock. Wi-Fi PS goes through wifiPsSet: an OTA / TLS hold wins.
// #249: re-evaluated every check, so a plug / unplug switches it; a change waits kProfileSettleMs (USB flapping).
void applyProfile(const PowerDecision& d, uint32_t now) {
  const bool changed = g_profile.step(profileOf(d), now);
  const PowerProfile& p = g_profile.applied();
  const int mhz = cpuMhzFor(p.cpu);
  const bool min = p.ps == WifiPs::Min;
  [[maybe_unused]] const bool inEffect = wifiPsSet(min);   // every check: also re-applies after a Wi-Fi restart reset the driver's mode
  if (changed) {
#if X4_QEMU
    LOG_INF("POWER", "[qemu] profile %s · CPU %d MHz · Wi-Fi PS %s (%s) · not applied, no clocks or radio",
            p.external ? "external" : "battery", mhz, wifiPsName(p.ps), d.reason);
#else
    if (int(getCpuFrequencyMhz()) != mhz && !setCpuFrequencyMhz(uint32_t(mhz)))
      LOG_WRN("POWER", "CPU %d MHz refused · stays %u MHz", mhz, unsigned(getCpuFrequencyMhz()));
    LOG_INF("POWER", "profile %s · CPU %u MHz · Wi-Fi PS %s (%s)%s", p.external ? "external" : "battery",
            unsigned(getCpuFrequencyMhz()), wifiPsName(p.ps), d.reason, inEffect ? "" : " · PS held off (OTA / TLS) until it ends");
#endif
    g_cpuMhz = mhz;
  }
  g_psMin = min;
}

void trailShown() {
  auto l = powertrail::lastLines(g_trail, kTrailShown);
  std::lock_guard<std::mutex> g(g_trailMu);
  g_trailLines = std::move(l);
}

// t = the whole new file (core/power_trail.h); writeFile closes and renames it, so it survives a power cut after this
void writeTrail(const std::string& t) {
  if (t.empty()) return;
  if (!storage().writeFile(kTrailFile, t)) {
    LOG_WRN("POWER", "could not write %s", kTrailFile);
    return;
  }
  g_trail = t;
  trailShown();
}

void leaveGlance(App& app, const char* why) {
  g_glance = false;
  writeTrail(powertrail::awakeWrite(g_trail));
  g_mode = "awake";
  LOG_INF("POWER", "glance wake → live (%s)", why);
  app.markAsleep(false);
  app.redraw(std::string("live · ") + why);
}

[[noreturn]] void enterSleep(const PowerDecision& d, App& app, Board& board) {
  app.markAsleep(true);   // #299: no live-looking clock on the sleeping panel (quiet face: no clock, nothing drawn)
  const int64_t epoch = board.epochSeconds();
  const int64_t secs = d.buttonWakeOnly ? 0 : std::max<int64_t>(1, d.wakeAtEpoch - epoch);
  phases::Rec rec;
  {
    std::lock_guard<std::mutex> l(g_rtcMu);
    g_rtc.sleptAtEpoch = epoch;
    g_rtc.wakeAtEpoch = d.buttonWakeOnly ? 0 : d.wakeAtEpoch;
    glance::tallySleep(g_rtc.tally, sinceReset(), app.stats().fullRefreshes, app.stats().partialRefreshes);
    if (strcmp(d.reason, "empty house") == 0) ++g_rtc.emptySleeps;   // #331
    rec = phasesNow(epoch);
    phases::push(g_rtc.wakes, rec);
    seal();
  }
  LOG_INF("POWER", "awake phases · %s · %d%% (gauge %d%%) %d mV", phases::line(rec).c_str(), rec.pct, rec.raw, rec.mv);
  writeTrail(powertrail::sleepWrite(g_trail, d.reason));
  if (secs) LOG_INF("POWER", "deep sleep (%s) · timer wake in %lld s", d.reason, static_cast<long long>(secs));
  else LOG_INF("POWER", "deep sleep (%s) · Power / Right key or charger only", d.reason);
  // WebSocket closed and Wi-Fi off on the net task (it owns them); give it a second
  std::atomic<bool> done{false};
  hub().post([&done] {
    haClient().stop();
#if !X4_QEMU
    wifiMgr().stopMdns("sleep");   // #326: before the STA netif is destroyed
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
#endif
    done = true;
  });
  for (uint32_t t0 = millis(); !done && millis() - t0 < 1000;) delay(10);
  Serial.flush();
#if X4_QEMU
  // No deep sleep in QEMU: wait a little (a key = button wake), leave the wake cause in RTC memory, reset.
  glance::SimWake why = glance::SimWake::Timer;
  const uint32_t ms = secs ? uint32_t(std::min<int64_t>(secs * 1000, kQemuSleepMaxMs)) : kQemuSleepMaxMs;
  for (uint32_t t0 = millis(); millis() - t0 < ms;) {
    InputEvent e;
    if (board.pollInput(e) && e.kind == InputEvent::Kind::KeyDown && (e.key == Key::Power || e.key == Key::Next)) {
      why = glance::SimWake::Button;
      break;
    }
    if (!g_rtc.simBattery) { why = glance::SimWake::Charger; break; }   // "plugged in" while asleep
    delay(50);
  }
  {
    std::lock_guard<std::mutex> l(g_rtcMu);
    g_rtc.simWake = why;
    seal();
  }
  LOG_INF("POWER", "[qemu] simulated deep sleep over · wake %s · esp_restart()", why == glance::SimWake::Timer ? "timer" : why == glance::SimWake::Button ? "button" : "charger");
  Serial.flush();
  esp_restart();
#else
  if (g_sleepFn) g_sleepFn(secs);
  esp_restart();   // no sleep function: never stay up half-shut-down
#endif
}

void glanceLoop(App& app, Board& board) {
  const uint32_t now = millis();
  const App::PowerView v = app.powerView();
  if (v.msSinceUserInput >= 0) return leaveGlance(app, "key press");
  HaState ha;
  uint32_t applied;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    ha = hub().status.ha;
    applied = hub().entitiesApplied;
  }
  if (applied != g_applied) { g_applied = applied; g_appliedAtMs = now; }
  if (g_wifiAtMs == glance::kNoMs && netConnected()) g_wifiAtMs = sinceReset();
  if (g_haAtMs == glance::kNoMs && g_wifiAtMs != glance::kNoMs && ha == HaState::Connected) g_haAtMs = sinceReset();
  const bool settled = v.main && ha == HaState::Connected && applied > 0 && now - g_appliedAtMs >= kSettleQuietMs;
  const bool capped = now - g_bootMs >= glance::kAwakeCapMs;
  if (!settled && !capped) return;
  app.settle();
  const glance::Snapshot snap = glance::snapshotOf(app.regionSignatures());
  const int64_t epoch = board.epochSeconds();
  glance::StepOut out;
  size_t changed = 0;
  {
    std::lock_guard<std::mutex> l(g_rtcMu);
    // unsettled too (#356): a transition wake moves the face itself (its date at midnight, the quiet face)
    changed = glance::snapshotDiff(g_rtc.hasSnap ? &g_rtc.snap : nullptr, snap, clockKeys(app)).size();
    const double minSince = epoch > kSaneEpoch && g_rtc.drawnAtEpoch > 0 ? double(epoch - g_rtc.drawnAtEpoch) / 60.0 : 0;
    out = glance::step({settled, int(changed), g_rtc.hasSnap, g_rtc.fails, g_rtc.drawnOffline, minSince});
    g_rtc.fails = uint8_t(std::min(out.fails, 255));
    g_rtc.drawnOffline = out.drawnOffline;
    if (out.redraw) {
      g_rtc.snap = snap;
      g_rtc.hasSnap = true;
      g_rtc.drawnAtEpoch = epoch > kSaneEpoch ? epoch : 0;
    }
    const uint32_t haMs = g_haAtMs == glance::kNoMs ? glance::kNoMs : g_haAtMs - g_wifiAtMs;
    glance::tallyGlance(g_rtc.tally, settled, out.redraw, g_wifiAtMs, haMs, sinceReset());
    seal();
  }
  LOG_INF("POWER", "glance wake · %u ms · Wi-Fi %d ms · HA %d ms · %s · %u region(s) changed · %s", unsigned(sinceReset()),
          g_wifiAtMs == glance::kNoMs ? -1 : int(g_wifiAtMs), g_haAtMs == glance::kNoMs ? -1 : int(g_haAtMs - g_wifiAtMs),
          settled ? "HA data in" : "HA unreachable", unsigned(changed), out.redraw ? out.reason : "no refresh");
  if (out.redraw) {
    const uint32_t before = app.stats().fullRefreshes;
    app.redraw(out.reason);
    LOG_INF("POWER", "glance redraw · %u full refresh (%s)", unsigned(app.stats().fullRefreshes - before), out.reason);
  }
  const PowerDecision d = powerDecision(inputs(app, board));
  if (!d.deepSleepNow) return leaveGlance(app, d.reason);
  enterSleep(d, app, board);
}

// #299 key wake from glance sleep: the dashboard is still on the glass and the controller RAM is gone (no partial
// possible), so no boot screen: the panel stays held until the data is in (or a later key, or the cap), then one clean
// refresh. Before: boot screen (clean) + dashboard (clean) + partials as the data came in, which looked like a restart.
void wakeHoldLoop(App& app, uint32_t now) {
  const App::PowerView v = app.powerView();
  if (!v.main) return;
  HaState ha;
  uint32_t applied;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    ha = hub().status.ha;
    applied = hub().entitiesApplied;
  }
  if (applied != g_applied) { g_applied = applied; g_appliedAtMs = now; }
  const int64_t up = int64_t(now - g_bootMs);
  const char* why = nullptr;
  if (v.setup) why = "setup";
  else if (ha == HaState::Connected && applied > 0 && now - g_appliedAtMs >= kSettleQuietMs) why = "data in";
  else if (v.msSinceUserInput >= 0 && v.msSinceUserInput <= up - kWakeKeyMs) why = "key press";
  else if (up >= int64_t(kWakeHoldMaxMs)) why = "cap";
  if (!why) return;
  g_wakeHold = false;
  LOG_INF("POWER", "key wake · panel released after %lld ms (%s)", static_cast<long long>(up), why);
  app.redraw(std::string("key wake · ") + why);
}

// the next timer wake compares against what the panel shows now
void snapshotForSleep(App& app, Board& board) {
  app.prepareSleep();
  app.markAsleep(true);   // the snapshot holds what the sleeping panel shows
  const glance::Snapshot snap = glance::snapshotOf(app.regionSignatures());
  const int64_t epoch = board.epochSeconds();
  std::lock_guard<std::mutex> l(g_rtcMu);
  g_rtc.snap = snap;
  g_rtc.hasSnap = true;
  g_rtc.drawnAtEpoch = epoch > kSaneEpoch ? epoch : 0;
  g_rtc.fails = 0;
  g_rtc.drawnOffline = false;
  seal();
}

// POST /device/sleep, on the main task: checked again with fresh inputs, then deep sleep now
void sleepRequested(App& app, Board& board, int64_t secs) {
  const SleepNowCheck c = sleepNowCheck(true, double(secs), inputs(app, board));
  if (c.status != 202) {
    LOG_WRN("POWER", "sleep request dropped: %s", c.error.c_str());
    return;
  }
  if (app.settings().powerSave == "glance") snapshotForSleep(app, board);
  PowerDecision d;
  d.deepSleepNow = true;
  d.wakeAtEpoch = board.epochSeconds() + secs;   // clock unknown: epoch 0, enterSleep still sleeps secs
  d.reason = "api sleep";
  enterSleep(d, app, board);
}
}  // namespace

void powerEarlyBoot() {
  std::lock_guard<std::mutex> l(g_rtcMu);
  if (!glance::valid(g_rtc)) glance::reset(g_rtc);
#if X4_QEMU
  g_simWake = g_rtc.simWake != glance::SimWake::None && esp_reset_reason() == ESP_RST_SW;
  if (g_simWake) {
    g_wake = g_rtc.simWake == glance::SimWake::Timer ? WakeKind::Timer
             : g_rtc.simWake == glance::SimWake::Button ? WakeKind::Button : WakeKind::Charger;
  }
  g_rtc.simWake = glance::SimWake::None;
  const bool woke = g_simWake;
  g_resetMs = millis();
#else
  const bool woke = esp_reset_reason() == ESP_RST_DEEPSLEEP;
  if (woke) {
    switch (esp_sleep_get_wakeup_cause()) {
      case ESP_SLEEP_WAKEUP_TIMER: g_wake = WakeKind::Timer; break;
      case ESP_SLEEP_WAKEUP_EXT1: g_wake = WakeKind::Button; break;
      case ESP_SLEEP_WAKEUP_EXT0: g_wake = WakeKind::Charger; break;
      default: g_wake = WakeKind::Other; break;
    }
  }
#endif
  if (woke) {   // the RTC timer keeps time() through deep sleep (and esp_restart)
    const time_t t = time(nullptr);
    glance::tallyWake(g_rtc.tally, glance::sleptSeconds(g_rtc.sleptAtEpoch, g_rtc.wakeAtEpoch, t > kSaneEpoch ? int64_t(t) : 0));
  }
  seal();
}

bool powerSimulatedWake() { return g_simWake; }
WakeKind powerWake() { return g_wake; }
const char* powerWakeName() { return reasonOf(g_wake); }

bool powerBegin(const DisplaySettings& s) {
  g_bootMs = g_netSeenMs = millis();
  loadArm();
  g_glance = g_wake == WakeKind::Timer && s.powerSave == "glance";
  {
    std::lock_guard<std::mutex> l(g_rtcMu);
    g_wakeHold = g_wake == WakeKind::Button && s.powerSave == "glance" && g_rtc.hasSnap;   // dashboard on the glass
  }
  g_mode = g_glance ? "glance" : "awake";
  LOG_INF("POWER", "wake: %s · %s · first-boot safety: %d boot(s) left", powerWakeName(),
          g_glance ? "glance (panel held, no boot screen)" : g_wakeHold ? "live (panel held until data, no boot screen)" : "live",
          armLeftNow());
  if (!storage().readFile(kTrailFile, g_trail)) g_trail.clear();
  {
    std::lock_guard<std::mutex> g(g_trailMu);
    g_trailBefore = powertrail::lastLine(g_trail);
  }
  trailShown();
  std::string last;   // newest stages of the previous boot, oldest first: "key … | standby drawn …"
  for (auto& l : powertrail::lastLines(g_trail, 4)) last += (last.empty() ? "" : " | ") + l;
  switch (powertrail::verdict(g_trail, diagResetReason())) {
    case powertrail::Verdict::LostAsleep:
      LOG_WRN("POWER", "power was lost while asleep: the previous boot entered deep sleep (%s), this one is a POWERON",
              powertrail::lastLine(g_trail).c_str() + 6);
      break;
    case powertrail::Verdict::LostAwake:
      LOG_INF("POWER", "power-on after running: battery empty, power cut, or USB plugged into a board that was off · last trail: %s",
              last.c_str());
      break;
    case powertrail::Verdict::None: break;
  }
  if (!g_glance) writeTrail(powertrail::awakeWrite(g_trail));
  return g_glance || g_wakeHold;
}

void powerOnSleep(std::function<void(int64_t)> fn) { g_sleepFn = std::move(fn); }

void powerLoop(App& app, Board& board) {
  const uint32_t now = millis();
  // Right held through the boot screen: live for 10 min (the way out if sleeping goes wrong on some unit)
  if (!g_holdChecked) {
    if (board.heldKeys() & kKeyRight) {
      g_holdChecked = g_hold = true;
      g_holdUntilMs = now + uint32_t(glance::kBootHoldLiveMin) * 60000;
      LOG_WRN("POWER", "Right held at boot · live for %d min, no deep sleep", glance::kBootHoldLiveMin);
      if (g_glance) leaveGlance(app, "key held");
    } else if (now - g_bootMs >= kHoldWindowMs) {
      g_holdChecked = true;
    }
  }
  // Power key: every press and how long it was held (no long-press power-off: #225, docs/HARDWARE_ASSUMPTIONS.md A41)
  // Down from the KeyDown stage (powerKeyStage) or the GPIO; the release is seen at the first pass after it, so a
  // press released during the standby refresh reads as held up to the refresh time.
  const bool powerDown = board.heldKeys() & kKeyPower;
  if (powerDown && !g_powerDown) g_powerDownMs = now;
  if (!powerDown && g_powerDown) {
    const uint32_t held = now - g_powerDownMs;
    if (held >= kLongPressLogMs) LOG_INF("POWER", "Power key held %u ms", unsigned(held));
    writeTrail(powertrail::append(g_trail, powertrail::keyUpLine(held)));
  }
  g_powerDown = powerDown;
  if (const bool standby = app.powerView().standby; standby != g_standbyLogged) {
    g_standbyLogged = standby;
    LOG_INF("POWER", "standby face %s", standby ? "on · Power wakes" : "off");
  }
  if (!g_armCounted && now - g_bootMs >= kArmUpMs && netConnected() && !otaPendingVerify()) countArm();
  uptimeArm(now);
  g_bootFull = app.stats().fullRefreshes;
  g_bootPartial = app.stats().partialRefreshes;
  g_bootFast = app.stats().fastRefreshes;
  markPhases(app);
  if (!g_lastInOk || now - g_lastInMs >= kCheckMs) {
    const PowerInputs in = inputs(app, board);
    battSample(in, now);
    std::lock_guard<std::mutex> l(g_inMu);
    g_lastIn = in;
    g_lastInOk = true;
    g_lastInMs = now;
  }
  if (const int64_t secs = g_sleepReqS.load()) {
    if (int32_t(millis() - g_sleepReqMs.load()) < int32_t(kSleepReqDelayMs)) return;   // set after `now` was read
    g_sleepReqS = 0;
    sleepRequested(app, board, secs);   // no return unless refused meanwhile
  }
  if (g_wakeHold) wakeHoldLoop(app, now);
  if (g_glance) return glanceLoop(app, board);
  if (now - g_lastCheckMs < kCheckMs) return;
  g_lastCheckMs = now;
  const PowerDecision d = powerDecision(inputs(app, board));
  applyProfile(d, now);
  const App::PowerView v = app.powerView();
  if (!v.main || now - g_bootMs < kAwakeMinMs || (v.msSinceUserInput >= 0 && v.msSinceUserInput < kAwakeMinMs)) return;
  if (!d.deepSleepNow || g_profile.settling()) {   // power source just changed: no deep sleep until it holds 2 s
    const char* why = d.deepSleepNow ? "power source settling" : d.reason;
    if (strcmp(why, g_lastReason)) LOG_INF("POWER", "stays awake: %s", why);
    g_lastReason = why;
    return;
  }
  if (app.settings().powerSave == "glance") snapshotForSleep(app, board);
  enterSleep(d, app, board);
}

SleepNowCheck powerSleepRequest(bool isNumber, double seconds) {
  SleepNowCheck c;
  {
    std::lock_guard<std::mutex> l(g_inMu);
    if (!g_lastInOk) return {409, "stays awake: starting up"};
    c = sleepNowCheck(isNumber, seconds, g_lastIn);
  }
  if (c.status != 202) return c;
  g_sleepReqMs = millis();
  g_sleepReqS = int64_t(seconds);
  LOG_INF("POWER", "sleep requested over the API · %lld s", static_cast<long long>(seconds));
  return c;
}

void powerTallyJson(JsonObject power, JsonObject refreshes) {
  glance::Tally t;
  {
    std::lock_guard<std::mutex> l(g_rtcMu);
    t = g_rtc.tally;
  }
  power["wakes"] = t.wakes;
  power["redraws"] = t.redraws;
  power["failedWakes"] = t.failedWakes;
  power["awakeS"] = static_cast<uint64_t>((t.awakeMs + sinceReset()) / 1000);
  power["asleepS"] = t.asleepS;
  if (t.hasLast) {
    JsonObject w = power["lastWake"].to<JsonObject>();
    auto ms = [&](const char* k, uint32_t v) { if (v == glance::kNoMs) w[k] = nullptr; else w[k] = v; };
    ms("wifiMs", t.lastWifiMs);
    ms("haMs", t.lastHaMs);
    w["totalMs"] = t.lastTotalMs;
  } else {
    power["lastWake"] = nullptr;
  }
  const uint32_t full = g_bootFull, partial = g_bootPartial;
  refreshes["full"] = t.fullRefreshes + full;
  refreshes["partial"] = t.partialRefreshes + partial;
  JsonObject b = refreshes["boot"].to<JsonObject>();
  b["full"] = full;
  b["partial"] = partial;
  b["fast"] = g_bootFast.load();   // #197: navigations without a flash
  b["clean"] = full;        // every App flash is a clean; the manual F7 (POST /display/refresh) is not counted
}

int powerArmBootsLeft() { return armLeftNow(); }
const char* powerArmedBy() {
#if X4_QEMU
  if (g_rtc.simArmed) return "boots";   // POST /__qemu/power armed: the first-boot count is skipped
#endif
  return g_armedBy;
}
void powerTrail(std::string& beforeBoot, std::vector<std::string>& lines) {
  std::lock_guard<std::mutex> g(g_trailMu);
  beforeBoot = g_trailBefore;
  lines = g_trailLines;
}

uint32_t powerEmptySleeps() {
  std::lock_guard<std::mutex> l(g_rtcMu);
  return g_rtc.emptySleeps;
}

std::string powerPhasesJson() {
  const phases::Rec now = phasesNow(int64_t(time(nullptr)));
  std::lock_guard<std::mutex> l(g_rtcMu);
  return phases::json(&now, g_rtc.wakes);
}

void powerKeyStage(const char* stage) {
  const uint32_t t0 = millis();
  std::string line;
  if (!strcmp(stage, "key")) {
    int mv = -1;
    bool usb = false;
    {
      std::lock_guard<std::mutex> l(g_inMu);   // last inputs(), at most a second old
      if (g_lastInOk && g_lastIn.voltage > 0) mv = int(g_lastIn.voltage * 1000 + 0.5);
      if (g_lastInOk) usb = g_lastIn.usb;
    }
    if (!g_powerDown) {
      g_powerDown = true;
      g_powerDownMs = t0;
    }
    line = powertrail::keyLine(t0, mv, usb);
  } else if (!strcmp(stage, "off")) {
    line = powertrail::offLine(t0);   // #258: before the latch is released
  } else {
    line = powertrail::standbyLine(t0);
  }
  writeTrail(powertrail::append(g_trail, line));
  LOG_INF("POWER", "trail: %s · written in %u ms", line.c_str(), unsigned(millis() - t0));
}

std::string powerBatteryJson() {
  std::lock_guard<std::mutex> l(g_battMu);
  return g_batt.json();
}
const char* powerMode() { return g_mode; }
int powerAppliedCpuMhz() { return g_cpuMhz; }
const char* powerAppliedWifiPs() { return g_psMin ? "min" : "none"; }

void powerWifiCache(const std::function<void(glance::WifiCache&)>& f) {
  std::lock_guard<std::mutex> l(g_rtcMu);
  f(g_rtc.wifi);
  seal();
}

#if X4_QEMU
static std::atomic<bool> g_simCharging{false};
static std::atomic<uint16_t> g_simMv{3950};
void powerSimSet(bool battery, bool armed, bool charging, int mv) {
  g_simCharging = charging;
  g_simMv = uint16_t(mv > 0 && mv < 5000 ? mv : 3950);
  {
    std::lock_guard<std::mutex> l(g_rtcMu);
    g_rtc.simBattery = battery;
    g_rtc.simArmed = armed;
    seal();
  }
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().apiUsed = false;   // the test's own API calls must not hold the device awake (device-sim: api_idle)
}
bool powerSimBattery() { return g_rtc.simBattery; }
bool powerSimCharging() { return g_simCharging; }
uint16_t powerSimMv() { return g_simMv; }
#endif

}  // namespace x4::net
