#include "net/time_sync.h"

#include <Arduino.h>

#include <cstdlib>
#include <ctime>

#include "Logging.h"
#include "core/locale.h"
#include "net/storage.h"

namespace x4::net {

namespace {
std::string gUnknownZone;   // last unknown HA zone, logged once

void applyTz() {
  setenv("TZ", timezone().c_str(), 1);
  tzset();
}
}  // namespace

std::string timezoneSetting() {
  std::string v;
  if (storage().readFile("/tz", v)) return v;
  return storage().getString("x4dev", "tz", "");   // set before eink-ha-os#147: an override
}

std::string haTimezone() {
  std::string v;
  return storage().readFile("/tz_ha", v) ? v : std::string();
}

std::string timezone() {
  std::string p = locale::tzFor(timezoneSetting(), haTimezone());
  return p.empty() ? std::string(locale::kDefaultTz) : p;
}

void setTimezone(const std::string& setting) {
  storage().writeFile("/tz", setting);
  applyTz();
  LOG_INF("TIME", "tz setting \"%s\" → %s", setting.c_str(), timezone().c_str());
}

void setHaTimezone(const std::string& zone) {
  if (zone.empty() || zone == haTimezone()) return;
  if (!locale::ianaToPosix(zone)) {
    if (zone != gUnknownZone) LOG_WRN("TIME", "HA time zone %s unknown · keeping %s", zone.c_str(), timezone().c_str());
    gUnknownZone = zone;
    return;
  }
  storage().writeFile("/tz_ha", zone);
  applyTz();
  LOG_INF("TIME", "HA time zone %s → %s", zone.c_str(), timezone().c_str());
}

}  // namespace x4::net
