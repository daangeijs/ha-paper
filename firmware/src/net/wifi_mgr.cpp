#include "net/wifi_mgr.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <mdns.h>
#include <WiFi.h>
#include <esp_attr.h>
#include <esp_netif.h>
#include <esp_sntp.h>
#include <esp_wifi.h>
#include <freertos/semphr.h>
#include <ping/ping_sock.h>

#include <algorithm>
#include <atomic>

#include "Logging.h"
#include "hw/watchdog.h"
#include "net/health.h"
#include "net/hub.h"
#include "net/net_stats.h"
#include "net/power.h"
#include "net/storage.h"
#include "net/time_sync.h"
#include "net/util.h"
#if X4_QEMU
#include "qemu_eth.h"   // sim/qemu/lib/qemu_openeth: QEMU's OpenCores Ethernet instead of Wi-Fi (never on hardware)
#endif

namespace x4::net {

const char* hostname() {
  static char h[16] = "";
  if (!h[0]) {
    const uint64_t mac = ESP.getEfuseMac();   // base MAC = Wi-Fi station MAC on the S3; byte 0 in the low bits
    snprintf(h, sizeof h, "ha-paper-%02x%02x", unsigned((mac >> 32) & 0xff), unsigned((mac >> 40) & 0xff));
  }
  return h;
}

std::string hostnameLocal() { return std::string(hostname()) + ".local"; }

bool wifiRssi(int& dbm) {
#if X4_QEMU
  (void)dbm;
  return false;
#else
  if (WiFi.status() != WL_CONNECTED) return false;
  dbm = WiFi.RSSI();
  return dbm != 0;
#endif
}

namespace {
DNSServer g_dns;
bool g_dnsUp = false;
constexpr uint32_t kFastMs = 8000;   // fast join (cached BSSID/channel/IP) not up after this → normal join
std::atomic<uint8_t> g_lastReason{0};
std::atomic<bool> g_timeSynced{false};
// #227: set by the Wi-Fi event task, handled by the net task (mDNS restart)
std::atomic<bool> g_ipEvent{false}, g_bssidEvent{false};
uint8_t g_bssid[6];
bool g_haveBssid = false;
const IPAddress kApIp(192, 168, 4, 1);

void setWifi(WifiState s) {
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  if (hub().status.wifi != s) {
    hub().status.wifi = s;
    hub().markStatus();
  }
}

void onTimeSync(struct timeval*) { g_timeSynced = true; }

// Consecutive Wi-Fi maintenance restarts without a connection in between (core WifiEscalation doubles the wait per
// restart). RTC memory survives esp_restart(); the magic tells a cold power-on's garbage apart.
constexpr uint32_t kRestartsMagic = 0x58345752;   // "X4WR"
RTC_NOINIT_ATTR uint32_t g_wifiRestartsMagic;
RTC_NOINIT_ATTR uint32_t g_wifiRestarts;

#if X4_QEMU
// The emulated NIC is always "in range"; Disconnect/Forget only take the link down logically so the rest of the
// firmware (HA client, OTA, status) sees exactly what it would see on Wi-Fi.
std::atomic<uint32_t> g_ethIp{0};
std::atomic<bool> g_qemuLinkWanted{false};
std::string qemuIp() {
  uint32_t ip = g_ethIp;
  char b[16];
  snprintf(b, sizeof b, "%u.%u.%u.%u", unsigned(ip & 0xff), unsigned((ip >> 8) & 0xff), unsigned((ip >> 16) & 0xff), unsigned(ip >> 24));
  return b;
}
#endif
bool linkUp() {
#if X4_QEMU
  return g_qemuLinkWanted && g_ethIp != 0;
#else
  return WiFi.status() == WL_CONNECTED;
#endif
}
}  // namespace

bool netConnected() { return linkUp(); }

bool takeTimeSynced() { return g_timeSynced.exchange(false); }

WifiMgr& wifiMgr() {
  static WifiMgr w;
  return w;
}

bool captivePortalActive() { return g_dnsUp; }

void WifiMgr::begin() {
#if X4_QEMU
  {
    if (!qemu_eth_start()) LOG_ERR("WIFI", "QEMU open_eth failed to start");
    WifiCreds c;
    if (!storage().loadWifi(c) || c.ssid != kQemuSsid) storage().saveWifi({kQemuSsid, ""});   // wired: always "saved"
    g_qemuLinkWanted = true;
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().savedSsid = kQemuSsid;
    hub().networks = {{kQemuSsid, -40, false, true}};
    hub().status.wifi = WifiState::Connecting;
    hub().status.ssid = kQemuSsid;
    hub().markStatus();
    LOG_INF("WIFI", "X4_QEMU: open_eth instead of Wi-Fi (reported as \"%s\")", kQemuSsid);
    return;
  }
#endif
  if (g_wifiRestartsMagic != kRestartsMagic) {
    g_wifiRestartsMagic = kRestartsMagic;
    g_wifiRestarts = 0;
  }
  esc_.setRestartsBefore(g_wifiRestarts);
  WiFi.persistent(false);   // we keep credentials ourselves (encrypted)
  WiFi.setHostname(hostname());
  WiFi.onEvent([](arduino_event_id_t e, arduino_event_info_t info) {
    if (e == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) g_lastReason = info.wifi_sta_disconnected.reason;
    if (e == ARDUINO_EVENT_WIFI_STA_GOT_IP) g_ipEvent = true;   // also a renewed lease (same IP)
    if (e == ARDUINO_EVENT_WIFI_STA_CONNECTED) {
      const uint8_t* b = info.wifi_sta_connected.bssid;
      if (g_haveBssid && memcmp(b, g_bssid, sizeof g_bssid) != 0) g_bssidEvent = true;
      memcpy(g_bssid, b, sizeof g_bssid);
      g_haveBssid = true;
    }
  });
  WifiCreds c;
  const bool have = storage().loadWifi(c);
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().savedSsid = have ? c.ssid : "";
  }
  if (have) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    beginFast(c);
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().status.wifi = WifiState::Connecting;
    hub().status.ssid = c.ssid;
    hub().markStatus();
    LOG_INF("WIFI", "joining saved network \"%s\"", c.ssid.c_str());
  } else {
    startSoftAp(false);
    setWifi(WifiState::NotConfigured);
    scan();
  }
}

void WifiMgr::startSoftAp(bool userRequested) {
#if X4_QEMU
  if (userRequested) setWifi(WifiState::SoftAP);   // no radio: the setup page is reachable over the NIC anyway
  return;
#endif
  if (!hub().softAp) {
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAPConfig(kApIp, kApIp, IPAddress(255, 255, 255, 0));
    WiFi.softAP(kApSsid);   // open network: the page only offers Wi-Fi setup + HA sign-in
    g_dns.setErrorReplyCode(DNSReplyCode::NoError);
    g_dnsUp = g_dns.start(53, "*", kApIp);
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().softAp = true;
    hub().markStatus();
    LOG_INF("WIFI", "SoftAP \"%s\" up · captive portal http://192.168.4.1/setup", kApSsid);
  }
  apStopAtMs_ = 0;
  if (userRequested) setWifi(WifiState::SoftAP);
}

void WifiMgr::stopSoftAp() {
  if (!hub().softAp) return;
#if X4_QEMU
  return;
#endif
  if (g_dnsUp) g_dns.stop();
  g_dnsUp = false;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().softAp = false;
  hub().markStatus();
  LOG_INF("WIFI", "SoftAP off");
}

void WifiMgr::scan() {
#if X4_QEMU
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().networks = {{kQemuSsid, -40, false, !hub().savedSsid.empty()}};
    hub().scanning = false;
    hub().markStatus();
    return;
  }
#endif
  if (scanRunning_) return;
  if (WiFi.getMode() == WIFI_OFF) WiFi.mode(WIFI_STA);
  if (WiFi.scanNetworks(true, false) == WIFI_SCAN_FAILED) return;
  scanRunning_ = true;
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().scanning = true;
}

std::vector<WifiNetwork> WifiMgr::scanNow() {
#if X4_QEMU
  scan();
  std::lock_guard<std::recursive_mutex> lq(hub().mu);
  return hub().networks;
#endif
  if (scanRunning_) {
    WiFi.scanDelete();
    scanRunning_ = false;
  }
  if (WiFi.getMode() == WIFI_OFF) WiFi.mode(WIFI_STA);
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().scanning = true;
  }
  WiFi.scanNetworks(false, false);
  scanRunning_ = true;   // let loop() collect the results synchronously below
  loop();
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  return hub().networks;
}

void WifiMgr::connect(const std::string& ssid, const std::string& password,
                      std::function<void(bool, std::string)> done) {
  if (ssid.empty()) {
    if (done) done(false, "Pick a network");
    return;
  }
  LOG_INF("WIFI", "connecting to \"%s\"", ssid.c_str());
  userDisconnected_ = false;
#if X4_QEMU
  if (ssid == kQemuSsid) {
    storage().saveWifi({ssid, ""});
    g_qemuLinkWanted = true;
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().savedSsid = ssid;
      hub().wifiError.clear();
      hub().wifiJoin = "connected";
      for (auto& n : hub().networks) n.saved = n.ssid == ssid;
    }
    if (g_ethIp) {
      wasConnected_ = true;
      onConnected();
    }
    if (done) done(true, "");
  } else {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().wifiError = "Network not found. Move closer or pick another one.";
    hub().wifiJoin = "failed";
    hub().markStatus();
    if (done) done(false, hub().wifiError);
  }
  return;
#endif
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().status.wifi = WifiState::Connecting;
    hub().status.ssid = ssid;
    hub().wifiError.clear();
    hub().wifiJoin = "connecting";
    hub().markStatus();
  }
  if (scanRunning_) {
    WiFi.scanDelete();
    scanRunning_ = false;
  }
  WiFi.disconnect(false, false);
  delay(100);
  g_lastReason = 0;
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), password.empty() ? nullptr : password.c_str());
  const uint32_t t0 = millis();
  wl_status_t st = WL_IDLE_STATUS;
  while (millis() - t0 < 20000) {
    wdt::feedIfSubscribed();
    st = WiFi.status();
    if (st == WL_CONNECTED) break;
    uint8_t r = g_lastReason;
    if (r == WIFI_REASON_AUTH_FAIL || r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || r == WIFI_REASON_HANDSHAKE_TIMEOUT ||
        r == WIFI_REASON_MIC_FAILURE || r == WIFI_REASON_NO_AP_FOUND)
      break;
    if (g_dnsUp) g_dns.processNextRequest();
    delay(50);
  }
  if (st == WL_CONNECTED) {
    storage().saveWifi({ssid, password});
    {
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().savedSsid = ssid;
      hub().wifiJoin = "connected";
      for (auto& n : hub().networks) n.saved = n.ssid == ssid;
    }
    wasConnected_ = true;
    onConnected();
    if (done) done(true, "");
    return;
  }
  const uint8_t r = g_lastReason;
  std::string err;
  WifiState ws = WifiState::Offline;
  if (r == WIFI_REASON_NO_AP_FOUND) err = "Network not found. Move closer or pick another one.";
  else if (r == WIFI_REASON_AUTH_FAIL || r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || r == WIFI_REASON_HANDSHAKE_TIMEOUT ||
           r == WIFI_REASON_MIC_FAILURE || r == 0) {
    err = "Wrong password. Try again.";
    ws = WifiState::WrongPassword;
  } else {
    err = "Could not connect (reason " + std::to_string(r) + ")";
  }
  LOG_WRN("WIFI", "connect to \"%s\" failed: %s", ssid.c_str(), err.c_str());
  WiFi.disconnect(false, false);
  // fall back to the saved network, if any
  WifiCreds saved;
  const bool haveSaved = storage().loadWifi(saved);
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().wifiError = err;
    hub().wifiJoin = "failed";
    hub().status.wifi = haveSaved ? WifiState::Connecting : ws;
    if (!haveSaved) hub().status.ssid.clear();
    hub().markStatus();
  }
  if (haveSaved) WiFi.begin(saved.ssid.c_str(), saved.password.empty() ? nullptr : saved.password.c_str());
  else setWifi(ws);
  if (done) done(false, err);
}

void WifiMgr::startMdns(const char* reason) {
  g_ipEvent = false;
  g_bssidEvent = false;
#if X4_QEMU
  (void)reason;
  return;   // the mDNS responder only binds the Wi-Fi/ETH default netifs, not "ETH_QEMU" (slirp has no multicast anyway)
#endif
  const uint32_t now = millis();
  switch (mdnsPlan_.next(mdns_, now)) {
    case MdnsStep::Skip:
      LOG_INF("WIFI", "mDNS re-bind skipped (%s, %u ms after the last)", reason, unsigned(now - mdnsPlan_.lastMs));
      return;
    case MdnsStep::Init:
      mdns_ = MDNS.begin(hostname());
      if (mdns_) {
        MDNS.addService("http", "tcp", 80);
        MDNS.addServiceTxt("http", "tcp", "path", "/");
        MDNS.addServiceTxt("http", "tcp", "fw", firmwareVersion());
        LOG_INF("WIFI", "mDNS %s.local + _http._tcp (%s)", hostname(), reason);
      } else {
        LOG_WRN("WIFI", "mDNS start failed (%s)", reason);
      }
      break;
    case MdnsStep::Rebind: {
      esp_netif_t* sta = WiFi.STA.netif();
      const esp_err_t e = sta ? mdns_netif_action(sta, MDNS_EVENT_DISABLE_IP4) : ESP_ERR_INVALID_STATE;
      const esp_err_t e2 = sta ? mdns_netif_action(sta, mdns_event_actions_t(MDNS_EVENT_ENABLE_IP4 | MDNS_EVENT_ANNOUNCE_IP4))
                               : ESP_ERR_INVALID_STATE;
      if (e == ESP_OK && e2 == ESP_OK) LOG_INF("WIFI", "mDNS re-bind %s.local (%s)", hostname(), reason);
      else LOG_WRN("WIFI", "mDNS re-bind failed (%s): %s", reason, esp_err_to_name(e != ESP_OK ? e : e2));
      break;
    }
  }
  mdnsPlan_.lastMs = now;
  mdnsStarted(mdns_, mdnsOnce_ ? reason : nullptr);
  mdnsOnce_ = true;
}

void WifiMgr::stopMdns(const char* why) {
  if (!mdns_) return;
  const uint32_t t0 = millis();
  MDNS.end();   // stops the task, closes the pcbs on the tcpip thread, frees queued rx packets: all before Wi-Fi off
  mdns_ = false;
  mdnsStarted(false, nullptr);
  LOG_INF("WIFI", "mDNS stopped before Wi-Fi off (%s, %u ms)", why, unsigned(millis() - t0));
}

void WifiMgr::onConnected() {
#if X4_QEMU
  const std::string ip = qemuIp(), ssid = kQemuSsid;
#else
  const std::string ip = WiFi.localIP().toString().c_str(), ssid = WiFi.SSID().c_str();
#endif
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().status.wifi = WifiState::Connected;
    hub().status.ssid = ssid;
    hub().status.ip = ip;
    hub().wifiJoin = "connected";
    hub().markStatus();
  }
  LOG_INF("WIFI", "connected · %s · %s", ssid.c_str(), ip.c_str());
  heapMark("Wi-Fi connected");
#if !X4_QEMU
  fastDone(true);   // RTC Wi-Fi cache for the next deep-sleep wake (#10)
#endif
  startMdns("connect");
  sntp_set_time_sync_notification_cb(onTimeSync);
  configTzTime(timezone().c_str(), "pool.ntp.org", "time.cloudflare.com", "time.google.com");
  if (hub().softAp) apStopAtMs_ = millis() + 8000;
  connectedOnce_ = true;
  bool needHa;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    needHa = hub().link.url.empty() && storage().haUrl().empty() && hub().haDiscovered.empty();
  }
  if (needHa) discoverHa();
}

void WifiMgr::discoverHa() {
  if (!mdns_) return;
  int n = MDNS.queryService("home-assistant", "tcp");
  std::vector<std::string> urls;
  for (int i = 0; i < n; i++) {
    std::string url = MDNS.txt(i, "internal_url").c_str();
    if (url.empty()) url = MDNS.txt(i, "base_url").c_str();
    if (url.empty()) url = "http://" + std::string(MDNS.address(i).toString().c_str()) + ":" + std::to_string(MDNS.port(i));
    urls.push_back(url);
  }
  const std::vector<std::string> found = applyDiscovered(urls);
  LOG_INF("WIFI", "mDNS _home-assistant._tcp → %d found%s%s", static_cast<int>(found.size()), found.empty() ? "" : " · ",
          found.empty() ? "" : found[0].c_str());
}

// Offered on the link page (console state, sign-in fallback); saved only once it answers as HA (#54).
std::vector<std::string> WifiMgr::applyDiscovered(const std::vector<std::string>& urls) {
  std::vector<std::string> found;
  for (const auto& u : urls) {
    const std::string url = normalizeBaseUrl(u);
    if (!url.empty() && std::find(found.begin(), found.end(), url) == found.end()) found.push_back(url);
  }
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().haDiscovered = found;
  hub().markStatus();
  return found;
}

void WifiMgr::forget() {
  storage().clearWifi();
#if X4_QEMU
  g_qemuLinkWanted = false;
#else
  stopMdns("forget");
  WiFi.disconnect(true, true);
#endif
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().savedSsid.clear();
    hub().status.ssid.clear();
    hub().status.ip.clear();
  }
  wasConnected_ = false;
  startSoftAp(false);
  setWifi(WifiState::NotConfigured);
}

void WifiMgr::disconnect() {
  userDisconnected_ = true;
#if X4_QEMU
  g_qemuLinkWanted = false;
#else
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false);
#endif
  wasConnected_ = false;
  std::lock_guard<std::recursive_mutex> l(hub().mu);
  hub().status.wifi = WifiState::Offline;
  hub().status.ip.clear();
  hub().wifiJoin = "idle";
  hub().markStatus();
  LOG_WRN("WIFI", "disconnected by the user · \"%s\" stays saved", hub().savedSsid.c_str());
}

#if X4_QEMU
namespace {
// The NIC's link and lease as the driver sees them (#108): `set_link off` drops the lease, `on` must bring both back.
void trackQemuLink() {
  static qemu_eth_link_t was{};
  qemu_eth_link_t e;
  qemu_eth_link(&e);
  g_ethIp = e.ip;
  if (e.link != was.link) {
    if (e.link) LOG_INF("WIFI", "QEMU-ETH link up (#%u) · RX ring realigned from %d", unsigned(e.link_ups), e.rx_skew);
    else LOG_WRN("WIFI", "QEMU-ETH link down (#%u)", unsigned(e.link_downs));
  }
  if (e.ip != was.ip) {
    if (e.ip) LOG_INF("WIFI", "QEMU-ETH lease %s (#%u)", IPAddress(e.ip).toString().c_str(), unsigned(e.leases));
    else LOG_WRN("WIFI", "QEMU-ETH no IP");
  }
  was = e;
}
}  // namespace
#endif

void WifiMgr::loop() {
#if X4_QEMU
  trackQemuLink();
  const bool qup = linkUp();
  checkStale(qup);
  checkInbound(qup);
  if (qup && !wasConnected_) {
    wasConnected_ = true;
    onConnected();
  } else if (!qup && wasConnected_) {
    wasConnected_ = false;
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().status.wifi = hub().savedSsid.empty() ? WifiState::NotConfigured : WifiState::Offline;
    hub().status.ip.clear();
    hub().markStatus();
  }
  return;
#endif
  if (g_dnsUp) g_dns.processNextRequest();
  if (fast_ != glance::WifiFast::None && !linkUp() && millis() - fastAtMs_ > kFastMs) fastDone(false);
  if (apStopAtMs_ && static_cast<int32_t>(millis() - apStopAtMs_) >= 0) {
    apStopAtMs_ = 0;
    if (WiFi.status() == WL_CONNECTED) stopSoftAp();
  }
  if (scanRunning_) {
    int n = WiFi.scanComplete();
    if (n >= 0 || n == WIFI_SCAN_FAILED) {
      std::vector<WifiNetwork> nets;
      std::string saved;
      {
        std::lock_guard<std::recursive_mutex> l(hub().mu);
        saved = hub().savedSsid;
      }
      for (int i = 0; i < n; i++) {
        std::string ssid = WiFi.SSID(i).c_str();
        if (ssid.empty()) continue;   // hidden
        int rssi = WiFi.RSSI(i);
        auto it = std::find_if(nets.begin(), nets.end(), [&](const WifiNetwork& x) { return x.ssid == ssid; });
        if (it != nets.end()) {
          it->rssi = std::max(it->rssi, rssi);
          continue;
        }
        nets.push_back({ssid, rssi, WiFi.encryptionType(i) != WIFI_AUTH_OPEN, ssid == saved});
      }
      std::sort(nets.begin(), nets.end(), [](const WifiNetwork& a, const WifiNetwork& b) { return a.rssi > b.rssi; });
      if (nets.size() > 20) nets.resize(20);
      WiFi.scanDelete();
      scanRunning_ = false;
      std::lock_guard<std::recursive_mutex> l(hub().mu);
      hub().networks = nets;
      hub().scanning = false;
      hub().markStatus();
    }
  }
  const bool up = WiFi.status() == WL_CONNECTED;
  if (up && !wasConnected_) {
    wasConnected_ = true;
    if (g_wifiRestarts) LOG_INF("WIFI", "back online after %u maintenance restart(s)", unsigned(g_wifiRestarts));
    g_wifiRestarts = 0;
    esc_.setRestartsBefore(0);
    onConnected();
  } else if (!up && wasConnected_) {
    wasConnected_ = false;
    LOG_WRN("WIFI", "connection lost (reason %u)", g_lastReason.load());
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    hub().status.wifi = WifiState::Offline;
    hub().status.ip.clear();
    hub().markStatus();
  }
  if (up || userDisconnected_ || hub().savedSsid.empty()) esc_.reset();
  else escalate();
  checkStale(up);
  // #227: the responder can miss a lease renewal (netif re-bound, no re-announce) or a roam to another AP
  if (up && (g_ipEvent || g_bssidEvent)) startMdns(g_bssidEvent ? "bssid" : "got_ip");
  checkInbound(up);
}

void WifiMgr::haReached(bool ok) {
  if (ok) stale_.reached();
  else stale_.failed(millis());
}

void WifiMgr::checkStale(bool up) {
  if (!up) return stale_.linkDown();
  const uint32_t fails = stale_.fails(), windowMin = stale_.waitMs() / 60000;
  if (!stale_.poll(millis())) return;
#if X4_QEMU
  LOG_WRN("WIFI", "link up but HA unreachable (%u failed connects in %u min) · DHCP restart", unsigned(fails), unsigned(windowMin));
  qemu_eth_renew();
#else
  LOG_WRN("WIFI", "link up but HA unreachable (%u failed connects in %u min) · reconnect", unsigned(fails), unsigned(windowMin));
  WiFi.reconnect();
#endif
}

namespace {
// 3 ICMP echoes to the default netif's gateway (~3 s, net task). true when one answers, or when it cannot be asked
// (no gateway, no session): the inbound watch only drops Wi-Fi on a clear "no".
bool gatewayAnswers() {
  esp_netif_t* nif = esp_netif_get_default_netif();
  esp_netif_ip_info_t ip{};
  if (!nif || esp_netif_get_ip_info(nif, &ip) != ESP_OK || ip.gw.addr == 0) return true;
  struct Ctx {
    SemaphoreHandle_t done;
    std::atomic<int> ok{0};
  } ctx;
  ctx.done = xSemaphoreCreateBinary();
  if (!ctx.done) return true;
  esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
  cfg.target_addr.type = IPADDR_TYPE_V4;
  cfg.target_addr.u_addr.ip4.addr = ip.gw.addr;
  cfg.count = 3;
  cfg.interval_ms = 500;
  cfg.timeout_ms = 1000;
  esp_ping_callbacks_t cb{};
  cb.cb_args = &ctx;
  cb.on_ping_success = [](esp_ping_handle_t, void* a) { static_cast<Ctx*>(a)->ok++; };
  cb.on_ping_end = [](esp_ping_handle_t, void* a) { xSemaphoreGive(static_cast<Ctx*>(a)->done); };
  esp_ping_handle_t h = nullptr;
  bool asked = esp_ping_new_session(&cfg, &cb, &h) == ESP_OK && esp_ping_start(h) == ESP_OK;
  bool ended = false;
  for (uint32_t t0 = millis(); asked && !ended && millis() - t0 < 6000;) {
    wdt::feedIfSubscribed();
    ended = xSemaphoreTake(ctx.done, pdMS_TO_TICKS(200)) == pdTRUE;
  }
  if (h) {
    esp_ping_stop(h);
    delay(50);   // the ping task returns from on_ping_end before its session is deleted
    esp_ping_delete_session(h);
  }
  vSemaphoreDelete(ctx.done);
  return !asked || !ended || ctx.ok > 0;
}
}  // namespace

void WifiMgr::checkInbound(bool up) {
  const uint32_t now = millis();
  if (now - sampleMs_ >= 10000 || !sampleMs_) {
    sampleMs_ = now | 1u;
    int dbm = 0;
    const bool known = wifiRssi(dbm);
#if X4_QEMU
    wifiSample(known, dbm, nullptr);
#else
    wifiSample(known, dbm, up ? WiFi.BSSID() : nullptr);
#endif
    if (samples_++ % 6 == 0) netStatsLog();   // once a minute, next to the HEAP line
  }
  if (!up) return inbound_.linkDown();
  inbound_.linkUp(now);
  const uint32_t served = webServed();
  if (served != servedSeen_) {
    servedSeen_ = served;
    inbound_.served(now);
  }
  if (!inbound_.due(now)) return;
  const bool gw = gatewayAnswers();
  const bool relink = inbound_.checked(millis(), gw) == InboundWatch::Action::Reconnect;
  idleChecked(relink);
  if (!relink) {
    LOG_WRN("WIFI", "no web request for %u min · gateway answers · mDNS restart", unsigned(InboundWatch::kIdleMs / 60000));
    return startMdns("idle");
  }
#if X4_QEMU
  LOG_WRN("WIFI", "no web request for %u min · gateway silent · DHCP restart", unsigned(InboundWatch::kIdleMs / 60000));
  qemu_eth_renew();
#else
  LOG_WRN("WIFI", "no web request for %u min · gateway silent · reconnect", unsigned(InboundWatch::kIdleMs / 60000));
  WiFi.reconnect();
#endif
}

// After a deep-sleep timer wake (#10): join with the BSSID/channel from RTC memory (no scan) and, while the lease is
// younger than an hour, the cached IP (no DHCP). Falls back to a normal join after kFastMs (core/glance wifiFast).
void WifiMgr::beginFast(const WifiCreds& c) {
  const char* pw = c.password.empty() ? nullptr : c.password.c_str();
  glance::WifiCache w{};
  if (powerWake() == WakeKind::Timer) powerWifiCache([&](glance::WifiCache& r) { w = r; });
  const time_t t = time(nullptr);   // kept across deep sleep by the RTC timer
  fast_ = powerWake() == WakeKind::Timer ? glance::wifiFast(w, glance::fnv1a(c.ssid), t > 1700000000 ? int64_t(t) : 0) : glance::WifiFast::None;
  if (fast_ == glance::WifiFast::None) {
    WiFi.begin(c.ssid.c_str(), pw);
    return;
  }
  if (fast_ == glance::WifiFast::Ip) WiFi.config(IPAddress(w.ip), IPAddress(w.gw), IPAddress(w.mask), IPAddress(w.dns));
  WiFi.begin(c.ssid.c_str(), pw, w.channel, w.bssid);
  fastAtMs_ = millis();
  LOG_INF("WIFI", "fast join · channel %u · %s", unsigned(w.channel), glance::wifiFastName(fast_));
}

void WifiMgr::fastDone(bool ok) {
  if (fast_ == glance::WifiFast::None && !ok) return;
  const glance::WifiFast was = fast_;
  fast_ = glance::WifiFast::None;
  if (!ok) {
    powerWifiCache([](glance::WifiCache& r) { r.fails++; });
    LOG_WRN("WIFI", "fast join (%s) failed · normal join", glance::wifiFastName(was));
    if (was == glance::WifiFast::Ip) WiFi.config(IPAddress(), IPAddress(), IPAddress());   // 0.0.0.0 = back to DHCP
    WiFi.disconnect(false, false);
    beginSaved();
    return;
  }
  const time_t t = time(nullptr);
  const std::string ssid = WiFi.SSID().c_str();
  const uint8_t* bssid = WiFi.BSSID();
  const uint32_t ip = WiFi.localIP(), gw = WiFi.gatewayIP(), mask = WiFi.subnetMask(), dns = WiFi.dnsIP();
  const uint8_t ch = uint8_t(WiFi.channel());
  powerWifiCache([&](glance::WifiCache& r) {
    const bool sameIp = r.valid && r.ip == ip;
    r.valid = bssid != nullptr && ch >= 1 && ch <= 14;
    r.ssidHash = glance::fnv1a(ssid);
    if (bssid) memcpy(r.bssid, bssid, sizeof r.bssid);
    r.channel = ch;
    r.fails = 0;
    r.ip = ip; r.gw = gw; r.mask = mask; r.dns = dns;
    // the lease age counts from the last DHCP answer; a static (cached) join keeps it
    if (was != glance::WifiFast::Ip || !sameIp) r.ipAtEpoch = t > 1700000000 ? int64_t(t) : 0;
  });
}

void WifiMgr::beginSaved() {
  WifiCreds c;
  if (!storage().loadWifi(c)) return;
  WiFi.begin(c.ssid.c_str(), c.password.empty() ? nullptr : c.password.c_str());
}

void WifiMgr::escalate() {
  const bool mayReset = !hub().softAp && !scanRunning_;   // the radio reset would drop the setup AP / a running scan
  const bool mayRestart = maintenanceRestartAllowed();
  switch (esc_.poll(millis(), mayReset, mayRestart)) {
    case WifiEscalation::Action::Reconnect: {
      WifiState cur;
      {
        std::lock_guard<std::recursive_mutex> l(hub().mu);
        cur = hub().status.wifi;
      }
      // "Connecting" (boot, or a failed join falling back to the saved network) turns "Offline" after 30 s
      if (cur == WifiState::Connecting && esc_.offlineMs() >= 30000) setWifi(WifiState::Offline);
      WiFi.reconnect();
      break;
    }
    case WifiEscalation::Action::Reset:
      // autoReconnect + reconnect() can stay stuck after an AP reboot / DHCP failure; a full radio restart clears it
      LOG_WRN("WIFI", "offline %u min · radio reset (Wi-Fi off → STA → begin)", unsigned(esc_.offlineMs() / 60000));
      stopMdns("radio reset");
      WiFi.mode(WIFI_OFF);
      delay(200);
      WiFi.mode(WIFI_STA);
      WiFi.setAutoReconnect(true);
      beginSaved();
      break;
    case WifiEscalation::Action::Restart: {
      g_wifiRestarts++;
      char why[48];
      snprintf(why, sizeof why, "Wi-Fi offline %u min", unsigned(esc_.offlineMs() / 60000));
      maintenanceRestart(why);
      break;
    }
    default:
      break;
  }
}

}  // namespace x4::net

#if !X4_QEMU
// Linked with -Wl,--wrap=esp_wifi_init (x4pro only, #198). Arduino's WiFiGeneric.cpp sets 32 dynamic RX and 32 dynamic
// TX buffers (~1.7 KB each, internal RAM: no SPIRAM_TRY_ALLOCATE_WIFI_LWIP in the prebuilt libs); a burst next to a
// TLS handshake took the internal heap to 10.9 KB. 12 + 12 cap the transient at ~41 KB instead of ~109 KB. The BA
// window must stay ≤ dynamic RX and ≤ 2 × static RX (4, kept: fixed cost, the minimum Arduino uses). TX 12 → 8
// (#248): the display sends little (pings, reports), and at RSSI -88 the retried frames sat in TX buffers; RX stays 12
// so a weak link doesn't also lose frames to a full RX queue (more retries, more airtime).
extern "C" esp_err_t __real_esp_wifi_init(const wifi_init_config_t* config);
extern "C" esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t* config) {
  wifi_init_config_t c = *config;
  c.dynamic_rx_buf_num = std::min(c.dynamic_rx_buf_num, 12);
  c.dynamic_tx_buf_num = std::min(c.dynamic_tx_buf_num, 8);
  c.rx_ba_win = std::min({c.rx_ba_win, 6, c.dynamic_rx_buf_num, 2 * c.static_rx_buf_num});
  const esp_err_t err = __real_esp_wifi_init(&c);
  LOG_INF("NET", "Wi-Fi buffers: static RX %d · dynamic RX %d · dynamic TX %d · cache TX %d · RX BA window %d (%s)",
          c.static_rx_buf_num, c.dynamic_rx_buf_num, c.dynamic_tx_buf_num, c.cache_tx_buf_num, c.rx_ba_win,
          esp_err_to_name(err));
  return err;
}
#endif
