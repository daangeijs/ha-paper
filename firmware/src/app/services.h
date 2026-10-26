// What the on-device app needs from networking/OTA/storage. Implemented by src/net (device) and fakes (host tests).
#pragma once
#include <string>
#include <vector>
#include <functional>
#include <cstdint>

namespace x4 {

struct WifiNetwork { std::string ssid; int rssi; bool secure; bool saved; };

enum class WifiState { NotConfigured, Connecting, Connected, WrongPassword, Offline, SoftAP };
enum class HaState { NeverLinked, Linking, Connected, Offline, KeyRevoked };
enum class OtaState { UpToDate, Available, Downloading, Installing, Failed };

struct NetStatus {
  WifiState wifi = WifiState::NotConfigured;
  std::string ssid, ip;
  // mDNS name, "ha-paper-XXXX.local" (last 4 hex of the Wi-Fi MAC; net/wifi_mgr.h hostname()). The device sets it at
  // boot; this placeholder is what host renders and tests show.
  std::string hostname = "ha-paper-a1b2.local";
  HaState ha = HaState::NeverLinked;
  std::string haUrl;
  int64_t haLastDataEpoch = 0;
  OtaState ota = OtaState::UpToDate;
  std::string otaAvailableVersion;
  int otaProgressPct = 0;
  std::vector<std::string> otaNotes;
  bool otaChecksOff = false;   // build has no release repo (X4_OTA_REPO placeholder): no checks, local upload only
  std::string pairingCode;   // shown on display while not linked (4 chars, 10 min)
  std::string language;      // HA get_config `language` as "en" | "nl" (#98, core/strings.h); "" = not known yet (English)
  std::string currency;      // HA get_config `currency` (ISO 4217, #147); "" = not known yet (€)
  std::string numberFormat;  // HA profile number_format (#110, core numFormatOf); "" = unset/unknown: the language decides
};

class Services {
 public:
  virtual ~Services() = default;
  virtual const NetStatus& status() = 0;
  // Wi-Fi (display setup step 1)
  virtual void wifiScan() = 0;
  virtual std::vector<WifiNetwork> wifiNetworks() = 0;
  virtual void wifiConnect(const std::string& ssid, const std::string& password) = 0;
  virtual void startSoftAp() = 0;
  // Settings › Wi-Fi: drop the current network (credentials stay saved; no auto-reconnect until a network is picked).
  virtual void wifiDisconnect() = 0;
  // Delete the saved credentials of ssid ("" = the saved network). Disconnects when it is the current one.
  virtual void wifiForget(const std::string& ssid) = 0;
  // Settings › Home Assistant: reconnect the WebSocket now (resets the backoff, refreshes the access token).
  virtual void haReconnect() = 0;
  // Settings › Home Assistant: revoke the key at HA (best effort), delete it from the display, end console sessions.
  virtual void haUnlink() = 0;
  // Home Assistant service calls (fire-and-forget; ack arrives as entity state change)
  virtual void callService(const std::string& domain, const std::string& service, const std::string& jsonData) = 0;
  // OTA
  virtual void otaCheck() = 0;
  virtual void otaInstall() = 0;
  // Device
  virtual void factoryReset() = 0;
};

}  // namespace x4
