// Shared state between the three device tasks:
//   main loop (App + Display + Board, core 1) · net task (Wi-Fi, HA WebSocket, OTA, blocking HTTPS, core 0) ·
//   AsyncTCP (web handlers, core 0). Everything here is guarded by `mu`. The App only ever sees data on the
//   main loop: DeviceServices::pump() publishes NetStatus, entity updates, config/settings changes.
#pragma once
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "app/app.h"
#include "app/services.h"
#include "core/config.h"
#include "core/entities.h"
#include "core/history_fetch.h"
#include "core/home.h"
#include "hw/platform.h"
#include "net/storage.h"

namespace x4::net {

struct Hub {
  std::recursive_mutex mu;

  // ---- status (written by net task / web, published to App by pump()) ----
  NetStatus status;
  bool statusDirty = true;

  // ---- HA → EntityStore (applied on main loop) ----
  std::vector<std::pair<std::string, EntityValue>> entityOut;
  bool clearEntities = false;
  uint32_t entitiesApplied = 0;   // entity updates handed to the App so far (diagnostics: GET /__qemu/state)
  // history tile series (#269) → App::setHistory; one entry per series key, PSRAM
  struct HistoryOut { PStr key; hist::FetchState state; bool has; hist::Series s; };
  std::vector<HistoryOut, PsramAlloc<HistoryOut>> historyOut;
  PStr historyInfo = "[]";        // [{key, active, state, source, fetched, bytes, points}] (GET /__qemu/state, log)

  // ---- config / settings (web → main loop) ----
  Config config;              // what the display shows now
  uint32_t configRev = 1;
  bool configPending = false;
  bool seedPending = false;   // no /screens.yaml yet: the first HA connection builds the screens from HA (#23)
  DisplaySettings settings;
  bool settingsPending = false;
  bool refreshPending = false;
  bool sourcesChanged = false;   // PUT /settings entities: the App draws the new states as they land (#151)
  bool applying = false;      // the main loop is drawing a config / settings / refresh it took from here (QEMU tests, #71)
  bool ambient = false;       // App chrome hidden after 60 s without input (#27), as of the last main loop (QEMU tests, #71)
  bool restartPending = false;
  uint32_t restartAtMs = 0;
  bool factoryResetPending = false;

  // ---- Wi-Fi ----
  std::string savedSsid;
  std::vector<WifiNetwork> networks;
  bool scanning = false;
  bool softAp = false;        // SoftAP "HA-Paper-Setup" currently up
  std::string wifiError;      // last connect error ("Wrong password. Try again.")
  const char* wifiJoin = "idle";   // GET /api/v1/wifi state: idle | connecting | connected | failed
  uint32_t linkingSinceMs = 0;   // HaState::Linking started (browser went to HA); expires after 10 min

  // ---- HA ----
  HaLink link;                // secret never leaves the device
  std::vector<std::string> haDiscovered;   // mDNS _home-assistant._tcp results
  std::map<std::string, std::string> entityOverrides;   // settings `entities`: logical id → HA entity ("-" = negate)
  std::map<std::string, std::string> entitySources;     // resolved mapping (core/entity_map), for GET /settings
  // GET /api/v1/ha/entities: [{"id","name","unit","state"}…] (JSON text, PSRAM) from one render_template, refreshed on demand.
  // Shared and immutable: a response streams it without copying while a newer list replaces it.
  std::shared_ptr<const std::string> haEntities;
  std::string haAreas = "[]";      // GET /ha/entities areas: [{"id","name"}] from config/area_registry/list (#127)
  ListCounts haLists;              // GET /ha/entities lists: climate / lights in HA vs what an unpicked list shows (#134)
  ListCount haEntitiesCount;       // GET /ha/entities lists.entities: in HA vs rows in haEntities (#150)
  uint32_t haEntitiesAtMs = 0;     // when haEntities arrived (0 = never)
  uint32_t haEntitiesAskMs = 0;    // when a refresh was requested (0 = none running)
  bool setupFinished = false; // browser pressed "Open the configurator" (or linked → implicit)

  // ---- board snapshot for web handlers (AsyncTCP must not touch I2C) ----
  PowerInfo power{0, false, false, false, 0};
  uint32_t lastApiMs = 0;      // last authorized API request (power: no deep sleep within 2 min)
  bool apiUsed = false;
  int64_t lastFullEpoch = 0;   // wall clock of the last full panel refresh (0 = none since the clock was set)
  // GET /status ha_report (net/ha_report): ok | off | waiting | not_admin | error; last accepted push (0 = none / no clock)
  const char* haReportState = "waiting";
  int64_t haReportEpoch = 0;

  // ---- preview of the panel ----
  const uint8_t* lastFrame = nullptr;   // the framebuffer last pushed to the panel (2-bit)
  // GET /screens/{id}/preview.png (#168): the shown screen is the panel's frame; any other is drawn off-screen by the
  // main loop (App::renderScreen) for the one paused request in previewReply (null PNG = 503 busy).
  std::string shownScreen;               // App::shownScreen(), refreshed by the main loop
  std::string previewAsk;                // screen id asked for
  uint32_t previewAskMs = 0;             // when; not picked up within kPreviewWaitMs → 503
  static constexpr uint32_t kPreviewWaitMs = 8000;   // under QEMU one full refresh blocks the main loop for seconds (#71)
  std::function<void(std::shared_ptr<const std::vector<uint8_t>>)> previewReply;
  // GET /screens/{id}/values (#122): the web task asks, the main loop formats that screen's tiles (App::tileValues)
  // about once a second until 30 s pass without an ask.
  std::string valuesAsk;                 // screen id asked for
  uint32_t valuesAskMs = 0;              // last ask (0 = none)
  std::string valuesId;                  // screen `values` belongs to
  std::vector<std::string> values;
  uint32_t valuesAtMs = 0;               // when `values` was formatted (0 = never)
  std::map<std::string, std::string> entityGaps;   // tile entity → unavailable | unknown (#86; main loop, once a second)
#if X4_QEMU
  std::string regionText;               // "key\tsignature\n" per region (GET /__qemu/regions)
#endif

  // ---- net-task job queue ----
  std::deque<std::function<void()>> jobs;

  void markStatus() { statusDirty = true; }
  template <class F>
  void post(F&& f) {
    std::lock_guard<std::recursive_mutex> l(mu);
    jobs.emplace_back(std::forward<F>(f));
  }
};

Hub& hub();

}  // namespace x4::net
