#include "net/device_services.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>

#include <algorithm>
#include <cctype>

#include "Logging.h"
#include "core/strings.h"
#include "hw/watchdog.h"
#include "net/auth.h"
#include "net/diag.h"
#include "net/ha_auth.h"
#include "net/ha_client.h"
#include "net/ha_report.h"
#include "net/health.h"
#include "net/hub.h"
#include "net/ota.h"
#include "net/png.h"
#include "net/psram.h"
#include "net/storage.h"
#include "net/tls.h"
#include "net/util.h"
#include "net/web_server.h"
#include "net/wifi_mgr.h"

namespace x4::net {

Hub& hub() {
  static Hub h;
  return h;
}

DeviceServices& deviceServices() {
  static DeviceServices s;
  return s;
}

namespace {
bool looksLikeEntityId(const std::string& v) {
  size_t dot = v.find('.');
  if (dot == std::string::npos || dot == 0 || dot + 1 >= v.size()) return false;
  for (char c : v)
    if (!(islower(static_cast<unsigned char>(c)) || isdigit(static_cast<unsigned char>(c)) || c == '_' || c == '.')) return false;
  return v.find('.', dot + 1) == std::string::npos;
}
}  // namespace

std::set<std::string> DeviceServices::entityIdsOf(const Config& c) {
  std::set<std::string> ids;
  for (auto& s : c.screens)
    for (auto& w : s.widgets) {
      auto* picks = listPicks(w.type);
      for (auto& kv : w.fields) {
        bool list = false;
        if (picks) for (auto& pk : *picks) list |= kv.first == pk.first;
        if (!list) { if (looksLikeEntityId(kv.second)) ids.insert(kv.second); continue; }
        for (auto& id : listOf(kv.second)) if (looksLikeEntityId(id)) ids.insert(id);   // #127 picks
      }
      if (w.type == "gauge" && w.field("entity").empty()) ids.insert(kGaugeDefaultEntity);
      if (w.type == "thermo" && !w.field("zone").empty()) ids.insert("climate." + w.field("zone"));   // #148
      if (w.type == "bins") for (auto& id : listOf(w, "entities")) if (looksLikeEntityId(id)) ids.insert(id);   // #317
      if (w.type == "guestWifi" && looksLikeEntityId(w.field("password_entity"))) ids.insert(w.field("password_entity"));   // #329
    }
  return ids;
}

void DeviceServices::begin() {
  Hub& h = hub();
  storage().begin();
  auth().begin();
  otaBegin();

  // Config: screens.yaml on userdata, else the built-in default (spec/default-screens.yaml).
  std::string yaml;
  bool saved;
  {
    PsramScope ps;   // the boot copy and the Hub's copy stay out of internal RAM (#160)
    bootConfig_ = defaultConfig();
    saved = storage().readFile("/screens.yaml", yaml);
    if (saved) {
      ParseResult r = parseConfig(yaml);
      if (r.ok) bootConfig_ = std::move(r.config);
      else LOG_ERR("CFG", "stored screens.yaml invalid (line %d: %s) · using default", r.line, r.message.c_str());
    }
    std::lock_guard<std::recursive_mutex> l(h.mu);
    h.config = bootConfig_;
  }
  storage().loadSettings(bootSettings_);
  bootSettings_.otaChannel = otaChannel();   // channel lives in NVS (x4ota/chan), shared with PUT /settings

  HaLink link;
  storage().loadHa(link);
  if (link.url.empty()) link.url = storage().haUrl();
  std::string lang;   // HA's language from the last connect (#98); English until HA says otherwise
  if (storage().readFile("/lang", lang) && !lang.empty()) lang = langCode(langOf(lang));
  else lang.clear();
  std::string numFmt;   // HA profile number_format from the last connect (#110)
  if (!storage().readFile("/numfmt", numFmt)) numFmt.clear();
  std::string currency;   // HA get_config currency from the last connect (#147)
  if (!storage().readFile("/currency", currency)) currency.clear();
  {
    std::lock_guard<std::recursive_mutex> l(h.mu);
    h.seedPending = !saved;
    h.settings = bootSettings_;
    h.link = link;
    h.status.hostname = hostnameLocal();
    h.status.haUrl = link.url;
    h.status.language = lang;
    h.status.numberFormat = numFmt;
    h.status.currency = currency;
    h.status.ha = link.linked() ? HaState::Offline : HaState::NeverLinked;
    h.status.otaChecksOff = !otaRepo()[0];
    h.status.otaLastCheckEpoch = otaLastCheckEpoch();
    h.setupFinished = link.linked();
    h.markStatus();
  }
  LOG_INF("NET", "firmware %s · HA %s", firmwareVersion(), link.linked() ? link.url.c_str() : "not linked");

  // Entity mapping overrides (settings `entities`, core/entity_map.h)
  {
    JsonDocument d;
    std::map<std::string, std::string> o;
    if (!deserializeJson(d, storage().getString("x4dev", "entities", "{}")) && d.is<JsonObject>())
      for (JsonPair kv : d.as<JsonObject>())
        if (kv.value().is<const char*>()) o[kv.key().c_str()] = kv.value().as<const char*>();
    {
      std::lock_guard<std::recursive_mutex> l(h.mu);
      h.entityOverrides = o;
    }
    h.post([o] { haClient().setEntityOverrides(o); });
  }

  tlsPoolBegin();   // before Wi-Fi: its WPA crypto uses mbedTLS too
  heapMark("before Wi-Fi");
  wifiMgr().begin();
  heapMark("Wi-Fi started");
  webServer().begin();
  auto ids = entityIdsOf(bootConfig_);
  LightSubs subs = lightSubs(bootConfig_);
  h.post([ids, subs] { haClient().setConfigEntities(ids, subs); });
  h.post([p = bootSettings_.emptyHouse] { haClient().setPresenceEntity(p); });   // #331
  {
    // The App reads status() at finishBoot(), before the first pump() when the boot refresh blocks longer than the
    // 1.6 s boot screen (real panel): publish the stored state now, or the defaults (no Wi-Fi, never linked) send a
    // configured device through the setup screens at every boot (#202).
    std::lock_guard<std::recursive_mutex> l(h.mu);
    h.status.haUrl = h.link.url;
    published_ = h.status;
  }
  // Net task on core 0 (AsyncTCP lives there too); App/display/input stay on core 1.
  // 12 KB, internal RAM (#248): peak use 5.1 KB on the X4 Pro (HA TLS, reports), 5.6 KB in QEMU (TLS, config apply)
  xTaskCreatePinnedToCore(netTask, "x4net", 12288, this, 3, nullptr, 0);
}

void DeviceServices::netTask(void*) {
  // Blocking HTTPS/TLS calls step out of the watchdog (wdt::BlockingCall); our own wait loops feed it.
  wdt::subscribe();
  for (;;) {
    wdt::feedIfSubscribed();
    std::function<void()> job;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      if (!hub().jobs.empty()) {
        job = std::move(hub().jobs.front());
        hub().jobs.pop_front();
      }
    }
    if (job) job();
    wifiMgr().loop();
    haClient().loop();
    haReportLoop();
    otaLoop();
    healthLoop();
    vTaskDelay(pdMS_TO_TICKS(job ? 1 : 10));
  }
}

void DeviceServices::pump(App& app, Board& board) {
  Hub& h = hub();
  const uint32_t now = millis();
  if (now - lastPowerMs_ > 5000 || lastPowerMs_ == 0) {
    lastPowerMs_ = now;
    PowerInfo p = board.power();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    h.power = p;
  }
  bool statusChanged = false, clear = false, cfgPending = false, setPending = false, refresh = false, restart = false, sources = false;
  std::vector<std::pair<std::string, EntityValue>> updates;
  std::vector<Hub::HistoryOut, PsramAlloc<Hub::HistoryOut>> hist;
  std::vector<Hub::WeatherOut, PsramAlloc<Hub::WeatherOut>> wxOut;
  std::vector<Hub::AgendaOut, PsramAlloc<Hub::AgendaOut>> agendas;
  Config cfg;
  DisplaySettings settings;
  {
    std::lock_guard<std::recursive_mutex> l(h.mu);
    if (now - lastPairCheckMs_ > 1000) {
      lastPairCheckMs_ = now;
      std::string code = h.link.linked() ? "" : auth().pairingCode();
      if (code != h.status.pairingCode) {
        h.status.pairingCode = code;
        h.markStatus();
      }
    }
    if (h.status.ha == HaState::Linking && !h.link.linked() && static_cast<int32_t>(now - h.linkingSinceMs) > 600000) {   // signed: set by the web task
      h.status.ha = HaState::NeverLinked;   // browser never came back from HA
      h.markStatus();
    }
    if (h.statusDirty) {
      h.statusDirty = false;
      h.status.haUrl = h.link.url;
      published_ = h.status;
      statusChanged = true;
    } else {
      published_.haLastDataEpoch = h.status.haLastDataEpoch;
      published_.otaProgressPct = h.status.otaProgressPct;
    }
    updates.swap(h.entityOut);
    h.entitiesApplied += updates.size();
    hist.swap(h.historyOut);
    wxOut.swap(h.weatherOut);
    agendas.swap(h.agendaOut);
    clear = h.clearEntities;
    h.clearEntities = false;
    if ((cfgPending = h.configPending)) {
      PsramScope ps;   // the App keeps this copy (setDisplayConfig moves it): out of internal RAM (#160)
      cfg = withSettings(h.config);
      h.configPending = false;
    }
    if ((setPending = h.settingsPending)) {
      settings = h.settings;
      h.settingsPending = false;
    }
    refresh = h.refreshPending;
    h.refreshPending = false;
    sources = h.sourcesChanged;
    h.sourcesChanged = false;
    restart = h.restartPending && static_cast<int32_t>(now - h.restartAtMs) >= 0;
    h.applying = setPending || cfgPending || refresh;
  }
  if (clear) app.entities().clear();
  for (auto& u : updates) app.entities().set(u.first, std::move(u.second));
  if (!hist.empty()) {   // history series (#269) → the tiles (#270)
    static_assert(int(hist::FetchState::NeedsStats) == int(hist::State::NeedsStats) && int(hist::FetchState::Ok) == int(hist::State::Ok),
                  "FetchState mirrors hist::State");
    for (auto& o : hist) app.setHistory(std::string(o.key), o.has ? &o.s : nullptr, hist::State(int(o.state)));
  }
  for (auto& o : wxOut) app.setWeather(std::string(o.entity), o.fc);   // #318
  for (auto& o : agendas) app.setAgenda(std::string(o.key), o.state, o.f);   // #316
  if (setPending) {
    app.setSettings(settings);
    h.post([p = settings.emptyHouse] { haClient().setPresenceEntity(p); });   // #331
  }
  if (cfgPending) app.setDisplayConfig(std::move(cfg));  // one full refresh
  else if (sources) app.expectData();
  else if (refresh && forceRefresh_) forceRefresh_();    // POST /display/refresh
  if (statusChanged) app.onNetStatusChanged();
  // GET /screens/{id}/values (#122): format the asked screen about once a second while the console keeps asking
  std::string ask;
  {
    std::lock_guard<std::recursive_mutex> l(h.mu);
    const uint32_t t = millis();   // under the lock: never older than an ask stored by the web task
    if (h.valuesAskMs && t - h.valuesAskMs >= 30000) { h.valuesAskMs = 0; h.valuesAtMs = 0; h.values.clear(); }
    else if (h.valuesAskMs && t - lastValuesMs_ >= 1000) ask = h.valuesAsk;
  }
  if (!ask.empty()) {
    lastValuesMs_ = millis();
    std::vector<std::string> v = app.tileValues(ask);
    std::lock_guard<std::recursive_mutex> l(h.mu);
    h.valuesId = ask;
    h.values = std::move(v);
    h.valuesAtMs = millis() | 1;
  }
  // GET /screens/{id}/preview.png (#168): draw the asked screen into a PSRAM frame, never onto the panel
  std::function<void(std::shared_ptr<const std::vector<uint8_t>>)> reply;
  std::string previewId;
  {
    std::lock_guard<std::recursive_mutex> l(h.mu);
    if (h.previewReply) {
      if (millis() - h.previewAskMs < Hub::kPreviewWaitMs) previewId = h.previewAsk;
      reply = std::move(h.previewReply);
      h.previewReply = nullptr;
    }
  }
  if (reply) {
    std::shared_ptr<const std::vector<uint8_t>> png;
    const uint32_t t0 = millis();
    const size_t heap0 = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    Framebuffer f{previewId.empty() ? nullptr : static_cast<uint8_t*>(heap_caps_malloc(Framebuffer::kBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT))};
    if (f.data && app.renderScreen(previewId, f)) {
      PsramScope ps;   // pure computation: the ~200 KB of encoder buffers stay out of internal RAM
      png = std::make_shared<const std::vector<uint8_t>>(encodePng2bpp(f.data, kScreenW, kScreenH));
    }
    heap_caps_free(f.data);
    LOG_INF("API", "preview %s · %s · %u ms · internal heap %+d B", previewId.empty() ? "(late)" : previewId.c_str(),
            png ? "drawn off-screen" : "busy", unsigned(millis() - t0),
            int(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)) - int(heap0));
    reply(std::move(png));
  }
  {
    const bool ambient = app.powerView().ambient;
    std::string shown = app.shownScreen();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    h.applying = false;
    h.ambient = ambient;
    if (shown != h.shownScreen) h.shownScreen = std::move(shown);
  }
  historyTiles(app, cfgPending);
  agendaTiles(app);
  const uint32_t fulls = app.stats().fullRefreshes;
  if (fulls != lastFulls_) {
    lastFulls_ = fulls;
    const time_t t = time(nullptr);
    std::lock_guard<std::recursive_mutex> l(h.mu);
    h.lastFullEpoch = t > 1700000000 ? int64_t(t) : 0;
  }
  if (restart) {
    LOG_WRN("NET", "restarting");
    delay(300);
    board.restart();
  }
}

void DeviceServices::saveDeviceSettings(const DisplaySettings& s) {
  // Changed on the display (Settings pages): persist and keep the web/OTA side in sync.
  storage().saveSettings(s);
  otaSetChannel(s.otaChannel);
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().settings = s;
}

void DeviceServices::wifiScan() {
  hub().post([] { wifiMgr().scan(); });
}

std::vector<WifiNetwork> DeviceServices::wifiNetworks() {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  return hub().networks;
}

void DeviceServices::wifiConnect(const std::string& ssid, const std::string& password) {
  hub().post([ssid, password] { wifiMgr().connect(ssid, password, nullptr); });
}

void DeviceServices::startSoftAp() {
  hub().post([] { wifiMgr().startSoftAp(true); });
}

void DeviceServices::wifiDisconnect() {
  hub().post([] { wifiMgr().disconnect(); });
}

void DeviceServices::wifiForget(const std::string& ssid) {
  hub().post([ssid] {
    std::string saved;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      saved = hub().savedSsid;
    }
    if (saved.empty() || (!ssid.empty() && ssid != saved)) return;   // only one network is stored
    LOG_WRN("WIFI", "forgetting \"%s\"", saved.c_str());
    wifiMgr().forget();
  });
}

void DeviceServices::haReconnect() {
  hub().post([] {
    LOG_INF("HA", "reconnect requested");
    haClient().restart();
  });
}

void DeviceServices::haUnlink() {
  // unlinkHa() touches NVS and posts the revoke to the net task; keep the main loop free of flash writes.
  hub().post([] { unlinkHa(); });
}

void DeviceServices::callService(const std::string& domain, const std::string& service, const std::string& jsonData) {
  hub().post([domain, service, jsonData] { haClient().callService(domain, service, jsonData); });
}

void DeviceServices::otaCheck() { otaRequestCheck(); }

void DeviceServices::otaInstall() {
  hub().post([] {
    std::string err;
    x4::net::otaInstall(err);
  });
}

void DeviceServices::factoryReset() {
  hub().post([] { doFactoryReset(); });
}

// History tiles (#269): the config's series, fetched only for the app on screen. Posted when the config or that app
// changes (an overlay or a menu shows no screen: the last app stays).
void DeviceServices::historyTiles(App& app, bool configChanged) {
  const std::string shown = app.shownScreen();
  const Config& cfg = app.config();
  std::string appId = histApp_;
  for (auto& sc : cfg.screens) if (sc.id == shown) appId = sc.app;
  if (histPosted_ && !configChanged && appId == histApp_) return;
  const bool changed = configChanged || !histPosted_;
  histPosted_ = true;
  histApp_ = appId;
  PsramScope ps;
  std::vector<hist::Fetcher::Want> want;
  for (auto& sc : cfg.screens)
    for (auto& w : sc.widgets) {
      if (w.type != "history") continue;
      hist::Spec s = hist::specOf(w);
      want.push_back({s, hist::seriesKey(s), sc.app == appId});
      if (!s.past.empty()) {   // #307: the recorder of `past` before now, a second series of the same tile
        hist::Spec p = hist::pastSpec(s);
        want.push_back({p, hist::seriesKey(p), sc.app == appId});
      }
    }
  std::vector<std::string> weather;   // #318: every weather tile's entity, whichever app shows it
  for (auto& sc : cfg.screens)
    for (auto& w : sc.widgets) if (w.type == "weather") weather.push_back(w.field("entity"));
  hub().post([want, changed, weather] {
    haClient().setHistoryTiles(want, changed);
    haClient().setWeatherTiles(weather);
  });
}

// Agenda / next tiles (#316): every calendar set of the config is kept fresh (on screen or not: one small call per set
// every 30 min). Posted when the set list changes.
void DeviceServices::agendaTiles(App& app) {
  std::vector<std::string> keys;
  std::string all;
  for (auto& sc : app.config().screens)
    for (auto& w : sc.widgets) {
      if (!agenda::isAgendaType(w.type)) continue;
      std::string k = agenda::keyOf(w.field("entities"));
      if (k.empty() || std::find(keys.begin(), keys.end(), k) != keys.end()) continue;
      keys.push_back(k);
      all += k + "|";
    }
  if (all == agendaKeys_) return;
  agendaKeys_ = all;
  hub().post([keys] { haClient().setAgendaTiles(keys); });
}

void DeviceServices::applyConfig(const Config& c) {
  // #160: the YAML text, the id sets and the Hub's long-lived copy were ~10 KB of small internal blocks per PUT, the
  // copy interleaved with transient ones (largest block 31.7 → 8 KB). No DMA here: LittleFS writes from its own cache.
  PsramScope ps;
  storage().writeFile("/screens.yaml", toYaml(c));
  auto ids = entityIdsOf(c);
  LightSubs subs = lightSubs(c);
  Hub& h = hub();
  std::lock_guard<std::recursive_mutex> l(h.mu);
  h.config = c;
  h.configRev++;
  h.configPending = true;
  h.seedPending = false;
  h.post([ids, subs] { haClient().setConfigEntities(ids, subs); });
}

void DeviceServices::unlinkHa() {
  HaLink link;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    link = hub().link;
    hub().link.kind.clear();
    hub().link.secret.clear();
    hub().link.user.clear();
    hub().status.ha = HaState::NeverLinked;
    hub().status.language.clear();   // unlinked: English on the display, the browser's language in the console (#98)
    hub().status.numberFormat.clear();
    hub().status.currency.clear();   // € again; the HA time zone stays (#147)
    hub().clearEntities = true;
    hub().markStatus();
  }
  storage().clearHa();
  storage().writeFile("/lang", "");
  storage().writeFile("/numfmt", "");
  storage().writeFile("/currency", "");
  auth().endAllSessions();
  hub().post([link] {
    haClient().stop();
    if (link.kind == "oauth" && !link.secret.empty()) HaAuth::revoke(link.url, link.secret);
  });
  LOG_WRN("HA", "unlinked · key deleted from the display");
}

void DeviceServices::doFactoryReset() {
  HaLink link;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    link = hub().link;
  }
  haClient().stop();
  if (link.kind == "oauth" && !link.secret.empty() && netConnected()) HaAuth::revoke(link.url, link.secret);
  storage().factoryReset();
  diagSave();   // the boot ring is not a setting: put /diag.json back on the freshly formatted userdata
  auth().endAllSessions();
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().restartPending = true;
  hub().restartAtMs = millis() + 500;
}

}  // namespace x4::net
