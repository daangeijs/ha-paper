// Device implementation of x4::Services (app/services.h) + the net task + main-loop pump.
#pragma once
#include <functional>
#include <set>
#include <string>
#include <utility>

#include "app/app.h"
#include "app/services.h"
#include "core/config.h"
#include "hw/platform.h"

namespace x4::net {

class DeviceServices : public Services {
 public:
  // setup(): storage, tokens, HA link, config + settings from flash, Wi-Fi, web server, OTA, net task.
  void begin();
  const Config& bootConfig() const { return bootConfig_; }
  const DisplaySettings& bootSettings() const { return bootSettings_; }
  void saveDeviceSettings(const DisplaySettings& s);   // App::onSettingsChanged

  // Main loop: publishes NetStatus, entity updates, config/settings changes into the App.
  void pump(App& app, Board& board);
  // Optional hook for POST /display/refresh (main.cpp → X4Display::fullRefresh(last frame)).
  void onForceRefresh(std::function<void()> fn) { forceRefresh_ = std::move(fn); }

  // Services
  const NetStatus& status() override { return published_; }
  void wifiScan() override;
  std::vector<WifiNetwork> wifiNetworks() override;
  void wifiConnect(const std::string& ssid, const std::string& password) override;
  void startSoftAp() override;
  void wifiDisconnect() override;
  void wifiForget(const std::string& ssid) override;
  void haReconnect() override;
  void haUnlink() override;
  void callService(const std::string& domain, const std::string& service, const std::string& jsonData) override;
  void otaCheck() override;
  void otaInstall() override;
  void factoryReset() override;

  // Used by the web server (any task).
  static std::set<std::string> entityIdsOf(const Config& c);
  static void applyConfig(const Config& c);   // persist + hand to App on next pump + resubscribe HA
  static void unlinkHa();                      // revoke key at HA (best effort) + forget it
  static void doFactoryReset();                // net task

 private:
  static void netTask(void*);
  void historyTiles(App& app, bool configChanged);   // eink-ha-os#269
  void agendaTiles(App& app);                          // eink-ha-os#316: the config's calendar sets, when it changes
  Config bootConfig_;
  DisplaySettings bootSettings_;
  NetStatus published_;
  std::function<void()> forceRefresh_;
  uint32_t lastPowerMs_ = 0, lastPairCheckMs_ = 0;
  uint32_t lastValuesMs_ = 0;   // last GET /screens/{id}/values formatting (eink-ha-os#122)
  uint32_t lastFulls_ = 0;   // App full refresh count seen by pump() (net/ha_report "last full refresh")
  std::string histApp_;      // app whose history tiles are fetched (eink-ha-os#269)
  bool histPosted_ = false;
  std::string agendaKeys_ = "-";   // calendar sets last posted (eink-ha-os#316)
};

DeviceServices& deviceServices();

}  // namespace x4::net
