#include "net/health.h"

#include <Arduino.h>
#include <esp_heap_caps.h>
#include <esp_wifi.h>

#include <atomic>
#include <cstring>
#include <ctime>
#include <mutex>

#include "Logging.h"
#include "core/net_policy.h"
#include "net/ha_client.h"
#include "net/hub.h"
#include "net/log.h"
#include "net/ota.h"
#include "net/tls.h"
#include "net/wifi_mgr.h"

namespace x4::net {

uint32_t heapLargestFree() { return heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL); }
uint32_t heapMinFree() { return heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL); }
uint32_t heapFreeInternal() { return heap_caps_get_free_size(MALLOC_CAP_INTERNAL); }

bool tlsHeapOk(const char* what) {
  const uint32_t largest = heapLargestFree(), free = heapFreeInternal();
  const bool pooled = kTlsPoolSlots - tlsPoolUsed() >= 2;
  if (heapOkForTls(largest, free, kTlsPoolSlots - tlsPoolUsed())) return true;
  LOG_WRN("HEAP", "internal free %u B (need %u), largest block %u B (need %u) · skipping TLS to %s", unsigned(free),
          unsigned(pooled ? kTlsMinFreePooled : kTlsMinFreeInternal), unsigned(largest),
          unsigned(pooled ? kTlsMinLargestPooled : kTlsMinLargestBlock), what);
  return false;
}

bool maintenanceRestartAllowed() {
  if (otaBusy() || otaPendingVerify()) return false;
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  return !hub().restartPending;
}

void maintenanceRestart(const char* why) {
  LOG_WRN("NET", "maintenance restart: %s (heap largest %u B, min %u B)", why, unsigned(heapLargestFree()),
          unsigned(heapMinFree()));
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().restartPending = true;
  hub().restartAtMs = millis() + 1000;
}

namespace {
struct Low {   // POD: copied under a spinlock
  bool set;
  uint32_t min, minDma, min8bitInt, uptimeS;
  bool ws, report, ota, rssiKnown;
  int tls, web, rssi;
  char where[16], path[40];
};
portMUX_TYPE g_lowMux = portMUX_INITIALIZER_UNLOCKED;
Low g_low;
char g_lastPath[40];
std::atomic<int> g_webOpen{0}, g_rssi{0};
std::atomic<bool> g_rssiKnown{false}, g_report{false};
}  // namespace

void heapRequestOpen(const char* path) {
  g_webOpen.fetch_add(1);
  portENTER_CRITICAL(&g_lowMux);
  strlcpy(g_lastPath, path, sizeof g_lastPath);
  portEXIT_CRITICAL(&g_lowMux);
}
void heapRequestClosed() { g_webOpen.fetch_sub(1); }
void heapReportInFlight(bool on) { g_report = on; }

void heapCheckpoint(const char* where) {
  Low p{};
  p.min = heapMinFree();
  portENTER_CRITICAL(&g_lowMux);
  const bool drop = !g_low.set || p.min + 512 <= g_low.min;
  portEXIT_CRITICAL(&g_lowMux);
  if (!drop) return;
  p.set = true;
  p.minDma = heap_caps_get_minimum_free_size(MALLOC_CAP_DMA);
  p.min8bitInt = heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL);
  p.uptimeS = uint32_t(millis() / 1000);
  p.ws = haClient().ready();
  p.tls = int(tlsPoolUsed());
  p.report = g_report;
  p.ota = otaBusy();
  p.web = g_webOpen;
  p.rssiKnown = g_rssiKnown;
  p.rssi = g_rssi;
  strlcpy(p.where, where, sizeof p.where);
  portENTER_CRITICAL(&g_lowMux);
  memcpy(p.path, g_lastPath, sizeof p.path);
  const bool still = !g_low.set || p.min + 512 <= g_low.min;   // another task may have logged it meanwhile
  if (still) g_low = p;
  portEXIT_CRITICAL(&g_lowMux);
  if (!still) return;
  char rssi[8] = "n/a";
  if (p.rssiKnown) snprintf(rssi, sizeof rssi, "%d", p.rssi);
  LOG_WRN("HEAP", "low point min %u min_dma %u min_8bit_int %u · at %s · ws %s · tls %d · report %s · ota %s · web %d · last %s · rssi %s",
          unsigned(p.min), unsigned(p.minDma), unsigned(p.min8bitInt), p.where, p.ws ? "up" : "down", p.tls,
          p.report ? "yes" : "no", p.ota ? "yes" : "no", p.web, p.path[0] ? p.path : "-", rssi);
}

void heapLowPoint(diag::LowPoint& out) {
  portENTER_CRITICAL(&g_lowMux);
  const Low p = g_low;
  portEXIT_CRITICAL(&g_lowMux);
  out = diag::LowPoint();
  if (!p.set) return;
  out.set = true;
  out.minFreeInternal = p.min;
  out.minDma = p.minDma;
  out.min8bitInt = p.min8bitInt;
  out.uptimeS = p.uptimeS;
  out.where = p.where;
  out.ws = p.ws;
  out.tlsSlots = p.tls;
  out.haReport = p.report;
  out.ota = p.ota;
  out.webOpen = p.web;
  out.lastPath = p.path;
  out.rssiKnown = p.rssiKnown;
  out.rssi = p.rssi;
}

void healthLoop() {
  static uint32_t lastMs = 0;
  static HeapWatch watch;
  const uint32_t now = millis();
  if (lastMs && now - lastMs < 10000) return;
  lastMs = now | 1u;
  int dbm = 0;
  const bool known = wifiRssi(dbm);
  g_rssi = dbm;
  g_rssiKnown = known;
  logAllocFailures();
  heapCheckpoint("health");
  int hour = -1;
  const time_t t = time(nullptr);
  if (t > 1700000000) {
    struct tm lt;
    localtime_r(&t, &lt);
    hour = lt.tm_hour;
  }
  static bool low = false;
  const uint32_t largest = heapLargestFree(), free = heapFreeInternal();
  const bool ok = heapOkForTls(largest, free, kTlsPoolSlots - tlsPoolUsed());
  if (!ok && !low)
    LOG_WRN("HEAP", "internal free %u B, largest block %u B · TLS refused until it recovers", unsigned(free), unsigned(largest));
  else if (ok && low) LOG_INF("HEAP", "internal free %u B, largest block %u B · TLS allowed again", unsigned(free), unsigned(largest));
  low = !ok;
  static uint32_t n = 0;
  if (n++ % 6 == 0)   // one line a minute for tools/monitor.py (--csv, soak tests); field names are its parse contract
    LOG_INF("HEAP", "free %u min %u largest %u psram %u min_dma %u min_8bit_int %u · net stack %u · tls %u/%u spills %u",
            unsigned(free), unsigned(heapMinFree()), unsigned(largest), unsigned(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)),
            unsigned(heap_caps_get_minimum_free_size(MALLOC_CAP_DMA)),
            unsigned(heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL)),
            unsigned(uxTaskGetStackHighWaterMark(nullptr)), tlsPoolUsed(), kTlsPoolSlots, unsigned(tlsPoolSpills()));
  if (watch.sample(now, largest, free, hour, maintenanceRestartAllowed()))
    maintenanceRestart("internal heap fragmented for 30 min");
}

namespace {
std::mutex g_psMu;
int g_psDepth = 0;
int g_psWant = -1;   // power rules (#177): 1 = modem sleep, 0 = none, -1 = not set yet
#if !X4_QEMU
bool g_psSaved = false;
wifi_ps_type_t g_psPrev = WIFI_PS_MIN_MODEM;

void psApplyLocked(bool sleep) {
  const wifi_ps_type_t want = sleep ? WIFI_PS_MIN_MODEM : WIFI_PS_NONE;
  wifi_ps_type_t cur;
  if (esp_wifi_get_ps(&cur) == ESP_OK && cur != want) esp_wifi_set_ps(want);
}
#endif
}  // namespace

void wifiPsOffAcquire() {
  std::lock_guard<std::mutex> l(g_psMu);
  if (g_psDepth++) return;
#if !X4_QEMU
  g_psSaved = esp_wifi_get_ps(&g_psPrev) == ESP_OK;
  if (g_psSaved && g_psPrev != WIFI_PS_NONE && esp_wifi_set_ps(WIFI_PS_NONE) != ESP_OK) g_psSaved = false;
#endif
}

void wifiPsOffRelease() {
  std::lock_guard<std::mutex> l(g_psMu);
  if (g_psDepth <= 0 || --g_psDepth) return;
#if !X4_QEMU
  // the power rules' mode (also one set during the hold), else the mode from before the hold
  if (g_psWant >= 0) psApplyLocked(g_psWant == 1);
  else if (g_psSaved && g_psPrev != WIFI_PS_NONE) esp_wifi_set_ps(g_psPrev);
  g_psSaved = false;
#endif
}

bool wifiPsSet(bool modemSleep) {
  std::lock_guard<std::mutex> l(g_psMu);
  g_psWant = modemSleep ? 1 : 0;
  if (g_psDepth) return false;
#if !X4_QEMU
  psApplyLocked(modemSleep);
#endif
  return true;
}

bool wifiPsHeld() {
  std::lock_guard<std::mutex> l(g_psMu);
  return g_psDepth > 0;
}

}  // namespace x4::net
