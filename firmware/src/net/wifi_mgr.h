// Wi-Fi (net task): STA connect with saved credentials, scan, SoftAP "HA-Paper-Setup" + captive DNS,
// mDNS ha-paper-XXXX.local (+ _http._tcp), Home Assistant discovery via _home-assistant._tcp, NTP.
//
// SoftAP policy: it comes up automatically (AP+STA) when no Wi-Fi is saved, so a phone can always reach
// the setup page at 192.168.4.1; NetStatus.wifi reports SoftAP only after the display asked for it
// (Services::startSoftAp, "Set up from phone"), otherwise NotConfigured. It goes down 8 s after a
// successful connect (so the phone still receives the answer).
#pragma once
#include <functional>
#include <string>
#include <vector>
#include <cstdint>

#include "app/services.h"
#include "core/glance.h"
#include "core/net_policy.h"
#include "net/storage.h"

namespace x4::net {

// "ha-paper-XXXX": XXXX = last two bytes of the Wi-Fi station MAC, lowercase hex (two displays on one network
// no longer both claim ha-paper.local). Same for DHCP hostname and mDNS. Stable for the life of the chip.
const char* hostname();
std::string hostnameLocal();   // hostname() + ".local"
bool wifiRssi(int& dbm);       // station RSSI; false when not on Wi-Fi (QEMU: Ethernet). Net task.
constexpr const char* kApSsid = "HA-Paper-Setup";

class WifiMgr {
 public:
  void begin();          // setup(): load creds, start STA or AP
  void loop();           // net task
  // Blocking connect (net task). done(ok, error) is called with the result.
  void connect(const std::string& ssid, const std::string& password, std::function<void(bool, std::string)> done);
  void scan();           // async scan; results land in Hub::networks
  std::vector<WifiNetwork> scanNow();   // blocking (~1.5 s), net task
  void startSoftAp(bool userRequested);
  void stopSoftAp();
  void discoverHa();     // blocking mDNS browse (~3 s)
  std::vector<std::string> applyDiscovered(const std::vector<std::string>& urls);   // normalized + deduped → Hub
  void forget();         // factory reset / Settings: delete the saved network, back to setup (SoftAP)
  void disconnect();     // Settings › Wi-Fi "Disconnect": drop the link, keep the credentials, no auto-reconnect
  // HA client: a connect / token refresh reached HA or not. With the link up, failures alone for long enough re-make
  // the link (core StaleLink, #108). Net task.
  void haReached(bool ok);

 private:
  void onConnected();
  void startMdns();
  void beginSaved();     // WiFi.begin() with the saved credentials
  void beginFast(const WifiCreds& c);   // boot: deep-sleep wake → cached BSSID/channel (+ IP), else beginSaved
  void fastDone(bool ok);               // connected → refresh the RTC cache; fast join timed out → normal join
  glance::WifiFast fast_ = glance::WifiFast::None;
  uint32_t fastAtMs_ = 0;
  void escalate();       // link down and wanted: core WifiEscalation → reconnect / radio reset / maintenance restart
  bool mdns_ = false;
  bool connectedOnce_ = false;
  uint32_t apStopAtMs_ = 0;
  WifiEscalation esc_;
  StaleLink stale_;
  void checkStale(bool up);   // link up but HA unreachable for long → Wi-Fi reconnect (QEMU: DHCP restart)
  bool wasConnected_ = false;
  bool scanRunning_ = false;
  bool userDisconnected_ = false;   // "Disconnect" pressed: no reconnect until a network is picked
};

WifiMgr& wifiMgr();
bool captivePortalActive();
// Station link up with an IP (Wi-Fi; under X4_QEMU the emulated open_eth NIC, reported as SSID "QEMU-ETH").
bool netConnected();
#if X4_QEMU
constexpr const char* kQemuSsid = "QEMU-ETH";
#endif

}  // namespace x4::net
