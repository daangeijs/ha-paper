#include "net/ota.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Update.h>
#include <WiFi.h>
#include <esp_ota_ops.h>
#include <esp_timer.h>
#include <hal/wdt_hal.h>
#include <mbedtls/sha256.h>
#include <soc/rtc.h>

#include <atomic>
#include <ctime>
#include <memory>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <esp_heap_caps.h>

#include "Logging.h"
#include "core/ota_status.h"
#include "core/www_image.h"
#include "hw/watchdog.h"
#include "net/ha_client.h"
#include "net/health.h"
#include "net/hub.h"
#include "net/wifi_mgr.h"
#include "net/www_ota.h"
#include "net/storage.h"
#include "net/tls.h"
#include "net/util.h"

namespace x4::net {

static_assert(kHttpLowMemory == kOtaHttpLowMemory, "core/ota_status.h mirrors net/tls.h");

namespace {

constexpr const char* kNs = "x4ota";
// A new image proves itself by running stably with the network up — Home Assistant plays no part, so updates work
// (and stick) whether or not HA is linked or reachable. Crash/reboot before that → the bootloader rolls back by itself;
// no network (Wi-Fi/IP) within the deadline → we roll back, because an image that cannot get online could never be
// updated over the air again. X4_OTA_NET_DEADLINE_MS shortens the deadline for QEMU tests only.
#ifndef X4_OTA_NET_DEADLINE_MS
#define X4_OTA_NET_DEADLINE_MS (10UL * 60UL * 1000UL)
#endif
constexpr uint32_t kStableMs = 60000;                       // up this long with network → valid
constexpr uint32_t kNetDeadlineMs = X4_OTA_NET_DEADLINE_MS;
constexpr uint32_t kLoopStaleMs = 30000;                    // loop() silent this long → UI is not running
// Guard while PENDING_VERIFY: rollback needs *a reset*, and an image that hangs (rather than crashes) would otherwise
// sit there until the battery is pulled. Any reset of an unconfirmed image makes the bootloader boot the previous one.
// An esp_timer restarts at X4_OTA_GUARD_MS (testable in QEMU); the RTC watchdog, 1 min later, is the hardware
// backstop for a wedged scheduler (QEMU does not model the RTC watchdog). The task watchdog (hw/watchdog.h, 30 s)
// runs on unconfirmed images too and usually catches a stuck loop/net task first; its reset rolls back the same way.
#ifndef X4_OTA_GUARD_MS
#define X4_OTA_GUARD_MS (X4_OTA_NET_DEADLINE_MS + 2UL * 60UL * 1000UL)
#endif
constexpr uint32_t kRtcWdtMs = X4_OTA_GUARD_MS + 60000UL;
constexpr int64_t kAutoCheckEverySec = 24 * 3600;

struct Release {
  std::string version, firmwareUrl, manifestUrl, sha256;
  size_t size = 0;
  std::vector<std::string> notes;
};

bool g_pending = false;
bool g_validated = false;
uint32_t g_bootMs = 0;
std::atomic<uint32_t> g_loopMs{0};   // last App loop() pass (loopTask, core 1)
bool g_guardArmed = false;
esp_timer_handle_t g_guardTimer = nullptr;
Release g_avail;
std::string g_error;
uint32_t g_lastAutoTryMs = 0;
bool g_autoTried = false;
std::atomic<bool> g_checking{false};
bool g_justUpdated = false;
bool g_nightTried = false;
uint32_t g_nightTriedMs = 0;
// Console sync (eink-ha-os#350): the www.bin of the running version's release, retried this often (or after a check)
constexpr uint32_t kWwwRetryMs = 6UL * 3600UL * 1000UL;
constexpr uint32_t kWwwRetryFailedMs = 10UL * 60UL * 1000UL;
bool g_wwwTried = false;
std::atomic<bool> g_wwwKick{false};
uint32_t g_wwwTriedMs = 0;
bool wwwSyncDue(uint32_t up);
bool wwwSync(std::string& err);
bool wwwDownloading();
void wwwStep();

// Upload state (AsyncTCP task)
mbedtls_sha256_context g_upSha;

// Hash through internal RAM: OTA chunks above 4 KB live in PSRAM, and the SHA peripheral's DMA read wrong bytes
// from PSRAM under QEMU (upload rejected as "does not match manifest", eink-ha-os#57).
// One OTA runs at a time, so one static bounce buffer is enough.
void shaUpdateInternal(mbedtls_sha256_context* ctx, const uint8_t* d, size_t n) {
  static uint8_t bounce[1024];
  while (n) {
    size_t k = std::min(n, sizeof bounce);
    memcpy(bounce, d, k);
    mbedtls_sha256_update(ctx, bounce, k);
    d += k;
    n -= k;
  }
}
bool g_upActive = false;
size_t g_upBytes = 0;

void setOta(OtaState s, int pct = -1) {
  Hub& h = hub();
  std::lock_guard<std::recursive_mutex> l(h.mu);
  if (h.status.ota != s || (pct >= 0 && pct != h.status.otaProgressPct)) {
    h.status.ota = s;
    if (pct >= 0) h.status.otaProgressPct = pct;
    h.markStatus();
  }
}

void guardDisarm() {
  if (!g_guardArmed) return;
  if (g_guardTimer) esp_timer_stop(g_guardTimer);
  wdt_hal_context_t w = RWDT_HAL_CONTEXT_DEFAULT();
  wdt_hal_write_protect_disable(&w);
  wdt_hal_disable(&w);
  wdt_hal_write_protect_enable(&w);
  g_guardArmed = false;
}

void markValid(const char* why) {
  if (!g_pending || g_validated) return;
  if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    g_validated = true;
    guardDisarm();
    LOG_INF("OTA", "health check passed (%s) · esp_ota_mark_app_valid_cancel_rollback()", why);
  }
}

bool parseManifest(const std::string& body, Release& r, std::string& err) {
  JsonDocument d;
  if (deserializeJson(d, body)) {
    err = "manifest.json is not valid JSON";
    return false;
  }
  r.version = d["version"] | "";
  r.sha256 = d["sha256"] | "";
  r.size = d["size"] | 0;
  r.notes.clear();
  for (JsonVariant n : d["notes"].as<JsonArray>()) r.notes.push_back(n.as<const char*>() ? n.as<const char*>() : "");
  for (auto& c : r.sha256) c = tolower(c);
  if (r.version.empty() || r.sha256.size() != 64 || r.size == 0) {
    err = "manifest.json is missing version/sha256/size";
    return false;
  }
  return true;
}

}  // namespace

std::string otaChannel() {
  std::string c = storage().getString(kNs, "chan", "stable");
  return c == "beta" ? "beta" : "stable";
}
void otaSetChannel(const std::string& ch) { storage().putString(kNs, "chan", ch == "beta" ? "beta" : "stable"); }
std::string otaLastError() { return g_error; }
int64_t otaLastCheckEpoch() { return storage().getI64(kNs, "last", 0); }
bool otaPendingVerify() { return g_pending && !g_validated; }
bool otaChecking() { return g_checking; }
bool otaBusy() {
  if (g_upActive || wwwWriting()) return true;   // eink-ha-os#350: no install/restart/sleep while the console is rewritten
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  return hub().status.ota == OtaState::Downloading || hub().status.ota == OtaState::Installing;
}
bool otaJustUpdated() { return g_justUpdated; }
double otaAvailableSizeMb() { return g_upActive ? 0 : g_avail.size / 1048576.0; }

bool otaBatteryOk(std::string* why) {
  PowerInfo p;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    p = hub().power;
  }
  if (p.batteryPct >= 30 || p.charging) return true;
  if (why) *why = "Battery at " + std::to_string(p.batteryPct) + "% — charge to 30% first";
  return false;
}

bool otaBootGuard() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  if (!running || esp_ota_get_state_partition(running, &st) != ESP_OK || st != ESP_OTA_IMG_PENDING_VERIFY) return false;
  wdt_hal_context_t w = RWDT_HAL_CONTEXT_DEFAULT();
  wdt_hal_init(&w, WDT_RWDT, 0, false);
  const uint32_t ticks = static_cast<uint32_t>(uint64_t(kRtcWdtMs) * rtc_clk_slow_freq_get_hz() / 1000);
  wdt_hal_write_protect_disable(&w);
  wdt_hal_config_stage(&w, WDT_STAGE0, ticks, WDT_STAGE_ACTION_RESET_SYSTEM);
  wdt_hal_enable(&w);
  wdt_hal_feed(&w);
  wdt_hal_write_protect_enable(&w);
  const esp_timer_create_args_t args = {
      .callback = [](void*) {
        LOG_ERR("OTA", "new image not confirmed after %u s · restarting → bootloader rollback",
                unsigned(X4_OTA_GUARD_MS / 1000));
        delay(200);
        esp_restart();
      },
      .arg = nullptr,
      .dispatch_method = ESP_TIMER_TASK,
      .name = "x4otaguard",
      .skip_unhandled_events = true,
  };
  if (esp_timer_create(&args, &g_guardTimer) == ESP_OK) esp_timer_start_once(g_guardTimer, uint64_t(X4_OTA_GUARD_MS) * 1000);
  g_guardArmed = true;
  return true;
}

void otaLoopAlive() { g_loopMs.store(millis() | 1u); }

void otaBegin() {
  g_bootMs = millis();
  const std::string prev = storage().getString(kNs, "ver");
  if (prev != firmwareVersion()) {
    g_justUpdated = !prev.empty();
    storage().putString(kNs, "ver", firmwareVersion());
  }
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  if (running && esp_ota_get_state_partition(running, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
    g_pending = true;
    LOG_WRN("OTA", "running v%s from %s · ESP_OTA_IMG_PENDING_VERIFY", firmwareVersion(), running->label);
  }
}

void otaLoop() {
  const uint32_t up = millis() - g_bootMs;
  if (g_pending && !g_validated) {
    const uint32_t loopMs = g_loopMs.load();
    const bool uiAlive = loopMs && millis() - loopMs < kLoopStaleMs;
    if (netConnected() && up > kStableMs && uiAlive) markValid("running 60 s with network");
    else if (!netConnected() && up > kNetDeadlineMs) {
      LOG_ERR("OTA", "new image has no network after %u s · rolling back", unsigned(kNetDeadlineMs / 1000));
      delay(200);
      esp_ota_mark_app_invalid_rollback_and_reboot();
    }
  }
  wwwLoop();
  if (wwwDownloading()) wwwStep();
  else if (wwwSyncDue(up)) {
    std::string err;
    if (!wwwSync(err)) LOG_WRN("OTA", "console update: %s", err.c_str());
  }
  // Automatic updates (Settings › Updates › Automatic): off = only when the user checks; notify = check GitHub once a
  // day and show the update icon; night = same daily check, then install between 03:00 and 04:00 local time when the
  // battery is above 50 % (or charging). Independent of Home Assistant.
  std::string mode;
  int battery;
  bool charging;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    mode = hub().settings.otaAuto;
    battery = hub().power.batteryPct;
    charging = hub().power.charging;
  }
  if (mode == "off" || !netConnected() || !otaRepo()[0]) return;
  const int64_t now = time(nullptr);
  if (now < 1700000000) return;   // need wall clock to space checks across reboots
  if (!(g_autoTried && millis() - g_lastAutoTryMs < 3600000UL) && now - otaLastCheckEpoch() >= kAutoCheckEverySec) {
    g_autoTried = true;           // GitHub unauthenticated API: 60 req/h per IP → once a day, retry hourly on error
    g_lastAutoTryMs = millis();
    std::string err;
    otaCheck(err);
  }
  if (mode != "night" || g_pending || g_avail.version.empty()) return;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    if (hub().status.ota != OtaState::Available) return;
  }
  struct tm lt;
  time_t t = static_cast<time_t>(now);
  localtime_r(&t, &lt);
  if (lt.tm_hour != 3 || !(battery > 50 || charging)) return;
  if (g_nightTried && millis() - g_nightTriedMs < 3600000UL) return;   // one attempt per night window
  g_nightTried = true;
  g_nightTriedMs = millis();
  LOG_INF("OTA", "night install v%s (battery %d%%)", g_avail.version.c_str(), battery);
  std::string err;
  if (!otaInstall(err)) LOG_ERR("OTA", "night install failed: %s", err.c_str());
}

namespace {
bool otaCheckImpl(std::string& err, OtaErr& why);
}

void setChecking(bool on, bool ok = true, OtaErr why = OtaErr::None, const std::string& msg = "") {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  NetStatus& st = hub().status;
  st.otaChecking = on;
  if (!on) {
    st.otaChecked = true;
    st.otaLastCheckEpoch = otaLastCheckEpoch();
    st.otaCheckErr = ok ? OtaErr::None : why;
    st.otaCheckMsg = ok ? "" : msg;
  }
  hub().markStatus();
}

bool otaCheck(std::string& err) {
  g_checking = true;
  setChecking(true);
  OtaErr why = OtaErr::None;
  bool ok = otaCheckImpl(err, why);
  setChecking(false, ok, why, err);
  g_checking = false;
  if (ok) {
    g_justUpdated = false;
    g_wwwKick = true;   // a check also retries a stale console (eink-ha-os#350)
  }
  LOG_INF("OTA", "check · %s", ok ? "done" : otaErrName(why) ? otaErrName(why) : "skipped");
  return ok;
}

bool otaRequestCheck() {
  if (!otaRepo()[0] || g_checking.exchange(true)) return false;
  setChecking(true);
  hub().post([] {
    std::string err;
    otaCheck(err);   // result: Hub status, GET /ota
  });
  return true;
}

namespace {
constexpr const char* kLowMemMsg = "Not enough memory right now — try again in a minute";
constexpr uint32_t kLowMemRetryMs = 2000;

// GitHub's handshake needs ~47 KB of internal RAM (eink-ha-os#248). When the guard refuses: close the HA WebSocket (its TLS
// session and socket buffers; HaClient::loop reconnects after this job) and give lwIP a moment before one more try.
void makeTlsRoom(const char* what) {
  LOG_WRN("OTA", "not enough memory for %s · closing the HA WebSocket, retrying in %u s", what,
          unsigned(kLowMemRetryMs / 1000));
  haClient().yieldTls();
  for (const uint32_t t0 = millis(); millis() - t0 < kLowMemRetryMs;) {
    wdt::feedIfSubscribed();
    delay(50);
  }
}

int githubGet(const std::string& url, std::string& body, size_t maxBytes, uint32_t timeoutMs,
              const char* accept = nullptr) {
  int code = httpGet(url, body, maxBytes, timeoutMs, accept);
  if (code != kHttpLowMemory) return code;
  Url u;
  makeTlsRoom(parseUrl(url, u) ? u.host.c_str() : "GitHub");
  return httpGet(url, body, maxBytes, timeoutMs, accept);
}

bool otaCheckImpl(std::string& err, OtaErr& why) {
  if (!otaRepo()[0]) {
    err = kOtaChecksOffMsg;   // a build state, not an error: g_error stays empty so GET /ota reports idle
    return false;
  }
  if (!netConnected()) {
    err = "No network — try again later";
    g_error = err;
    why = OtaErr::Network;
    return false;
  }
  const bool beta = otaChannel() == "beta";
  const std::string api = std::string("https://api.github.com/repos/") + otaRepo() +
                          (beta ? "/releases?per_page=5" : "/releases/latest");
  LOG_INF("OTA", "GET %s", api.c_str());
  std::string body;
  int code = githubGet(api, body, 256 * 1024, 15000, "application/vnd.github+json");
  // GitHub never saw a refused request: no stamp, so the hourly auto retry applies
  if (code != kHttpLowMemory) storage().putI64(kNs, "last", time(nullptr) > 1700000000 ? time(nullptr) : 0);
  if (code != 200) {
    err = code == 404               ? "No releases published yet"
          : code == kHttpLowMemory ? kLowMemMsg
                                   : "GitHub not reachable (HTTP " + std::to_string(code) + ")";
    g_error = err;
    why = otaErrOf(code, netConnected());
    return false;
  }
  JsonDocument filter;
  JsonObject f = beta ? filter[0].to<JsonObject>() : filter.to<JsonObject>();
  f["tag_name"] = true;
  f["draft"] = true;
  f["prerelease"] = true;
  f["assets"][0]["name"] = true;
  f["assets"][0]["browser_download_url"] = true;
  JsonDocument d;
  if (deserializeJson(d, body, DeserializationOption::Filter(filter))) {
    err = "Unexpected answer from GitHub";
    g_error = err;
    why = OtaErr::Other;
    return false;
  }
  JsonObject rel;
  if (beta) {
    for (JsonObject r : d.as<JsonArray>())
      if (!(r["draft"] | false)) {
        rel = r;
        break;
      }
  } else {
    rel = d.as<JsonObject>();
  }
  if (rel.isNull()) {
    err = "No releases published yet";
    g_error = err;
    why = OtaErr::NoReleases;
    return false;
  }
  Release r;
  JsonArray assets = rel["assets"];
  for (JsonObject a : assets) {
    std::string name = a["name"] | "";
    if (name == "firmware.bin") r.firmwareUrl = a["browser_download_url"] | "";
    if (name == "manifest.json") r.manifestUrl = a["browser_download_url"] | "";
  }
  if (r.firmwareUrl.empty() || r.manifestUrl.empty()) {
    err = "Release " + std::string(rel["tag_name"] | "?") + " has no firmware.bin + manifest.json";
    g_error = err;
    why = OtaErr::Other;
    return false;
  }
  std::string man;
  code = githubGet(r.manifestUrl, man, 16 * 1024, 15000);
  if (code != 200 || !parseManifest(man, r, err)) {
    if (err.empty() && code == kHttpLowMemory) err = kLowMemMsg;
    why = code == 200 ? OtaErr::Other : otaErrOf(code, netConnected());
    if (err.empty()) err = "manifest.json download failed (HTTP " + std::to_string(code) + ")";
    g_error = err;
    return false;
  }
  g_error.clear();
  const bool newer = compareVersions(r.version, firmwareVersion()) > 0;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().status.otaAvailableVersion = newer ? r.version : "";
    hub().status.otaNotes = newer ? r.notes : std::vector<std::string>{};
    hub().status.ota = newer ? OtaState::Available : OtaState::UpToDate;
    hub().markStatus();
  }
  g_avail = newer ? r : Release{};
  LOG_INF("OTA", "%s (latest %s, running %s)", newer ? "update available" : "up to date", r.version.c_str(),
          firmwareVersion());
  return true;
}
}  // namespace

namespace {
// The download of a running console update: one otaLoop pass moves at most kWwwStepBytes / kWwwStepMs, so Wi-Fi, HA
// and the hub keep running on the net task for the minute it takes (eink-ha-os#350 review).
constexpr size_t kWwwStepBytes = 16 * 1024;
constexpr uint32_t kWwwStepMs = 50;
struct WwwDownload {
  std::unique_ptr<NetworkClientSecure> client{new NetworkClientSecure()};
  HTTPClient http;   // declared after client: destroyed first
  std::string sha;
  size_t size = 0, got = 0;
  uint32_t lastData = 0;
  uint8_t* buf = static_cast<uint8_t*>(heap_caps_malloc(4096, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  ~WwwDownload() {
    http.end();
    free(buf);
  }
};
std::unique_ptr<WwwDownload> g_wwwDl;
bool wwwDownloading() { return g_wwwDl != nullptr; }
bool g_wwwWasUp = false;

bool wwwSyncDue(uint32_t up) {
  const bool upNow = netConnected();
  if (upNow && !g_wwwWasUp) g_wwwKick = true;   // retry on reconnect (a Wi-Fi drop mid-download)
  g_wwwWasUp = upNow;
  if (g_wwwDl || !otaRepo()[0] || (g_pending && !g_validated) || up < kStableMs || g_checking || !upNow || otaBusy())
    return false;
  const WwwInfo w = wwwInfo();
  if (w.current || std::strcmp(w.state, "updating") == 0) return false;
  // console offline (failed): every 10 min; stale but working: after a check, else every 6 h
  const uint32_t every = std::strcmp(w.state, "failed") == 0 ? kWwwRetryFailedMs : kWwwRetryMs;
  return !g_wwwTried || g_wwwKick || millis() - g_wwwTriedMs >= every;
}

void wwwDlFail(const char* why) {
  g_wwwDl.reset();
  wwwWriteAbort(why);
  LOG_WRN("OTA", "console update: %s", why);
}

// Pass of the running download (otaLoop): read what arrived, write it, finish or give up.
void wwwStep() {
  WwwDownload& d = *g_wwwDl;
  NetworkClient* s = d.http.getStreamPtr();
  const uint32_t t0 = millis();
  size_t moved = 0;
  while (d.got < d.size && moved < kWwwStepBytes && millis() - t0 < kWwwStepMs) {
    size_t avail = s ? s->available() : 0;
    if (!avail) {
      if (!s || !s->connected() || millis() - d.lastData > 20000) return wwwDlFail("download interrupted");
      return;   // next pass
    }
    int n = s->read(d.buf, std::min<size_t>(std::min<size_t>(avail, 4096), d.size - d.got));
    if (n <= 0) return wwwDlFail("download interrupted");
    d.lastData = millis();
    std::string err;
    if (!wwwWriteChunk(d.buf, n, &err)) return wwwDlFail(err.c_str());
    d.got += n;
    moved += n;
  }
  if (d.got < d.size) return;
  const std::string sha = d.sha;
  g_wwwDl.reset();
  std::string err;
  if (!wwwWriteEnd(sha, err)) LOG_WRN("OTA", "console update: %s", err.c_str());
}

// The console of the running version: release v<version> → manifest.json `www` → www.bin streamed into the partition
// by wwwStep. Starts only on a confirmed image (wwwSyncDue), so a rollback never leaves a newer console behind. The
// HTTP stream is open before the console goes offline: no network = the old console stays.
bool wwwSync(std::string& err) {
  g_wwwTried = true;
  g_wwwKick = false;
  g_wwwTriedMs = millis();
  const std::string tag = std::string("v") + firmwareVersion();
  const std::string api = std::string("https://api.github.com/repos/") + otaRepo() + "/releases/tags/" + tag;
  LOG_INF("OTA", "console v%s out of date · GET %s", wwwInfo().version.c_str(), api.c_str());
  std::string body;
  int code = githubGet(api, body, 256 * 1024, 15000, "application/vnd.github+json");
  if (code != 200) {
    err = code == 404 ? "no release " + tag : "GitHub not reachable (HTTP " + std::to_string(code) + ")";
    return false;
  }
  JsonDocument filter;
  filter["assets"][0]["name"] = true;
  filter["assets"][0]["browser_download_url"] = true;
  JsonDocument doc;
  const bool bad = static_cast<bool>(deserializeJson(doc, body, DeserializationOption::Filter(filter)));
  std::string().swap(body);   // give the 256 KB back before the TLS download
  if (bad) {
    err = "unexpected answer from GitHub";
    return false;
  }
  std::string wwwUrl, manUrl;
  for (JsonObject a : doc["assets"].as<JsonArray>()) {
    std::string name = a["name"] | "";
    if (name == "www.bin") wwwUrl = a["browser_download_url"] | "";
    if (name == "manifest.json") manUrl = a["browser_download_url"] | "";
  }
  doc.clear();
  if (wwwUrl.empty() || manUrl.empty()) {
    err = "release " + tag + " has no www.bin + manifest.json";
    return false;
  }
  std::string man;
  www::Manifest m;
  Release r;
  code = githubGet(manUrl, man, 16 * 1024, 15000);
  if (code != 200 || !parseManifest(man, r, err) || r.version != firmwareVersion() || !www::parseManifest(man, m)) {
    if (err.empty()) err = code != 200 ? "manifest.json download failed (HTTP " + std::to_string(code) + ")"
                                       : "manifest.json of " + tag + " has no www entry";
    return false;
  }
  if (!otaBatteryOk(&err)) return false;
  if (!tlsHeapOk("console download", TlsPeer::GitHub)) {
    makeTlsRoom("console download");
    if (!tlsHeapOk("console download", TlsPeer::GitHub)) {
      err = kLowMemMsg;
      return false;
    }
  }
  std::unique_ptr<WwwDownload> d(new WwwDownload());
  if (!d->buf) {
    err = "out of memory";
    return false;
  }
  attachCaBundle(*d->client);
  d->http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  d->http.setTimeout(20000);
  if (!d->http.begin(*d->client, wwwUrl.c_str())) {
    err = "download failed";
    return false;
  }
  d->http.setUserAgent(String("HA-Paper/") + firmwareVersion());
  {
    wdt::BlockingCall b("OTA www GET");
    code = d->http.GET();
  }
  const int len = d->http.getSize();
  if (code != 200 || (len > 0 && static_cast<size_t>(len) != m.size)) {
    err = code != 200 ? "www.bin download failed (HTTP " + std::to_string(code) + ")" : "www.bin size does not match manifest.json";
    return false;
  }
  if (wwwWriteBegin(m.size, err)) return false;
  LOG_INF("OTA", "GET %s → www partition (streamed)", wwwUrl.c_str());
  d->sha = m.sha256;
  d->size = m.size;
  d->lastData = millis();
  g_wwwDl = std::move(d);
  return true;
}
}  // namespace

bool otaInstall(std::string& err) {
  if (g_avail.version.empty()) {
    err = "Already up to date";
    return false;
  }
  if (wwwWriting()) {   // a restart now would cut the console rewrite (eink-ha-os#350)
    err = "The web console is being updated — try again in a minute";
    return false;
  }
  if (!otaBatteryOk(&err)) {
    LOG_WRN("OTA", "blocked: %s", err.c_str());
    g_error = err;
    return false;
  }
  if (!tlsHeapOk("firmware download", TlsPeer::GitHub)) {
    makeTlsRoom("firmware download");
    if (!tlsHeapOk("firmware download", TlsPeer::GitHub)) {
      err = g_error = kLowMemMsg;
      return false;
    }
  }
  WifiPsOff psOff;   // modem sleep stalls a minutes-long stream
  const Release r = g_avail;
  setOta(OtaState::Downloading, 0);
  LOG_INF("OTA", "GET %s → inactive slot (streamed)", r.firmwareUrl.c_str());

  std::unique_ptr<NetworkClientSecure> client(new NetworkClientSecure());
  attachCaBundle(*client);
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(20000);
  auto failWith = [&](const std::string& m) {
    err = m;
    g_error = m;
    if (Update.isRunning()) Update.abort();
    http.end();
    setOta(OtaState::Failed);
    LOG_WRN("OTA", "abort: %s", m.c_str());
    return false;
  };
  if (!http.begin(*client, r.firmwareUrl.c_str())) return failWith("Download failed");
  http.setUserAgent(String("HA-Paper/") + firmwareVersion());
  int code;
  {
    wdt::BlockingCall b("OTA GET");   // GitHub answers with a redirect: two connects + handshakes
    code = http.GET();
  }
  if (code != 200) return failWith("Download failed (HTTP " + std::to_string(code) + ")");
  int len = http.getSize();
  if (len > 0 && static_cast<size_t>(len) != r.size) return failWith("Download size does not match manifest.json");
  if (!Update.begin(r.size, U_FLASH)) return failWith(std::string("Not enough space: ") + Update.errorString());

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);
  NetworkClient* s = http.getStreamPtr();
  std::unique_ptr<uint8_t[]> buf(new uint8_t[4096]);
  size_t got = 0;
  uint32_t lastData = millis();
  int lastPct = -1;
  while (got < r.size) {
    wdt::feedIfSubscribed();
    size_t avail = s->available();
    if (!avail) {
      if (!s->connected() || millis() - lastData > 20000) break;
      delay(2);
      continue;
    }
    int n = s->read(buf.get(), std::min<size_t>(std::min<size_t>(avail, 4096), r.size - got));
    if (n <= 0) break;
    lastData = millis();
    shaUpdateInternal(&sha, buf.get(), n);
    if (Update.write(buf.get(), n) != static_cast<size_t>(n)) {
      mbedtls_sha256_free(&sha);
      return failWith(std::string("Flash write failed: ") + Update.errorString());
    }
    got += n;
    int pct = static_cast<int>(got * 100 / r.size);
    if (pct / 5 != lastPct / 5) {
      lastPct = pct;
      setOta(OtaState::Downloading, pct);
    }
  }
  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  if (got != r.size) return failWith("Download interrupted — nothing changed. Try again.");
  setOta(OtaState::Installing, 100);
  if (hex(digest, 32) != r.sha256) return failWith("Download was corrupted — nothing changed. Try again.");
  wdt::feedIfSubscribed();
  if (!Update.end(true)) return failWith(std::string("Image rejected: ") + Update.errorString());
  http.end();
  LOG_INF("OTA", "esp_ota_end() OK · boot partition set · restarting into v%s", r.version.c_str());
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().restartPending = true;
    hub().restartAtMs = millis() + 1500;
  }
  return true;
}

// eink-ha-os#237: the install face reads otaAvailableVersion; an upload replaces the GitHub target ("" = unknown: no version line)
static void setUploadTarget(const std::string& v) {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  if (hub().status.otaAvailableVersion == v && hub().status.otaNotes.empty()) return;
  hub().status.otaAvailableVersion = v;
  hub().status.otaNotes.clear();
  hub().markStatus();
}

std::string otaUploadVersion(const std::string& v) {
  size_t b = v.find_first_not_of(" \t"), e = v.find_last_not_of(" \t");
  if (b == std::string::npos) return "";
  std::string s = v.substr(b, e - b + 1);
  if (s.size() > 1 && (s[0] == 'v' || s[0] == 'V') && isdigit(static_cast<unsigned char>(s[1]))) s.erase(0, 1);
  if (s.empty() || s.size() > 64) return "";
  for (char c : s)
    if (c < 0x21 || c > 0x7e) return "";
  return s;
}

void otaUploadSetVersion(const std::string& v) {
  if (g_upActive && !v.empty()) setUploadTarget(v);
}

bool otaUploadBegin(size_t size, const std::string& version, std::string& err) {
  if (g_upActive) {
    err = "an upload is already running";
    return false;
  }
  if (wwwWriting()) {
    err = "the web console is being updated — try again in a minute";
    return false;
  }
  if (!otaBatteryOk(&err)) return false;
  if (!Update.begin(size ? size : UPDATE_SIZE_UNKNOWN, U_FLASH)) {
    err = std::string("cannot start update: ") + Update.errorString();
    return false;
  }
  mbedtls_sha256_init(&g_upSha);
  mbedtls_sha256_starts(&g_upSha, 0);
  wifiPsOffAcquire();   // released in otaUploadEnd/Abort
  g_upActive = true;
  g_upBytes = 0;
  setUploadTarget(version);   // before the state flips: the face draws once, with the right line
  setOta(OtaState::Installing, 0);
  return true;
}

bool otaUploadWrite(const uint8_t* d, size_t n) {
  if (!g_upActive) return false;
  wdt::feedIfSubscribed();   // async_tcp (hw/watchdog.h)
  shaUpdateInternal(&g_upSha, d, n);
  if (Update.write(const_cast<uint8_t*>(d), n) != n) return false;
  g_upBytes += n;
  return true;
}

bool otaUploadEnd(const std::string& sha, std::string& err, std::string* digestHex) {
  if (!g_upActive) {
    err = "no upload in progress";
    return false;
  }
  g_upActive = false;
  wifiPsOffRelease();
  uint8_t digest[32];
  mbedtls_sha256_finish(&g_upSha, digest);
  mbedtls_sha256_free(&g_upSha);
  std::string want = sha;
  for (auto& c : want) c = tolower(c);
  if (digestHex) *digestHex = hex(digest, 32);
  if (!want.empty() && hex(digest, 32) != want) {
    Update.abort();
    err = "SHA-256 does not match — nothing changed";
    setUploadTarget("");
    setOta(OtaState::Failed);
    return false;
  }
  wdt::feedIfSubscribed();
  if (!Update.end(true)) {
    err = std::string("image rejected: ") + Update.errorString();
    setUploadTarget("");
    setOta(OtaState::Failed);
    return false;
  }
  LOG_INF("OTA", "uploaded image OK (%u bytes) · restarting", static_cast<unsigned>(g_upBytes));
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().restartPending = true;
  hub().restartAtMs = millis() + 1500;
  return true;
}

void otaUploadAbort() {
  if (!g_upActive) return;
  g_upActive = false;
  wifiPsOffRelease();
  mbedtls_sha256_free(&g_upSha);
  Update.abort();
  setUploadTarget("");
  setOta(OtaState::Failed);
}

}  // namespace x4::net
