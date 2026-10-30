#include "net/ha_report.h"

#include <Arduino.h>
#include <esp_timer.h>

#include <cstring>
#include <ctime>
#include <string>
#include <utility>
#include <vector>

#include "Logging.h"
#include "core/ha_report.h"
#include "net/diag.h"
#include "net/ha_client.h"
#include "net/health.h"
#include "net/hub.h"
#include "net/storage.h"
#include "net/tls.h"
#include "net/util.h"
#include "net/wifi_mgr.h"

namespace x4::net {

namespace {

constexpr uint32_t kCheckMs = 5000;
uint32_t g_checkMs = 0;
bool g_wasReady = false, g_wasOn = true;
bool g_force = true;    // (re)connected or toggled on: push at the next allowed moment
bool g_denied = false;  // HA said 401/403 (linked user is not an admin): quiet until the next connect
bool g_have = false;    // g_last valid
bool g_retried = false; // the one early retry after a network failure is used (until a push lands or HA reconnects)
ha_report::Last g_last;

}  // namespace

void haReportLoop() {
  const uint32_t now = millis();
  if (now - g_checkMs < kCheckMs) return;
  g_checkMs = now;
  const bool ready = haClient().ready();
  if (ready && !g_wasReady) {
    g_force = true;
    g_denied = false;
    g_retried = false;
  }
  g_wasReady = ready;

  ha_report::Health h;
  std::string url;
  bool on, linked;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    on = hub().settings.haReport;
    linked = hub().link.linked();
    url = hub().link.url;
    h.battery = hub().power.batteryPct;
    h.charging = hub().power.charging;
    h.usb = hub().power.usb;
    h.lastFullEpoch = hub().lastFullEpoch;
  }
  if (on && !g_wasOn) g_force = true;
  g_wasOn = on;
  if (!linked) {  // unlinked: the next link starts over (eink-ha-os#44)
    g_force = true;
    g_denied = false;
    g_have = false;
  }
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    const char*& st = hub().haReportState;
    if (!linked) hub().haReportEpoch = 0;
    if (!on) st = "off";
    else if (!linked) st = "waiting";
    else if (!strcmp(st, "off") || (!strcmp(st, "not_admin") && !g_denied)) st = "waiting";
  }
  if (!on || !ready || !linked || g_denied) return;
  if (!ha_report::due(g_have ? &g_last : nullptr, g_force, now, h.battery, h.charging)) return;

  h.hostname = hostnameLocal();
  h.name = storage().getString("x4dev", "name", "HA Paper");
  h.firmware = firmwareVersion();
  h.resetReason = diagResetReason();
  h.hasRssi = wifiRssi(h.rssi);
  const time_t t = time(nullptr);
  if (t > 1700000000) h.bootEpoch = int64_t(t) - esp_timer_get_time() / 1000000;
  std::vector<std::pair<std::string, std::string>> reqs;
  for (auto& s : ha_report::states(h)) reqs.emplace_back("/api/states/" + s.entityId, ha_report::body(s));

  const std::string token = haClient().accessToken();
  heapReportInFlight(true);
  const int code = token.empty() ? -1 : httpPostJsonEach(url, token, reqs);
  heapReportInFlight(false);
  heapCheckpoint("ha report");
  if (code >= 200 && code < 300) {
    g_last = {now, h.battery, h.charging};
    g_have = true;
    g_force = false;
    g_retried = false;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().haReportState = "ok";
      hub().haReportEpoch = t > 1700000000 ? int64_t(t) : 0;
    }
    LOG_INF("HA", "report: %u states (battery %d%%)", static_cast<unsigned>(reqs.size()), h.battery);
    return;
  }
  // failed: retry after the minimum gap, keeping the last reported values. No HTTP answer (a handshake that ran out
  // of time or heap next to the WebSocket's): one early retry first (eink-ha-os#123).
  if (!g_have) g_last = {now, h.battery, h.charging};
  g_last.atMs = now;
  g_last.retry = code <= 0 && !g_retried;
  g_retried = g_retried || g_last.retry;
  g_have = true;
  g_force = true;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().haReportState = code == 401 || code == 403 ? "not_admin" : "error";
  }
  if (code == 401 || code == 403) {
    g_denied = true;
    LOG_WRN("HA", "report: HA %d, the linked HA user is not an administrator · stopped until the next connect", code);
  } else {
    LOG_WRN("HA", "report failed (%d) · retry in %u s", code,
            static_cast<unsigned>((g_last.retry ? ha_report::kRetryMs : ha_report::kMinGapMs) / 1000));
  }
}

}  // namespace x4::net
