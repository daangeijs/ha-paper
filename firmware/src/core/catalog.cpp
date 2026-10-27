#include "core/catalog.h"
#include "core/config.h"
#include <cstring>

namespace x4 {

const std::vector<const char*>& widgetTypes() {
  static const std::vector<const char*> v = {"clock", "stat", "price", "gauge", "bars", "route", "lightList", "switch",
                                             "light", "scene", "zoneList", "thermo", "history", "setting", "ota", "wifi", "ha", "about"};
  return v;
}

const std::vector<AppDef>& apps() {
  static const std::vector<AppDef> v = {
      {"home", "Home", S::appDescHome},
      {"house", "House", S::appDescHouse},
      {"travel", "Travel", S::appDescTravel},
      {"settings", "Settings", S::appDescSettings},
  };
  return v;
}

const AppDef* findApp(const std::string& id) {
  for (auto& a : apps()) if (id == a.id) return &a;
  return nullptr;
}

const std::vector<EntityDef>& entities() {
  static const std::vector<EntityDef> v = {
      {"sensor.solar_power", S::solar},
      {"sensor.home_power", S::homeUse},
      {"sensor.grid_power", S::grid},
      {"sensor.battery_power", S::batteryFlow},
      {"sensor.energy_today", S::usedToday},
      {"sensor.solar_today", S::solarToday},
      {"sensor.grid_import_today", S::imported},
      {"sensor.grid_export_today", S::exported},
      {"sensor.price_min", S::lowest},
      {"sensor.price_max", S::highest},
      {"sensor.price_cheap_window", S::cheapest3h},
      {"sensor.living_temperature", S::inside},
  };
  return v;
}

const EntityDef* findEntity(const std::string& id) {
  for (auto& e : entities()) if (id == e.id) return &e;
  return nullptr;
}

const std::vector<SettingDef>& settingDefs() {
  static const std::vector<SettingDef> v = {
      {"brightness", S::setBrightness}, {"warmth", S::setWarmth}, {"lightTimeout", S::setLightTimeout}, {"returnHome", S::setReturnHome},
      {"standby", S::setStandby}, {"clock", S::setClock}, {"interval", S::setInterval}, {"cleanEvery", S::setCleanEvery},
      {"fullEvery", S::setCleanEvery},   // legacy tile key (#26, #44)
      {"style", S::setStyle}, {"typeface", S::setTypeface}, {"surface", S::setSurface},   // display styles (device setting)
      {"powerSave", S::setPowerSave}, {"wakeEvery", S::setWakeEvery}, {"liveMin", S::setLiveMin},   // glance (#10)
      {"quiet", S::setQuiet},   // quiet hours (#295)
  };
  return v;
}

const SettingDef* findSetting(const std::string& key) {
  for (auto& s : settingDefs()) if (key == s.key) return &s;
  return nullptr;
}

bool isWidgetType(const std::string& t) {
  for (auto* w : widgetTypes()) if (t == w) return true;
  return false;
}

bool isLocalWidget(const std::string& t) {
  static const char* L[] = {"clock", "setting", "ota", "wifi", "ha", "about", "info", "setupWeb"};
  for (auto* l : L) if (t == l) return true;
  return false;
}

S noHaText(const std::string& id) {
  if (id == "prices") return S::noHaPrices;
  if (id == "energy") return S::noHaEnergy;
  if (id == "solar") return S::noHaSolar;
  if (id == "lights") return S::noHaLights;
  if (id == "climate") return S::noHaClimate;
  if (id == "travel") return S::noHaTravel;
  return S::noHaOther;
}

std::string ghostLabel(const Widget& w, Lang l) {
  auto f = [&](const char* k) { auto it = w.fields.find(k); return it == w.fields.end() ? std::string() : it->second; };
  if (!f("label").empty()) return f("label");
  if (w.type == "stat") { if (auto* e = findEntity(f("entity"))) return tr(l, e->label); return f("entity"); }
  if (w.type == "switch" || (w.type == "scene" && !f("entity").empty())) return f("entity");
  if (w.type == "route") return f("entity").empty() ? tr(l, S::palRoute) : f("entity");
  if (w.type == "gauge" && !f("entity").empty() && f("entity") != kGaugeDefaultEntity) return f("entity");
  static const struct { const char* type; S label; } M[] = {{"price", S::priceNow}, {"gauge", S::homeBattery}, {"bars", S::todayPerHour},
                                                         {"zoneList", S::rooms}, {"lightList", S::lights}, {"thermo", S::room}, {"scene", S::scene}};
  for (auto& m : M) if (w.type == m.type) return tr(l, m.label);
  return tr(l, S::data);
}

}  // namespace x4
