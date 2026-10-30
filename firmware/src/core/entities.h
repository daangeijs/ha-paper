// Last-known Home Assistant entity values. Writers: HA client (device) / fakes (host). Reader: UI runtime.
#pragma once
#include <string>
#include <map>
#include <cstdint>
#include <utility>
#include "core/psram_alloc.h"

namespace x4 {

// Entity conventions read by the UI (core/home.cpp). The HA client maps real entities onto these ids at link time.
//   sensor.solar_power / home_power / grid_power (+import) / battery_power (+charge)   state = W
//   sensor.energy_today / solar_today / grid_import_today / grid_export_today           state = kWh
//   sensor.living_temperature   state = °C          sensor.home_battery_soc   state = %
//   sensor.energy_prices        attr today = JSON [24 × €/kWh], quarters = JSON [96 × €/kWh] (quarter-hourly source, #151)
//   sensor.energy_usage_hourly  attr today = JSON [24 × kWh];  sensor.solar_hourly attr today = JSON [24 × kWh], forecast = kWh
//                               (no forecast attr = no forecast line, #151)
//   climate.<zone>   attrs friendly_name, current_temperature, temperature, preset_mode ("away"), x4_order (optional)
//   light.<id>       state on|off; attrs friendly_name, area_id, area_name, brightness (0–255), dimmable (true|false), x4_order
//                    (fallbacks: area from meta entity x4.lights {light.<id>: area_id}, name from x4.areas {area_id: name},
//                     dimmable from supported_color_modes)
//   route tile entity (any sensor.*, the widget's `entity`, #145; spec/SCHEMA.md "Route sensors"):
//                    train/bus: attr departures = list or JSON [{"time":"HH:MM","delay":min,"cancelled":bool,"info":text}],
//                    else attr upcoming = [{planned, actual (ISO), delay, track, direction, status}] (NS departures, #275),
//                    per_hour (bus), note (optional);  car: state = travel time min, attr typical = usual min (optional)
//   bins tile sensors (the widget's `entities`, #317; spec/SCHEMA.md "bins"): state = a date or days to; attr daysTo,
//                    upcoming (JSON list of dates)
//   guestWifi password_entity (#329): input_text / text / sensor, state = the guest password (never logged)
// Any entity: attr display_precision (HA's, or the entity registry's via EntityAdapter::setPrecision) → core/logic fmtValue.
// Missing/unknown values render as "—" (never fake numbers).
// HA attributes not named here (plus price/unit keys in entity_map.cpp) are dropped at ingest: core/ha_stream.cpp keepAttr.

// Strings and maps live in PSRAM (core/psram_alloc.h, #76).
struct EntityValue {
  PStr state;
  PMap<PStr> attrs;  // flattened scalars; JSON text for arrays/objects (e.g. 24 h prices)
  int64_t updatedEpoch = 0;
};

class EntityStore {
 public:
  void set(const std::string& id, EntityValue v) { values_[id] = std::move(v); ++revision_; }
  const EntityValue* get(const std::string& id) const {
    auto it = values_.find(id);
    return it == values_.end() ? nullptr : &it->second;
  }
  const PMap<EntityValue>& all() const { return values_; }
  uint32_t revision() const { return revision_; }   // bump = UI should recompute regions
  void clear() { values_.clear(); ++revision_; }
 private:
  PMap<EntityValue> values_;
  uint32_t revision_ = 0;
};

}  // namespace x4
