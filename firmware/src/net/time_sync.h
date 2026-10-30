// Time zone + NTP sync notification (consumed by main.cpp to write the BM8563 RTC).
#pragma once
#include <string>

namespace x4::net {

// POSIX TZ the clock uses (eink-ha-os#147): the `tz` setting (userdata /tz; before eink-ha-os#147 NVS x4dev/tz, read only) wins, else
// Home Assistant's time_zone (userdata /tz_ha, core/locale.h table), else Europe/Amsterdam.
std::string timezone();
std::string timezoneSetting();   // PUT /api/v1/settings {"tz": …}: "" = follow Home Assistant, a zone name or POSIX
std::string haTimezone();        // HA's time_zone as last applied; "" = not known yet
void setTimezone(const std::string& setting);   // validated by core/settings_api; applies it now
void setHaTimezone(const std::string& ianaZone);   // get_config time_zone; an unknown zone keeps the current one
bool takeTimeSynced();   // true once after each SNTP sync

}  // namespace x4::net
