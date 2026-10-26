// Home Assistant → logical entity ids (core/entities.h). Pure, host-tested (test/test_core, fixtures in
// test/fixtures/ha/). Runs on the net task: HaClient feeds every HA entity / registry answer through it and pushes
// what comes out into the EntityStore, so the UI only ever sees the logical ids.
//
// Where a logical id gets its value, highest priority first:
//   1. Overrides: settings `entities` {"<logical id>": "<HA entity id>"} (PUT /api/v1/settings). A leading "-" flips
//      the sign ("-sensor.inverter_battery_power"). The only way to map sensor.living_temperature (no HA convention).
//      Older settings may still map sensor.x4_route_<id>; route tiles read their own `entity` (#145).
//   2. The Energy dashboard (energy/get_prefs):
//        solar   power ← source.stat_rate (HA ≥ 2025.12 power sensors) or a power sensor on the device of
//                        stat_energy_from (device discovery template); today ← recorder change of stat_energy_from
//        grid    power ← stat_rate | power[].stat_rate | power_config{stat_rate[_inverted] | stat_rate_from − _to}
//                        (or device discovery); import/export today ← flow_from / flow_to statistics;
//                prices ← flow_from[].entity_energy_price (attrs normalised to 24 × €/kWh, see hourlyPrices())
//        battery power ← stat_rate etc. (HA: + = discharging; the UI shows + = charging, so it is negated);
//                soc   ← device_class battery sensor (%) on the battery's device
//        home    power ← solar + grid + battery discharge (when the sources exist); today ← solar + import − export
//                        + battery out − battery in; hourly usage/solar series ← hourly recorder statistics
//   3. Identity: an HA entity that already is called like a logical id (sensor.solar_power …).
// Everything else (climate.*, light.*, scene.*, …) passes through unchanged. Nothing mapped → nothing written → "—".
#pragma once
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "core/entities.h"

namespace x4 {

using EntityUpdates = std::vector<std::pair<std::string, EntityValue>>;

struct EntitySource {
  std::string ha;          // HA entity id
  std::string minus;       // optional second HA entity subtracted (power_config stat_rate_from − stat_rate_to)
  double sign = 1;         // -1: negate
  const char* why = "";    // "override" | "energy" | "device" | "identity" (diagnostics, GET /settings)
};

class EntityAdapter {
 public:
  // ---- configuration ----
  void setOverrides(const std::map<std::string, std::string>& o);
  // HA entities a widget shows directly (stat / gauge / switch `entity`): always passed through, even when they
  // also feed a logical id.
  void setKeep(const std::set<std::string>& ids) { keep_ = ids; }
  const std::map<std::string, std::string>& overrides() const { return overrides_; }
  // energy/get_prefs result (JSON text). Returns true when the set of HA entities to watch changed.
  bool setEnergyPrefs(const std::string& json);
  // render_template answer of deviceDiscoveryTemplate(): {"<stat id>": [["sensor.x","power","W"], …], …}
  bool setDeviceDiscovery(const std::string& json);
  // Jinja template HA renders once: power / battery sensors on the devices of the Energy dashboard meters.
  // "" when the Energy dashboard names no meters.
  std::string deviceDiscoveryTemplate() const;
  // recorder/statistics_during_period (period "hour", types ["change"], from local midnight) result JSON.
  void setHourlyStatistics(const std::string& json, EntityUpdates& out);
  std::vector<std::string> statisticIds() const;   // energy meters to ask the recorder about

  // ---- data ----
  void setNow(int64_t epoch) { now_ = epoch; }       // for "today" in price attributes (0 = unknown)
  // HA entities whose state the adapter needs (subscribe them next to the configured ones).
  std::set<std::string> watchIds() const;
  // One HA entity changed (EntityValue as HA sent it; attributes flattened like HaClient does).
  void ingest(const std::string& haId, const EntityValue& v, EntityUpdates& out);
  // Mapping changed: recompute every logical value from the cached HA states.
  void remapAll(EntityUpdates& out);
  // HA entity registry display_precision (#85, core/ha_stream registryPrecision): added to the entity's values as
  // attribute "display_precision" unless HA sends one itself. Re-emits the entity when its state is known.
  void setPrecision(const std::string& haId, int dp, EntityUpdates& out);
  // Last HA state of every entity seen. HaClient applies subscribe_entities diffs to it (core/ha_stream.h) instead of
  // keeping a second copy, then ingest()s the result.
  PMap<EntityValue>& raw() { return raw_; }

  // logical id → where it comes from (after overrides/energy/identity resolution; identity entries appear once seen)
  std::map<std::string, EntitySource> sources() const;
  static bool isLogicalId(const std::string& id);   // ids the UI reads (entities.h)

 private:
  void resolve();
  bool sourceOf(const std::string& logical, EntitySource& s) const;
  void emitLogical(const std::string& logical, EntityUpdates& out);
  void emitDerived(EntityUpdates& out);
  bool numberOf(const std::string& haId, double& w, bool power) const;   // state → W (power) or kWh
  EntityValue withPrecision(const std::string& haId, const EntityValue& v) const;

  std::map<std::string, std::string> overrides_;
  std::set<std::string> keep_;
  std::map<std::string, EntitySource> energy_;          // logical → source from prefs / device discovery
  std::vector<std::string> solarMeters_, importMeters_, exportMeters_, battOutMeters_, battInMeters_;
  std::string priceEntity_;
  bool hasBattery_ = false, hasSolar_ = false, hasGrid_ = false;
  std::map<std::string, EntitySource> resolved_;
  PMap<EntityValue> raw_;                             // last HA state of every entity seen
  std::set<std::string> statsOwned_;                    // logical ids now fed by recorder statistics
  std::map<std::string, int> precision_;                // HA id → registry display_precision
  int64_t now_ = 0;
};

// Normalise a price entity's attributes to 24 hourly prices in €/kWh for the local day of `nowEpoch`
// (0 = the day of the first entry). Understands:
//   * 24 / 96 numbers in `today` / `prices_today` (Nord Pool HACS `today`; quarter-hours averaged)
//   * lists of objects with a time key (start | startsAt | from | time | start_time | datetime) and a value key
//     (value | total | price | price_ct): Nord Pool `raw_today` [{start,end,value}], Tibber `today`
//     [{total,startsAt}], EnergyZero / Frank Energie `prices` [{from,till,price}], ENTSO-e `prices_today` [{time,price}]
//   * units: unit_of_measurement / unit containing MWh → ÷1000; "ct"/"cent"/price_in_cents=true → ÷100
// Missing hours (DST, partial data) are filled from the previous hour. Empty when nothing usable.
std::vector<double> hourlyPrices(const EntityValue& v, int64_t nowEpoch);
// The same, plus the 96 quarter-hour prices when the source is quarter-hourly (96 numbers, or entries starting at
// :15/:30/:45); `quarters` empty otherwise. The tiles' "now" is the current quarter (#151), the bars stay hourly.
struct PriceSeries { std::vector<double> hourly, quarters; };
PriceSeries priceSeries(const EntityValue& v, int64_t nowEpoch);

// ISO-8601 ("2026-10-13T00:00:00+02:00", "…Z", "… 00:00:00") → epoch seconds; no offset = local time. -1 on error.
int64_t parseIsoTime(const std::string& s);

}  // namespace x4
