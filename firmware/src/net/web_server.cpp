#include "net/web_server.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>
#include <esp_timer.h>

#include <atomic>
#include <memory>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <sys/time.h>

#include "Logging.h"
#include "core/power.h"
#include "net/auth.h"
#include "net/device_services.h"
#include "net/diag.h"
#include "net/ha_auth.h"
#include "net/ha_client.h"
#include "net/health.h"
#include "net/hub.h"
#include "net/log.h"
#include "net/net_stats.h"
#include "net/ota.h"
#include "net/power.h"
#include "net/png.h"
#include "net/psram.h"
#include "net/storage.h"
#include "net/time_sync.h"
#include "net/util.h"
#include "net/web_fallback.h"
#include "net/www_ota.h"
#include "core/entity_map.h"
#include "core/ha_address.h"
#include "core/input_spec.h"
#include "net/tls.h"
#include "core/net_policy.h"
#include "core/panel_guard.h"
#include "core/settings_api.h"
#include "net/wifi_mgr.h"
#if X4_QEMU
#include "hw/qemu_hw.h"
#include "qemu_eth.h"
#endif

namespace x4::net {

namespace {

// At most kMaxConns open HTTP connections (eink-ha-os#198). Each holds up to ~5.7 KB of lwIP send buffer plus Wi-Fi TX copies in
// internal RAM. The server closes every connection after its response (no keep-alive, no WebSocket here), so open
// connections = requests in flight. One browser opens ≤ 6 per host (console first load); steady state is ~2 (state
// poll every 3 s, preview.png every 15 s). 8 = one browser + two API/HA clients; above that: 503 + Retry-After.
constexpr int kMaxConns = 8;
std::atomic<int> g_conns{0};
std::atomic<Board*> g_inputBoard{nullptr};   // POST /debug/input target (eink-ha-os#214)

class CappedWebServer : public AsyncWebServer {
 public:
  explicit CappedWebServer(uint16_t port) : AsyncWebServer(port) {
    _server.onClient([](void* s, AsyncClient* c) {
      if (!c) return;
      if (g_conns.load() >= kMaxConns) return refuse(c, "connections open");
      // eink-ha-os#248: under the heap floor a request (console state poll, preview.png: -9.5 KB) took the last internal RAM
      // the Wi-Fi driver needed; its failed timer allocation aborts (ESP_ERROR_CHECK in ets_timer_*)
      if (HeapStarve::critical(heapFreeInternal(), uint32_t(heap_caps_get_free_size(MALLOC_CAP_DMA))))
        return refuse(c, "internal RAM low");
      c->setRxTimeout(3);   // what AsyncWebServer's own onClient does
      std::shared_ptr<AsyncWebServerRequest> r = AsyncWebServerRequest::create(static_cast<AsyncWebServer*>(s), c);
      if (!r) {
        c->abort();
        delete c;
        return;
      }
      // the token lives as long as the request (its disconnect callback), so every exit path decrements. The only
      // onDisconnect: a second one in handleRequest replaced it, and API requests stopped counting toward kMaxConns.
      struct Token {
        Token() { g_conns++; webOpened(); heapRequestOpen(); }
        ~Token() { g_conns--; webDone(); heapRequestClosed(); }
      };
      r->onDisconnect([t = std::make_shared<Token>()] {});
    }, this);
  }

 private:
  static void refuse(AsyncClient* c, const char* why) {
    static uint32_t lastLog = 0;
    static uint32_t refused = 0;
    refused++;
    webRefused();
    const uint32_t now = millis();
    if (lastLog == 0 || now - lastLog >= 10000) {
      lastLog = now ? now : 1;
      LOG_WRN("WEB", "%s · %d connections open · refused %u (503)", why, g_conns.load(), unsigned(refused));
      refused = 0;
    }
    static const char kBusy[] =
        "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    c->onDisconnect([](void*, AsyncClient* cl) { delete cl; });
    c->write(kBusy, sizeof kBusy - 1);
    c->close();
  }
};

CappedWebServer g_server(80);
constexpr size_t kMaxBody = 64 * 1024;
constexpr const char* kJson = "application/json";

// ---------------------------------------------------------------- request helpers

std::string str(const String& s) { return std::string(s.c_str(), s.length()); }

std::string header(AsyncWebServerRequest* r, const char* name) {
  const AsyncWebHeader* h = r->getHeader(name);
  return h ? str(h->value()) : std::string();
}

std::string clientIp(AsyncWebServerRequest* r) { return str(r->client()->remoteIP().toString()); }

std::string bearerOf(AsyncWebServerRequest* r) {
  std::string a = header(r, "Authorization");
  if (a.size() > 7 && strncasecmp(a.c_str(), "Bearer ", 7) == 0) return a.substr(7);
  return {};
}

std::string cookieOf(AsyncWebServerRequest* r, const char* name) {
  std::string c = header(r, "Cookie");
  std::string key = std::string(name) + "=";
  size_t p = 0;
  while ((p = c.find(key, p)) != std::string::npos) {
    if (p == 0 || c[p - 1] == ' ' || c[p - 1] == ';') {
      size_t e = c.find(';', p);
      return c.substr(p + key.size(), e == std::string::npos ? std::string::npos : e - p - key.size());
    }
    p += key.size();
  }
  return {};
}

std::string body(AsyncWebServerRequest* r) {
  return r->_tempObject ? std::string(static_cast<const char*>(r->_tempObject)) : std::string();
}

void sendJson(AsyncWebServerRequest* r, int code, const std::string& json) {
  AsyncWebServerResponse* resp = r->beginResponse(code, kJson, json.c_str());
  resp->addHeader("Cache-Control", "no-store");
  r->send(resp);
}

void sendJsonDoc(AsyncWebServerRequest* r, int code, const JsonDocument& d) {
  std::string s;
  serializeJson(d, s);
  sendJson(r, code, s);
}

void sendError(AsyncWebServerRequest* r, int code, const std::string& msg) { sendJson(r, code, errorJson(msg)); }

void sendNoContent(AsyncWebServerRequest* r) { r->send(204); }

std::string sessionCookieHeader(const std::string& value) {
  if (value.empty()) return std::string(Auth::kCookie) + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  return std::string(Auth::kCookie) + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
         std::to_string(Auth::kSessionMs / 1000);
}

bool viaSoftAp(AsyncWebServerRequest* r) { return r->client()->localIP() == IPAddress(192, 168, 4, 1); }

bool deviceLinked() {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  return hub().link.linked();
}

// CSRF: a cookie-authenticated write must come from our own pages, Origin (or Referer) == http://<Host>.
// SameSite=Lax alone lets a missing Origin through (core/net_policy.h sameOriginWrite).
constexpr const char* kCrossOrigin = "cross-origin request refused";
bool sessionWriteOk(AsyncWebServerRequest* r) {
  const auto m = r->method();
  if (m == AsyncWebRequestMethod::HTTP_GET || m == AsyncWebRequestMethod::HTTP_HEAD) return true;
  return sameOriginWrite(header(r, "Origin"), header(r, "Referer"), str(r->host()));
}

// Request authorization. Sends the error response and returns false when denied.
bool authorize(AsyncWebServerRequest* r, Scope need, AuthResult* out = nullptr) {
  AuthResult a = auth().check(clientIp(r), bearerOf(r), cookieOf(r, Auth::kCookie), need);
  if (a.code == 0 && a.viaSession && !sessionWriteOk(r)) {
    a.code = 403;
    a.error = kCrossOrigin;
  }
  if (a.code) {
    AsyncWebServerResponse* resp = r->beginResponse(a.code, kJson, errorJson(a.error).c_str());
    if (a.code == 401) resp->addHeader("WWW-Authenticate", "Bearer realm=\"ha-paper\"");
    if (a.code == 429) resp->addHeader("Retry-After", "60");
    r->send(resp);
    return false;
  }
  if (out) *out = a;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().lastApiMs = millis();
    hub().apiUsed = true;
  }
  return true;
}

// Setup actions (Wi-Fi, HA sign-in) are open while the display is not linked to Home Assistant — exactly like
// the emulator's first-install flow. Afterwards they need an admin browser session (a non-admin one → 403).
bool authorizeSetup(AsyncWebServerRequest* r) {
  if (!deviceLinked()) return true;
  AuthResult a = auth().check(clientIp(r), "", cookieOf(r, Auth::kCookie), Scope::Write);
  if (a.code) {
    sendError(r, a.code == 403 ? 403 : 401, a.code == 403 ? a.error : "sign in with Home Assistant first");
    return false;
  }
  if (!sessionWriteOk(r)) {
    sendError(r, 403, kCrossOrigin);
    return false;
  }
  return true;
}

bool sessionAdmin(AsyncWebServerRequest* r, Session* out = nullptr) {
  Session s;
  if (!auth().session(cookieOf(r, Auth::kCookie), s)) {
    sendError(r, 401, "sign in with Home Assistant first");
    return false;
  }
  if (!s.admin) {
    sendError(r, 403, "Home Assistant admin required");
    return false;
  }
  if (!sessionWriteOk(r)) {
    sendError(r, 403, kCrossOrigin);
    return false;
  }
  if (out) *out = s;
  return true;
}

// ---------------------------------------------------------------- JSON views

// Config::apps (defaultApps() when built in code without any)
void appsToJson(const Config& c, JsonArray out) {
  for (auto& a : c.apps.empty() ? defaultApps() : c.apps) {
    JsonObject o = out.add<JsonObject>();
    o["id"] = a.id;
    o["title"] = a.title;
  }
}

void screensToJson(const Config& c, JsonArray out) {
  for (auto& s : c.screens) {
    JsonObject o = out.add<JsonObject>();
    o["id"] = s.id;
    o["app"] = s.app;
    o["title"] = s.title;
    JsonArray ws = o["widgets"].to<JsonArray>();
    for (auto& w : s.widgets) {
      JsonObject x = ws.add<JsonObject>();
      x["type"] = w.type;
      if (w.cs != 1) x["cs"] = w.cs;
      if (w.rs != 1) x["rs"] = w.rs;
      for (auto& kv : w.fields) x[kv.first] = kv.second;
    }
  }
}

const char* haWord(HaState s) {
  switch (s) {
    case HaState::Connected: return "linked";
    case HaState::KeyRevoked: return "revoked";
    case HaState::Offline: return "offline";
    default: return "not linked";
  }
}

// "2026-10-13 10:42" local time, "" when the clock was unknown
std::string fmtTime(int64_t epoch) {
  if (epoch <= 0) return {};
  time_t t = static_cast<time_t>(epoch);
  tm lt;
  localtime_r(&t, &lt);
  char b[24];
  strftime(b, sizeof b, "%Y-%m-%d %H:%M", &lt);
  return b;
}

void tokenToJson(const ApiToken& t, JsonObject o) {
  o["id"] = t.id;
  o["name"] = t.name;
  o["scope"] = t.rw ? "write" : "read";
  o["created"] = fmtTime(t.created);
  if (t.lastUsed) o["last_used"] = fmtTime(t.lastUsed);
  else o["last_used"] = nullptr;
  o["masked"] = t.masked;
}

// spec/openapi.yaml OtaState
void otaToJson(JsonObject o) {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  const NetStatus& st = hub().status;
  o["installed"] = firmwareVersion();
  o["channel"] = otaChannel();
  const bool checksOff = !otaRepo()[0];
  o["auto"] = checksOff ? "off" : "notify";   // TODO(owner): automatic night installs (≥ 50 % battery) not implemented yet
  const char* status = "idle";
  std::string why;
  if (otaChecking()) status = "checking";
  else if (st.ota == OtaState::Downloading) status = "downloading";
  else if (st.ota == OtaState::Installing) status = "installing";
  else if (otaPendingVerify()) status = "verifying";
  else if (st.ota == OtaState::Available) status = otaBatteryOk(&why) ? "available" : "blocked";
  else if (st.ota == OtaState::Failed || !otaLastError().empty()) status = "error";
  else if (otaJustUpdated()) status = "updated";
  else if (otaLastCheckEpoch() > 0) status = "uptodate";
  o["status"] = status;
  // an upload without a version (eink-ha-os#237) has nothing to name: null, like the install face without its version line
  if ((st.ota == OtaState::Available || st.ota == OtaState::Downloading || st.ota == OtaState::Installing) &&
      !st.otaAvailableVersion.empty()) {
    JsonObject a = o["available"].to<JsonObject>();
    a["version"] = st.otaAvailableVersion;
    a["size_mb"] = static_cast<double>(static_cast<int>(otaAvailableSizeMb() * 10 + 0.5)) / 10.0;
    JsonArray n = a["notes"].to<JsonArray>();
    for (auto& x : st.otaNotes) n.add(x);
  } else {
    o["available"] = nullptr;
  }
  const int64_t last = otaLastCheckEpoch();
  if (last > 0) {
    time_t t = static_cast<time_t>(last);
    tm u;
    gmtime_r(&t, &u);
    char b[24];
    strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &u);
    o["last_check"] = b;
  } else {
    o["last_check"] = nullptr;
  }
  o["message"] = !why.empty() ? why : !otaLastError().empty() ? otaLastError() : checksOff ? kOtaChecksOffMsg : "";
  // eink-ha-os#250: why the last check failed (status error); null for a failed install
  const char* err = std::strcmp(status, "error") == 0 ? otaErrName(st.otaCheckErr) : nullptr;
  if (err) o["error"] = err;
  else o["error"] = nullptr;
  o["progress"] = st.otaProgressPct;   // extension
  const WwwInfo w = wwwInfo();          // eink-ha-os#350: the web console on the www partition
  JsonObject wo = o["www"].to<JsonObject>();
  if (w.version.empty()) wo["version"] = nullptr;
  else wo["version"] = w.version;
  if (w.sha256.empty()) wo["sha256"] = nullptr;
  else wo["sha256"] = w.sha256;
  wo["current"] = w.current;
  wo["state"] = w.state;
  wo["message"] = w.message;
  o["repo"] = otaRepo();               // extension ("" = not configured in this build)
}

// /status `power` (ROBUSTNESS_PLAN 3.0): while it answers, the display is awake (deep sleep turns Wi-Fi off), so
// nextWakeEpoch stays null. source/charging wording: core/power.h powerSource().
static void powerToJson(JsonObject o) {
  PowerInfo p;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    p = hub().power;
  }
  o["source"] = powerSource(p.charging, p.usb);
  o["charging"] = p.charging;
  o["cpuMhz"] = getCpuFrequencyMhz();
  if (const char* ps = wifiPsMode()) o["wifiPs"] = ps;
  else o["wifiPs"] = nullptr;
  JsonObject a = o["applied"].to<JsonObject>();   // what the power rules set (eink-ha-os#177); QEMU: tracked, not applied
  a["cpuMhz"] = powerAppliedCpuMhz();
  a["wifiPs"] = powerAppliedWifiPs();
  a["psOffHeld"] = wifiPsHeld();
  o["mode"] = powerMode();   // awake | glance (a glance wake in progress; asleep = unreachable)
  o["nextWakeEpoch"] = nullptr;
}

void statusJson(JsonDocument& d) {
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    Hub& h = hub();
    d["name"] = storage().getString("x4dev", "name", "HA Paper");
    d["firmware"] = firmwareVersion();
    d["battery"] = h.power.batteryPct;
    if (h.power.mv) d["battery_mv"] = h.power.mv;   // CW2017 VCELL (eink-ha-os#73); null until read
    else d["battery_mv"] = nullptr;
    d["wifi"] = h.status.wifi == WifiState::Connected ? h.status.ssid : "";
    d["home_assistant"] = h.link.linked() ? haWord(h.status.ha) : "not linked";
    d["screens"] = h.config.screens.size();
    if (h.status.language.empty()) d["language"] = nullptr;   // HA's language (eink-ha-os#98); null until HA told us
    else d["language"] = h.status.language;
    if (h.status.currency.empty() || !h.link.linked()) d["currency"] = nullptr;   // HA's currency (eink-ha-os#147)
    else d["currency"] = h.status.currency;
    // extensions (additive)
    d["charging"] = h.power.charging;
    d["ip"] = h.status.ip;
    d["hostname"] = h.status.hostname;
    d["uptime_s"] = static_cast<uint64_t>(esp_timer_get_time() / 1000000);
    d["free_heap"] = ESP.getFreeHeap();
    d["free_psram"] = ESP.getFreePsram();
    d["heap_largest_block"] = heapLargestFree();   // internal RAM; TLS gate: core/net_policy.h heapOkForTls
    d["heap_min_free"] = heapMinFree();
    JsonObject rep = d["ha_report"].to<JsonObject>();   // net/ha_report (eink-ha-os#32)
    rep["enabled"] = h.settings.haReport;
    rep["state"] = h.haReportState;
    if (h.haReportEpoch) rep["last_push_epoch"] = h.haReportEpoch;
    else rep["last_push_epoch"] = nullptr;
  }
  d["panel"] = panelGuard().failed() ? "failed" : "ok";   // eink-ha-os#181: BUSY stuck → panel given up until restart
  otaToJson(d["ota"].to<JsonObject>());
  powerToJson(d["power"].to<JsonObject>());
  powerTallyJson(d["power"].as<JsonObject>(), d["refreshes"].to<JsonObject>());   // eink-ha-os#178
}

// GET /api/v1/diagnostics/coredump: the ELF image straight from the coredump partition, in chunks.
void sendCoredump(AsyncWebServerRequest* r) {
  size_t offset = 0, size = 0;
  if (!coredumpRange(offset, size)) return sendError(r, 404, "no core dump stored");
  AsyncWebServerResponse* resp = r->beginResponse("application/octet-stream", size,
      [offset, size](uint8_t* buf, size_t maxLen, size_t index) -> size_t {
        if (index >= size) return 0;
        size_t n = size - index < maxLen ? size - index : maxLen;
        return coredumpRead(offset + index, buf, n) ? n : 0;
      });
  resp->addHeader("Content-Disposition", "attachment; filename=\"coredump.elf\"");
  resp->addHeader("Cache-Control", "no-store");
  r->send(resp);
}

std::string haUrlFor(const std::string& requested);

// spec/openapi.yaml ConsoleState. Without a session only the setup fields are filled.
void consoleState(AsyncWebServerRequest* r) {
  Session s;
  const bool signedIn = auth().session(cookieOf(r, Auth::kCookie), s);
  JsonDocument d;
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  Hub& h = hub();
  const bool wifiOk = h.status.wifi == WifiState::Connected;
  const bool linked = h.link.linked();
  d["name"] = storage().getString("x4dev", "name", "HA Paper");
  d["firmware"] = firmwareVersion();
  d["battery"] = h.power.batteryPct;
  if (h.status.ip.empty()) d["ip"] = nullptr;
  else d["ip"] = h.status.ip;
  d["hostname"] = h.status.hostname;
  if (!wifiOk && !linked) d["setup"] = "wifi";
  else if (!linked || !h.setupFinished) d["setup"] = "web";
  else d["setup"] = nullptr;
  d["softap"] = viaSoftAp(r);
  JsonObject w = d["wifi"].to<JsonObject>();
  if (wifiOk) w["connected"] = h.status.ssid;
  else w["connected"] = nullptr;
  JsonArray saved = w["saved"].to<JsonArray>();
  if (!h.savedSsid.empty()) saved.add(h.savedSsid);
  JsonArray nets = d["networks"].to<JsonArray>();
  if (!linked || signedIn)
    for (auto& n : h.networks) {
      JsonObject o = nets.add<JsonObject>();
      o["ssid"] = n.ssid;
      o["rssi"] = n.rssi;
      o["secure"] = n.secure;
    }
  JsonObject ha = d["home_assistant"].to<JsonObject>();
  ha["linked"] = linked;
  ha["revoked"] = linked && h.status.ha == HaState::KeyRevoked;
  // Once linked, the HA address and account are for a signed-in console only (anyone on the LAN can call this).
  const bool showHa = !linked || signedIn;
  // Not linked: the address a sign-in would use (typed / remembered, else the first discovered one).
  ha["server"] = !showHa ? std::string() : linked ? h.link.url : haUrlFor("");
  ha["user"] = showHa ? h.link.user : std::string();
  JsonArray disc = ha["discovered"].to<JsonArray>();   // extension: mDNS _home-assistant._tcp
  if (showHa)
    for (auto& u : h.haDiscovered) disc.add(u);
  d["offline"] = linked && h.status.ha != HaState::Connected;
  JsonObject gaps = d["entity_gaps"].to<JsonObject>();   // eink-ha-os#86: the console says why a tile has no value
  if (linked && signedIn)
    for (auto& kv : h.entityGaps) gaps[kv.first] = kv.second;
  if (h.status.language.empty()) d["language"] = nullptr;   // the console follows it while linked (eink-ha-os#98)
  else d["language"] = h.status.language;
  JsonObject se = d["session"].to<JsonObject>();
  se["signed_in"] = signedIn;
  se["user"] = signedIn ? s.user : "";
  se["admin"] = signedIn && s.admin;   // false: view-only session (HA user who is not an admin)
  JsonArray apps = d["apps"].to<JsonArray>();
  if (signedIn) appsToJson(h.config, apps);
  JsonArray screens = d["screens"].to<JsonArray>();
  if (signedIn) screensToJson(h.config, screens);
  d["config_rev"] = h.configRev;
  d["install_id"] = storage().installId();
  d["seed_pending"] = h.seedPending;   // first HA connection still has to build the screens (eink-ha-os#23)
  JsonArray toks = d["tokens"].to<JsonArray>();
  if (signedIn && s.admin)
    for (auto& t : auth().tokens()) tokenToJson(t, toks.add<JsonObject>());
  sendJsonDoc(r, 200, d);
}

// ---------------------------------------------------------------- config

// GET /api/v1/ha/entities: what the console's entity picker offers. A missing or > 5 min old list asks Home Assistant
// again (net task); until the first answer arrives: ready false. The list (~70 KB for 800 entities, PSRAM) is streamed
// from the hub's shared copy, never copied into one body string (eink-ha-os#57).
void haEntities(AsyncWebServerRequest* r) {
  if (!authorize(r, Scope::Read)) return;
  std::shared_ptr<const std::string> list;
  std::string areas;
  ListCounts lc;
  ListCount ec;
  bool ask = false;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    Hub& h = hub();
    if (h.link.linked() && h.status.ha == HaState::Connected) {
      list = h.haEntities;
      areas = h.haAreas;
      lc = h.haLists;
      ec = h.haEntitiesCount;
      uint32_t now = millis();
      bool stale = !h.haEntitiesAtMs || now - h.haEntitiesAtMs > 300000;
      bool running = h.haEntitiesAskMs && now - h.haEntitiesAskMs < 30000;
      if (stale && !running) { h.haEntitiesAskMs = now | 1; ask = true; }
    }
  }
  if (ask) hub().post([] { haClient().requestEntityList(); });
  if (!list || list->empty()) return sendJson(r, 200, "{\"ready\":false,\"areas\":[],\"entities\":[]}");
  auto n = [](const ListCount& c) { return "{\"total\":" + std::to_string(c.total) + ",\"shown\":" + std::to_string(c.shown) + "}"; };
  auto prefix = std::make_shared<const std::string>("{\"ready\":true,\"areas\":" + areas + ",\"lists\":{\"climate\":" +
                                                    n(lc.climate) + ",\"lights\":" + n(lc.lights) + ",\"entities\":" + n(ec) + "},\"entities\":");   // areas: eink-ha-os#127, lists: eink-ha-os#134 / eink-ha-os#150
  const size_t head = prefix->size();
  const size_t total = head + list->size() + 1;   // head · list · "}"
  AsyncWebServerResponse* resp = r->beginResponse(kJson, total, [prefix, list, head, total](uint8_t* buf, size_t max, size_t index) -> size_t {
    size_t n = 0;
    while (n < max && index < total) {
      size_t k = 1;
      if (index < head) {
        k = std::min(max - n, head - index);
        memcpy(buf + n, prefix->data() + index, k);
      } else if (index < total - 1) {
        k = std::min(max - n, total - 1 - index);
        memcpy(buf + n, list->data() + (index - head), k);
      } else {
        buf[n] = '}';
      }
      n += k;
      index += k;
    }
    return n;
  });
  resp->addHeader("Cache-Control", "no-store");
  r->send(resp);
}

void sendParseError(AsyncWebServerRequest* r, const ParseResult& p) {
  JsonDocument d;
  d["error"] = (p.line > 0 ? "line " + std::to_string(p.line) + ": " : std::string()) + p.message;
  d["line"] = p.line;
  d["message"] = p.message;
  sendJsonDoc(r, 422, d);
}

void getConfig(AsyncWebServerRequest* r) {
  if (!authorize(r, Scope::Read)) return;
  const bool json = header(r, "Accept").find("application/json") != std::string::npos;
  std::string text;
  {
    PsramScope ps;   // the copy, the DOM and the text: ~10 KB of small blocks on a real house (eink-ha-os#160)
    Config c;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      c = hub().config;
    }
    if (json) {
      JsonDocument d(psramJson());
      d["version"] = c.version;
      appsToJson(c, d["apps"].to<JsonArray>());
      screensToJson(c, d["screens"].to<JsonArray>());
      serializeJson(d, text);
    } else {
      text = toYaml(c);
    }
  }
  if (json) return sendJson(r, 200, text);
  AsyncWebServerResponse* resp = r->beginResponse(200, "application/yaml", text.c_str());
  resp->addHeader("Cache-Control", "no-store");
  r->send(resp);
}

// Parse a config body in PSRAM (eink-ha-os#160): the YAML lines, key/value pairs and the parsed Config were ~15 KB of small
// internal blocks per PUT. Only the summary leaves the scope.
struct ConfigParse {
  bool empty = false;
  ParseResult p;   // p.config stays empty: the screens live in PSRAM until the scope ends
  size_t screens = 0, widgets = 0;
};
ConfigParse parseBody(AsyncWebServerRequest* r, bool apply) {
  ConfigParse out;
  PsramScope ps;
  const char* b = r->_tempObject ? static_cast<const char*>(r->_tempObject) : "";
  if (apply && !*b) {   // PUT: 400; validate reports the parser's message
    out.empty = true;
    return out;
  }
  ParseResult p = parseConfig(b);
  if (p.ok) {
    out.screens = p.config.screens.size();
    for (auto& s : p.config.screens) out.widgets += s.widgets.size();
    if (apply) DeviceServices::applyConfig(p.config);
  }
  out.p.ok = p.ok;
  out.p.line = p.line;
  out.p.message = p.message;
  return out;
}

void putConfig(AsyncWebServerRequest* r, AuthResult& a) {
  ConfigParse c = parseBody(r, true);
  if (c.empty) return sendError(r, 400, "empty body");
  if (!c.p.ok) return sendParseError(r, c.p);
  LOG_INF("API", "PUT /api/v1/config · 200 · %u screens · %s from %s", static_cast<unsigned>(c.screens), a.who.c_str(),
          clientIp(r).c_str());
  JsonDocument d;
  d["status"] = "applied";
  d["screens"] = c.screens;
  sendJsonDoc(r, 200, d);
}

void validateConfig(AsyncWebServerRequest* r) {
  if (!authorize(r, Scope::Read)) return;
  ConfigParse c = parseBody(r, false);
  if (!c.p.ok) return sendParseError(r, c.p);
  JsonDocument d;
  d["status"] = "valid";
  d["screens"] = c.screens;
  d["widgets"] = c.widgets;
  sendJsonDoc(r, 200, d);
}

void sendPng(AsyncWebServerRequest* r, std::shared_ptr<const std::vector<uint8_t>> png, const char* source) {
  AsyncWebServerResponse* resp = r->beginResponse("image/png", png->size(), [png](uint8_t* buf, size_t max, size_t index) -> size_t {
    if (index >= png->size()) return 0;
    size_t n = std::min(max, png->size() - index);
    memcpy(buf, png->data() + index, n);
    return n;
  });
  resp->addHeader("Cache-Control", "no-store");
  resp->addHeader("X-X4-Preview", source);
  r->send(resp);
}

void sendPreviewBusy(AsyncWebServerRequest* r) {
  AsyncWebServerResponse* resp = r->beginResponse(503, kJson, errorJson("display busy").c_str());
  resp->addHeader("Retry-After", "2");
  r->send(resp);
}

// GET /screens/{id}/preview.png (eink-ha-os#168): the screen the panel shows is its frame; any other screen is drawn off-screen
// by the main loop (net/device_services pump), one at a time, 503 + Retry-After while busy.
void preview(AsyncWebServerRequest* r, const std::string& id) {
  if (!authorize(r, Scope::Read)) return;
  const uint8_t* fb = nullptr;
  bool known = false, shown = false, busy = false;
  std::function<void(std::shared_ptr<const std::vector<uint8_t>>)> stale;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    Hub& h = hub();
    for (auto& s : h.config.screens) known |= s.id == id;
    fb = h.lastFrame;
    shown = known && fb && h.shownScreen == id;
    if (known && !shown) {
      const uint32_t now = millis();
      if (h.previewReply && now - h.previewAskMs < Hub::kPreviewWaitMs) busy = true;
      else {
        stale = std::move(h.previewReply);   // never picked up: the main loop is stuck
        AsyncWebServerRequestPtr ptr = r->pause();
        h.previewAsk = id;
        h.previewAskMs = now;
        h.previewReply = [ptr](std::shared_ptr<const std::vector<uint8_t>> png) {
          auto req = ptr.lock();
          if (!req) return;
          if (png) sendPng(req.get(), std::move(png), "rendered");
          else sendPreviewBusy(req.get());
        };
      }
    }
  }
  if (stale) stale(nullptr);
  if (!known) return sendError(r, 404, "unknown screen");
  if (busy) return sendPreviewBusy(r);
  if (!shown) return;   // answered by the main loop
  std::shared_ptr<const std::vector<uint8_t>> png;
  {
    PsramScope ps;
    png = std::make_shared<const std::vector<uint8_t>>(encodePng2bpp(fb, kScreenW, kScreenH));
  }
  sendPng(r, std::move(png), "current-panel");
}

// POST /debug/input (eink-ha-os#214): the same queue as touch/keys (App coalescing applies); off unless display.debugInput.
void debugInput(AsyncWebServerRequest* r) {
  if (!authorize(r, Scope::Write)) return;
  bool on;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    on = hub().settings.debugInput;
  }
  if (!on) return sendError(r, 403, "remote input is off");
  std::string spec;
  for (const char* k : {"tap", "key", "swipe"})
    if (r->hasParam(k)) spec = std::string(k) + "=" + r->getParam(k)->value().c_str();
  InputEvent e;
  if (!parseInputSpec(spec, e)) return sendError(r, 400, "use ?tap=x,y | ?key=prev|next|home|power | ?swipe=-1|1");
  Board* b = g_inputBoard.load();
  if (!b || !b->pushInput(e)) return sendError(r, 503, "input queue full");
  LOG_INF("INPUT", "remote %s", spec.c_str());
  sendNoContent(r);
}

// GET /debug/framebuffer.png (eink-ha-os#214): the frame last pushed to the panel.
void debugFramebuffer(AsyncWebServerRequest* r) {
  if (!authorize(r, Scope::Read)) return;
  const uint8_t* fb;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    fb = hub().lastFrame;
  }
  if (!fb) return sendError(r, 503, "no frame yet");
  std::shared_ptr<const std::vector<uint8_t>> png;
  {
    PsramScope ps;
    png = std::make_shared<const std::vector<uint8_t>>(encodePng2bpp(fb, kScreenW, kScreenH));
  }
  sendPng(r, std::move(png), "current-panel");
}

// GET /screens/{id}/values (eink-ha-os#122): formatted by the main loop (it owns the entity store); ready: false until it has.
void screenValues(AsyncWebServerRequest* r, const std::string& id) {
  if (!authorize(r, Scope::Read)) return;
  bool known = false, ready = false;
  std::vector<std::string> values;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    Hub& h = hub();
    for (auto& s : h.config.screens) known |= s.id == id;
    if (known) {
      uint32_t now = millis();
      h.valuesAsk = id;
      h.valuesAskMs = now | 1;
      ready = h.valuesAtMs && h.valuesId == id && now - h.valuesAtMs < 5000;
      if (ready) values = h.values;
    }
  }
  if (!known) return sendError(r, 404, "unknown screen");
  JsonDocument d;
  d["ready"] = ready;
  JsonArray a = d["values"].to<JsonArray>();
  for (auto& v : values) a.add(v);
  sendJsonDoc(r, 200, d);
}

// ---------------------------------------------------------------- Wi-Fi

void wifiStateJson(JsonDocument& d) {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  d["state"] = hub().wifiJoin;
  if (hub().status.wifi == WifiState::Connected) d["connected"] = hub().status.ssid;
  else d["connected"] = nullptr;
  JsonArray saved = d["saved"].to<JsonArray>();
  if (!hub().savedSsid.empty()) saved.add(hub().savedSsid);
  if (!hub().wifiError.empty()) d["error"] = hub().wifiError;
}

// POST /wifi → 202 at once; the browser polls GET /wifi (the page may drop while the radio switches).
void wifiConnect(AsyncWebServerRequest* r) {
  if (!authorizeSetup(r)) return;
  JsonDocument d;
  if (deserializeJson(d, body(r))) return sendError(r, 400, "expected JSON {ssid, password}");
  std::string ssid = d["ssid"] | "";
  std::string pw = d["password"] | "";
  if (ssid.empty()) return sendError(r, 400, "Pick a network");
  bool secure = true, saved = false;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    for (auto& n : hub().networks)
      if (n.ssid == ssid) secure = n.secure;
    saved = hub().savedSsid == ssid;
  }
  if (pw.empty() && saved) {
    WifiCreds c;
    if (storage().loadWifi(c)) pw = c.password;
  }
  if (secure && pw.size() < 8) return sendError(r, 400, "Wi-Fi passwords have at least 8 characters.");
  if (pw.size() > 63) return sendError(r, 400, "Wi-Fi passwords have at most 63 characters.");
  LOG_INF("API", "POST /api/v1/wifi {\"ssid\":\"%s\"} · device tries to join", ssid.c_str());
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().wifiJoin = "connecting";
    hub().wifiError.clear();
  }
  hub().post([ssid, pw] { wifiMgr().connect(ssid, pw, nullptr); });
  JsonDocument o;
  wifiStateJson(o);
  sendJsonDoc(r, 202, o);
}

void wifiScan(AsyncWebServerRequest* r) {
  if (!authorizeSetup(r)) return;
  AsyncWebServerRequestPtr ptr = r->pause();
  hub().post([ptr] {
    std::vector<WifiNetwork> nets = wifiMgr().scanNow();
    auto req = ptr.lock();
    if (!req) return;
    JsonDocument d;
    JsonArray a = d.to<JsonArray>();
    for (auto& n : nets) {
      JsonObject o = a.add<JsonObject>();
      o["ssid"] = n.ssid;
      o["rssi"] = n.rssi;
      o["secure"] = n.secure;
    }
    sendJsonDoc(req.get(), 200, d);
  });
}

// ---------------------------------------------------------------- Home Assistant sign-in

// Pick the HA base URL for a sign-in. Linked devices always use the linked server.
std::string haUrlFor(const std::string& requested) {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  if (hub().link.linked()) return hub().link.url;
  if (!requested.empty()) {
    const std::string u = ha_address::parse(requested).url;   // "" = not an address
    if (u.empty()) return {};
    hub().link.url = u;
    storage().saveHaUrl(u);
    return u;
  }
  if (!hub().link.url.empty()) return hub().link.url;
  std::string stored = storage().haUrl();
  if (!stored.empty()) return stored;
  return hub().haDiscovered.empty() ? std::string() : hub().haDiscovered[0];
}

// Returns "" and sends an error when sign-in can't start.
std::string startAuth(AsyncWebServerRequest* r, const std::string& requestedUrl, const std::string& returnTo,
                      bool respondJson) {
  if (viaSoftAp(r)) {
    if (respondJson) sendError(r, 409, "Connect the display to your Wi-Fi first, then continue at http://" + hostnameLocal());
    else r->redirect("/setup?auth_error=wifi");
    return {};
  }
  std::string ha = haUrlFor(requestedUrl);
  if (ha.empty()) {
    if (respondJson) {
      JsonDocument d;
      d["error"] = "Home Assistant not found on this network. Enter its address.";
      d["need"] = "ha_url";   // extension: POST /auth/ha/start {ha_url} or POST /ha/url
      sendJsonDoc(r, 503, d);
    } else {
      r->redirect("/setup?auth_error=no_ha");
    }
    return {};
  }
  std::string host = str(r->host());
  if (host.empty()) host = hostnameLocal();
  bool link = !deviceLinked();
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    link = link || hub().status.ha == HaState::KeyRevoked;
  }
  std::string url = haAuth().authorizeUrl(host, ha, link, returnTo);
  LOG_INF("WEB", "sign-in → 302 %s/auth/authorize?client_id=http://%s/ (%s)", ha.c_str(), host.c_str(),
          link ? "links the display" : "browser session");
  if (link && !deviceLinked()) {   // a re-link after "key revoked" keeps showing the revoked state until it succeeds
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().status.ha = HaState::Linking;
    hub().linkingSinceMs = millis();
    hub().markStatus();
  }
  return url;
}

// HA address probe in flight / last one ended (eink-ha-os#75). Guarded by hub().mu.
struct {
  bool busy = false, ran = false;
  uint32_t endMs = 0;
} g_probe;

// POST /api/v1/auth/ha/start. Not linked yet: the address (typed, else remembered / discovered) must answer as Home
// Assistant first (eink-ha-os#54); it is remembered only then. Probing blocks, so it runs on the net task.
void authHaStart(AsyncWebServerRequest* r) {
  JsonDocument in;
  deserializeJson(in, body(r));
  const std::string typed = in["ha_url"] | "";
  const std::string returnTo = in["return_to"] | "/";
  const std::string input = typed.empty() ? haUrlFor("") : typed;
  if (viaSoftAp(r) || deviceLinked() || input.empty()) {   // 409 / linked server / 503 need ha_url
    std::string url = startAuth(r, "", returnTo, true);
    if (url.empty()) return;
    return sendJson(r, 200, "{\"authorize_url\":\"" + jsonEscape(url) + "\"}");
  }
  const ha_address::Parsed parsed = ha_address::parse(input);
  if (!parsed.error.empty()) {   // not an address: answered here, no probe
    JsonDocument d;
    d["error"] = parsed.error;
    d["need"] = "ha_url";
    return sendJsonDoc(r, 422, d);
  }
  {   // one probe in flight, then a short cooldown (eink-ha-os#75): each one holds the net task for up to 2 × 5 s
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    if (g_probe.busy || (g_probe.ran && millis() - g_probe.endMs < ha_address::kProbeCooldownMs)) {
      AsyncWebServerResponse* resp = r->beginResponse(429, kJson, errorJson(ha_address::kProbeBusy).c_str());
      resp->addHeader("Retry-After", "1");
      return r->send(resp);
    }
    g_probe.busy = true;
  }
  AsyncWebServerRequestPtr ptr = r->pause();
  hub().post([ptr, input, returnTo] {
    ha_address::Resolved res = ha_address::resolve(input, [](const std::string& u) {
      ha_address::Answer a;
      a.status = httpProbe(u + ha_address::kProbePath, a.body, a.location, 4096, 5000);
      LOG_INF("WEB", "HA probe %s%s → %d", u.c_str(), ha_address::kProbePath, a.status);
      return a;
    });
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      g_probe.busy = false, g_probe.ran = true, g_probe.endMs = millis();
    }
    auto req = ptr.lock();
    if (!req) return;
    if (res.url.empty()) {
      JsonDocument d;
      d["error"] = res.error;
      d["need"] = "ha_url";
      return sendJsonDoc(req.get(), res.status, d);
    }
    std::string url = startAuth(req.get(), res.url, returnTo, true);   // remembers res.url
    if (url.empty()) return;
    sendJson(req.get(), 200, "{\"authorize_url\":\"" + jsonEscape(url) + "\"}");
  });
}

void clearLinking() {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  if (!hub().link.linked() && hub().status.ha == HaState::Linking) {
    hub().status.ha = HaState::NeverLinked;
    hub().markStatus();
  }
}

std::string withQuery(const std::string& path, const std::string& kv) {
  return path + (path.find('?') == std::string::npos ? "?" : "&") + kv;
}

// HA → /auth/callback?code&state. Exchanges the code (net task): links the display if it isn't yet, and
// creates the browser session (view-only unless the user is an HA admin, issue eink-ha-os#22). 302 → return_to.
// Spec (openapi.yaml): unknown / used state → 400 (no session).
void sendAuthError(AsyncWebServerRequest* r, int code, const std::string& msg) {
  std::string html = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>HA Paper</title>"
                     "<body style=\"font:16px system-ui;padding:32px\"><h1>Sign-in failed</h1><p>" + msg +
                     "</p><p><a href=\"/\">Back to the display</a></p>";
  r->send(code, "text/html; charset=utf-8", html.c_str());
}

void authCallback(AsyncWebServerRequest* r) {
  PendingAuth p;
  if (!r->hasParam("state") || !haAuth().takePending(str(r->arg("state")), p)) {
    clearLinking();
    LOG_WRN("WEB", "auth callback rejected · unknown or used state");
    return sendAuthError(r, 400, "This sign-in link is not valid (state mismatch or expired). Start the sign-in again.");
  }
  if (r->hasParam("error")) {
    clearLinking();
    return r->redirect(withQuery(p.returnTo, "signin=denied").c_str());
  }
  if (!r->hasParam("code")) {
    clearLinking();
    return sendAuthError(r, 400, "Home Assistant did not send a code.");
  }
  const std::string code = str(r->arg("code"));
  AsyncWebServerRequestPtr ptr = r->pause();
  hub().post([ptr, p, code] {
    auto redirect = [&ptr](const std::string& to, const std::string& cookie) {
      auto req = ptr.lock();
      if (!req) return;
      AsyncWebServerResponse* resp = req->beginResponse(302);
      resp->addHeader("Location", to.c_str());
      resp->addHeader("Cache-Control", "no-store");
      if (!cookie.empty()) resp->addHeader("Set-Cookie", sessionCookieHeader(cookie).c_str());
      req->send(resp);
    };
    TokenSet t;
    std::string err, name;
    bool admin = false;
    int st = 0;
    bool ok = HaAuth::exchangeCode(p, code, t, err, &st);
    // The open HA WebSocket holds two 16 KB record buffers; the exchange needs two more (eink-ha-os#123). Close it, retry once:
    // it reconnects after this job. An auth code is single use, but HA never saw the failed attempt.
    if (!ok && st == kHttpLowMemory && haClient().yieldTls()) ok = HaAuth::exchangeCode(p, code, t, err, &st);
    if (!ok) {
      clearLinking();
      return redirect(withQuery(p.returnTo, "auth_error=token"), "");
    }
    if (!HaAuth::currentUser(p.haUrl, t.access, name, admin, err)) {
      clearLinking();
      HaAuth::revoke(p.haUrl, t.refresh);
      return redirect(withQuery(p.returnTo, "auth_error=user"), "");
    }
    bool linkNow;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      // first link, or re-link after the key was revoked in HA (same sign-in, like the emulator)
      linkNow = !hub().link.linked() || (p.linkDevice && hub().status.ha != HaState::Connected);
      if (linkNow) {
        HaLink link{"oauth", p.haUrl, p.clientId, t.refresh, name};
        storage().saveHa(link);
        hub().link = link;
        hub().status.ha = HaState::Offline;   // → Connected once the WebSocket is up
        hub().setupFinished = true;           // the same sign-in opens the configurator
        hub().markStatus();
      }
    }
    if (linkNow) {
      haClient().restart();
      LOG_INF("HA", "code → key stored on device (display linked as \"%s\")", name.c_str());
    } else {
      HaAuth::revoke(p.haUrl, t.refresh);   // browser-only sign-in: we don't keep this user's token
    }
    std::string cookie = auth().createSession(name, admin);
    LOG_INF("WEB", "session for \"%s\" (%s) · cookie HttpOnly, 12 h", name.c_str(),
            admin ? "Home Assistant admin" : "not a Home Assistant admin · view only");
    redirect(p.returnTo, cookie);
  });
}

void haToken(AsyncWebServerRequest* r) {
  if (!authorizeSetup(r)) return;
  JsonDocument d;
  if (deserializeJson(d, body(r))) return sendError(r, 400, "expected JSON {url, token}");
  std::string token = d["token"] | "";
  std::string url = haUrlFor(d["url"] | "");
  if (url.empty()) return sendError(r, 422, "Enter the Home Assistant address");
  // spec: 401 = HA rejected the token. A string this short cannot be one, so don't bother HA with it.
  if (token.size() < 20) return sendError(r, 401, "Home Assistant rejected the token");
  AsyncWebServerRequestPtr ptr = r->pause();
  hub().post([ptr, url, token] {
    std::string name, err;
    bool admin = false, rejected = false;
    bool ok = HaAuth::currentUser(url, token, name, admin, err, &rejected);
    auto req = ptr.lock();
    if (!ok) {
      if (req) sendError(req.get(), rejected ? 401 : 502, rejected ? "Home Assistant rejected the token" : err);
      return;
    }
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      HaLink link{"llat", url, "", token, name};
      storage().saveHa(link);
      hub().link = link;
      hub().status.ha = HaState::Offline;
      hub().setupFinished = true;
      hub().markStatus();
    }
    haClient().restart();
    std::string cookie = auth().createSession(name, admin);
    if (!req) return;
    AsyncWebServerResponse* resp = req->beginResponse(200, kJson, ("{\"status\":\"linked\",\"user\":\"" + jsonEscape(name) + "\"}").c_str());
    resp->addHeader("Set-Cookie", sessionCookieHeader(cookie).c_str());
    req->send(resp);
  });
}

// ---------------------------------------------------------------- tokens / settings / ota / device

void listTokens(AsyncWebServerRequest* r) {
  if (!sessionAdmin(r)) return;
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (auto& t : auth().tokens()) tokenToJson(t, a.add<JsonObject>());
  sendJsonDoc(r, 200, d);
}

void createToken(AsyncWebServerRequest* r) {
  if (!sessionAdmin(r)) return;
  JsonDocument in;
  deserializeJson(in, body(r));
  std::string scope = in["scope"] | "read";
  const bool rw = scope == "write" || scope == "rw";
  if (!(rw || scope == "read" || scope == "ro")) return sendError(r, 400, "scope must be read or write");
  ApiToken t;
  std::string secret = auth().createToken(in["name"] | "Token", rw, &t);
  if (secret.empty()) return sendError(r, 409, "too many tokens (max 20) — revoke one first");
  JsonDocument d;
  tokenToJson(t, d.to<JsonObject>());
  d["token"] = secret;   // shown once; only its SHA-256 is stored
  sendJsonDoc(r, 201, d);
}

void settingsJson(JsonDocument& d) {
  DisplaySettings s;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    s = hub().settings;
  }
  JsonDocument disp;
  deserializeJson(disp, Storage::settingsToJson(s));
  d["display"] = disp;
  d["ota_channel"] = otaChannel();
  d["tz"] = timezoneSetting();   // eink-ha-os#147: "" = follow Home Assistant
  d["tz_ha"] = haTimezone();
  d["tz_active"] = timezone();
  d["name"] = storage().getString("x4dev", "name", "HA Paper");
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  JsonObject e = d["entities"].to<JsonObject>();
  for (auto& kv : hub().entityOverrides) e[kv.first] = kv.second;
  JsonObject src = d["entity_sources"].to<JsonObject>();
  for (auto& kv : hub().entitySources) src[kv.first] = kv.second;
}

// settings `entities`: {"<logical id>": "<HA entity id>" | "-<HA entity id>" | "" | null} (core/entity_map.h)
bool validEntityId(const std::string& v) {
  size_t i = v[0] == '-' ? 1 : 0, dot = v.find('.', i);
  if (dot == std::string::npos || dot == i || dot + 1 >= v.size()) return false;
  for (size_t k = i; k < v.size(); ++k) {
    char c = v[k];
    if (!(islower(static_cast<unsigned char>(c)) || isdigit(static_cast<unsigned char>(c)) || c == '_' || (c == '.' && k == dot))) return false;
  }
  return true;
}

void putSettings(AsyncWebServerRequest* r) {
  const std::string raw = body(r);
  JsonDocument in;
  if (deserializeJson(in, raw) || !in.is<JsonObject>()) return sendError(r, 400, "expected a JSON object");
  {
    Json core;   // keys + tz first (core/settings_api): an unknown key or a bad tz applies nothing
    std::string err = parseJson(raw, core) ? settings_api::putError(core) : "expected a JSON object";
    if (!err.empty()) return sendError(r, 422, err);
  }
  if (!in["display"].isNull()) {
    DisplaySettings s;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      s = hub().settings;
    }
    std::string text, err;
    serializeJson(in["display"], text);
    if (!Storage::settingsFromJson(text, s, &err, true)) return sendError(r, 422, "display." + err);
    storage().saveSettings(s);
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().settings = s;
    hub().settingsPending = true;
  }
  if (in["ota_channel"].is<const char*>()) {
    std::string ch = in["ota_channel"].as<const char*>();
    if (ch != "stable" && ch != "beta") return sendError(r, 422, "ota_channel must be stable or beta");
    otaSetChannel(ch);
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().settings.otaChannel = ch;
      hub().settingsPending = true;   // display's Settings › Updates shows the new channel
    }
  }
  if (!in["entities"].isNull()) {
    if (!in["entities"].is<JsonObject>()) return sendError(r, 422, "entities must be an object {logical id: HA entity id}");
    std::map<std::string, std::string> o;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      o = hub().entityOverrides;
    }
    for (JsonPair kv : in["entities"].as<JsonObject>()) {
      const std::string k = kv.key().c_str();
      if (!EntityAdapter::isLogicalId(k)) return sendError(r, 422, "entities: unknown logical id " + k);
      if (kv.value().isNull() || (kv.value().is<const char*>() && !*kv.value().as<const char*>())) {
        o.erase(k);
        continue;
      }
      std::string v = kv.value().is<const char*>() ? kv.value().as<const char*>() : "";
      if (!validEntityId(v)) return sendError(r, 422, "entities: " + k + " must name an HA entity like sensor.my_power");
      o[k] = v;
    }
    JsonDocument save;
    JsonObject so = save.to<JsonObject>();
    for (auto& kv : o) so[kv.first] = kv.second;
    std::string text;
    serializeJson(save, text);
    storage().putString("x4dev", "entities", text);
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().entityOverrides = o;
      hub().sourcesChanged = true;
    }
    LOG_INF("API", "PUT /api/v1/settings · entities · %u overrides", unsigned(o.size()));   // eink-ha-os#81: was invisible in the log
    hub().post([o] { haClient().setEntityOverrides(o); });
  }
  if (in["tz"].is<const char*>()) setTimezone(in["tz"].as<const char*>());   // validated above
  if (in["name"].is<const char*>()) storage().putString("x4dev", "name", std::string(in["name"].as<const char*>()).substr(0, 40));
  JsonDocument d;
  settingsJson(d);
  sendJsonDoc(r, 200, d);
}

void otaCheckReq(AsyncWebServerRequest* r) {
  if (!netConnected()) return sendError(r, 409, "No network — try again later");
  otaRequestCheck();   // result: GET /ota (checking from now on; checks off: nothing runs)
  sendJson(r, 202, "{\"status\":\"checking\"}");
}

void otaInstallReq(AsyncWebServerRequest* r) {
  if (!otaRepo()[0]) return sendError(r, 409, kOtaChecksOffMsg);   // nothing to install from; upload instead
  std::string why;
  if (!otaBatteryOk(&why)) return sendError(r, 409, why);
  AsyncWebServerRequestPtr ptr = r->pause();
  hub().post([ptr] {
    std::string err;
    bool checked = otaCheck(err);
    bool avail;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      avail = hub().status.ota == OtaState::Available;
    }
    if (auto req = ptr.lock()) {
      if (!checked) sendError(req.get(), 502, err);
      else if (!avail) sendError(req.get(), 409, std::string("Already up to date (") + firmwareVersion() + ")");
      else {
        JsonDocument d;
        d["status"] = "started";
        std::lock_guard<std::recursive_mutex> l(hub().mu);
        d["version"] = hub().status.otaAvailableVersion;
        sendJsonDoc(req.get(), 202, d);
      }
    }
    if (checked && avail) otaInstall(err);
  });
}

// ---------------------------------------------------------------- the /api/v1 handler

struct UploadState {   // POD: freed by the server with free()
  bool authed;
  bool started;
  bool failed;
  char err[120];
  uint16_t manifestLen;
  char manifest[1024];  // multipart part "manifest.json" ({version, sha256, size, notes}); never written to flash
};

bool isWwwUpload(AsyncWebServerRequest* r) { return r->url() == "/api/v1/ota/upload-www"; }
bool isUpload(AsyncWebServerRequest* r) { return r->url() == "/api/v1/ota/upload" || isWwwUpload(r); }

class ApiHandler : public AsyncWebHandler {
 public:
  bool canHandle(AsyncWebServerRequest* r) const override { return r->url().startsWith("/api/"); }
  bool isRequestHandlerTrivial() const override { return false; }

  void handleBody(AsyncWebServerRequest* r, uint8_t* data, size_t len, size_t index, size_t total) override {
    if (isWwwUpload(r)) return wwwChunk(r, data, len, index, total);
    if (isUpload(r)) return uploadChunk(r, data, len, index, total, index + len >= total);
    if (total > kMaxBody) return;   // handleRequest answers 413
    if (index == 0 && !r->_tempObject) {   // freed by the request with free(): PSRAM if there is any (eink-ha-os#160)
      r->_tempObject = heap_caps_calloc(total + 1, 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (!r->_tempObject) r->_tempObject = calloc(total + 1, 1);
    }
    if (r->_tempObject && index + len <= total) memcpy(static_cast<char*>(r->_tempObject) + index, data, len);
  }

  void handleUpload(AsyncWebServerRequest* r, const String& filename, size_t index, uint8_t* data, size_t len, bool final) override {
    if (!isUpload(r)) return;
    if (isWwwUpload(r)) {   // raw body only: the image size must be known up front (core/www_image checkTarget)
      UploadState* s = state(r);
      if (s && !s->failed && !s->started) {
        s->failed = true;
        snprintf(s->err, sizeof s->err, "415:send www.bin as the raw body (Content-Type: application/octet-stream)");
      }
      return;
    }
    // multipart: the manifest part must not end up in the image (it used to be appended to firmware.bin → 422)
    if (filename.endsWith(".json")) {
      UploadState* s = state(r);
      if (!s) return;
      size_t room = sizeof s->manifest - 1 - s->manifestLen;
      size_t n = len < room ? len : room;
      memcpy(s->manifest + s->manifestLen, data, n);
      s->manifestLen += n;
      if (final && s->started && !s->failed) otaUploadSetVersion(manifestVersion(s));   // after the image: update the face
      return;
    }
    uploadChunk(r, data, len, index, r->contentLength(), final);   // multipart: total unknown → 0
  }

  void handleRequest(AsyncWebServerRequest* r) override {
    if (r->contentLength() > kMaxBody && !isUpload(r)) return sendError(r, 413, "body too large");
    heapRequestPath(r->url().c_str());
    route(r);
    heapCheckpoint("web");
  }

 private:
  static std::string manifestVersion(const UploadState* s) {
    JsonDocument m;
    if (!s->manifestLen || deserializeJson(m, s->manifest, s->manifestLen)) return "";
    return otaUploadVersion(m["version"] | "");
  }

  static UploadState* state(AsyncWebServerRequest* r) {
    if (!r->_tempObject) r->_tempObject = calloc(1, sizeof(UploadState));
    return static_cast<UploadState*>(r->_tempObject);
  }

  static void uploadChunk(AsyncWebServerRequest* r, uint8_t* data, size_t len, size_t index, size_t total, bool final) {
    UploadState* s = state(r);
    if (!s || s->failed) return;
    if (index == 0) {
      AuthResult a = auth().check(clientIp(r), bearerOf(r), cookieOf(r, Auth::kCookie), Scope::Write);
      if (a.code == 0 && a.viaSession && !sessionWriteOk(r)) {
        a.code = 403;
        a.error = kCrossOrigin;
      }
      if (a.code) {
        s->failed = true;
        snprintf(s->err, sizeof s->err, "%d:%s", a.code, a.error.c_str());
        return;
      }
      s->authed = true;
      std::string err;
      // multipart bodies are larger than the image → size unknown
      const bool raw = !r->contentType().startsWith("multipart/");
      // the install face shows now: name the version if a manifest part came first or ?version= has it (eink-ha-os#237)
      std::string ver = manifestVersion(s);
      if (ver.empty() && r->hasParam("version")) ver = otaUploadVersion(str(r->arg("version")));
      if (!otaUploadBegin(raw ? total : 0, ver, err)) {
        s->failed = true;
        snprintf(s->err, sizeof s->err, "409:%s", err.c_str());
        return;
      }
      s->started = true;
    }
    if (!otaUploadWrite(data, len)) {
      s->failed = true;
      otaUploadAbort();
      snprintf(s->err, sizeof s->err, "500:flash write failed");
    }
    (void)final;
  }

  // POST /ota/upload-www (eink-ha-os#350): www.bin straight into the www partition; sha256 required (a bad image takes the
  // console offline until a good one is written, so nothing unverified counts as done).
  static void wwwChunk(AsyncWebServerRequest* r, uint8_t* data, size_t len, size_t index, size_t total) {
    UploadState* s = state(r);
    if (!s || s->failed) return;
    if (index == 0) {
      AuthResult a = auth().check(clientIp(r), bearerOf(r), cookieOf(r, Auth::kCookie), Scope::Write);
      if (a.code == 0 && a.viaSession && !sessionWriteOk(r)) {
        a.code = 403;
        a.error = kCrossOrigin;
      }
      if (a.code) {
        s->failed = true;
        snprintf(s->err, sizeof s->err, "%d:%s", a.code, a.error.c_str());
        return;
      }
      s->authed = true;
      std::string sha = header(r, "X-SHA256");
      if (r->hasParam("sha256")) sha = str(r->arg("sha256"));
      if (sha.size() != 64) {
        s->failed = true;
        snprintf(s->err, sizeof s->err, "400:sha256 of www.bin required (?sha256= or X-SHA256)");
        return;
      }
      std::string err;
      if (int code = wwwWriteBegin(total, err)) {
        s->failed = true;
        snprintf(s->err, sizeof s->err, "%d:%s", code, err.c_str());
        return;
      }
      s->started = true;
    }
    std::string err;
    if (!wwwWriteChunk(data, len, &err)) {
      s->failed = true;
      snprintf(s->err, sizeof s->err, "500:%s", err.c_str());
      wwwWriteAbort(err.c_str());
    }
  }

  static void finishWwwUpload(AsyncWebServerRequest* r) {
    UploadState* s = static_cast<UploadState*>(r->_tempObject);
    if (!s) {
      if (!authorize(r, Scope::Write)) return;
      return sendError(r, 400, "send www.bin as the request body (application/octet-stream)");
    }
    if (s->failed) {
      if (s->started) wwwWriteAbort("upload failed");
      int code = atoi(s->err);
      const char* msg = strchr(s->err, ':');
      return sendError(r, code ? code : 500, msg ? msg + 1 : "upload failed");
    }
    if (!s->started) return sendError(r, 400, "no www.bin in the upload");
    std::string sha = header(r, "X-SHA256");
    if (r->hasParam("sha256")) sha = str(r->arg("sha256"));
    std::string err, digest;
    if (!wwwWriteEnd(sha, err, &digest)) return sendError(r, 422, err);
    const WwwInfo w = wwwInfo();
    JsonDocument d;
    d["status"] = "written";
    if (w.version.empty()) d["version"] = nullptr;
    else d["version"] = w.version;
    d["sha256"] = digest;
    d["current"] = w.current;
    sendJsonDoc(r, 200, d);
  }

  static void finishUpload(AsyncWebServerRequest* r) {
    UploadState* s = static_cast<UploadState*>(r->_tempObject);
    if (!s) {
      if (!authorize(r, Scope::Write)) return;
      return sendError(r, 400, "send the image as the request body (application/octet-stream) or a multipart file");
    }
    if (s->failed) {
      if (s->started) otaUploadAbort();
      int code = atoi(s->err);
      const char* msg = strchr(s->err, ':');
      return sendError(r, code ? code : 500, msg ? msg + 1 : "upload failed");
    }
    if (!s->started) return sendError(r, 400, "no firmware part in the upload");
    std::string err, digest, version;
    std::string sha = header(r, "X-SHA256");
    if (r->hasParam("sha256")) sha = str(r->arg("sha256"));
    if (s->manifestLen) {
      JsonDocument m;
      if (deserializeJson(m, s->manifest, s->manifestLen)) {
        otaUploadAbort();
        return sendError(r, 400, "manifest.json is not valid JSON");
      }
      if (m["sha256"].is<const char*>()) sha = m["sha256"].as<const char*>();
      version = m["version"] | "";
    }
    if (!otaUploadEnd(sha, err, &digest)) {
      if (!sha.empty() && err.find("SHA-256") != std::string::npos && s->manifestLen) err = "firmware.bin does not match manifest.json — nothing changed";
      return sendError(r, 422, err);
    }
    JsonDocument d;
    d["status"] = "rebooting";
    if (!version.empty()) d["version"] = version;
    d["sha256"] = digest;
    sendJsonDoc(r, 202, d);
  }

  static void route(AsyncWebServerRequest* r) {
    const std::string path = str(r->url());
    const auto m = r->method();
    using namespace AsyncWebRequestMethod;
    const bool GET = m == HTTP_GET, POST = m == HTTP_POST, PUT = m == HTTP_PUT, DEL = m == HTTP_DELETE;
    AuthResult a;

    // --- base API (original design openapi.yaml) ---
    if (path == "/api/v1/status" && GET) {
      if (!authorize(r, Scope::Read)) return;
      JsonDocument d;
      statusJson(d);
      return sendJsonDoc(r, 200, d);
    }
    if (path == "/api/v1/config" && GET) return getConfig(r);
    if ((path == "/api/v1/config" && PUT) || (path == "/api/v1/config/validate" && POST)) {
      if (r->contentType().startsWith("application/x-www-form-urlencoded"))
        return sendError(r, 415, "send the file with -H \"Content-Type: application/yaml\" (or application/json)");
    }
    if (path == "/api/v1/config" && PUT) {
      if (!authorize(r, Scope::Write, &a)) return;
      return putConfig(r, a);
    }
    if (path == "/api/v1/config/validate" && POST) return validateConfig(r);
    if (path.rfind("/api/v1/screens/", 0) == 0 && GET) {
      const std::string rest = path.substr(16);
      const std::string suffix = "/preview.png";
      if (rest.size() > suffix.size() && rest.compare(rest.size() - suffix.size(), suffix.size(), suffix) == 0)
        return preview(r, rest.substr(0, rest.size() - suffix.size()));
      const std::string vals = "/values";
      if (rest.size() > vals.size() && rest.compare(rest.size() - vals.size(), vals.size(), vals) == 0)
        return screenValues(r, rest.substr(0, rest.size() - vals.size()));
    }
    if (path == "/api/v1/debug/input" && POST) return debugInput(r);
    if (path == "/api/v1/debug/framebuffer.png" && GET) return debugFramebuffer(r);
    if (path == "/api/v1/display/refresh" && POST) {
      if (!authorize(r, Scope::Write)) return;
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().refreshPending = true;
      return sendNoContent(r);
    }
    if (path == "/api/v1/ota" && POST) {
      if (!authorize(r, Scope::Write)) return;
      return otaInstallReq(r);
    }

    // --- extensions (spec/openapi.yaml) ---
    if (path == "/api/v1/console/state" && GET) return consoleState(r);
    if (path == "/api/v1/wifi" && POST) return wifiConnect(r);
    if (path == "/api/v1/wifi" && GET) {
      if (!authorizeSetup(r)) return;
      JsonDocument d;
      wifiStateJson(d);
      return sendJsonDoc(r, 200, d);
    }
    if (path == "/api/v1/wifi/scan" && POST) return wifiScan(r);
    if (path == "/api/v1/auth/ha/start" && POST) return authHaStart(r);
    if (path == "/api/v1/session/logout" && POST) {
      auth().endSession(cookieOf(r, Auth::kCookie));
      AsyncWebServerResponse* resp = r->beginResponse(204);
      resp->addHeader("Set-Cookie", sessionCookieHeader("").c_str());
      return r->send(resp);
    }
    if (path == "/api/v1/ha/token" && POST) return haToken(r);
    if (path == "/api/v1/ha/entities" && GET) return haEntities(r);
    if (path == "/api/v1/ha/url" && POST) {
      if (!authorizeSetup(r)) return;
      if (deviceLinked()) return sendError(r, 409, "unlink first to change the Home Assistant server");
      JsonDocument in;
      deserializeJson(in, body(r));
      std::string u = haUrlFor(in["url"] | "");
      if (u.empty()) return sendError(r, 422, "not a valid URL");
      return sendJson(r, 200, "{\"url\":\"" + jsonEscape(u) + "\"}");
    }
    if (path == "/api/v1/ha/discover" && POST) {
      if (!authorizeSetup(r)) return;
      hub().post([] { wifiMgr().discoverHa(); });
      return sendJson(r, 202, "{\"status\":\"searching\"}");
    }
#if X4_QEMU
    if (path == "/api/v1/debug/ha-discovered" && POST) {   // stands in for mDNS (slirp has none); QEMU image only
      JsonDocument in;
      deserializeJson(in, body(r));
      std::vector<std::string> urls;
      for (JsonVariantConst u : in["urls"].as<JsonArrayConst>()) urls.push_back(u | "");
      const std::vector<std::string> found = wifiMgr().applyDiscovered(urls);
      std::string list;
      for (const auto& u : found) list += (list.empty() ? "" : ", ") + u;
      LOG_INF("HA", "discovered (injected): %s", list.empty() ? "none" : list.c_str());
      return sendJson(r, 200, "{\"discovered\":" + std::to_string(found.size()) + "}");
    }
#endif
    if (path == "/api/v1/ha" && DEL) {
      if (!sessionAdmin(r)) return;
      DeviceServices::unlinkHa();
      AsyncWebServerResponse* resp = r->beginResponse(204);
      resp->addHeader("Set-Cookie", sessionCookieHeader("").c_str());
      return r->send(resp);
    }
    if (path == "/api/v1/setup/finish" && POST) {
      if (!sessionAdmin(r)) return;
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().setupFinished = true;
      hub().markStatus();
      return sendNoContent(r);
    }
    if (path == "/api/v1/tokens" && GET) return listTokens(r);
    if (path == "/api/v1/tokens" && POST) return createToken(r);
    if (path.rfind("/api/v1/tokens/", 0) == 0 && DEL) {
      if (!sessionAdmin(r)) return;
      return auth().revokeToken(path.substr(15)) ? sendNoContent(r) : sendError(r, 404, "no such token");
    }
    if (path == "/api/v1/settings" && GET) {
      if (!authorize(r, Scope::Read)) return;
      JsonDocument d;
      settingsJson(d);
      return sendJsonDoc(r, 200, d);
    }
    if (path == "/api/v1/settings" && PUT) {
      if (!authorize(r, Scope::Write)) return;
      return putSettings(r);
    }
    if (path == "/api/v1/ota" && GET) {
      if (!authorize(r, Scope::Read)) return;
      JsonDocument d;
      otaToJson(d.to<JsonObject>());
      return sendJsonDoc(r, 200, d);
    }
    if (path == "/api/v1/ota/check" && POST) {
      if (!authorize(r, Scope::Write)) return;
      return otaCheckReq(r);
    }
    if (path == "/api/v1/ota/upload" && POST) return finishUpload(r);
    if (path == "/api/v1/ota/upload-www" && POST) return finishWwwUpload(r);
    if (path == "/api/v1/diagnostics" && GET) {
      if (!authorize(r, Scope::Read)) return;
      return sendJson(r, 200, diagReportJson());
    }
    if (path == "/api/v1/logs" && GET) {   // eink-ha-os#200: the log ring (net/log.h)
      if (!authorize(r, Scope::Read)) return;
      auto arg = [r](const char* k) { return r->hasParam(k) ? r->getParam(k)->value().c_str() : nullptr; };
      logs::Query q;
      std::string err;
      if (!logs::parseQuery(arg("since"), arg("level"), arg("tag"), arg("limit"), q, err)) return sendError(r, 422, err);
      const char* boot = arg("boot");
      if (boot && strcmp(boot, "previous") != 0 && strcmp(boot, "current") != 0) return sendError(r, 422, "boot must be current or previous");
      std::shared_ptr<const std::string> body;
      {
        PsramScope ps;   // the body (up to ~120 KB for a full ring) in PSRAM, streamed without a copy
        body = std::make_shared<const std::string>(logsJson(q, boot && !strcmp(boot, "previous")));
      }
      const size_t total = body->size();
      AsyncWebServerResponse* resp = r->beginResponse(kJson, total, [body, total](uint8_t* buf, size_t max, size_t index) -> size_t {
        const size_t k = index < total ? std::min(max, total - index) : 0;
        memcpy(buf, body->data() + index, k);
        return k;
      });
      resp->addHeader("Cache-Control", "no-store");
      return r->send(resp);
    }
    if (path == "/api/v1/diagnostics" && DEL) {
      if (!authorize(r, Scope::Write)) return;
      diagClear();
      return sendNoContent(r);
    }
    if (path == "/api/v1/seed" && (GET || DEL)) {   // eink-ha-os#89: written once by the first-link seed (HaClient::maybeSeed)
      if (!authorize(r, GET ? Scope::Read : Scope::Write)) return;
      std::string j;
      if (!storage().readFile("/seed.json", j) || j.empty()) return sendError(r, 404, "no seed report");
      if (GET) return sendJson(r, 200, j);
      const std::string open = "\"dismissed\":false}";
      if (j.size() >= open.size() && j.compare(j.size() - open.size(), open.size(), open) == 0) {
        j.replace(j.size() - open.size(), open.size(), "\"dismissed\":true}");
        storage().writeFile("/seed.json", j);
      }
      return sendNoContent(r);
    }
    if (path == "/api/v1/diagnostics/coredump" && GET) {
      if (!authorize(r, Scope::Write)) return;   // the image holds RAM contents (tokens in flight)
      return sendCoredump(r);
    }
    if (path == "/api/v1/device/restart" && POST) {
      if (!authorize(r, Scope::Write)) return;
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().restartPending = true;
      hub().restartAtMs = millis() + 1000;
      return sendJson(r, 202, "{\"status\":\"restarting\"}");
    }
    if (path == "/api/v1/device/sleep" && POST) {   // eink-ha-os#178: deep sleep now (power measurements)
      if (!authorize(r, Scope::Write)) return;
      JsonDocument in;
      deserializeJson(in, body(r));
      const JsonVariantConst sec = in["seconds"];
      const bool num = sec.is<double>();   // any JSON number
      const SleepNowCheck c = powerSleepRequest(num, num ? sec.as<double>() : 0);
      if (c.status != 202) return sendError(r, c.status, c.error);
      return sendJson(r, 202, "{\"status\":\"sleeping\",\"seconds\":" + std::to_string(int64_t(sec.as<double>())) + "}");
    }
    if (path == "/api/v1/device/factory-reset" && POST) {
      if (!sessionAdmin(r)) return;
      hub().post([] { DeviceServices::doFactoryReset(); });
      AsyncWebServerResponse* resp = r->beginResponse(202, kJson, "{\"status\":\"resetting\"}");
      resp->addHeader("Set-Cookie", sessionCookieHeader("").c_str());
      return r->send(resp);
    }
    sendError(r, 404, "no such endpoint");
  }
};

// ---------------------------------------------------------------- SPA + captive portal

// Console files live on the `www` partition (www.bin), not on userdata (net/storage.h).
bool wwwHas(const char* path) {
  size_t n;
  return wwwStat(path, n);
}
bool hasUi() { return wwwHas("/www/index.html.gz") || wwwHas("/www/index.html"); }

const char* mimeOf(const std::string& p) {
  auto ends = [&](const char* e) { size_t n = strlen(e); return p.size() >= n && p.compare(p.size() - n, n, e) == 0; };
  return ends(".html") ? "text/html" : ends(".js") ? "application/javascript" : ends(".css") ? "text/css"
       : ends(".woff2") ? "font/woff2" : ends(".yaml") ? "application/yaml" : ends(".svg") ? "image/svg+xml"
       : ends(".png") ? "image/png" : ends(".json") ? "application/json" : ends(".ico") ? "image/x-icon"
       : ends(".txt") ? "text/plain" : "application/octet-stream";
}

// eink-ha-os#350: console files go out chunk by chunk through wwwRead (open, seek, read, close under the www lock). No File
// handle outlives a callback, so a console rewrite can unmount the partition at any time; a response cut by it ends
// short. path: "/www/<file>" without .gz (the .gz is preferred).
bool sendWwwFile(AsyncWebServerRequest* r, const std::string& path, const char* type = nullptr) {
  size_t n = 0;
  std::string f = path + ".gz";
  const bool gz = wwwStat(f.c_str(), n);
  if (!gz && !wwwStat((f = path).c_str(), n)) return false;
  AsyncWebServerResponse* resp = r->beginResponse(type ? type : mimeOf(path), n, [f](uint8_t* buf, size_t max, size_t index) -> size_t {
    const int k = wwwRead(f.c_str(), index, buf, max);
    return k > 0 ? size_t(k) : 0;
  });
  if (gz) resp->addHeader("Content-Encoding", "gzip");
  resp->addHeader("Cache-Control", "no-cache");
  r->send(resp);
  return true;
}

std::string htmlEsc(const std::string& s) {
  std::string o;
  for (char c : s) o += c == '<' ? "&lt;" : c == '>' ? "&gt;" : c == '&' ? "&amp;" : c == '"' ? "&quot;" : std::string(1, c);
  return o;
}

// eink-ha-os#350: the console on the www partition is not this firmware's (or is being / failed to be rewritten). The old
// console stays one click away (/?console=old); a console from before eink-ha-os#350 has no version.txt.
bool consoleStale(AsyncWebServerRequest* r) { return !r->hasParam("console") && hasUi() && !wwwCurrent(); }

void sendWwwPage(AsyncWebServerRequest* r) {
  const WwwInfo w = wwwInfo();
  const bool updating = std::strcmp(w.state, "updating") == 0, failed = std::strcmp(w.state, "failed") == 0;
  const bool checks = otaRepo()[0] != '\0';
  std::string h = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
                  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">";
  if (updating || checks) h += "<meta http-equiv=\"refresh\" content=\"15\">";
  h += "<title>HA Paper</title><style>body{font:16px/1.45 system-ui,sans-serif;max-width:520px;margin:0 auto;"
       "padding:24px 16px}code{font-size:13px;word-break:break-all}.mut{color:#6f6c66;font-size:14px}</style>"
       "</head><body><h1>";
  h += updating ? "Updating the web console…" : failed ? "Web console not available" : "Web console out of date";
  h += "</h1><p>Firmware v" + htmlEsc(firmwareVersion()) + ", console " +
       (w.version.empty() ? std::string("from an older release") : "v" + htmlEsc(w.version)) + ".</p>";
  if (failed) h += "<p>" + htmlEsc(w.message) + "</p>";
  if (updating) h += "<p>This page reloads when it is done.</p>";
  else if (checks) h += "<p>The display downloads the matching console from the release by itself. This page reloads.</p>";
  if (!updating) {
    h += "<p class=\"mut\">Or upload <code>www.bin</code> of v" + htmlEsc(firmwareVersion()) +
         " with an API token: <code>curl -X POST -H \"Authorization: Bearer $X4_TOKEN\" --data-binary @www.bin "
         "-H \"Content-Type: application/octet-stream\" \"http://" + htmlEsc(hostnameLocal()) +
         "/api/v1/ota/upload-www?sha256=$(shasum -a 256 www.bin | cut -d' ' -f1)\"</code></p>";
    if (!failed && hasUi()) h += "<p><a href=\"/?console=old\">Open the old console anyway</a></p>";
  }
  h += "</body></html>";
  AsyncWebServerResponse* resp = r->beginResponse(200, "text/html", h.c_str());
  resp->addHeader("Cache-Control", "no-cache");
  r->send(resp);
}

void sendSpa(AsyncWebServerRequest* r) {
  const char* st = wwwInfo().state;
  if (std::strcmp(st, "updating") == 0 || std::strcmp(st, "failed") == 0 || consoleStale(r)) return sendWwwPage(r);
  if (sendWwwFile(r, "/www/index.html")) return;
  AsyncWebServerResponse* resp = r->beginResponse(200, "text/html", kFallbackPage);
  resp->addHeader("Cache-Control", "no-cache");
  r->send(resp);
}

// While the SoftAP is up, every foreign host (OS connectivity probes) lands on the setup page.
bool captiveRedirect(AsyncWebServerRequest* r) {
  if (!hub().softAp || !viaSoftAp(r)) return false;
  std::string host = str(r->host());
  if (host == "192.168.4.1" || host == hostnameLocal()) return false;
  r->redirect("http://192.168.4.1/setup");
  return true;
}

}  // namespace

void setRemoteInput(Board* board) { g_inputBoard = board; }

WebServer& webServer() {
  static WebServer w;
  return w;
}

namespace {
void addRoutes() {
  // Captive portal probes (Android, iOS/macOS, Windows, Firefox) → setup page while the SoftAP is up.
  for (const char* probe : {"/generate_204", "/gen_204", "/hotspot-detect.html", "/library/test/success.html",
                            "/ncsi.txt", "/connecttest.txt", "/redirect", "/canonical.html", "/success.txt"}) {
    g_server.on(probe, HTTP_ANY, [](AsyncWebServerRequest* r) {
      if (hub().softAp) return r->redirect("http://192.168.4.1/setup");
      r->send(404);
    });
  }

  g_server.addHandler(new ApiHandler());

  // QR on the display: /link?p=CODE (single use, 10 min) → HA sign-in that links the display.
  g_server.on("/link", HTTP_GET, [](AsyncWebServerRequest* r) {
    if (!r->hasParam("p") || !auth().consumePairing(str(r->arg("p")))) return r->redirect("/setup?auth_error=pairing");
    std::string url = startAuth(r, "", "/", false);
    if (!url.empty()) r->redirect(url.c_str());
  });
  g_server.on("/auth/start", HTTP_GET, [](AsyncWebServerRequest* r) {
    std::string url = startAuth(r, r->hasParam("ha") ? str(r->arg("ha")) : "", "/", false);
    if (!url.empty()) r->redirect(url.c_str());
  });
  g_server.on("/auth/callback", HTTP_GET, authCallback);
#if X4_QEMU
  // Debug hooks of the QEMU build only (no auth: this image never runs on hardware).
  g_server.on("/__qemu/framebuffer.pgm", HTTP_GET, [](AsyncWebServerRequest* r) {
    const uint8_t* fb;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      fb = hub().lastFrame;
    }
    static const char kHead[] = "P5\n800 480\n255\n";
    const size_t headLen = sizeof(kHead) - 1, total = headLen + size_t(kScreenW) * kScreenH;
    AsyncWebServerResponse* resp = r->beginResponse("image/x-portable-graymap", total,
        [fb, headLen](uint8_t* buf, size_t maxLen, size_t index) -> size_t {
          size_t n = 0;
          for (; n < maxLen; ++n, ++index) {
            if (index < headLen) { buf[n] = uint8_t(kHead[index]); continue; }
            const size_t px = index - headLen;
            if (px >= size_t(kScreenW) * kScreenH) break;
            const uint8_t b = fb ? fb[px / 4] : 0xFF;
            buf[n] = uint8_t(((b >> (6 - 2 * (px % 4))) & 3) * 85);
          }
          return n;
        });
    resp->addHeader("Cache-Control", "no-store");
    r->send(resp);
  });
  g_server.on("/__qemu/regions", HTTP_GET, [](AsyncWebServerRequest* r) {   // eink-ha-os#86: the panel's text, per region
    std::string t;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      t = hub().regionText;
    }
    r->send(200, "text/plain; charset=utf-8", t.c_str());
  });
  // Stuck panel (eink-ha-os#181): ?stuck=1 → the next refresh's BUSY never releases (core/panel_guard times out, panel failed);
  // ?stuck=0 → BUSY releases again and the failure is cleared (a real panel stays failed until restart).
  g_server.on("/__qemu/panel", HTTP_POST, [](AsyncWebServerRequest* r) {
    const std::string v = r->hasParam("stuck") ? str(r->arg("stuck")) : "";
    if (v != "0" && v != "1") return sendError(r, 400, "use ?stuck=0|1");
    qemuDisplayStats().setStuck(v == "1");
    sendNoContent(r);
  });
  g_server.on("/__qemu/input", HTTP_POST, [](AsyncWebServerRequest* r) {
    std::string spec;
    for (const char* k : {"tap", "key", "swipe"})
      if (r->hasParam(k)) spec = std::string(k) + "=" + str(r->arg(k));
    if (!qemuPushInput(spec)) return sendError(r, 400, "use ?tap=x,y | ?key=prev|next|home|power | ?swipe=-1|1");
    sendNoContent(r);
  });
  // Power source + first-boot safety for glance tests (sim/qemu/glance-test.sh); kept in RTC memory, so it survives
  // the simulated deep sleep (esp_restart) but not a fresh QEMU start (USB, not armed).
  g_server.on("/__qemu/power", HTTP_POST, [](AsyncWebServerRequest* r) {
    const std::string src = r->hasParam("source") ? str(r->arg("source")) : "";
    if (src != "battery" && src != "usb") return sendError(r, 400, "use ?source=battery|usb[&armed=1][&charging=1][&mv=N]");
    powerSimSet(src == "battery", r->hasParam("armed") && str(r->arg("armed")) == "1",
                r->hasParam("charging") && str(r->arg("charging")) == "1", r->hasParam("mv") ? r->arg("mv").toInt() : 0);
    sendNoContent(r);
  });
  // eink-ha-os#300: display settings before any sign-in (PUT /settings needs a token): the contract suite turns quiet hours off
  // on the fresh image, so a run at 23:00–07:00 links like one at noon. ?display={"quiet":"off"}, validated as PUT's.
  g_server.on("/__qemu/settings", HTTP_POST, [](AsyncWebServerRequest* r) {
    if (!r->hasParam("display")) return sendError(r, 400, "use ?display={\"quiet\":\"off\"}");
    DisplaySettings s;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      s = hub().settings;
    }
    std::string err;
    if (!Storage::settingsFromJson(str(r->arg("display")), s, &err, true)) return sendError(r, 422, "display." + err);
    storage().saveSettings(s);
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().settings = s;
      hub().settingsPending = true;
    }
    sendNoContent(r);
  });
  g_server.on("/__qemu/state", HTTP_GET, [](AsyncWebServerRequest* r) {
    JsonDocument d;
    d["full"] = qemuDisplayStats().fulls();
    d["partial"] = qemuDisplayStats().partials();
    d["heap"] = ESP.getFreeHeap();
    d["psram"] = ESP.getFreePsram();
    d["largest"] = heapLargestFree();      // internal RAM
    d["tls_slots"] = tlsPoolUsed();        // TLS record-buffer reserve in use (net/tls_pool.cpp)
    d["tls_spills"] = tlsPoolSpills();     // record buffers that missed the reserve since boot (eink-ha-os#198)
    d["time"] = static_cast<int64_t>(time(nullptr));   // > 1.7e9 once SNTP (over slirp) set the clock
    d["wake"] = powerWakeName();                       // cold | timer | button | charger (simulated deep sleep)
    d["power_mode"] = powerMode();                     // awake | glance
    {
      qemu_eth_link_t e;   // the NIC as the driver sees it: link, lease, how often each came and went (eink-ha-os#108)
      qemu_eth_link(&e);
      JsonObject eth = d["eth"].to<JsonObject>();
      eth["link"] = e.link;
      eth["ip"] = IPAddress(e.ip).toString();
      eth["link_ups"] = e.link_ups;
      eth["link_downs"] = e.link_downs;
      eth["leases"] = e.leases;
      eth["lease_age_s"] = e.leases ? (millis() - e.lease_ms) / 1000 : 0;
      eth["rx_skew"] = e.rx_skew;
    }
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      d["entities_applied"] = hub().entitiesApplied;
      d["ha"] = static_cast<int>(hub().status.ha);
      // a queued config / settings / refresh not drawn yet: under QEMU a full refresh renders for seconds (eink-ha-os#71)
      d["busy"] = hub().configPending || hub().settingsPending || hub().refreshPending || hub().applying;
      d["ambient"] = hub().ambient;
      d["history"] = serialized(std::string(hub().historyInfo));   // eink-ha-os#269: per series key: state, source, bytes
      d["screen"] = hub().shownScreen;                    // screen the panel shows plainly ("" = menu, setup, face)
      d["number_format"] = hub().status.numberFormat;   // HA profile number_format (eink-ha-os#110)
    }
    sendJsonDoc(r, 200, d);
  });
  // Forced low-memory episode (eink-ha-os#149): hold internal RAM in 1 KB blocks until ?free=<bytes> is left; ?free=0 lets go.
  g_server.on("/__qemu/heap-hog", HTTP_POST, [](AsyncWebServerRequest* r) {
    static void* held[512];
    static size_t n = 0;
    const uint32_t target = r->hasParam("free") ? strtoul(r->arg("free").c_str(), nullptr, 10) : 0;
    if (!target)
      while (n) free(held[--n]);
    while (target && n < 512 && heapFreeInternal() > target)
      if (!(held[n] = heap_caps_malloc(1024, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT))) break; else ++n;
    LOG_WRN("QEMU", "heap hog: %u KB held · internal free %u B, largest %u B", unsigned(n), unsigned(heapFreeInternal()),
            unsigned(heapLargestFree()));
    sendJson(r, 200, "{\"held_kb\":" + std::to_string(n) + ",\"free\":" + std::to_string(heapFreeInternal()) +
                         ",\"largest\":" + std::to_string(heapLargestFree()) + "}");
  });
  // Clock jump (endurance run, sim/qemu/endurance.sh): shift the wall clock by ?jump=<seconds> until SNTP corrects it.
  g_server.on("/__qemu/clock", HTTP_POST, [](AsyncWebServerRequest* r) {
    if (!r->hasParam("jump")) return sendError(r, 400, "use ?jump=<seconds>");
    const long jump = strtol(r->arg("jump").c_str(), nullptr, 10);
    timeval tv;
    gettimeofday(&tv, nullptr);
    tv.tv_sec += jump;
    settimeofday(&tv, nullptr);
    LOG_WRN("QEMU", "clock jumped by %ld s", jump);
    sendJson(r, 200, "{\"time\":" + std::to_string(static_cast<long long>(tv.tv_sec)) + "}");
  });
#endif

  // The REST API description (spec/openapi.yaml, packaged by scripts/build_ui.py). No auth: it holds no secrets.
  g_server.on("/openapi.yaml", HTTP_GET, [](AsyncWebServerRequest* r) {
    if (!sendWwwFile(r, "/www/openapi.yaml", "application/yaml")) sendError(r, 404, "openapi.yaml is not in this firmware image");
  });

  g_server.onNotFound([](AsyncWebServerRequest* r) {
    if (captiveRedirect(r)) return;
    if (r->method() == AsyncWebRequestMethod::HTTP_GET && !r->url().startsWith("/api/")) {
      // SPA routes (/setup, /screens, /yaml, /api-access, /device, …)
      const String& u = r->url();
      int dot = u.lastIndexOf('.');
      if (dot < 0 || u.lastIndexOf('/') > dot) return sendSpa(r);
      // console files (app.js, app.css, fonts, version.txt) from the www partition (eink-ha-os#350: no serveStatic File handles)
      if (u.indexOf("..") < 0 && sendWwwFile(r, "/www" + str(u))) return;
    }
    sendError(r, 404, "not found");
  });
}
}  // namespace

void WebServer::begin() {
  {
    PsramScope ps;   // the route handlers (std::function, matchers): ~3 KB of internal RAM for the server's life (eink-ha-os#289)
    addRoutes();
  }
  g_server.begin();
  LOG_INF("WEB", "HTTP server on :80 · console %s", hasUi() ? "from the www partition" : "fallback page (no www.bin in flash)");
}

}  // namespace x4::net
