#include "net/net_stats.h"

#include <Arduino.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>

#include "Logging.h"
#include "core/net_policy.h"

namespace x4::net {

namespace {
std::atomic<int> g_open{0};
std::atomic<uint32_t> g_served{0}, g_refused{0}, g_lastMs{0}, g_restarts{0}, g_checks{0}, g_reconnects{0};
std::atomic<uint32_t> g_announceMs{0};
std::atomic<bool> g_any{false}, g_mdnsUp{false}, g_announced{false}, g_mdnsV4{false};
std::atomic<const char*> g_reason{nullptr};
std::mutex g_mu;   // rssi + bssid tag
bool g_rssiKnown = false;
int g_rssi = 0;
char g_bssid[5] = "";
char g_mdnsHost[33] = "";   // MDNS_NAME_BUF_LEN 64, but ours is ha-paper-XXXX (+ a mangled -N)
}  // namespace

void webOpened() { g_open++; }

void webDone() {
  g_open--;
  g_lastMs = millis();
  g_any = true;
  g_served++;
}

void webRefused() { g_refused++; }

uint32_t webServed() { return g_served; }

void mdnsStarted(bool up, const char* reason) {
  g_mdnsUp = up;
  if (!up) g_mdnsV4 = false;
  if (!reason) return;
  g_restarts++;
  g_reason = reason;
}

void mdnsAnnounced() {
  g_announceMs = millis();
  g_announced = true;
}

void mdnsSample(const char* host, bool v4) {
  g_mdnsV4 = v4;
  std::lock_guard<std::mutex> l(g_mu);
  snprintf(g_mdnsHost, sizeof g_mdnsHost, "%s", host);
}

void wifiSample(bool rssiKnown, int rssi, const uint8_t* bssid) {
  const std::string tag = bssidTag(bssid);
  std::lock_guard<std::mutex> l(g_mu);
  g_rssiKnown = rssiKnown;
  g_rssi = rssi;
  snprintf(g_bssid, sizeof g_bssid, "%s", tag.c_str());
}

void idleChecked(bool reconnected) {
  g_checks++;
  if (reconnected) g_reconnects++;
}

void netStatsFill(diag::Net& n) {
  n.webOpen = g_open;
  n.served = g_served;
  n.refused503 = g_refused;
  n.lastRequestAgeS = g_any ? int64_t((millis() - g_lastMs) / 1000) : -1;
  n.mdnsUp = g_mdnsUp;
  n.mdnsRestarts = g_restarts;
  n.mdnsReason = g_reason;
  n.mdnsV4 = g_mdnsUp && g_mdnsV4;
  n.mdnsAnnounceAgeS = g_announced ? int64_t((millis() - g_announceMs) / 1000) : -1;
  n.idleChecks = g_checks;
  n.idleReconnects = g_reconnects;
  std::lock_guard<std::mutex> l(g_mu);
  n.rssiKnown = g_rssiKnown;
  n.rssi = g_rssi;
  n.bssid = g_bssid;
  if (g_mdnsUp) n.mdnsHost = g_mdnsHost;
}

void netStatsLog() {
  diag::Net n;
  netStatsFill(n);
  char age[12] = "-", rssi[8] = "n/a";
  if (n.lastRequestAgeS >= 0) snprintf(age, sizeof age, "%u s", unsigned(n.lastRequestAgeS));
  if (n.rssiKnown) snprintf(rssi, sizeof rssi, "%d", n.rssi);
  LOG_INF("NET", "web open %d served %u 503 %u last_req %s · mdns up %d v4 %d %s restarts %u · rssi %s · bssid %s · idle checks %u relinks %u",
          n.webOpen, unsigned(n.served), unsigned(n.refused503), age, n.mdnsUp ? 1 : 0, n.mdnsV4 ? 1 : 0,
          n.mdnsHost.empty() ? "-" : n.mdnsHost.c_str(), unsigned(n.mdnsRestarts), rssi,
          n.bssid.empty() ? "-" : n.bssid.c_str(), unsigned(n.idleChecks), unsigned(n.idleReconnects));
}

}  // namespace x4::net
