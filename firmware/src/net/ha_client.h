// Home Assistant WebSocket client (net task). Auth → subscribe_entities (filtered, chunked) +
// energy/get_prefs + area registry + climate/light discovery → EntityStore (via Hub::entityOut).
// First connection without /screens.yaml (Hub::seedPending): one more render_template (core seedTemplate()), then
// core/seed builds the screens from what this HA has and DeviceServices::applyConfig saves them (#23).
//
// Every HA entity goes through core/entity_map (EntityAdapter) first: Energy dashboard sources, device-discovered
// power/battery sensors, recorder statistics (today / hourly) and the settings `entities` overrides become the logical
// ids the UI reads (core/entities.h); lights, climate, scenes and the x4.* meta entities pass through unchanged.
//
// Pseudo-entities written next to the real ones (for the UI runtime):
//   x4.energy_prefs   state "ok", attrs.json = raw energy/get_prefs result (solar/battery/grid/price sensors)
//   x4.areas          attrs: area_id → area name
//   x4.lights         attrs: light entity_id → area_id ("" when unassigned)
//   x4.climate        state = count, attrs.ids = JSON array of climate.* entity ids
//   x4.ha             state = user name the display is linked as; attrs.url
#pragma once
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "core/entities.h"
#include "core/entity_map.h"
#include "core/history_fetch.h"
#include "core/home.h"
#include "net/storage.h"
#include "net/ws_client.h"

namespace x4::net {

class HaClient : private WsStream {
 public:
  void loop();                       // net task, call continuously
  void restart();                    // link changed → reconnect now
  void stop();                       // unlink / factory reset
  // Close the WebSocket so a second TLS session gets its heap; reconnects on the next loop(). False: nothing open.
  bool yieldTls();
  // Internal RAM under the floor (#248): close the WebSocket and stay off for waitMs (the TLS guard then decides).
  bool shedHeap(uint32_t waitMs);
  void callService(const std::string& domain, const std::string& service, const std::string& jsonData);
  void setConfigEntities(const std::set<std::string>& ids, const LightSubs& lights);   // from the active config
  void setEntityOverrides(const std::map<std::string, std::string>& o);   // settings `entities` (net task)
  bool ready() const { return state_ == St::Ready; }
  // One render_template listing pickable entities (GET /api/v1/ha/entities) → hub().haEntities. Net task.
  void requestEntityList();
  // Access token for the current link (refreshing if needed). Blocking. "" if unavailable.
  std::string accessToken(bool* revoked = nullptr);
  // History tiles of the config (#269); active = on the current app's screens, the only ones fetched. Net task.
  void setHistoryTiles(const std::vector<hist::Fetcher::Want>& want, bool configChanged);

 private:
  enum class St : uint8_t { Idle, Connecting, AuthWait, Ready, Backoff, Revoked };
  void connect();
  void onMessage(const std::string& msg);
  void onReady();
  void subscribeAll();
  void resubscribeFor(const char* why);   // the watched set may have changed: check it on the next loop
  void rediscover();   // discoveredIds_ from the discovery answer + lightSubs_ (#127)
  void handleCompressed(const char* kind, void* obj);   // JsonObject*
  void push(const std::string& id, const EntityValue& v);   // raw HA entity → adapter → store
  void pushOut(const EntityUpdates& u);
  void publishSources();
  void requestStatistics();
  void maybeSeed(bool force = false);   // all seed inputs in (or timed out) → build + save the screens
  void setHaState(int s);   // HaState
  void setLanguage(const char* haLang);   // get_config `language` → NetStatus.language + userdata /lang (#98)
  void setCurrency(const char* code);     // get_config `currency` → NetStatus.currency + userdata /currency (#147)
  void setNumberFormat(const char* nf);   // profile number_format → NetStatus.numberFormat + userdata /numfmt (#110)
  void fail(const char* why);
  // history answers stream past the message buffer (#269)
  bool want(uint32_t id) override;
  void begin(uint32_t id, uint64_t len) override;
  void chunk(const char* p, size_t n) override;
  void end(uint32_t id, uint64_t len) override;
  void dropped(uint32_t id, uint64_t len) override;
  void historyLoop();
  void historyPublish();
  void historyAttr(const std::string& entity);   // #292: feed an attribute tile from the mirror

  St state_ = St::Idle;
  WsClient ws_;
  uint32_t nextTryMs_ = 0, backoffMs_ = 2000, lastPingMs_ = 0;
  uint32_t nextId_ = 1;
  std::string access_;
  uint32_t accessAtMs_ = 0, accessTtlMs_ = 0;
  bool restartRequested_ = false;

  std::set<std::string> configIds_, discoveredIds_;
  std::vector<std::string> climateIds_;                            // discovery answer, HA order
  std::vector<std::pair<std::string, std::string>> lightAreas_;   // discovery answer: light entity_id, area_id
  LightSubs lightSubs_;
  std::vector<uint32_t> entitySubs_;   // subscription ids of subscribe_entities chunks
  std::set<uint32_t> idRegistry_;      // pending config/entity_registry/get_entries (display_precision, #85)
  uint32_t idPrefs_ = 0, idAreas_ = 0, idTemplate_ = 0, idUser_ = 0, idDevices_ = 0, idStats_ = 0, idList_ = 0, idConfig_ = 0, idUserData_ = 0;
  uint32_t lastStatsMs_ = 0, lastDayCheckMs_ = 0;
  // first-run seed (#23): template answer + energy prefs; device discovery must be done (idDevices_ == 0)
  uint32_t idSeed_ = 0, seedAskMs_ = 0;
  uint32_t listFree_ = 0, listLargest_ = 0;   // internal heap when the entity list was asked (log only)
  uint32_t listAskMs_ = 0;
  bool seeding_ = false, seedTplDone_ = false, seedFailed_ = false, prefsDone_ = false;
  std::string seedTpl_, prefsJson_;
  EntityAdapter adapter_;
  bool resubscribe_ = false;
  const char* resubWhy_ = "connect";
  std::set<std::string> subscribed_;   // what entitySubs_ cover (#81: an unchanged set is not sent again)
  std::vector<std::string> outbox_;              // service calls queued while offline (dropped after 30 s)
  uint32_t outboxMs_ = 0;
  hist::Fetcher* hist_ = nullptr;   // PSRAM, made with the first history tile
  uint32_t histLow0_ = 0;           // internal low-water when an answer began (HEAP log)
  bool histInfo_ = false;           // tile states changed: refresh Hub::historyInfo
};

HaClient& haClient();

}  // namespace x4::net
