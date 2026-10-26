// The fake HA's "stranger house" (#23): somebody else's Home Assistant, nothing like the demo data.
// A flat with a P1 meter on the Energy dashboard (grid only, HA ≥ 2025.12 power sensor, no prices, no solar),
// one Nest thermostat, four lights (one without an area), room thermometers, a NAS and a phone that also report
// a temperature, a weather station outside and a weather entity, plus the usual clutter of a real install (#58):
// entities without device_class / unit / area, unavailable and text states. No sensor.x4_route_*, no logical ids.
// `npm run fake-ha -- --house stranger`, `npm run device-sim -- --house stranger`.

type Raw = { id: string; state: string; attrs: Record<string, unknown>; area?: string };

export const STRANGER_AREAS: [string, string][] = [['lounge', 'Lounge'], ['kitchen', 'Kitchen'], ['bedroom', 'Bedroom'], ['office', 'Office: upstairs'], ['hallway', 'Hallway']];

export const STRANGER_ENTITIES: Raw[] = [
  { id: 'sensor.p1_meter_power', state: '412', attrs: { friendly_name: 'P1 meter power', unit_of_measurement: 'W', device_class: 'power' } },
  { id: 'sensor.p1_meter_energy_import', state: '5321.4', attrs: { friendly_name: 'P1 meter energy import', unit_of_measurement: 'kWh', device_class: 'energy' } },
  { id: 'sensor.lounge_temperature', state: '21.3', attrs: { friendly_name: 'Lounge temperature', unit_of_measurement: '°C', device_class: 'temperature' }, area: 'lounge' },
  { id: 'sensor.kitchen_thermometer_temperature', state: '20.6', attrs: { friendly_name: 'Kitchen thermometer', unit_of_measurement: '°C', device_class: 'temperature' }, area: 'kitchen' },
  { id: 'sensor.bedroom_temperature', state: '18.9', attrs: { friendly_name: 'Bedroom temperature', unit_of_measurement: '°C', device_class: 'temperature' }, area: 'bedroom' },
  { id: 'sensor.bedroom_humidity', state: '54', attrs: { friendly_name: 'Bedroom humidity', unit_of_measurement: '%', device_class: 'humidity' }, area: 'bedroom' },
  { id: 'sensor.office_temperature', state: '19.8', attrs: { friendly_name: 'Office temperature', unit_of_measurement: '°C', device_class: 'temperature' }, area: 'office' },
  { id: 'sensor.nas_temperature', state: '41', attrs: { friendly_name: 'NAS temperature', unit_of_measurement: '°C', device_class: 'temperature' }, area: 'office' },
  { id: 'sensor.pixel_battery_temperature', state: '29.5', attrs: { friendly_name: 'Pixel battery temperature', unit_of_measurement: '°C', device_class: 'temperature' } },
  { id: 'sensor.garden_station_outside_temperature', state: '8.2', attrs: { friendly_name: 'Garden station outside temperature', unit_of_measurement: '°C', device_class: 'temperature' } },
  { id: 'weather.forecast_home', state: 'rainy', attrs: { friendly_name: 'Forecast Home', temperature: 8.5, temperature_unit: '°C' } },
  { id: 'climate.thermostat', state: 'heat', attrs: { friendly_name: 'Thermostat', current_temperature: 21.0, temperature: 21.5, hvac_modes: ['off', 'heat'], preset_mode: 'none' }, area: 'lounge' },
  { id: 'light.lounge_lamp', state: 'on', attrs: { friendly_name: 'Lounge lamp', brightness: 180, supported_color_modes: ['brightness'] }, area: 'lounge' },
  { id: 'light.kitchen_ceiling', state: 'off', attrs: { friendly_name: 'Kitchen ceiling', supported_color_modes: ['onoff'] }, area: 'kitchen' },
  { id: 'light.bedside', state: 'off', attrs: { friendly_name: 'Bedside', brightness: null, supported_color_modes: ['brightness'] }, area: 'bedroom' },
  { id: 'light.porch', state: 'off', attrs: { friendly_name: 'Porch', supported_color_modes: ['onoff'] } },
  { id: 'switch.kettle', state: 'off', attrs: { friendly_name: 'Kettle' } },
  // What a real HA also has (#58): sensors without device_class / unit / area / even a friendly_name, unavailable
  // and unknown states, text and timestamp values. None of them may break the seed template or become a tile.
  { id: 'sensor.uptime', state: '2026-10-12T06:01:22+00:00', attrs: { friendly_name: 'Uptime', device_class: 'timestamp' } },
  { id: 'sensor.washing_machine_status', state: 'unavailable', attrs: { friendly_name: 'Washing machine status' } },
  { id: 'sensor.p1_meter_tariff', state: 'normal', attrs: { friendly_name: 'P1 meter tariff' } },
  { id: 'sensor.hacs', state: 'unknown', attrs: {} },
  { id: 'sensor.zigbee_hallway_temperature', state: 'unavailable', attrs: { friendly_name: 'Hallway temperature', unit_of_measurement: '°C', device_class: 'temperature' }, area: 'hallway' },
  { id: 'sensor.attic_temperature', state: 'unknown', attrs: { device_class: 'temperature' } },
  { id: 'sensor.sun_next_dawn', state: '2026-10-17T05:42:11+00:00', attrs: { friendly_name: 'Sun Next dawn', device_class: 'timestamp' } },
  { id: 'light.hue_go', state: 'unavailable', attrs: { friendly_name: 'Hue Go', supported_color_modes: ['xy'] } },
];

/** get_config `time_zone` and `currency` (#147). */
export const STRANGER_CONFIG = { time_zone: 'Europe/London', currency: 'GBP' };

export const STRANGER_PREFS = {
  energy_sources: [
    { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.p1_meter_energy_import', entity_energy_price: null }], flow_to: [], stat_rate: 'sensor.p1_meter_power', cost_adjustment_day: 0 },
  ],
  device_consumption: [],
};
