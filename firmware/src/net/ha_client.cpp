#include "net/ha_client.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>

#include <esp_heap_caps.h>
#include <sys/time.h>

#include <ctime>
#include <algorithm>
#include <cstring>
#include <new>

#include "Logging.h"
#include "core/ha_stream.h"
#include "core/net_policy.h"
#include "core/seed.h"
#include "core/strings.h"
#include "net/device_services.h"
#include "hw/watchdog.h"
#include "net/health.h"
#include "net/time_sync.h"
#include "net/ha_auth.h"
#include "net/hub.h"
#include "net/wifi_mgr.h"
#include "net/ota.h"
#include "net/psram.h"
#include "net/util.h"

namespace x4::net {

namespace {
constexpr size_t kChunk = 15;           // entities per subscribe_entities (keeps each snapshot small)
constexpr uint32_t kMaxBackoffMs = 60000;

const char* kDiscoveryTemplate =
    "{% set ns = namespace(l=[]) %}{% for s in states.light %}"
    "{% set ns.l = ns.l + [[s.entity_id, area_id(s.entity_id) or '']] %}{% endfor %}"
    "{{ {'climate': states.climate | map(attribute='entity_id') | list, 'lights': ns.l} | tojson }}";

constexpr uint32_t kSeedWaitMs = 20000;   // give up waiting for device discovery / a lost answer

int64_t epochMs() {
  timeval tv;
  gettimeofday(&tv, nullptr);
  return int64_t(tv.tv_sec) * 1000 + tv.tv_usec / 1000;
}
int tzMinutesNow() {   // local UTC offset now (no tm_gmtoff on newlib)
  const time_t t = time(nullptr);
  struct tm l, u;
  localtime_r(&t, &l);
  gmtime_r(&t, &u);
  const int days = l.tm_year != u.tm_year ? (l.tm_year > u.tm_year ? 1 : -1) : l.tm_yday - u.tm_yday;
  return days * 1440 + (l.tm_hour - u.tm_hour) * 60 + (l.tm_min - u.tm_min);
}

// Entities the web console can put on a stat / gauge / switch / scene / media (eink-ha-os#319) / agenda (eink-ha-os#316) widget (core/config.cpp entityDomains) or pick
// for a zoneList (climate, eink-ha-os#127), with the HA area (entity or device) for the lightList picker. At most 800, cut fairly
// (eink-ha-os#150, emulator core/entityList.ts, the fake HA renders it there): per domain a budget of pickable entities first
// (budgets add up to 800), then pickable ones past their budget, then unavailable / unknown ones and sensors that are no
// reading (no unit, signal strength); a never-run scene is "unknown" and still pickable (eink-ha-os#146). A climate / weather row
// carries its temperature as the state (eink-ha-os#161, core/home.cpp statSource).
// Answer: {"t": entities in these domains, "e": [[id, name, unit, state, area], …]}.
constexpr int kMaxListed = 800;
const char* kEntityListTemplate =
    "{% set ns = namespace(a=[], b=[], c=[], k=0) %}"
    "{% for d, cap in [['climate', 50], ['weather', 10], ['light', 100], ['switch', 100], ['input_boolean', 30], "
    "['input_number', 30], ['fan', 20], ['binary_sensor', 60], ['number', 30], ['scene', 30], ['script', 30], "
    "['media_player', 10], ['calendar', 10], ['sensor', 290]] %}{% set ns.k = 0 %}"
    "{% for s in states | selectattr('domain', 'eq', d) | sort(attribute='entity_id') %}"
    "{% set u = s.attributes.unit_of_measurement | default('') %}{% set v = s.state %}"
    "{% set gap = s.state in ['unavailable', 'unknown'] %}"
    "{% set t = s.attributes.get('current_temperature' if d == 'climate' else 'temperature') "
    "if d in ['climate', 'weather'] and not gap else none %}"
    "{% if t is not none %}{% set v = t | string %}"
    "{% set u = s.attributes.get('temperature_unit') or '°C' if d == 'weather' else '°C' %}{% endif %}"
    "{% set r = [s.entity_id, s.name, u, v, area_id(s.entity_id) or ''] %}"
    "{% if s.state == 'unavailable' or (s.state == 'unknown' and d != 'scene') or (d == 'sensor' and (not (s.attributes.unit_of_measurement | default('')) "
    "or s.attributes.get('device_class') == 'signal_strength')) %}{% set ns.c = ns.c + [r] %}"
    "{% elif ns.k >= cap %}{% set ns.b = ns.b + [r] %}"
    "{% else %}{% set ns.a = ns.a + [r] %}{% set ns.k = ns.k + 1 %}{% endif %}"
    "{% endfor %}{% endfor %}"
    "{{ {'t': ns.a | length + ns.b | length + ns.c | length, 'e': ns.a + (ns.b + ns.c)[:800 - ns.a | length]} | tojson }}";

}  // namespace

HaClient& haClient() {
  static HaClient c;
  return c;
}

void HaClient::setHaState(int s) {
  Hub& h = hub();
  std::lock_guard<std::recursive_mutex> l(h.mu);
  if (static_cast<int>(h.status.ha) != s) {
    h.status.ha = static_cast<HaState>(s);
    h.markStatus();
  }
}

void HaClient::setLanguage(const char* haLang) {
  const char* code = langCode(langOf(haLang));
  {
    Hub& h = hub();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    if (h.status.language == code) return;
    h.status.language = code;
    h.markStatus();
  }
  storage().writeFile("/lang", code);
  LOG_INF("HA", "language %s (Home Assistant: %s)", code, haLang);
}

void HaClient::setCurrency(const char* code) {
  {
    Hub& h = hub();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    if (h.status.currency == code) return;
    h.status.currency = code;
    h.markStatus();
  }
  storage().writeFile("/currency", code);
  LOG_INF("HA", "currency \"%s\"", code);
}

void HaClient::setNumberFormat(const char* nf) {
  {
    Hub& h = hub();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    if (h.status.numberFormat == nf) return;
    h.status.numberFormat = nf;
    h.markStatus();
  }
  storage().writeFile("/numfmt", nf);
  LOG_INF("HA", "number format \"%s\" (profile)", nf);
}

void HaClient::pushOut(const EntityUpdates& u) {
  if (u.empty()) return;
  Hub& h = hub();
  std::lock_guard<std::recursive_mutex> l(h.mu);
  for (auto& x : u) h.entityOut.emplace_back(x.first, x.second);
  time_t now = time(nullptr);
  if (now > 1700000000) h.status.haLastDataEpoch = now;
}

void HaClient::push(const std::string& id, const EntityValue& v) {
  const time_t now = time(nullptr);
  adapter_.setNow(now > 1700000000 ? static_cast<int64_t>(now) : 0);
  PsramScope ps;   // a price source's attributes parse into ~16 KB of small blocks (eink-ha-os#149)
  EntityUpdates out;
  adapter_.ingest(id, v, out);
  pushOut(out);
}

void HaClient::publishSources() {
  std::map<std::string, std::string> m;
  for (auto& kv : adapter_.sources())
    m[kv.first] = (kv.second.sign < 0 ? "-" : "") + kv.second.ha + (kv.second.minus.empty() ? "" : " - " + kv.second.minus) +
                  " (" + kv.second.why + ")";
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().entitySources = m;
}

void HaClient::setEntityOverrides(const std::map<std::string, std::string>& o) {
  {
    PsramScope ps;
    adapter_.setOverrides(o);
    EntityUpdates out;
    adapter_.remapAll(out);
    pushOut(out);
  }
  publishSources();
  resubscribeFor("entity overrides");
}

// Today's hourly energy (solar, import, export, battery) from the recorder → *_today + hourly series.
void HaClient::requestStatistics() {
  lastStatsMs_ = millis();
  auto ids = adapter_.statisticIds();
  const time_t now = time(nullptr);
  if (ids.empty() || now < 1700000000) return;
  struct tm lt;
  localtime_r(&now, &lt);
  lt.tm_hour = lt.tm_min = lt.tm_sec = 0;
  lt.tm_isdst = -1;
  const time_t midnight = mktime(&lt);
  struct tm ut;
  gmtime_r(&midnight, &ut);
  char iso[32];
  strftime(iso, sizeof iso, "%Y-%m-%dT%H:%M:%SZ", &ut);
  JsonDocument d(psramJson());
  idStats_ = nextId_++;
  d["id"] = idStats_;
  d["type"] = "recorder/statistics_during_period";
  d["start_time"] = iso;
  d["period"] = "hour";
  JsonArray t = d["types"].to<JsonArray>();
  t.add("change");
  JsonArray a = d["statistic_ids"].to<JsonArray>();
  for (auto& id : ids) a.add(id);
  std::string s;
  serializeJson(d, s);
  ws_.sendText(s);
}

void HaClient::restart() {
  restartRequested_ = true;
  access_.clear();
  accessTtlMs_ = 0;
}

void HaClient::stop() {
  ws_.close();
  state_ = St::Idle;
  nextTryMs_ = millis();
  access_.clear();
  entitySubs_.clear();
  {
    auto overrides = adapter_.overrides();
    adapter_ = EntityAdapter();
    adapter_.setOverrides(overrides);
    adapter_.setKeep(configIds_);
  }
  idDevices_ = idStats_ = 0;
  idRegistry_.clear();
  discoveredIds_.clear();
  climateIds_.clear();
  lightAreas_.clear();
  outbox_.clear();
}

bool HaClient::yieldTls() {
  if (state_ == St::Idle || state_ == St::Backoff || state_ == St::Revoked) return false;
  LOG_INF("HA", "WebSocket closed for a moment: no internal heap for a second TLS session");
  ws_.close();
  state_ = St::Backoff;
  nextTryMs_ = millis();
  entitySubs_.clear();
  return true;
}

bool HaClient::shedHeap(uint32_t waitMs) {
  if (state_ == St::Idle || state_ == St::Backoff || state_ == St::Revoked) return false;
  LOG_WRN("HA", "WebSocket closed: internal RAM under the floor · retry in %us", unsigned(waitMs / 1000));
  ws_.close();
  state_ = St::Backoff;
  nextTryMs_ = millis() + waitMs;
  entitySubs_.clear();
  return true;
}

void HaClient::setConfigEntities(const std::set<std::string>& ids, const LightSubs& lights) {
  PsramScope ps;   // the config's entity ids and light picks, kept until the next config (eink-ha-os#289)
  if (!(lights == lightSubs_)) {
    lightSubs_ = lights;
    rediscover();
  }
  if (ids == configIds_) return;
  configIds_ = ids;
  adapter_.setKeep(ids);
  resubscribeFor("config entities");
}

// Climate first, then the lights lightSubs_ asks for (all, or those of picked areas), kMaxWatched in total. A big
// house used to lose every light past the cap in HA's entity_id order (eink-ha-os#127: 14 climate + 149 lights → 66 lights).
void HaClient::rediscover() {
  PsramScope ps;   // discoveredIds_: up to kMaxWatched ids (eink-ha-os#289)
  std::set<std::string> ids;
  for (auto& c : climateIds_) if (ids.size() < kMaxWatched) ids.insert(c);
  for (auto& l : lightsToWatch(lightAreas_, lightSubs_, kMaxWatched - ids.size())) ids.insert(l);
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().haLists = listCounts(climateIds_.size(), lightAreas_.size());   // console: "Showing 66 of 149 lights" (eink-ha-os#134)
  }
  if (ids == discoveredIds_) return;
  discoveredIds_ = std::move(ids);
  resubscribeFor("discovery");
}

void HaClient::callService(const std::string& domain, const std::string& service, const std::string& jsonData) {
  JsonDocument d(psramJson());
  d["type"] = "call_service";
  d["domain"] = domain;
  d["service"] = service;
  JsonDocument data(psramJson());
  if (!jsonData.empty() && !deserializeJson(data, jsonData) && data.is<JsonObject>()) d["service_data"] = data;
  std::string s;
  serializeJson(d, s);   // id added at send time
  if (outbox_.size() >= 10) outbox_.erase(outbox_.begin());
  outbox_.push_back(s);
  outboxMs_ = millis();
  LOG_INF("HA", "call_service %s.%s %s", domain.c_str(), service.c_str(), jsonData.c_str());
}

std::string HaClient::accessToken(bool* revoked) {
  if (revoked) *revoked = false;
  HaLink link;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    link = hub().link;
  }
  if (!link.linked()) return {};
  if (link.kind == "llat") return link.secret;
  // elapsed-vs-ttl (unsigned): an absolute expiry stale by > 24.8 days would read as still valid
  if (!access_.empty() && accessTtlMs_ > 60000 && millis() - accessAtMs_ < accessTtlMs_ - 60000) return access_;
  TokenSet t;
  switch (HaAuth::refresh(link.url, link.clientId, link.secret, t)) {
    case RefreshResult::Ok:
      access_ = t.access;
      accessAtMs_ = millis();
      accessTtlMs_ = t.expiresInSec * 1000UL;
      return access_;
    case RefreshResult::Revoked:
      if (revoked) *revoked = true;
      return {};
    default:
      return {};
  }
}

void HaClient::fail(const char* why) {
  // ±20 %: several displays (or a display and its sibling integrations) restarting with HA don't retry in lockstep
  const uint32_t wait = jitterMs(backoffMs_, esp_random());
  LOG_WRN("HA", "connection lost (%s) · retry in %.1fs", why, wait / 1000.0);
  ws_.close();
  state_ = St::Backoff;
  nextTryMs_ = millis() + wait;
  backoffMs_ = nextBackoffMs(backoffMs_, kMaxBackoffMs);
  entitySubs_.clear();
  setHaState(static_cast<int>(HaState::Offline));
}

void HaClient::connect() {
  HaLink link;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    link = hub().link;
  }
  Url u;
  if (!parseUrl(link.url, u)) return fail("bad url");
  if (u.tls && !tlsHeapOk(u.host.c_str())) return fail("low memory");
  WifiPsOff psOff;   // token refresh + TLS handshake
  bool revoked = false;
  std::string token = accessToken(&revoked);
  if (revoked) {
    state_ = St::Revoked;
    setHaState(static_cast<int>(HaState::KeyRevoked));
    return;
  }
  if (token.empty()) {
    wifiMgr().haReached(false);
    return fail("token refresh failed");
  }
  std::string base = u.path == "/" ? "" : u.path;
  while (!base.empty() && base.back() == '/') base.pop_back();
  state_ = St::Connecting;
  ws_.setStream(this);
  if (!ws_.connect(u, base + "/api/websocket", 10000)) {
    wifiMgr().haReached(false);
    return fail("connect");
  }
  state_ = St::AuthWait;
  nextTryMs_ = millis() + 15000;   // auth deadline
}

void HaClient::loop() {
  Hub& h = hub();
  bool linked;
  {
    std::lock_guard<std::recursive_mutex> l(h.mu);
    linked = h.link.linked();
  }
  if (!linked) {
    if (state_ != St::Idle) stop();
    return;
  }
  if (restartRequested_) {
    restartRequested_ = false;
    stop();
    backoffMs_ = 2000;
    nextTryMs_ = millis();   // now, not 0: signed compare below breaks when millis() >= 2^31
  }
  if (state_ == St::Revoked) return;   // wait for re-link (restart())
  if (!netConnected()) {
    if (state_ != St::Idle && state_ != St::Backoff) fail("wifi down");
    setHaState(static_cast<int>(HaState::Offline));
    return;
  }
  const uint32_t now = millis();
  switch (state_) {
    case St::Idle:
    case St::Backoff:
      if (static_cast<int32_t>(now - nextTryMs_) >= 0) connect();
      return;
    case St::AuthWait:
      if (static_cast<int32_t>(now - nextTryMs_) >= 0) return fail("auth timeout");
      break;
    default:
      break;
  }
  std::string msg;
  for (int i = 0; i < 8 && ws_.poll(msg); i++) onMessage(msg);
  if (state_ != St::Ready && state_ != St::AuthWait) return;
  if (!ws_.connected()) return fail("closed");
  if (state_ == St::Ready) {
    if (now - lastPingMs_ > 30000) {
      lastPingMs_ = now;
      ws_.sendText("{\"id\":" + std::to_string(nextId_++) + ",\"type\":\"ping\"}");
    }
    // signed: poll() above may have stamped lastRxMs() after `now` was taken (unsigned wrap → false "silent")
    if (static_cast<int32_t>(millis() - ws_.lastRxMs()) > 90000) return fail("silent for 90 s");
    if (resubscribe_) subscribeAll();
    if (idPrefs_ == 0 && millis() - lastDayCheckMs_ >= 5000) {   // eink-ha-os#308: midnight → today's bars restart at 0, ask now
      lastDayCheckMs_ = millis();
      const time_t t = time(nullptr);
      adapter_.setNow(t > 1700000000 ? static_cast<int64_t>(t) : 0);
      PsramScope ps;
      EntityUpdates out;
      if (adapter_.rollDay(out)) {
        LOG_INF("HA", "local day changed: today's energy reset, statistics asked again");
        pushOut(out);
        requestStatistics();
      }
    }
    if (idPrefs_ == 0 && static_cast<int32_t>(millis() - lastStatsMs_) > 600000) requestStatistics();   // every 10 min
    if (hist_) historyLoop();
    if (wx_) weatherLoop();
    if (agenda_) agendaLoop();
    if (seeding_ && millis() - seedAskMs_ > kSeedWaitMs) maybeSeed(true);
    if (!outbox_.empty()) {
      for (auto& s : outbox_) {
        // splice the id into the pre-serialized call
        std::string withId = "{\"id\":" + std::to_string(nextId_++) + "," + s.substr(1);
        ws_.sendText(withId);
      }
      outbox_.clear();
    }
  } else if (!outbox_.empty() && now - outboxMs_ > 30000) {
    outbox_.clear();   // stale taps should not fire minutes later
  }
}

void HaClient::requestEntityList() {
  // an answer lost on the way (bad JSON, eink-ha-os#57) must not block the list until the next reconnect: re-ask after 30 s
  if (state_ != St::Ready || (idList_ && millis() - listAskMs_ < 30000)) {
    if (state_ != St::Ready) { std::lock_guard<std::recursive_mutex> l(hub().mu); hub().haEntitiesAskMs = 0; }
    return;
  }
  if (idList_) LOG_WRN("HA", "entity list: no answer to #%u in 30 s · asking again", unsigned(idList_));
  idList_ = nextId_++;
  listAskMs_ = millis();
  listFree_ = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  listLargest_ = heapLargestFree();
  JsonDocument d(psramJson());
  d["id"] = idList_;
  d["type"] = "render_template";
  d["template"] = kEntityListTemplate;
  d["report_errors"] = true;
  std::string s;
  serializeJson(d, s);
  ws_.sendText(s);
}

void HaClient::maybeSeed(bool force) {
  if (!seeding_) return;
  const bool inputs = seedTplDone_ && prefsDone_;
  if (!force && !(inputs && idDevices_ == 0)) return;
  seeding_ = false;
  if (!inputs) {   // HA never answered: try again on the next connection rather than save a clock-only screen
    LOG_WRN("HA", "seed: no answer from HA in %u s · retry on reconnect", static_cast<unsigned>(kSeedWaitMs / 1000));
    return;
  }
  if (seedFailed_) {   // eink-ha-os#58: energy prefs alone are not the user's house; keep the default, unsaved
    LOG_WRN("HA", "seed: template failed · default screens kept unsaved · retry on reconnect");
    seedTpl_.clear();
    prefsJson_.clear();
    return;
  }
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    if (!hub().seedPending) return;   // a PUT /config got there first
  }
  std::vector<std::string> live;
  for (auto& kv : adapter_.sources()) live.push_back(kv.first);
  SeedReport rep;
  ParseResult r;
  {
    PsramScope ps;   // the seed answer's DOM: ~80 KB of small blocks on a big house (eink-ha-os#137)
    Config c = seedConfig(seedSnapshot(prefsJson_, live, seedTpl_), {}, &rep);   // no tail: Settings is built in (eink-ha-os#159)
    r = parseConfig(toYaml(c));   // save only what the parser reads back
  }
  seedTpl_.clear();
  prefsJson_.clear();
  if (!r.ok) {
    LOG_ERR("HA", "seeded screens invalid (line %d: %s) · keeping the default", r.line, r.message.c_str());
    return;
  }
  std::string ids;
  for (auto& sc : r.config.screens) ids += (ids.empty() ? "" : ",") + sc.id;
  LOG_INF("HA", "screens from HA%s: %s · %d of %u tiles filled", force ? " (timed out waiting)" : "", ids.c_str(),
          rep.filled(), static_cast<unsigned>(rep.tiles.size()));
  DeviceServices::applyConfig(r.config);
  std::string j = seedReportJson(rep);   // GET /api/v1/seed (eink-ha-os#89)
  j.insert(j.size() - 1, ",\"dismissed\":false");
  storage().writeFile("/seed.json", j);
}

void HaClient::onReady() {
  idList_ = 0;
  state_ = St::Ready;
  backoffMs_ = 2000;
  wifiMgr().haReached(true);
  lastPingMs_ = millis();
  setHaState(static_cast<int>(HaState::Connected));
  LOG_INF("HA", "WebSocket auth_ok");
  heapMark("WebSocket auth_ok");

  idUser_ = nextId_++;
  ws_.sendText("{\"id\":" + std::to_string(idUser_) + ",\"type\":\"auth/current_user\"}");
  idConfig_ = nextId_++;   // HA's language → the display's (eink-ha-os#98)
  ws_.sendText("{\"id\":" + std::to_string(idConfig_) + ",\"type\":\"get_config\"}");
  idUserData_ = nextId_++;   // the auth user's profile number_format (eink-ha-os#110); the HA frontend saves it under key "language"
  ws_.sendText("{\"id\":" + std::to_string(idUserData_) + ",\"type\":\"frontend/get_user_data\",\"key\":\"language\"}");
  lastStatsMs_ = millis();
  idPrefs_ = nextId_++;
  ws_.sendText("{\"id\":" + std::to_string(idPrefs_) + ",\"type\":\"energy/get_prefs\"}");
  idAreas_ = nextId_++;
  ws_.sendText("{\"id\":" + std::to_string(idAreas_) + ",\"type\":\"config/area_registry/list\"}");
  prefsDone_ = seedTplDone_ = seedFailed_ = false;
  idDevices_ = 0;   // a discovery cut off by the last disconnect is not coming back
  prefsJson_.clear();
  seedTpl_.clear();
  idSeed_ = 0;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    seeding_ = hub().seedPending;
  }
  if (seeding_) {
    seedAskMs_ = millis();
    idSeed_ = nextId_++;
    JsonDocument d(psramJson());
    d["id"] = idSeed_;
    d["type"] = "render_template";
    d["template"] = seedTemplate();
    d["report_errors"] = true;
    std::string s;
    serializeJson(d, s);
    ws_.sendText(s);
    LOG_INF("HA", "no screens.yaml yet: asking HA what to show");
  }
  idTemplate_ = nextId_++;
  {
    JsonDocument d(psramJson());
    d["id"] = idTemplate_;
    d["type"] = "render_template";
    d["template"] = kDiscoveryTemplate;
    d["report_errors"] = true;
    std::string s;
    serializeJson(d, s);
    ws_.sendText(s);
  }
  entitySubs_.clear();   // a new socket: nothing is subscribed yet
  resubWhy_ = "connect";
  subscribeAll();
  if (hist_) hist_->reset();   // answers of the last socket are not coming: fetch every tile again
  if (wx_) wx_->reset();
  if (agenda_) agenda_->reset();
}

void HaClient::setPresenceEntity(const std::string& id) {
  if (id == presenceId_) return;
  presenceId_ = id;
  resubscribeFor("presence entity");
}

void HaClient::resubscribeFor(const char* why) {
  if (!resubscribe_) resubWhy_ = why;
  resubscribe_ = true;
}

void HaClient::subscribeAll() {
  resubscribe_ = false;
  std::set<std::string> all;
  {
    PsramScope ps;   // kept as subscribed_: ~2 KB of internal RAM on the demo house (eink-ha-os#289)
    all.insert(configIds_.begin(), configIds_.end());
    all.insert(discoveredIds_.begin(), discoveredIds_.end());
    for (auto& w : adapter_.watchIds()) all.insert(w);
    if (!presenceId_.empty()) all.insert(presenceId_);   // eink-ha-os#331 empty-house sleep
  }
  // eink-ha-os#81: a real HA re-ran the full subscribe (and HA re-sent every state) every ~5 min with the same 67 ids
  if (!resubscribeNeeded(subscribed_, entitySubs_.size(), all)) {
    LOG_INF("HA", "subscribe_entities: %u entities unchanged (%08x) after %s · kept", unsigned(all.size()),
            unsigned(idSetHash(all)), resubWhy_);
    return;
  }
  if (!entitySubs_.empty())
    LOG_INF("HA", "subscribe_entities: %s · %u → %u entities (%08x → %08x): %s", resubWhy_, unsigned(subscribed_.size()),
            unsigned(all.size()), unsigned(idSetHash(subscribed_)), unsigned(idSetHash(all)),
            idSetDiff(subscribed_, all).c_str());
  for (uint32_t sub : entitySubs_)
    ws_.sendText("{\"id\":" + std::to_string(nextId_++) + ",\"type\":\"unsubscribe_events\",\"subscription\":" +
                 std::to_string(sub) + "}");
  entitySubs_.clear();
  std::vector<std::string> ids(all.begin(), all.end());
  subscribed_ = std::move(all);
  for (size_t i = 0; i < ids.size(); i += kChunk) {
    JsonDocument d(psramJson());
    uint32_t id = nextId_++;
    d["id"] = id;
    d["type"] = "subscribe_entities";
    JsonArray a = d["entity_ids"].to<JsonArray>();
    for (size_t j = i; j < ids.size() && j < i + kChunk; j++) a.add(ids[j]);
    std::string s;
    serializeJson(d, s);
    ws_.sendText(s);
    entitySubs_.push_back(id);
    // display_precision lives in the entity registry, not in the state (eink-ha-os#85)
    uint32_t rid = nextId_++;
    d["id"] = rid;
    d["type"] = "config/entity_registry/get_entries";
    s.clear();
    serializeJson(d, s);
    ws_.sendText(s);
    idRegistry_.insert(rid);
  }
  LOG_INF("HA", "subscribe_entities: %u entities in %u chunks", static_cast<unsigned>(ids.size()),
          static_cast<unsigned>(entitySubs_.size()));
}

void HaClient::onMessage(const std::string& msg) {
  JsonDocument d(psramJson());
  if (DeserializationError e = deserializeJson(d, msg)) {
    LOG_WRN("HA", "bad JSON (%u bytes): %s", static_cast<unsigned>(msg.size()), e.c_str());
    return;
  }
  const char* type = d["type"] | "";
  if (!strcmp(type, "auth_required")) {
    ws_.sendText("{\"type\":\"auth\",\"access_token\":\"" + jsonEscape(access_.empty() ? accessToken() : access_) + "\"}");
    return;
  }
  if (!strcmp(type, "auth_ok")) return onReady();
  if (!strcmp(type, "auth_invalid")) {
    std::string kind;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      kind = hub().link.kind;
    }
    ws_.close();
    if (kind == "llat") {
      state_ = St::Revoked;
      setHaState(static_cast<int>(HaState::KeyRevoked));
      return;
    }
    // access token may simply be stale: drop it; the next connect refreshes (invalid_grant → KeyRevoked)
    access_.clear();
    accessTtlMs_ = 0;
    return fail("auth_invalid");
  }
  const uint32_t id = d["id"] | 0;
  if (!strcmp(type, "result")) {
    if (!(d["success"] | false)) {
      LOG_WRN("HA", "request %u failed: %s", (unsigned)id, (const char*)(d["error"]["message"] | "?"));
      if (id && id == idList_) {
        idList_ = 0;
        std::lock_guard<std::recursive_mutex> l(hub().mu);
        hub().haEntitiesAskMs = 0;
      }
      if (id && id == idPrefs_) prefsDone_ = true;
      if (id && id == idUserData_) idUserData_ = 0;   // no frontend: keep the last known format
      if (id && id == idDevices_) idDevices_ = 0;
      if (id && id == idSeed_) { idSeed_ = 0; seedTplDone_ = seedFailed_ = true; }
      idRegistry_.erase(id);   // an HA without get_entries: per-unit decimals only
      maybeSeed();
      return;
    }
    JsonVariantConst r = d["result"];
    if (id == idUser_) {
      std::string name = r["name"] | "";
      EntityValue v;
      v.state = name;
      {
        std::lock_guard<std::recursive_mutex> l(hub().mu);
        v.attrs["url"] = hub().link.url;
        if (!name.empty() && hub().link.user != name) {
          hub().link.user = name;
          storage().saveHa(hub().link);
        }
      }
      push("x4.ha", v);
    } else if (id == idConfig_) {
      idConfig_ = 0;
      setLanguage(r["language"] | "");
      setHaTimezone(r["time_zone"] | "");   // the clock zone unless the tz setting overrides it (eink-ha-os#147)
      setCurrency(r["currency"] | "");
    } else if (id == idUserData_) {
      idUserData_ = 0;
      setNumberFormat(r["value"]["number_format"] | "");   // null value: never saved in the profile → the language decides
    } else if (id == idPrefs_) {
      std::string json;
      {
        PsramScope ps;   // prefsJson_ is kept for the seed (eink-ha-os#289)
        EntityValue v;
        v.state = "ok";
        serializeJson(r, json);
        v.attrs["json"] = json;
        push("x4.energy_prefs", v);
        prefsJson_ = json;
      }
      prefsDone_ = true;
      idPrefs_ = 0;
      bool prefsChanged;
      {
        PsramScope ps;
        prefsChanged = adapter_.setEnergyPrefs(json);
      }
      if (prefsChanged) resubscribeFor("energy prefs");
      publishSources();
      std::string tpl = adapter_.deviceDiscoveryTemplate();
      if (!tpl.empty()) {
        JsonDocument t(psramJson());
        idDevices_ = nextId_++;
        t["id"] = idDevices_;
        t["type"] = "render_template";
        t["template"] = tpl;
        t["report_errors"] = true;
        std::string s;
        serializeJson(t, s);
        ws_.sendText(s);
      }
      requestStatistics();
      maybeSeed();
    } else if (id == idStats_) {
      std::string text;
      serializeJson(r, text);
      const time_t t = time(nullptr);   // rows of another local day are dropped (eink-ha-os#308): an answer that crossed midnight
      adapter_.setNow(t > 1700000000 ? static_cast<int64_t>(t) : 0);
      PsramScope ps;
      EntityUpdates out;
      adapter_.setHourlyStatistics(text, out);
      pushOut(out);
    } else if (idRegistry_.erase(id)) {
      PsramScope ps;   // setPrecision re-ingests the raw state (prices included)
      EntityUpdates out;
      for (JsonPairConst kv : r.as<JsonObjectConst>()) adapter_.setPrecision(kv.key().c_str(), registryPrecision(kv.value()), out);
      pushOut(out);
    } else if (id == idAreas_) {
      EntityValue v;
      v.state = "ok";
      std::string areas = "[";
      for (JsonVariantConst a : r.as<JsonArrayConst>()) {
        v.attrs[a["area_id"] | ""] = a["name"] | "";
        areas += std::string(areas.size() > 1 ? "," : "") + "{\"id\":\"" + jsonEscape(a["area_id"] | "") + "\",\"name\":\"" +
                 jsonEscape(a["name"] | "") + "\"}";
      }
      areas += ']';
      {
        std::lock_guard<std::recursive_mutex> l(hub().mu);
        hub().haAreas = std::move(areas);
      }
      push("x4.areas", v);
    }
    return;
  }
  if (!strcmp(type, "event")) {
    JsonVariantConst ev = d["event"];
    // report_errors: a WARNING event (e.g. an undefined attribute) comes before the result; keep waiting for it (eink-ha-os#58)
    if (id && (id == idDevices_ || id == idSeed_ || id == idList_) &&
        !templateEventFinal(!ev["result"].isNull(), ev["level"].as<const char*>())) {
      LOG_WRN("HA", "template %u warning: %s", (unsigned)id, (const char*)(ev["error"] | "?"));
      return;
    }
    if (id && id == idDevices_) {
      std::string text;
      JsonVariantConst res = ev["result"];
      if (res.is<const char*>()) text = res.as<const char*>();
      else serializeJson(res, text);
      {
        PsramScope ps;
        if (adapter_.setDeviceDiscovery(text)) resubscribeFor("device discovery");
        EntityUpdates out;
        adapter_.remapAll(out);
        pushOut(out);
      }
      publishSources();
      ws_.sendText("{\"id\":" + std::to_string(nextId_++) + ",\"type\":\"unsubscribe_events\",\"subscription\":" +
                   std::to_string(idDevices_) + "}");
      idDevices_ = 0;
      maybeSeed();
      return;
    }
    if (id && id == idSeed_) {
      JsonVariantConst res = ev["result"];
      bool ok;
      {
        PsramScope ps;   // the template answer waits here for the seed (eink-ha-os#289)
        if (res.is<const char*>()) seedTpl_ = res.as<const char*>();
        else if (res.is<JsonObjectConst>()) serializeJson(res, seedTpl_);
        ok = seedAnswerOk(seedTpl_);
      }
      if (!ok) {
        LOG_ERR("HA", "seed template failed: %s", (const char*)(ev["error"] | "answer is not a JSON object"));
        seedTpl_.clear();
        seedFailed_ = true;
      }
      ws_.sendText("{\"id\":" + std::to_string(nextId_++) + ",\"type\":\"unsubscribe_events\",\"subscription\":" +
                   std::to_string(idSeed_) + "}");
      idSeed_ = 0;
      seedTplDone_ = true;
      maybeSeed();
      return;
    }
    if (id && id == idList_) {
      JsonDocument parsed(psramJson());
      JsonVariantConst res = ev["result"];
      if (res.is<const char*>()) {
        if (deserializeJson(parsed, res.as<const char*>())) res = JsonVariantConst();
        else res = parsed.as<JsonVariantConst>();
      }
      if (res["e"].is<JsonArrayConst>()) {
        // written straight into one reserved string (> 4 KB → PSRAM), no second document
        JsonArrayConst all = res["e"].as<JsonArrayConst>();
        const int inHa = res["t"] | int(all.size());
        std::string text;
        text.reserve(std::min<size_t>(all.size(), kMaxListed) * 88 + 2);
        text += '[';
        int n = 0;
        for (JsonVariantConst e : all) {
          if (n == kMaxListed) break;
          if (n++) text += ',';
          text += "{\"id\":\"";
          text += jsonEscape(e[0] | "");
          text += "\",\"name\":\"";
          text += jsonEscape(e[1] | "");
          text += "\",\"unit\":\"";
          text += jsonEscape(e[2] | "");
          text += "\",\"state\":\"";   // HA's state when the list was read (eink-ha-os#84, console entity picker)
          text += jsonEscape(e[3] | "");
          const char* area = e[4] | "";
          if (*area) {   // lightList picker (eink-ha-os#127); absent = no area
            text += "\",\"area\":\"";
            text += jsonEscape(area);
          }
          text += "\"}";
        }
        text += ']';
        const size_t bytes = text.size();
        {
          std::lock_guard<std::recursive_mutex> l(hub().mu);
          hub().haEntities = std::make_shared<const std::string>(std::move(text));
          hub().haEntitiesCount = {size_t(std::max(inHa, n)), size_t(n)};
          hub().haEntitiesAtMs = millis() | 1;
          hub().haEntitiesAskMs = 0;
        }
        LOG_INF("HA", "entity list: %d of %d entities, %u B", n, inHa, unsigned(bytes));
        LOG_INF("HEAP", "entity list: internal free %u → %u B, largest block %u → %u B, low-water %u B",
                unsigned(listFree_), unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)), unsigned(listLargest_),
                unsigned(heapLargestFree()), unsigned(heapMinFree()));
      } else {
        std::lock_guard<std::recursive_mutex> l(hub().mu);
        hub().haEntitiesAskMs = 0;
      }
      ws_.sendText("{\"id\":" + std::to_string(nextId_++) + ",\"type\":\"unsubscribe_events\",\"subscription\":" +
                   std::to_string(idList_) + "}");
      idList_ = 0;
      return;
    }
    if (id == idTemplate_) {
      JsonDocument parsed(psramJson());
      JsonVariantConst res = ev["result"];
      if (res.is<const char*>()) {
        if (deserializeJson(parsed, res.as<const char*>())) return;
        res = parsed.as<JsonVariantConst>();
      }
      if (res.isNull()) return;
      {
        PsramScope ps;   // climateIds_, lightAreas_, discoveredIds_: kept until the next discovery (eink-ha-os#289)
        EntityValue climate, lights;
        std::string ids;
        serializeJson(res["climate"], ids);
        climate.state = std::to_string(res["climate"].size());
        climate.attrs["ids"] = ids;
        climateIds_.clear();
        for (JsonVariantConst c : res["climate"].as<JsonArrayConst>()) climateIds_.push_back(c | "");
        lights.state = std::to_string(res["lights"].size());
        lightAreas_.clear();
        for (JsonVariantConst p : res["lights"].as<JsonArrayConst>()) {
          const char* eid = p[0] | "";
          lights.attrs[eid] = p[1] | "";
          lightAreas_.emplace_back(eid, p[1] | "");
        }
        rediscover();
        LOG_INF("HA", "discovery: %u climate, %u lights · %u subscribed (%s)", unsigned(climateIds_.size()),
                unsigned(lightAreas_.size()), unsigned(discoveredIds_.size()),
                lightSubs_.all ? "all lights" : "lights of picked areas");
        push("x4.climate", climate);
        push("x4.lights", lights);
      }
      // one-shot discovery: drop the template listener (it would re-render on every light change)
      ws_.sendText("{\"id\":" + std::to_string(nextId_++) + ",\"type\":\"unsubscribe_events\",\"subscription\":" +
                   std::to_string(idTemplate_) + "}");
      idTemplate_ = 0;
      return;
    }
    bool ours = false;
    for (uint32_t s : entitySubs_) ours |= (s == id);
    if (!ours) return;
    // compressed state stream: a = added (full), c = changed (diff), r = removed. Diffs apply to the adapter's copy
    // of the HA states (one mirror, not two) and only attributes a reader uses are kept (eink-ha-os#76).
    const uint32_t low0 = heapMinFree();
    PsramScope ps;   // attribute text (scalarText) and the price DOM (hourlyPrices) stay out of internal RAM (eink-ha-os#149)
    EntityUpdates touched;
    applyEntityEvent(ev.as<JsonObjectConst>(), adapter_.raw(), touched);
    for (auto& t : touched) {
      if (hist_ && hist_->watches(t.first)) {   // live append to the open bucket (eink-ha-os#269)
        const auto& st = t.second.state;
        int64_t at = t.second.updatedEpoch * 1000;
        if (at <= 0) at = epochMs();
        hist_->live(t.first, hist::pointOf(st.data(), st.size(), 0).v, at);
      }
      if (hist_ && hist_->wantsAttr(t.first)) historyAttr(t.first);   // eink-ha-os#292: an attribute list changed
      push(t.first, t.second);
    }
    if (heapMinFree() < low0 && heapMinFree() < 48 * 1024)   // eink-ha-os#149: which message took the internal low-water down
      LOG_WRN("HEAP", "entity event (%u B, %u entities): internal low-water %u → %u B, largest block %u B",
              unsigned(msg.size()), unsigned(touched.size()), unsigned(low0), unsigned(heapMinFree()), unsigned(heapLargestFree()));
    static uint32_t events = 0;
    if (++events % 10 == 0) {
      char what[32];
      snprintf(what, sizeof what, "%u HA events", unsigned(events));
      heapMark(what);
    }
    if (!ev["a"].isNull()) {
      size_t attrs = 0, bytes = 0;
      for (auto& m : adapter_.raw())
        for (auto& a : m.second.attrs) ++attrs, bytes += a.first.size() + a.second.size();
      LOG_INF("HEAP", "mirror: %u entities, %u attrs (%u B text), internal free %u B, largest block %u B, low-water %u B",
              unsigned(adapter_.raw().size()), unsigned(attrs), unsigned(bytes),
              unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)), unsigned(heapLargestFree()), unsigned(heapMinFree()));
    }
  }
}

// ---- agenda / next tiles (eink-ha-os#316, core/agenda.h) ----
void HaClient::setAgendaTiles(const std::vector<std::string>& keys) {
  if (!agenda_ && keys.empty()) return;
  PsramScope ps;
  const bool first = !agenda_;
  if (!agenda_) {
    void* m = heap_caps_malloc(sizeof(agenda::Fetcher), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    agenda_ = m ? new (m) agenda::Fetcher() : new agenda::Fetcher();
  }
  agenda_->setKeys(keys);
  if (first) {   // events of the last boot: shown at once, asked again only when 30 min old or another day
    std::string t;
    if (storage().readFile("/agenda.txt", t)) agenda_->load(t);
  }
  agendaPublish();
}

void HaClient::agendaLoop() {
  const int64_t now = epochMs();
  if (now < 1700000000000LL) return;   // no clock yet: the window needs it
  if (agenda_->timedOut(now)) {
    LOG_WRN("AGENDA", "request %u unanswered for 60 s · given up", unsigned(agenda_->requestId()));
    agenda_->abandon();
  }
  if (agenda_->inFlight()) return;
  std::string j;
  bool ask;
  {
    PsramScope ps;
    ask = agenda_->next(now, tzMinutesNow(), nextId_, j);
  }
  if (!ask) return;
  LOG_INF("AGENDA", "ask %u: %.160s", unsigned(nextId_), j.c_str());
  nextId_++;
  ws_.sendText(j);
}

void HaClient::agendaPublish() {
  PsramScope ps;
  agenda_->publish([&](const std::string& key, agenda::State st, const agenda::Fetch& f) {
    Hub& h = hub();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    auto it = std::find_if(h.agendaOut.begin(), h.agendaOut.end(), [&](const Hub::AgendaOut& o) { return o.key == PStr(key); });
    if (it == h.agendaOut.end()) it = h.agendaOut.emplace(h.agendaOut.end());
    it->key = key;
    it->state = st;
    it->f = f;
  });
}

// ---- history tiles (eink-ha-os#269, core/history_fetch.h) ----
void HaClient::setHistoryTiles(const std::vector<hist::Fetcher::Want>& want, bool configChanged) {
  if (!hist_ && want.empty()) return;
  PsramScope ps;
  if (!hist_) {
    void* m = heap_caps_malloc(sizeof(hist::Fetcher), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    hist_ = m ? new (m) hist::Fetcher() : new hist::Fetcher();
  }
  hist_->setTiles(want, configChanged);
  histInfo_ = true;
  // eink-ha-os#292: keep each attribute tile's attribute for its entity; one already mirrored without it is asked again
  // (subscribe_entities sends its full state first)
  const auto keys = hist_->attrKeys();
  if (setExtraAttrs(keys)) askAttrsAgain(keys, "HIST");
}

void HaClient::setListTiles(const std::vector<std::pair<std::string, std::string>>& keys) {
  if (setListAttrs(keys)) askAttrsAgain(keys, "LIST");
}

void HaClient::askAttrsAgain(const std::vector<std::pair<std::string, std::string>>& keys, const char* tag) {
  if (state_ != St::Ready || entitySubs_.empty()) return;
  std::string ids;
  for (auto& k : keys) {
    auto it = adapter_.raw().find(k.first);
    if (it == adapter_.raw().end() || it->second.attrs.count(k.second) || ids.find("\"" + k.first + "\"") != std::string::npos) continue;
    ids += (ids.empty() ? "\"" : ",\"") + k.first + "\"";
  }
  if (ids.empty()) return;
  const uint32_t id = nextId_++;
  ws_.sendText("{\"id\":" + std::to_string(id) + ",\"type\":\"subscribe_entities\",\"entity_ids\":[" + ids + "]}");
  entitySubs_.push_back(id);   // dropped with the others at the next resubscribe
  LOG_INF(tag, "attribute tiles: subscribe %s again for their attribute", ids.c_str());
}

void HaClient::historyAttr(const std::string& entity) {
  auto it = adapter_.raw().find(entity);
  if (it == adapter_.raw().end()) return;   // not mirrored yet: the tile stays Loading
  PsramScope ps;
  const auto& attrs = it->second.attrs;
  hist_->feedAttr(entity, epochMs(), tzMinutesNow(), [&](const std::string& a) -> const PStr* {
    auto f = attrs.find(a);
    return f == attrs.end() ? nullptr : &f->second;
  });
}

void HaClient::historyLoop() {
  const int64_t now = epochMs();
  if (now < 1700000000000LL) return;   // no clock yet: spans need it
  if (hist_->timedOut(now)) {
    LOG_WRN("HIST", "request %u unanswered for 60 s · given up", unsigned(hist_->requestId()));
    hist_->abandon();
  }
  hist_->tick(now);
  {
    PsramScope ps;
    for (auto& e : hist_->pendingAttr()) historyAttr(e);   // eink-ha-os#292: new tiles, a bucket boundary
  }
  if (!hist_->inFlight()) {
    std::string j;
    bool ask;
    {
      PsramScope ps;
      ask = hist_->next(now, tzMinutesNow(), nextId_, j);
    }
    if (ask) {
      const char* t = strstr(j.c_str(), "\"type\":\"");
      LOG_INF("HIST", "ask %u: %.100s", unsigned(nextId_), t ? t + 8 : j.c_str());
      nextId_++;
      histInfo_ = true;
      ws_.sendText(j);
    }
  }
  historyPublish();
}

void HaClient::historyPublish() {
  PsramScope ps;
  bool any = false;
  hist_->publish(epochMs(), [&](const std::string& key, const hist::Series* s, hist::FetchState st) {
    any = true;
    Hub& h = hub();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    auto it = std::find_if(h.historyOut.begin(), h.historyOut.end(), [&](const Hub::HistoryOut& o) { return o.key == PStr(key); });
    if (it == h.historyOut.end()) it = h.historyOut.emplace(h.historyOut.end());
    it->key = key;
    it->state = st;
    it->has = s != nullptr;
    if (s) it->s = *s;
  });
  if (!any && !histInfo_) return;
  histInfo_ = false;
  std::string j = "[";
  for (auto& t : hist_->info()) {
    char b[112];   // the key apart: an attribute tile's key is ~90 chars (eink-ha-os#292)
    j += std::string(j.size() > 1 ? "," : "") + "{\"key\":\"" + jsonEscape(t.key) + "\"";
    snprintf(b, sizeof b, ",\"active\":%s,\"state\":\"%s\",\"source\":\"%s\",\"fetched\":%lld,\"bytes\":%u,\"points\":%u}",
             t.active ? "true" : "false", hist::fetchStateName(t.state), hist::sourceName(t.source),
             static_cast<long long>(t.fetchedAt / 1000), unsigned(t.bytes), unsigned(t.points));
    j += b;
  }
  j += "]";
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().historyInfo = j;
}

// ---- weather tiles (eink-ha-os#318, core/weather.h) ----
namespace {
RTC_NOINIT_ATTR wx::Rtc g_wxRtc;   // forecasts across deep sleep: a glance wake within the hour asks nothing
}

void HaClient::setWeatherTiles(const std::vector<std::string>& entities) {
  if (!wx_ && entities.empty()) return;
  PsramScope ps;
  const bool first = !wx_;
  if (!wx_) {
    void* m = heap_caps_malloc(sizeof(wx::Fetcher), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    wx_ = m ? new (m) wx::Fetcher() : new wx::Fetcher();
  }
  wx_->setEntities(entities);
  if (first) {
    wx::load(g_wxRtc, *wx_);
    if (wx_->size() && wx_->forecast(0).dailyAt)
      LOG_INF("WX", "forecasts from RTC, %lld s old", static_cast<long long>((epochMs() - wx_->forecast(0).dailyAt) / 1000));
  }
  weatherPublish();
}

void HaClient::weatherLoop() {
  const int64_t now = epochMs();
  if (now < 1700000000000LL || state_ != St::Ready) return;   // no clock yet: the "past entry" cut needs it
  if (wx_->timedOut(now)) {
    LOG_WRN("WX", "forecast unanswered for 60 s · given up");
    wx_->abandon();
  }
  if (wx_->inFlight() || (hist_ && hist_->inFlight())) return;   // one streamed answer at a time
  std::string j;
  bool ask;
  {
    PsramScope ps;
    ask = wx_->next(now, tzMinutesNow(), nextId_, j);
  }
  if (!ask) return;
  LOG_INF("WX", "ask %u: %.140s", unsigned(nextId_), j.c_str() + std::min<size_t>(j.size(), 10));
  nextId_++;
  ws_.sendText(j);
}

void HaClient::weatherPublish() {
  PsramScope ps;
  const int n = wx_->publish([&](const std::string& e, const wx::Forecast& fc) {
    Hub& h = hub();
    std::lock_guard<std::recursive_mutex> l(h.mu);
    auto it = std::find_if(h.weatherOut.begin(), h.weatherOut.end(), [&](const Hub::WeatherOut& o) { return o.entity == PStr(e); });
    if (it == h.weatherOut.end()) it = h.weatherOut.emplace(h.weatherOut.end());
    it->entity = PStr(e);
    it->fc = fc;
  });
  if (n) wx::save(g_wxRtc, *wx_);
}

bool HaClient::want(uint32_t id) { return (hist_ && hist_->owns(id)) || (wx_ && wx_->owns(id)) || (agenda_ && agenda_->owns(id)); }

void HaClient::begin(uint32_t id, uint64_t) {
  histLow0_ = heapMinFree();
  streamWx_ = wx_ && wx_->owns(id);
  agStream_ = !streamWx_ && agenda_ && agenda_->owns(id);
  if (streamWx_) wx_->begin();
  else if (agStream_) { PsramScope ps; agenda_->begin(id); }   // the scanner's calendar list: PSRAM too
  else hist_->begin(id);
}

void HaClient::chunk(const char* p, size_t n) {
  wdt::feedIfSubscribed();
  if (streamWx_) wx_->feed(p, n);
  else if (agStream_) agenda_->feed(p, n);
  else hist_->feed(p, n);
}

void HaClient::end(uint32_t id, uint64_t len) {
  if (streamWx_) {
    streamWx_ = false;
    wx_->end(epochMs());
    LOG_INF("WX", "forecast %u %u B: internal low-water %u → %u B", unsigned(id), unsigned(len), unsigned(histLow0_), unsigned(heapMinFree()));
    weatherPublish();
    return;
  }
  if (agStream_) {   // eink-ha-os#316: events taken → the cache, so a wake from deep sleep does not ask again
    agStream_ = false;
    PsramScope ps;
    const bool took = agenda_->end(epochMs());
    if (took) storage().writeFile("/agenda.txt", agenda_->save());
    LOG_INF("AGENDA", "answer %u %u B%s: internal low-water %u → %u B", unsigned(id), unsigned(len), took ? "" : " (no events: failed)",
            unsigned(histLow0_), unsigned(heapMinFree()));
    agendaPublish();
    return;
  }
  {
    PsramScope ps;
    hist_->end(epochMs(), static_cast<uint32_t>(len));
  }
  histInfo_ = true;
  LOG_INF("HEAP", "history %u %u B: internal low-water %u → %u B", unsigned(id), unsigned(len), unsigned(histLow0_),
          unsigned(heapMinFree()));
}

void HaClient::dropped(uint32_t id, uint64_t len) {
  if (wx_ && wx_->owns(id)) {
    wx_->end(epochMs());   // never parsed: kept as it was, asked again after the retry gap
    LOG_WRN("WX", "forecast %u over the frame cap (%llu B)", unsigned(id), static_cast<unsigned long long>(len));
    return;
  }
  if (agenda_ && agenda_->owns(id)) {   // eink-ha-os#316: over the frame cap; asked again in 5 min
    agenda_->abandon();
    LOG_WRN("AGENDA", "answer %u over the frame cap (%llu B)", unsigned(id), static_cast<unsigned long long>(len));
    return;
  }
  if (!hist_ || !hist_->owns(id)) return;   // not a history answer: WsClient logged it
  {
    PsramScope ps;
    hist_->dropped(id, epochMs(), static_cast<uint32_t>(std::min<uint64_t>(len, UINT32_MAX)));
  }
  histInfo_ = true;
  LOG_WRN("HIST", "answer %u over the frame cap (%llu B): too many changes, not asked again", unsigned(id),
          static_cast<unsigned long long>(len));
}

}  // namespace x4::net
