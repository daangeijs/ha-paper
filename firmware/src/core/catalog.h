// Static catalog from the emulator (Main.dc.html): widget types, apps, logical entities, settings.
// Validation in parseConfig() uses exactly these sets (WIDGET_TYPES, APP, ENT). Routes are user tiles (#145).
#pragma once
#include <string>
#include <vector>
#include "core/strings.h"

namespace x4 {

struct AppDef { const char* id; const char* title; S desc; };
struct EntityDef { const char* id; S label; };
struct SettingDef { const char* key; S label; };

const std::vector<const char*>& widgetTypes();
const std::vector<AppDef>& apps();
const AppDef* findApp(const std::string& id);
const std::vector<EntityDef>& entities();
const EntityDef* findEntity(const std::string& id);
const std::vector<SettingDef>& settingDefs();
const SettingDef* findSetting(const std::string& key);
bool isWidgetType(const std::string& t);
// Local widgets (stay real when Home Assistant was never linked).
bool isLocalWidget(const std::string& t);
// Text on the "‹Page› needs Home Assistant" card, by screen id.
S noHaText(const std::string& screenId);
// Label shown on a ghost tile for widget w (emulator vm 'ghost').
struct Widget;
std::string ghostLabel(const Widget& w, Lang l = Lang::En);

}  // namespace x4
