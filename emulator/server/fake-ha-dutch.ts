// The fake HA's "Dutch house" (eink-ha-os#82), shaped like the first real HA the display met (2026-10-16, ~800 entities):
// a SolarEdge inverter, a HomeWizard P1 meter, an Anker Solix battery (SOC %, and a kWh capacity that is not a
// charge), tado zones, a Buienradar temperature, Dutch friendly names, plus the sensors that look alike: phone and
// Zigbee batteries, P1 per-phase power, Wi-Fi strength and tado heating in %, a NAS, plugs. No logical ids
// (sensor.solar_power …) exist here. Two variants: 'dutch' (Energy dashboard not set up: energy/get_prefs fails like
// HA's "No prefs") and 'dutch-energy' (Energy dashboard with meters only, no power sensors: HA < 2025.12).
// `npm run fake-ha -- --house dutch`, `npm run device-sim -- --house dutch-energy`.

type Raw = { id: string; state: string; attrs: Record<string, unknown>; area?: string };

export const DUTCH_AREAS: [string, string][] = [['woonkamer', 'Woonkamer'], ['keuken', 'Keuken'], ['slaapkamer', 'Slaapkamer'], ['badkamer', 'Badkamer'], ['zolder', 'Zolder'], ['meterkast', 'Meterkast'], ['tuin', 'Tuin']];

const W = (name: string) => ({ friendly_name: name, unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' });
const kWh = (name: string, sc = 'total_increasing') => ({ friendly_name: name, unit_of_measurement: 'kWh', device_class: 'energy', state_class: sc });
const C = (name: string) => ({ friendly_name: name, unit_of_measurement: '°C', device_class: 'temperature', state_class: 'measurement' });
const pct = (name: string, dc?: string) => ({ friendly_name: name, unit_of_measurement: '%', ...(dc ? { device_class: dc } : {}) });

export const DUTCH_ENTITIES: Raw[] = [
  // Anker Solix (home battery): SOC in %, capacity in kWh (the gauge got this one before eink-ha-os#82)
  { id: 'sensor.anker_solix_battery_capacity', state: '1.6', attrs: { friendly_name: 'Batterijcapaciteit', unit_of_measurement: 'kWh', device_class: 'energy_storage' }, area: 'meterkast' },
  { id: 'sensor.anker_solix_battery_power', state: '-220', attrs: W('Batterijvermogen'), area: 'meterkast' },
  { id: 'sensor.anker_solix_charged_energy', state: '412.8', attrs: kWh('Batterij geladen'), area: 'meterkast' },
  { id: 'sensor.anker_solix_discharged_energy', state: '377.1', attrs: kWh('Batterij ontladen'), area: 'meterkast' },
  { id: 'sensor.anker_solix_home_load', state: '630', attrs: W('Huisverbruik'), area: 'meterkast' },
  { id: 'sensor.anker_solix_soc', state: '64', attrs: pct('Batterij laadniveau', 'battery'), area: 'meterkast' },
  { id: 'sensor.anker_solix_solar_power', state: '0', attrs: W('Anker zonne-energie'), area: 'meterkast' },
  // tado zones
  { id: 'climate.badkamer', state: 'heat', attrs: { friendly_name: 'Badkamer', current_temperature: 21.5, temperature: 22, hvac_modes: ['off', 'heat', 'auto'], preset_mode: 'home', preset_modes: ['home', 'away'] }, area: 'badkamer' },
  { id: 'climate.slaapkamer', state: 'auto', attrs: { friendly_name: 'Slaapkamer', current_temperature: 18.2, temperature: 17, hvac_modes: ['off', 'heat', 'auto'], preset_mode: 'home', preset_modes: ['home', 'away'] }, area: 'slaapkamer' },
  { id: 'climate.woonkamer', state: 'heat', attrs: { friendly_name: 'Woonkamer', current_temperature: 20.8, temperature: 21, hvac_modes: ['off', 'heat', 'auto'], preset_mode: 'home', preset_modes: ['home', 'away'] }, area: 'woonkamer' },
  { id: 'sensor.badkamer_temperature', state: '21.5', attrs: C('Badkamer Temperatuur'), area: 'badkamer' },
  { id: 'sensor.slaapkamer_temperature', state: '18.2', attrs: C('Slaapkamer Temperatuur'), area: 'slaapkamer' },
  { id: 'sensor.woonkamer_temperature', state: '20.8', attrs: C('Woonkamer Temperatuur'), area: 'woonkamer' },
  { id: 'sensor.woonkamer_humidity', state: '52', attrs: pct('Woonkamer Luchtvochtigheid', 'humidity'), area: 'woonkamer' },
  { id: 'sensor.woonkamer_heating', state: '34', attrs: pct('Woonkamer Verwarming'), area: 'woonkamer' },
  // Zigbee
  { id: 'sensor.keuken_temperatuur', state: '19.9', attrs: C('Keuken temperatuur'), area: 'keuken' },
  { id: 'sensor.beweging_gang_battery', state: '90', attrs: pct('Bewegingssensor gang batterij', 'battery') },
  // weather
  { id: 'sensor.buienradar_temperature', state: '11.3', attrs: C('Buienradar Temperatuur') },
  { id: 'weather.forecast_thuis', state: 'cloudy', attrs: { friendly_name: 'Forecast Thuis', temperature: 11.0, temperature_unit: '°C' } },
  // phones
  { id: 'sensor.ipad_battery_level', state: '47', attrs: pct('iPad Battery Level', 'battery') },
  { id: 'sensor.pixel_8_battery_level', state: '81', attrs: pct('Pixel 8 Batterijniveau', 'battery') },
  // NAS, plugs
  { id: 'sensor.nas_cpu_temperature', state: '47', attrs: C('NAS CPU temperatuur'), area: 'meterkast' },
  { id: 'sensor.vaatwasser_power', state: '0', attrs: W('Vaatwasser vermogen'), area: 'keuken' },
  { id: 'sensor.wasmachine_power', state: '2', attrs: W('Wasmachine vermogen'), area: 'zolder' },
  // HomeWizard P1 meter: net power (+ = import), per phase, lifetime import / export
  { id: 'sensor.p1_meter_energy_export', state: '9120.7', attrs: kWh('P1 energie export'), area: 'meterkast' },
  { id: 'sensor.p1_meter_energy_import', state: '23450.2', attrs: kWh('P1 energie import'), area: 'meterkast' },
  { id: 'sensor.p1_meter_power', state: '-850', attrs: W('P1 vermogen'), area: 'meterkast' },
  { id: 'sensor.p1_meter_power_phase_1', state: '-850', attrs: W('P1 vermogen fase 1'), area: 'meterkast' },
  { id: 'sensor.p1_meter_tariff', state: '2', attrs: { friendly_name: 'P1 tarief' }, area: 'meterkast' },
  { id: 'sensor.p1_meter_wifi_strength', state: '78', attrs: pct('P1 wifi-sterkte'), area: 'meterkast' },
  // SolarEdge inverter
  { id: 'sensor.solaredge_i1_ac_energy_kwh', state: '18342.1', attrs: kWh('Zon totaal'), area: 'zolder' },
  { id: 'sensor.solaredge_i1_ac_power', state: '1840', attrs: W('Zonproductie'), area: 'zolder' },
  { id: 'sensor.solaredge_i1_dc_power', state: '1910', attrs: W('SolarEdge DC vermogen'), area: 'zolder' },
  { id: 'sensor.solaredge_i1_temperature', state: '41', attrs: C('SolarEdge temperatuur') },
  { id: 'sensor.solaredge_i1_zon_vandaag', state: '6.4', attrs: kWh('Zon vandaag', 'total') },
  // lights, clutter
  { id: 'light.keuken_spots', state: 'off', attrs: { friendly_name: 'Keuken spots', supported_color_modes: ['onoff'] }, area: 'keuken' },
  { id: 'light.tuin', state: 'off', attrs: { friendly_name: 'Tuin', supported_color_modes: ['onoff'] }, area: 'tuin' },
  { id: 'light.woonkamer_plafond', state: 'on', attrs: { friendly_name: 'Woonkamer plafond', brightness: 150, supported_color_modes: ['brightness'] }, area: 'woonkamer' },
  { id: 'sensor.uptime', state: '2026-10-12T06:01:22+00:00', attrs: { friendly_name: 'Uptime', device_class: 'timestamp' } },
  { id: 'sensor.wasmachine_status', state: 'unavailable', attrs: { friendly_name: 'Wasmachine status' } },
];

/** 'dutch-energy': HA's Energy dashboard with the meters (no stat_rate: power sensors are found by device name). */
export const DUTCH_PREFS = {
  energy_sources: [
    { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.p1_meter_energy_import', stat_cost: null, entity_energy_price: null, number_energy_price: null }],
      flow_to: [{ stat_energy_to: 'sensor.p1_meter_energy_export', stat_compensation: null, entity_energy_price: null, number_energy_price: null }], cost_adjustment_day: 0 },
    { type: 'solar', stat_energy_from: 'sensor.solaredge_i1_ac_energy_kwh', config_entry_solar_forecast: null },
    { type: 'battery', stat_energy_from: 'sensor.anker_solix_discharged_energy', stat_energy_to: 'sensor.anker_solix_charged_energy' },
  ],
  device_consumption: [],
};
