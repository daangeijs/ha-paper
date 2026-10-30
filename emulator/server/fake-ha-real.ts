// The fake HA's large example house (house id `real`, eink-ha-os#88): an invented household shaped like a real Home Assistant after a few
// years of use (~1100 entities, > 800 of them in the entity picker's domains). Hue (bridge + room groups), Zigbee2MQTT
// (sensors, plugs, bulbs, buttons, each with config entities), ESPHome (one node offline), Shelly, tado, Netatmo,
// DSMR P1 (kW, gas), Enphase (microinverters), a car, two phone companion apps, Nord Pool prices, Sonos, updates,
// automations. Areas come from devices: most entities have no area of their own (HA's entity registry area_id is
// null, area_id() in a template resolves the device's), a few override it, some have none. Renamed areas (id ≠ name),
// emoji / percent / quotes / ampersands in names, unavailable and unknown states, long attribute sets,
// display_precision in the entity registry, an Energy dashboard with grid, gas, solar (stat_rate) and devices.
// No real people, addresses, serials or tokens. `npm run fake-ha -- --house real`; QEMU: FAKE_HA_HOUSE=real.

export type RealDevice = { id: string; name: string; area: string | null; manufacturer: string; model: string };
/** `area`: the entity registry's own area (overrides the device's); `dp`: registry display_precision. */
export type RealEntity = { id: string; state: string; attrs: Record<string, unknown>; device?: string; area?: string; dp?: number };

export const REAL_AREAS: [string, string][] = [
  ['living_room', 'Living room'], ['kitchen', 'Kitchen'], ['hallway', 'Hallway'], ['toilet', 'Toilet'], ['bedroom', 'Bedroom'],
  ['kids_room', 'Playroom & Study'], ['guest_room', 'Guest room'], ['bathroom', 'Bathroom'], ['office', 'Office 🖥️'],
  ['attic', 'Attic'], ['utility', 'Meter cupboard'], ['garage', 'Garage'], ['garden', 'Garden 🌷'], ['driveway', 'Driveway'],
  ['basement', 'Basement'], ['bike_shed', 'Bike shed (empty)'],
];

export const REAL_DEVICES: RealDevice[] = [];
export const REAL_ENTITIES: RealEntity[] = [];

const dev = (id: string, name: string, area: string | null, manufacturer: string, model: string) => { REAL_DEVICES.push({ id, name, area, manufacturer, model }); return id; };
const taken = new Set<string>();
/** A second entity with the same object id gets `_2`, like HA. */
const ent = (id: string, state: string, attrs: Record<string, unknown>, o: Omit<RealEntity, 'id' | 'state' | 'attrs'> = {}) => {
  let u = id; for (let n = 2; taken.has(u); n++) u = id + '_' + n;
  taken.add(u); REAL_ENTITIES.push({ id: u, state, attrs, ...o });
};
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const hex = (n: number, w = 4) => n.toString(16).padStart(w, '0');

const meas = (name: string, unit: string, dc?: string) => ({ state_class: 'measurement', unit_of_measurement: unit, ...(dc ? { device_class: dc } : {}), friendly_name: name });
const T = (name: string) => meas(name, '°C', 'temperature');
const H = (name: string) => meas(name, '%', 'humidity');
const BAT = (name: string) => meas(name, '%', 'battery');
const W = (name: string) => meas(name, 'W', 'power');
const KWH = (name: string, sc = 'total_increasing') => ({ state_class: sc, unit_of_measurement: 'kWh', device_class: 'energy', friendly_name: name });
const LQI = (name: string) => ({ state_class: 'measurement', unit_of_measurement: 'lqi', icon: 'mdi:signal', friendly_name: name });
const RSSI = (name: string) => meas(name, 'dBm', 'signal_strength');
const TS = (name: string) => ({ device_class: 'timestamp', friendly_name: name });

// ---------------------------------------------------------------- Philips Hue
const HUE_EFFECTS = ['None', 'candle', 'fire', 'prism', 'sparkle', 'opal', 'glisten', 'underwater', 'cosmos', 'sunbeam', 'enchant'];
const hueBridge = dev('hue_bridge', 'Hue Bridge', 'utility', 'Signify Netherlands B.V.', 'BSB002');
function hueLight(id: string, name: string, area: string | null, on: boolean, color: boolean, b = 180, state?: string) {
  const d = dev('hue_' + id, name, area, 'Signify Netherlands B.V.', color ? 'Hue color lamp (LCA001)' : 'Hue white ambiance (LTA001)');
  const modes = color ? ['color_temp', 'xy'] : ['color_temp'];
  const base = { min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6535, min_mireds: 153, max_mireds: 500, effect_list: HUE_EFFECTS, supported_color_modes: modes, mode: 'normal', dynamics: 'none', friendly_name: name, supported_features: 44 };
  if (state) { ent('light.' + id, state, { supported_color_modes: modes, friendly_name: name, supported_features: 44, restored: true }, { device: d }); return; }
  ent('light.' + id, on ? 'on' : 'off', on
    ? { ...base, effect: 'None', color_mode: 'color_temp', brightness: b, color_temp_kelvin: 2732, color_temp: 366, hs_color: [28.327, 64.71], rgb_color: [255, 167, 89], xy_color: [0.524, 0.387] }
    : { ...base, effect: null, color_mode: null, brightness: null, color_temp_kelvin: null, color_temp: null, hs_color: null, rgb_color: null, xy_color: null }, { device: d });
}
hueLight('living_room_ceiling', 'Living room ceiling', 'living_room', true, false, 203);
hueLight('living_room_floor_lamp', 'Floor lamp', 'living_room', true, true, 120);
hueLight('living_room_reading_lamp', 'Reading lamp 📖', 'living_room', false, false);
hueLight('tv_lightstrip', 'TV lightstrip', 'living_room', true, true, 64);
hueLight('kitchen_spot_1', 'Kitchen spot 1', 'kitchen', true, false, 254);
hueLight('kitchen_spot_2', 'Kitchen spot 2', 'kitchen', true, false, 254);
hueLight('kitchen_spot_3', 'Kitchen spot 3', 'kitchen', false, false, 0, 'unavailable');
hueLight('dining_table', 'Dining table', 'kitchen', false, true);
hueLight('hallway', 'Hallway', 'hallway', false, false);
hueLight('toilet', 'Toilet', 'toilet', false, false);
hueLight('bedroom_ceiling', 'Bedroom ceiling', 'bedroom', false, false);
hueLight('bedside_lamp_left', 'Bedside lamp left', 'bedroom', false, true);
hueLight('bedside_lamp_right', 'Bedside lamp right', 'bedroom', false, true);
hueLight('playroom', 'Playroom "starry sky"', 'kids_room', true, true, 25);
hueLight('bathroom_mirror', 'Bathroom mirror', 'bathroom', false, false);
hueLight('office_desk', 'Desk lamp', 'office', true, false, 230);
hueLight('hue_color_lamp_3', 'Hue color lamp 3', null, false, true);   // never renamed, no area
hueLight('garden_wall_lamp', 'Garden wall lamp', 'garden', false, false);
hueLight('driveway_spot', 'Driveway spot', 'driveway', false, false);
// room groups: entities of the bridge (utility), each with its own area
for (const [id, name, area, on] of [['living_room', 'Living room', 'living_room', true], ['kitchen', 'Kitchen', 'kitchen', true], ['bedroom', 'Bedroom', 'bedroom', false], ['outdoor', 'Outdoor', 'garden', false]] as const)
  ent('light.' + id, on ? 'on' : 'off', { min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6535, supported_color_modes: ['color_temp', 'xy'], color_mode: on ? 'color_temp' : null, brightness: on ? 190 : null, is_hue_group: true, hue_scenes: ['Bright', 'Dimmed', 'Read', 'Nightlight', 'Energize', 'Relax', 'Concentrate', 'Savanna sunset'], hue_type: 'room', lights: ['Living room ceiling', 'Floor lamp', 'Reading lamp 📖'], dynamics: false, friendly_name: name + ' (group)', supported_features: 44 }, { device: hueBridge, area });
// eink-ha-os#152: an HA light group of the same room (a second integration's duplicate of the Hue room group)
ent('light.living_room_lamps', 'on', { min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6535, supported_color_modes: ['color_temp'], color_mode: 'color_temp', brightness: 160, entity_id: ['light.living_room_ceiling', 'light.living_room_floor_lamp', 'light.living_room_reading_lamp'], icon: 'mdi:lightbulb-group', friendly_name: 'Living room lamps', supported_features: 40 }, { area: 'living_room' });
for (const [room, area, motion, lux, temp] of [['hallway', 'hallway', 'off', '3', '18.71'], ['toilet', 'toilet', 'off', '0', '17.2'], ['landing', 'attic', 'on', '41', '19.43'], ['garage', 'garage', 'off', 'unavailable', 'unavailable']] as const) {
  const d = dev('hue_motion_' + room, 'Motion sensor ' + room, area, 'Signify Netherlands B.V.', 'Hue motion sensor (SML001)');
  ent('binary_sensor.' + room + '_motion', motion, { device_class: 'motion', friendly_name: 'Motion sensor ' + room + ' Motion' }, { device: d });
  ent('sensor.' + room + '_illuminance', lux, meas('Motion sensor ' + room + ' Illuminance', 'lx', 'illuminance'), { device: d });
  ent('sensor.' + room + '_temperature', temp, T('Motion sensor ' + room + ' Temperature'), { device: d, dp: 1 });
  ent('sensor.' + room + '_battery', lux === 'unavailable' ? 'unavailable' : String(70 + room.length), BAT('Motion sensor ' + room + ' Battery'), { device: d });
}
ent('switch.automation_motion_sensor_hallway', 'on', { friendly_name: 'Automation: Motion sensor hallway' }, { device: hueBridge });

// ---------------------------------------------------------------- Zigbee2MQTT
const z2mBridge = dev('z2m_bridge', 'Zigbee2MQTT Bridge', 'utility', 'Zigbee2MQTT', 'Bridge');
ent('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on', { device_class: 'connectivity', friendly_name: 'Zigbee2MQTT Bridge Connection state' }, { device: z2mBridge });
ent('switch.zigbee2mqtt_bridge_permit_join', 'off', { icon: 'mdi:human-greeting-proximity', friendly_name: 'Zigbee2MQTT Bridge Permit join' }, { device: z2mBridge });
ent('sensor.zigbee2mqtt_bridge_version', '2.6.1', { icon: 'mdi:zigbee', friendly_name: 'Zigbee2MQTT Bridge Version' }, { device: z2mBridge });
let ieee = 0x2b10;
function z2m(kind: 'climate' | 'contact' | 'plug' | 'bulb' | 'button' | 'leak' | 'vibration', name: string, area: string | null, i: number, opts: { off?: boolean; unknown?: boolean } = {}) {
  const id = slug(name); ieee += 0x13d;
  const model = { climate: 'WSDCGQ11LM', contact: 'MCCGQ11LM', plug: 'E1603/E1702/E1708', bulb: 'LED2102G3', button: 'E2002', leak: 'SJCGQ11LM', vibration: 'DJT11LM' }[kind];
  const d = dev('z2m_0x00158d000' + hex(ieee, 7), name, area, kind === 'plug' || kind === 'bulb' || kind === 'button' ? 'IKEA' : 'Aqara', model);
  const u = (s: string) => (opts.off ? 'unavailable' : s);
  const lq = String(40 + ((i * 37) % 200));
  ent('sensor.' + id + '_linkquality', u(lq), LQI(name + ' Linkquality'), { device: d });
  ent('sensor.' + id + '_last_seen', u('2026-10-17T0' + (i % 10) + ':' + String((i * 7) % 60).padStart(2, '0') + ':12+00:00'), TS(name + ' Last seen'), { device: d });
  if (kind !== 'plug' && kind !== 'bulb') {
    ent('sensor.' + id + '_battery', u(String(100 - ((i * 11) % 80))), BAT(name + ' Battery'), { device: d });
    ent('sensor.' + id + '_voltage', u(String(2900 + ((i * 13) % 300))), meas(name + ' Voltage', 'mV', 'voltage'), { device: d });
  }
  if (kind !== 'bulb' && kind !== 'button') ent('sensor.' + id + '_device_temperature', u(String(20 + (i % 9))), T(name + ' Device temperature'), { device: d });
  if (kind === 'climate') {
    ent('sensor.' + id + '_temperature', u((17 + ((i * 7) % 60) / 10).toFixed(2)), T(name + ' Temperature'), { device: d, dp: 1 });
    ent('sensor.' + id + '_humidity', u((45 + ((i * 13) % 300) / 10).toFixed(2)), H(name + ' Humidity'), { device: d, dp: 0 });
    ent('sensor.' + id + '_pressure', u((1008 + (i % 20)).toFixed(1)), meas(name + ' Pressure', 'hPa', 'atmospheric_pressure'), { device: d });
    ent('number.' + id + '_temperature_calibration', u('0'), { min: -9999, max: 9999, step: 1, mode: 'auto', unit_of_measurement: '°C', icon: 'mdi:wrench-clock', friendly_name: name + ' Temperature calibration' }, { device: d });
    ent('number.' + id + '_humidity_calibration', u('0'), { min: -9999, max: 9999, step: 1, mode: 'auto', unit_of_measurement: '%', icon: 'mdi:wrench-clock', friendly_name: name + ' Humidity calibration' }, { device: d });
  } else if (kind === 'contact') {
    ent('binary_sensor.' + id + '_contact', u(i % 5 ? 'off' : 'on'), { device_class: name.toLowerCase().includes('window') ? 'window' : 'door', friendly_name: name + ' Contact' }, { device: d });
  } else if (kind === 'leak') {
    ent('binary_sensor.' + id + '_water_leak', u('off'), { device_class: 'moisture', friendly_name: name + ' Water leak' }, { device: d });
  } else if (kind === 'vibration') {
    ent('binary_sensor.' + id + '_vibration', u('off'), { device_class: 'vibration', friendly_name: name + ' Vibration' }, { device: d });
    ent('select.' + id + '_sensitivity', u('medium'), { options: ['low', 'medium', 'high'], friendly_name: name + ' Sensitivity' }, { device: d });
  } else if (kind === 'button') {
    ent('sensor.' + id + '_action', opts.unknown ? 'unknown' : u(''), { icon: 'mdi:gesture-double-tap', friendly_name: name + ' Action' }, { device: d });
    ent('event.' + id + '_action', 'unknown', { event_types: ['on', 'off', 'brightness_move_up', 'brightness_move_down', 'brightness_stop', 'arrow_left_click', 'arrow_right_click'], event_type: null, friendly_name: name + ' Action' }, { device: d });
  } else if (kind === 'plug') {
    const p = opts.off ? 'unavailable' : String((i * 53) % 1800);
    ent('switch.' + id, u(p !== '0' && i % 3 ? 'on' : 'off'), { friendly_name: name }, { device: d });
    ent('sensor.' + id + '_power', p, W(name + ' Power'), { device: d, dp: 0 });
    ent('sensor.' + id + '_energy', u((i * 17.31).toFixed(2)), KWH(name + ' Energy'), { device: d, dp: 2 });
    ent('select.' + id + '_power_on_behavior', u('previous'), { options: ['off', 'on', 'toggle', 'previous'], icon: 'mdi:power-settings', friendly_name: name + ' Power-on behavior' }, { device: d });
    ent('switch.' + id + '_child_lock', u('off'), { icon: 'mdi:account-lock', friendly_name: name + ' Child lock' }, { device: d });
    ent('switch.' + id + '_led_disabled_night', u('on'), { icon: 'mdi:led-off', friendly_name: name + ' LED disabled night' }, { device: d });
  } else {
    ent('light.' + id, u(i % 2 ? 'on' : 'off'), { min_color_temp_kelvin: 2202, max_color_temp_kelvin: 4000, min_mireds: 250, max_mireds: 454, effect_list: ['blink', 'breathe', 'okay', 'channel_change', 'finish_effect', 'stop_effect'], supported_color_modes: ['color_temp'], color_mode: i % 2 ? 'color_temp' : null, brightness: i % 2 ? 128 : null, color_temp: i % 2 ? 370 : null, friendly_name: name, supported_features: 44 }, { device: d });
    ent('select.' + id + '_power_on_behavior', u('previous'), { options: ['off', 'on', 'toggle', 'previous'], icon: 'mdi:power-settings', friendly_name: name + ' Power-on behavior' }, { device: d });
    ent('number.' + id + '_color_temp_startup', u('65535'), { min: 250, max: 454, step: 1, mode: 'auto', unit_of_measurement: 'mired', friendly_name: name + ' Color temp startup' }, { device: d });
  }
}
const Z2M: [Parameters<typeof z2m>[0], string, string | null, { off?: boolean; unknown?: boolean }?][] = [
  ['climate', 'Thermometer living room', 'living_room'], ['climate', 'Thermometer kitchen', 'kitchen'], ['climate', 'Thermometer bedroom', 'bedroom'],
  ['climate', 'Thermometer playroom', 'kids_room'], ['climate', 'Thermometer guest room', 'guest_room'], ['climate', 'Thermometer bathroom', 'bathroom'],
  ['climate', 'Office climate', 'office'], ['climate', 'Thermometer attic', 'attic'], ['climate', 'Thermometer garage', 'garage'],
  ['climate', 'Thermometer basement', null, { off: true }], ['climate', 'Fridge temp', 'kitchen'], ['climate', 'Freezer temp', 'garage'],
  ['climate', 'Shed temp', 'garden'], ['climate', 'Crawl space', null], ['climate', 'Wine cabinet', 'basement'], ['climate', 'Thermometer toilet', 'toilet'],
  ['contact', 'Front door', 'hallway'], ['contact', 'Back door', 'kitchen'], ['contact', 'Shed door', 'garden'], ['contact', 'Garage door', 'garage'],
  ['contact', 'Window bedroom', 'bedroom'], ['contact', 'Window playroom', 'kids_room'], ['contact', 'Window bathroom', 'bathroom'],
  ['contact', 'Roof window attic', 'attic'], ['contact', 'Mailbox', 'driveway'], ['contact', 'Fridge door', 'kitchen'],
  ['plug', 'Washing machine', 'attic'], ['plug', 'Tumble dryer', 'attic'], ['plug', 'Dishwasher', 'kitchen'], ['plug', 'Coffee maker ☕', 'kitchen'],
  ['plug', 'Christmas tree 🎄', 'living_room', { off: true }], ['plug', 'TV cabinet', 'living_room'], ['plug', 'Desk 100% power strip', 'office'],
  ['plug', 'Aquarium', 'living_room'], ['plug', 'Air purifier', 'bedroom'], ['plug', 'Bedside table playroom', 'kids_room'], ['plug', 'Soldering station', 'garage'],
  ['plug', 'Christmas lights outdoor', 'garden'], ['plug', 'Monitor 2', 'office'], ['plug', 'Plug 0x7a3f', null], ['plug', 'Pond pump', 'garden'], ['plug', 'Server rack', 'utility'], ['plug', 'Electric blanket', 'bedroom'],
  ['bulb', 'Desk lamp playroom', 'kids_room'], ['bulb', 'Guest room lamp', 'guest_room'], ['bulb', 'Attic tube light', 'attic'],
  ['bulb', 'Shed lamp', 'garden'], ['bulb', 'Garage lamp', 'garage'], ['bulb', 'Basement lamp', null],
  ['button', 'Button bed left', 'bedroom'], ['button', 'Button bed right', 'bedroom', { unknown: true }], ['button', 'Rodret living room', 'living_room'],
  ['button', 'Button front door', 'hallway'], ['button', 'Styrbar kitchen', 'kitchen'],
  ['leak', 'Leak washing machine', 'attic'], ['leak', 'Leak dishwasher', 'kitchen'], ['leak', 'Leak central heating', 'attic'],
  ['vibration', 'Washing machine vibration', 'attic'], ['vibration', 'Tumble dryer vibration', 'attic'],
];
Z2M.forEach(([k, n, a, o], i) => z2m(k, n, a, i, o));

// ---------------------------------------------------------------- ESPHome
function esphome(node: string, name: string, area: string | null, sensors: [string, string, Record<string, unknown>, number?][], offline = false) {
  const d = dev('esphome_' + node, name, area, 'Espressif', 'esp32dev');
  for (const [key, state, attrs, dp] of sensors) ent('sensor.' + node.replace(/-/g, '_') + '_' + key, offline ? 'unavailable' : state, attrs, { device: d, ...(dp !== undefined ? { dp } : {}) });
  ent('sensor.' + node.replace(/-/g, '_') + '_wifi_signal', offline ? 'unavailable' : '-61', RSSI(name + ' WiFi Signal'), { device: d });
  ent('sensor.' + node.replace(/-/g, '_') + '_uptime', offline ? 'unavailable' : '412873', meas(name + ' Uptime', 's', 'duration'), { device: d });
  ent('button.' + node.replace(/-/g, '_') + '_restart', 'unknown', { device_class: 'restart', friendly_name: name + ' Restart' }, { device: d });
  ent('update.' + node.replace(/-/g, '_') + '_firmware', 'off', { auto_update: false, installed_version: '2026.9.2', in_progress: false, latest_version: '2026.9.2', release_summary: null, release_url: 'https://esphome.io/changelog/', skipped_version: null, title: 'ESPHome', friendly_name: name + ' Firmware', supported_features: 23 }, { device: d });
}
esphome('co2-living-room', 'CO2 living room', 'living_room', [['co2', '612', meas('CO2 living room CO2', 'ppm', 'carbon_dioxide')], ['temperature', '21.4372', T('CO2 living room Temperature'), 1], ['humidity', '51.875', H('CO2 living room Humidity'), 0], ['pm_2_5', '4', meas('CO2 living room PM2.5', 'µg/m³', 'pm25')]]);
esphome('co2-bedroom', 'CO2 bedroom', 'bedroom', [['co2', '1180', meas('CO2 bedroom CO2', 'ppm', 'carbon_dioxide')], ['temperature', '18.9', T('CO2 bedroom Temperature'), 1]]);
esphome('plantsensor-ficus', 'Ficus 🌿', 'living_room', [['soil_moisture', '38', meas('Ficus 🌿 Soil moisture', '%', 'moisture')], ['battery_level', '87', BAT('Ficus 🌿 Battery level')]]);
esphome('watermeter', 'Water meter', 'utility', [['water_total', '1834.217', { state_class: 'total_increasing', unit_of_measurement: 'm³', device_class: 'water', friendly_name: 'Water meter Water total' }, 3], ['water_flow', '0.0', meas('Water meter Water flow', 'L/min', 'volume_flow_rate')]]);
esphome('garage-opener', 'Garage door opener', 'garage', [['distance', '2.31', meas('Garage door opener Distance', 'm', 'distance'), 2]]);
esphome('attic-ventilation', 'Attic ventilation', 'attic', [['temperature', '24.1', T('Attic ventilation Temperature')], ['fan_speed', '0', meas('Attic ventilation Fan speed', '%')]], true);
ent('cover.garage_door', 'closed', { current_position: 0, device_class: 'garage', friendly_name: 'Garage door', supported_features: 15 }, { device: 'esphome_garage-opener' });
ent('fan.attic_ventilation', 'unavailable', { preset_modes: ['auto', 'boost', 'night'], friendly_name: 'Attic ventilation', supported_features: 57 }, { device: 'esphome_attic-ventilation' });
// a 16-channel energy monitor in the meter cupboard: per group power, energy and current
const emon = dev('esphome_energymonitor', 'Energy monitor breaker panel', 'utility', 'Espressif', 'esp32-s3');
['Circuit 1 kitchen', 'Circuit 2 induction L1', 'Circuit 3 induction L2', 'Circuit 4 washing machine', 'Circuit 5 dryer', 'Circuit 6 upstairs', 'Circuit 7 downstairs', 'Circuit 8 garden',
  'Circuit 9 charger L1', 'Circuit 10 charger L2', 'Circuit 11 charger L3', 'Circuit 12 heat pump', 'Circuit 13 dishwasher', 'Circuit 14 oven', 'Circuit 15 attic', 'Circuit 16 spare']
  .forEach((g, i) => {
    const k = 'energymonitor_' + slug(g);
    ent('sensor.' + k + '_power', String(i === 15 ? 0 : (i * 97) % 2300), W(g + ' power'), { device: emon, dp: 0 });
    ent('sensor.' + k + '_energy', (i * 123.457).toFixed(3), KWH(g + ' energy'), { device: emon, dp: 1 });
    ent('sensor.' + k + '_current', ((i * 0.43) % 10).toFixed(2), meas(g + ' current', 'A', 'current'), { device: emon });
  });

// ---------------------------------------------------------------- Shelly
function shelly(id: string, name: string, area: string | null, kind: '1pm' | 'ht', off = false) {
  const d = dev('shelly_' + id, name, area, 'Shelly', kind === '1pm' ? 'Shelly Plus 1PM' : 'Shelly Plus H&T');
  const u = (s: string) => (off ? 'unavailable' : s);
  if (kind === '1pm') {
    ent('switch.' + id + '_switch_0', u('on'), { friendly_name: name + ' Switch 0' }, { device: d });
    ent('sensor.' + id + '_switch_0_power', u('1873.4'), W(name + ' Switch 0 power'), { device: d, dp: 0 });
    ent('sensor.' + id + '_switch_0_energy', u('3121.889'), KWH(name + ' Switch 0 energy'), { device: d });
    ent('sensor.' + id + '_switch_0_voltage', u('231.2'), meas(name + ' Switch 0 voltage', 'V', 'voltage'), { device: d });
    ent('sensor.' + id + '_temperature', u('46.3'), T(name + ' Temperature'), { device: d });
  } else {
    ent('sensor.' + id + '_temperature', u('9.8'), T(name + ' Temperature'), { device: d, dp: 1 });
    ent('sensor.' + id + '_humidity', u('88.4'), H(name + ' Humidity'), { device: d });
    ent('sensor.' + id + '_battery', u('64'), BAT(name + ' Battery'), { device: d });
  }
  ent('sensor.' + id + '_signal_strength', u('-71'), RSSI(name + ' Signal strength'), { device: d });
  ent('binary_sensor.' + id + '_cloud', u('off'), { device_class: 'connectivity', friendly_name: name + ' Cloud' }, { device: d });
  ent('update.' + id + '_firmware_update', u('off'), { auto_update: false, installed_version: '1.4.4', in_progress: false, latest_version: '1.4.4', release_summary: null, title: null, friendly_name: name + ' Firmware update', supported_features: 5 }, { device: d });
}
shelly('shelly_boiler', 'Boiler', 'attic', '1pm');
shelly('shelly_floor_heating', 'Floor heating pump', 'utility', '1pm');
shelly('shelly_garden_lights', 'Garden lights', null, '1pm', true);
shelly('shelly_ht_outdoor', 'Outdoor (H&T)', 'garden', 'ht');
shelly('shelly_ht_shed', 'Shed', 'garden', 'ht');

// ---------------------------------------------------------------- tado
const tadoBridge = dev('tado_ib01', 'tado Internet Bridge IB0123456789', 'utility', 'tado', 'IB01');
ent('binary_sensor.tado_internet_bridge_connection_state', 'on', { device_class: 'connectivity', friendly_name: 'tado Internet Bridge Connection state' }, { device: tadoBridge });
ent('sensor.tado_outdoor_temperature', '10.6', T('Outdoor temperature'), { dp: 1 });
ent('sensor.tado_solar_percentage', '12.3', meas('Solar percentage', '%'));
ent('sensor.tado_weather_condition', 'cloudy', { device_class: 'enum', options: ['clear-night', 'cloudy', 'fog', 'hail', 'lightning', 'rainy', 'snowy', 'sunny', 'windy'], friendly_name: 'Weather condition' });
for (const [zone, name, area, mode, cur, set, hum, heat] of [
  ['living_room', 'Living room', 'living_room', 'auto', 20.83, 21, 52.1, 34], ['kitchen', 'Kitchen', 'kitchen', 'auto', 20.1, 20, 55.0, 0],
  ['bedroom', 'Bedroom', 'bedroom', 'auto', 17.92, 16, 58.6, 0], ['bathroom', 'Bathroom', 'bathroom', 'heat', 22.4, 23, 71.3, 88],
  ['playroom', 'Playroom & Study', 'kids_room', 'off', 18.5, null, 54.2, 0], ['attic', 'Attic', 'attic', 'unavailable', null, null, null, null],
] as const) {
  const d = dev('tado_' + zone, name, area, 'tado', 'VA02');
  const off = mode === 'unavailable';
  ent('climate.' + zone, mode, off ? { hvac_modes: ['off', 'auto', 'heat'], min_temp: 5, max_temp: 25, target_temp_step: 0.1, preset_modes: ['away', 'home', 'auto'], friendly_name: name, supported_features: 401 } : {
    hvac_modes: ['off', 'auto', 'heat'], min_temp: 5, max_temp: 25, target_temp_step: 0.1, preset_modes: ['away', 'home', 'auto'], current_temperature: cur, temperature: set, current_humidity: hum,
    hvac_action: heat ? 'heating' : mode === 'off' ? 'off' : 'idle', preset_mode: 'home', offset_celsius: -0.3, offset_fahrenheit: -0.54, friendly_name: name, supported_features: 401,
  }, { device: d });
  ent('sensor.' + zone + '_temperature', off ? 'unavailable' : String(cur), { ...T(name + ' Temperature'), time: '2026-10-17T08:41:02.112Z', setting: 0 }, { device: d, dp: 1 });
  ent('sensor.' + zone + '_humidity', off ? 'unavailable' : String(hum), { ...H(name + ' Humidity'), time: '2026-10-17T08:41:02.112Z' }, { device: d });
  ent('sensor.' + zone + '_heating', off ? 'unavailable' : String(heat), { ...meas(name + ' Heating', '%'), time: '2026-10-17T08:39:57.003Z' }, { device: d });
  ent('sensor.' + zone + '_tado_mode', off ? 'unavailable' : 'HOME', { friendly_name: name + ' Tado mode' }, { device: d });
  ent('binary_sensor.' + zone + '_window', off ? 'unavailable' : 'off', { device_class: 'window', friendly_name: name + ' Window' }, { device: d });
  ent('binary_sensor.' + zone + '_connectivity', off ? 'off' : 'on', { device_class: 'connectivity', friendly_name: name + ' Connectivity' }, { device: d });
  ent('binary_sensor.' + zone + '_battery_state', off ? 'unavailable' : 'off', { device_class: 'battery', friendly_name: name + ' Battery state' }, { device: d });
}
// eink-ha-os#152: a Better-Thermostat-style wrapper of the living-room thermostat (same room and name, switched off)
const btLiving = dev('better_thermostat_living_room', 'Living room', 'living_room', 'Better Thermostat', 'climate');
ent('climate.living_room_better_thermostat', 'off', { hvac_modes: ['heat', 'off'], min_temp: 5, max_temp: 30, target_temp_step: 0.5, current_temperature: 20.8, temperature: 21, hvac_action: 'idle', call_for_heat: false, window_open: false, batteries: '{}', errors: '[]', friendly_name: 'Living room', supported_features: 385 }, { device: btLiving });
ent('switch.playroom_child_lock', 'on', { friendly_name: 'Playroom & Study Child lock' }, { device: 'tado_playroom' });

// ---------------------------------------------------------------- Netatmo
const nBase = dev('netatmo_base', 'Weather station', 'living_room', 'Netatmo', 'NAMain');
const nOut = dev('netatmo_outdoor', 'Weather station outdoor', 'garden', 'Netatmo', 'NAModule1');
const nRain = dev('netatmo_rain', 'Rain gauge', 'garden', 'Netatmo', 'NAModule3');
ent('sensor.weather_station_temperature', '21.1', T('Weather station Temperature'), { device: nBase, dp: 1 });
ent('sensor.weather_station_co2', '734', meas('Weather station CO2', 'ppm', 'carbon_dioxide'), { device: nBase });
ent('sensor.weather_station_humidity', '53', H('Weather station Humidity'), { device: nBase });
ent('sensor.weather_station_noise', '38', meas('Weather station Noise', 'dB', 'sound_pressure'), { device: nBase });
ent('sensor.weather_station_atmospheric_pressure', '1013.7', meas('Weather station Atmospheric pressure', 'mbar', 'atmospheric_pressure'), { device: nBase });
ent('sensor.weather_station_reachability', 'True', { friendly_name: 'Weather station Reachability' }, { device: nBase });
ent('sensor.weather_station_outdoor_temperature', '10.42', T('Weather station outdoor Temperature'), { device: nOut, dp: 1 });
ent('sensor.weather_station_outdoor_humidity', '91', H('Weather station outdoor Humidity'), { device: nOut });
ent('sensor.weather_station_outdoor_battery', '42', BAT('Weather station outdoor Battery'), { device: nOut });
ent('sensor.weather_station_outdoor_temperature_trend', 'down', { friendly_name: 'Weather station outdoor Temperature trend' }, { device: nOut });
ent('sensor.rain_gauge_precipitation', '0.0', meas('Rain gauge Precipitation', 'mm', 'precipitation'), { device: nRain });
ent('sensor.rain_gauge_precipitation_last_hour', '0.2', meas('Rain gauge Precipitation last hour', 'mm', 'precipitation'), { device: nRain });
ent('sensor.rain_gauge_precipitation_today', 'unknown', { ...meas('Rain gauge Precipitation today', 'mm', 'precipitation'), state_class: 'total_increasing' }, { device: nRain });
// eink-ha-os#152: a forecast's maximum of today (sorts before the Shelly H&T: it was the Outside tile)
ent('sensor.forecast_max_temperature_today', '13.4', T('Forecast Max temperature today'));
ent('sensor.rain_gauge_battery', 'unavailable', BAT('Rain gauge Battery'), { device: nRain });

// ---------------------------------------------------------------- DSMR P1 (kW) + gas
const dsmr = dev('dsmr_meter', 'Electricity Meter', 'utility', 'Landis+Gyr', 'E360 (DSMR 5.0)');
const gas = dev('dsmr_gas', 'Gas Meter', 'utility', 'Itron', 'G4 RF1');
const KW = (name: string) => meas(name, 'kW', 'power');
ent('sensor.electricity_meter_power_consumption', '0.000', KW('Electricity Meter Power consumption'), { device: dsmr, dp: 3 });
ent('sensor.electricity_meter_power_production', '1.214', KW('Electricity Meter Power production'), { device: dsmr, dp: 3 });
for (const t of [1, 2]) {
  ent('sensor.electricity_meter_energy_consumption_tarif_' + t, (t === 1 ? 8123.411 : 7744.902).toFixed(3), KWH('Electricity Meter Energy consumption (tarif ' + t + ')'), { device: dsmr });
  ent('sensor.electricity_meter_energy_production_tarif_' + t, (t === 1 ? 2210.019 : 5531.6).toFixed(3), KWH('Electricity Meter Energy production (tarif ' + t + ')'), { device: dsmr });
}
for (const l of [1, 2, 3]) {
  ent('sensor.electricity_meter_power_consumption_phase_l' + l, '0.000', KW('Electricity Meter Power consumption phase L' + l), { device: dsmr });
  ent('sensor.electricity_meter_power_production_phase_l' + l, (0.4 + l / 100).toFixed(3), KW('Electricity Meter Power production phase L' + l), { device: dsmr });
  ent('sensor.electricity_meter_voltage_phase_l' + l, (230 + l).toFixed(1), meas('Electricity Meter Voltage phase L' + l, 'V', 'voltage'), { device: dsmr });
  ent('sensor.electricity_meter_current_phase_l' + l, String(2 + l), meas('Electricity Meter Current phase L' + l, 'A', 'current'), { device: dsmr });
}
ent('sensor.electricity_meter_active_tariff', 'normal', { device_class: 'enum', options: ['low', 'normal'], icon: 'mdi:flash', friendly_name: 'Electricity Meter Active tariff' }, { device: dsmr });
ent('sensor.electricity_meter_short_power_failure_count', '7', { state_class: 'total_increasing', friendly_name: 'Electricity Meter Short power failure count' }, { device: dsmr });
ent('sensor.electricity_meter_long_power_failure_count', '2', { state_class: 'total_increasing', friendly_name: 'Electricity Meter Long power failure count' }, { device: dsmr });
ent('sensor.gas_meter_gas_consumption', '4817.392', { state_class: 'total_increasing', unit_of_measurement: 'm³', device_class: 'gas', friendly_name: 'Gas Meter Gas consumption' }, { device: gas, dp: 2 });
ent('sensor.home_energy_usage_today', '7.83', KWH('Home energy usage today', 'total'), {});   // a utility_meter helper, no device, no area
ent('sensor.gas_usage_today', '1.21', { state_class: 'total', unit_of_measurement: 'm³', device_class: 'gas', friendly_name: 'Gas usage today' });

// eink-ha-os#152: an appliance plug's own day counter ("today consumption"; it was Imported today) and power
const dryer = dev('tapo_dryer', 'Dryer', 'garden', 'TP-Link', 'P110');
ent('switch.dryer', 'off', { friendly_name: 'Dryer' }, { device: dryer });
ent('sensor.dryer_current_consumption', '0.0', W('Dryer Current consumption'), { device: dryer });
ent('sensor.dryer_today_consumption', '4.12', KWH('Dryer Today consumption', 'total_increasing'), { device: dryer, dp: 2 });

// ---------------------------------------------------------------- Enphase Envoy (solar)
const ENVOY = 'envoy_482100000000';
const envoy = dev('enphase_envoy', 'Envoy 482100000000', 'attic', 'Enphase', 'Envoy-S Metered');
ent('sensor.' + ENVOY + '_current_power_production', '1214', W('Envoy 482100000000 Current power production'), { device: envoy, dp: 0 });
ent('sensor.' + ENVOY + '_energy_production_today', '4.821', KWH('Envoy 482100000000 Energy production today', 'total_increasing'), { device: envoy, dp: 2 });
ent('sensor.' + ENVOY + '_energy_production_last_seven_days', '61.4', KWH('Envoy 482100000000 Energy production last seven days', 'total'), { device: envoy });
ent('sensor.' + ENVOY + '_lifetime_energy_production', '24.817', { ...KWH('Envoy 482100000000 Lifetime energy production'), unit_of_measurement: 'MWh' }, { device: envoy, dp: 3 });
ent('sensor.' + ENVOY + '_current_power_consumption', '842', W('Envoy 482100000000 Current power consumption'), { device: envoy, dp: 0 });
ent('sensor.' + ENVOY + '_energy_consumption_today', '6.112', KWH('Envoy 482100000000 Energy consumption today'), { device: envoy });
ent('binary_sensor.' + ENVOY + '_communicating', 'on', { device_class: 'connectivity', friendly_name: 'Envoy 482100000000 Communicating' }, { device: envoy });
for (let i = 0; i < 16; i++) {
  const sn = '1221000' + String(10000 + i * 371).padStart(5, '0');
  const d = dev('enphase_inv_' + sn, 'Inverter ' + sn, i < 12 ? 'attic' : 'garage', 'Enphase', 'IQ8MC');
  const p = i === 13 ? 'unavailable' : String(70 + ((i * 17) % 40));
  ent('sensor.inverter_' + sn, p, W('Inverter ' + sn), { device: d });
  ent('sensor.inverter_' + sn + '_last_reported', p === 'unavailable' ? 'unavailable' : '2026-10-17T08:3' + (i % 10) + ':00+00:00', TS('Inverter ' + sn + ' Last reported'), { device: d });
  ent('sensor.inverter_' + sn + '_lifetime_energy', p === 'unavailable' ? 'unavailable' : (1100 + i * 13.7).toFixed(1), KWH('Inverter ' + sn + ' Lifetime energy'), { device: d });
}

// ---------------------------------------------------------------- car (asleep: half of it unavailable)
const car = dev('car_model_y', 'Car', null, 'Tesla', 'Model Y');
ent('sensor.car_battery_level', '71', BAT('Car Battery level'), { device: car });
ent('sensor.car_battery_range', '312.4', meas('Car Battery range', 'km', 'distance'), { device: car, dp: 0 });
ent('sensor.car_charging', 'stopped', { device_class: 'enum', options: ['starting', 'charging', 'stopped', 'complete', 'disconnected', 'no_power'], friendly_name: 'Car Charging' }, { device: car });
ent('sensor.car_charger_power', '0', meas('Car Charger power', 'kW', 'power'), { device: car });
ent('sensor.car_charge_energy_added', '18.21', KWH('Car Charge energy added', 'total_increasing'), { device: car });
ent('sensor.car_odometer', '48211.9', { state_class: 'total_increasing', unit_of_measurement: 'km', device_class: 'distance', friendly_name: 'Car Odometer' }, { device: car, dp: 0 });
ent('sensor.car_inside_temperature', 'unavailable', T('Car Inside temperature'), { device: car });
ent('sensor.car_outside_temperature', 'unavailable', T('Car Outside temperature'), { device: car });
ent('sensor.car_tire_pressure_front_left', 'unavailable', meas('Car Tire pressure front left', 'bar', 'pressure'), { device: car });
ent('binary_sensor.car_charge_cable', 'off', { device_class: 'connectivity', friendly_name: 'Car Charge cable' }, { device: car });
ent('binary_sensor.car_status', 'off', { device_class: 'connectivity', friendly_name: 'Car Status' }, { device: car });
ent('climate.car_climate', 'unavailable', { hvac_modes: ['heat_cool', 'off'], min_temp: 15, max_temp: 28, preset_modes: ['off', 'keep', 'dog', 'camp'], friendly_name: 'Car Climate', supported_features: 401 }, { device: car });
ent('switch.car_charge', 'off', { friendly_name: 'Car Charge' }, { device: car });
ent('switch.car_sentry_mode', 'unavailable', { friendly_name: 'Car Sentry mode' }, { device: car });
ent('number.car_charge_limit', '80', { min: 50, max: 100, step: 1, mode: 'auto', unit_of_measurement: '%', device_class: 'battery', friendly_name: 'Car Charge limit' }, { device: car });
ent('number.car_charge_current', '16', { min: 0, max: 16, step: 1, mode: 'auto', unit_of_measurement: 'A', device_class: 'current', friendly_name: 'Car Charge current' }, { device: car });
ent('lock.car_lock', 'locked', { friendly_name: 'Car Lock', supported_features: 0 }, { device: car });
ent('device_tracker.car_location', 'home', { source_type: 'gps', latitude: 52.0, longitude: 5.0, gps_accuracy: 0, friendly_name: 'Car Location' }, { device: car });

// ---------------------------------------------------------------- phones (companion app)
function phone(id: string, name: string, model: string, ios: boolean, bat: string) {
  const d = dev('mobile_app_' + id, name, null, ios ? 'Apple' : 'Google', model);
  ent('sensor.' + id + '_battery_level', bat, { ...BAT(name + ' Battery Level'), icon: 'mdi:battery-60' }, { device: d });
  ent('sensor.' + id + '_battery_state', ios ? 'Not Charging' : 'discharging', { icon: 'mdi:battery-minus', ...(ios ? { 'Low Power Mode': false } : { is_charging: false }), friendly_name: name + ' Battery State' }, { device: d });
  ent('sensor.' + id + '_steps', '6421', { state_class: 'total', unit_of_measurement: 'steps', icon: 'mdi:walk', friendly_name: name + ' Steps' }, { device: d });
  ent('sensor.' + id + '_ssid', 'HomeNetwork', { icon: 'mdi:wifi', friendly_name: name + ' SSID' }, { device: d });
  ent('sensor.' + id + '_activity', ios ? 'Stationary' : 'still', { Confidence: 'High', Types: ['Stationary'], icon: 'mdi:human-male', friendly_name: name + ' Activity' }, { device: d });
  ent('sensor.' + id + '_storage', '41.83', { 'Available': '62.31 GB', 'Available (Important)': '71.02 GB', 'Available (Opportunistic)': '58.10 GB', 'Total': '128.00 GB', unit_of_measurement: '%', icon: 'mdi:database', friendly_name: name + ' Storage' }, { device: d });
  ent('sensor.' + id + '_geocoded_location', 'Example Street 1, 1234 AB Sampletown', { Name: 'Example Street 1', Locality: 'Sampletown', Country: 'Netherlands', 'Postal Code': '1234 AB', Location: [52.0, 5.0], friendly_name: name + ' Geocoded Location' }, { device: d });
  ent('sensor.' + id + '_last_update_trigger', 'Background Fetch', { icon: 'mdi:cellphone-wireless', friendly_name: name + ' Last Update Trigger' }, { device: d });
  ent('binary_sensor.' + id + '_focus', 'off', { icon: 'mdi:moon-waning-crescent', friendly_name: name + ' Focus' }, { device: d });
  ent('device_tracker.' + id, 'home', { source_type: 'gps', battery_level: Number(bat), latitude: 52.0, longitude: 5.0, gps_accuracy: 12, altitude: 3, course: -1, speed: -1, vertical_accuracy: 8, friendly_name: name }, { device: d });
}
phone('iphone_15', 'iPhone 15', 'iPhone 15', true, '58');
phone('pixel_9', 'Pixel 9', 'Pixel 9', false, '23');
ent('person.resident_a', 'home', { editable: true, id: 'resident_a', device_trackers: ['device_tracker.iphone_15'], latitude: 52.0, longitude: 5.0, gps_accuracy: 12, source: 'device_tracker.iphone_15', user_id: 'u1', friendly_name: 'Resident A' });
ent('person.resident_b', 'not_home', { editable: true, id: 'resident_b', device_trackers: ['device_tracker.pixel_9'], user_id: 'u2', friendly_name: 'Resident B' });

// ---------------------------------------------------------------- Nord Pool prices (long attributes)
const NP = [0.231, 0.219, 0.208, 0.204, 0.209, 0.226, 0.271, 0.318, 0.336, 0.297, 0.252, 0.228, 0.211, 0.203, 0.214, 0.241, 0.287, 0.344, 0.372, 0.351, 0.309, 0.277, 0.254, 0.238];
ent('sensor.nordpool_kwh_nl_eur_3_10_021', '0.297', {
  average: 0.2629, off_peak_1: 0.2163, off_peak_2: 0.2694, peak: 0.2847, min: 0.203, max: 0.372, mean: 0.2629, unit: 'kWh', currency: 'EUR', country: 'Netherlands', region: 'NL', low_price: false, price_percent_to_average: 1.13,
  today: NP, tomorrow: [], tomorrow_valid: false,
  raw_today: NP.map((value, h) => ({ start: '2026-10-17T' + String(h).padStart(2, '0') + ':00:00+02:00', end: '2026-10-17T' + String(h + 1).padStart(2, '0') + ':00:00+02:00', value })),
  raw_tomorrow: [], current_price: 0.297, additional_costs_current_hour: 0.1462, price_in_cents: false,
  unit_of_measurement: 'EUR/kWh', device_class: 'monetary', icon: 'mdi:flash', friendly_name: 'Electricity price (Nord Pool)',
}, { dp: 3 });

// ---------------------------------------------------------------- media, helpers, automations, updates, clutter
const sonos = dev('sonos_living_room', 'Living room Sonos', 'living_room', 'Sonos', 'Arc');
ent('media_player.living_room_sonos', 'paused', { group_members: ['media_player.living_room_sonos', 'media_player.kitchen_sonos'], volume_level: 0.18, is_volume_muted: false, media_content_type: 'music', media_duration: 214, media_position: 37, media_title: 'A song with a very long title (Live in a big hall) [Remastered 2026]', media_artist: 'The Invented Band', media_album_name: 'All Made Up', shuffle: false, repeat: 'off', source_list: ['Line-in', 'TV', 'Radio 1', 'Radio 2', 'Radio 3', 'Favorites', 'Discover', 'Spotify Connect'], night_sound: false, speech_enhance: true, friendly_name: 'Living room Sonos', supported_features: 4127295 }, { device: sonos });
ent('media_player.kitchen_sonos', 'unavailable', { friendly_name: 'Kitchen Sonos', supported_features: 4127295, restored: true }, { device: dev('sonos_kitchen', 'Kitchen Sonos', 'kitchen', 'Sonos', 'One SL') });
ent('number.living_room_sonos_bass', '2', { min: -10, max: 10, step: 1, mode: 'slider', friendly_name: 'Living room Sonos Bass' }, { device: sonos });
ent('switch.living_room_sonos_crossfade', 'off', { icon: 'mdi:swap-horizontal', friendly_name: 'Living room Sonos Crossfade' }, { device: sonos });
ent('sun.sun', 'above_horizon', { next_dawn: '2026-10-18T05:36:45+00:00', next_dusk: '2026-10-17T17:15:02+00:00', next_midnight: '2026-10-17T23:26:10+00:00', next_noon: '2026-10-18T11:26:05+00:00', next_rising: '2026-10-18T06:12:11+00:00', next_setting: '2026-10-17T16:39:30+00:00', elevation: 24.6, azimuth: 157.32, rising: true, friendly_name: 'Sun' });
ent('weather.forecast_home', 'cloudy', { temperature: 10.9, apparent_temperature: 8.7, dew_point: 9.1, temperature_unit: '°C', humidity: 89, cloud_coverage: 92.2, uv_index: 1.1, pressure: 1013.8, pressure_unit: 'hPa', wind_bearing: 221.3, wind_speed: 19.1, wind_speed_unit: 'km/h', visibility_unit: 'km', precipitation_unit: 'mm', attribution: 'Weather forecast from met.no, delivered by the Norwegian Meteorological Institute.', friendly_name: 'Forecast Home', supported_features: 3 });
ent('zone.home', '2', { latitude: 52.0, longitude: 5.0, radius: 100, passive: false, persons: ['person.resident_a'], editable: true, icon: 'mdi:home', friendly_name: 'Home' });
ent('sensor.date', '2026-10-17', { icon: 'mdi:calendar', friendly_name: 'Date' });
ent('sensor.home_rain_radar_temperature', '10.8', T('Rain radar temperature'));
ent('sensor.uv_index', 'unknown', { state_class: 'measurement', unit_of_measurement: 'UV index', friendly_name: 'UV index' });
ent('sensor.backup_last_successful_automatic_backup', '2026-10-17T03:47:12+00:00', TS('Backup Last successful automatic backup'));
ent('sensor.processor_use', '7', { ...meas('Processor use', '%'), icon: 'mdi:cpu-64-bit' });
ent('sensor.memory_use_percent', '38.2', { ...meas('Memory use (percent)', '%'), icon: 'mdi:memory' });
ent('sensor.disk_use_percent', '61.0', { ...meas('Disk use %', '%'), icon: 'mdi:harddisk' });
ent('sensor.processor_temperature', '51.2', T('Processor temperature'), { area: 'utility' });
ent('sensor.speedtest_download', '483.21', meas('SpeedTest Download', 'Mbit/s', 'data_rate'), { dp: 0 });
ent('sensor.speedtest_ping', '9', meas('SpeedTest Ping', 'ms', 'duration'));
ent('sensor.waste_collection_organic', '2026-10-21', { device_class: 'date', friendly_name: 'Waste: organic 🍂' });
ent('sensor.waste_collection_paper', '2026-10-29', { device_class: 'date', friendly_name: 'Waste: paper' });
ent('sensor.waste_collection_residual', 'unknown', { device_class: 'date', friendly_name: 'Waste: residual' });
for (const [id, name, st] of [['guest_mode', 'Guest mode', 'off'], ['vacation', 'Vacation ✈️', 'off'], ['christmas_lights_automatic', 'Christmas lights automatic', 'on'], ['night_mode', 'Night mode', 'off'], ['cleaner_present', 'Cleaner present', 'off'], ['washing_machine_done_notification', 'Washing machine done notification', 'on']] as const)
  ent('input_boolean.' + id, st, { editable: true, icon: 'mdi:toggle-switch', friendly_name: name });
for (const [id, name, st, unit, min, max] of [['shower_timer', 'Shower timer', '10.0', 'min', 1, 30], ['dim_level_evening', 'Dim level evening %', '35.0', '%', 0, 100], ['target_temperature_night', 'Target temperature night', '16.0', '°C', 12, 20]] as const)
  ent('input_number.' + id, st, { initial: null, editable: true, min, max, step: 1, mode: 'slider', unit_of_measurement: unit, friendly_name: name });
ent('input_select.house_mode', 'Home', { options: ['Home', 'Away', 'Sleep', 'Vacation'], editable: true, friendly_name: 'House mode' });
ent('input_datetime.alarm_clock', '06:45:00', { has_date: false, has_time: true, editable: true, hour: 6, minute: 45, second: 0, timestamp: 24300, friendly_name: 'Alarm clock ⏰' });
ent('counter.coffee_today', '3', { initial: 0, step: 1, editable: true, friendly_name: 'Coffee today' });
ent('timer.washing_machine', 'idle', { duration: '1:30:00', editable: true, friendly_name: 'Washing machine' });
for (const [id, name] of [['evening', 'Evening'], ['movie', 'Movie 🎬'], ['breakfast', 'Breakfast'], ['all_off', 'All off'], ['good_night', 'Good night'], ['party', 'Party!']] as const)
  ent('scene.' + id, 'unknown', { entity_id: ['light.living_room_ceiling', 'light.living_room_floor_lamp', 'light.tv_lightstrip'], id: id, friendly_name: name });
for (const [id, name] of [['all_off', 'All off'], ['good_morning', 'Good morning'], ['leaving', 'Leaving'], ['new_waste_day_notification', 'New waste day notification']] as const)
  ent('script.' + id, 'off', { last_triggered: '2026-10-16T21:14:03.551211+00:00', mode: 'single', current: 0, friendly_name: name });
const AUTOS = ['Hallway light on motion', 'Toilet light on motion', 'Landing nightlight', 'Sunset living room', 'All off when leaving', 'Welcome home', 'Washing machine done', 'Dryer done',
  'Dishwasher done', 'Fridge door open > 2 min', 'Mailbox notification 📬', 'Window open, heating off', 'Garden lights on', 'Garden lights off', 'Christmas tree on', 'Christmas tree off', 'Wake-up light',
  'Night mode', 'Leak alarm', 'Pond pump schedule', 'Boiler cheap hours', 'Charger cheap hours', 'Charge car on solar', 'CO2 bedroom high', 'Bathroom ventilation', 'Waste reminder',
  'Backup notification', 'Update notification', 'Low battery notification', 'Zigbee device offline', 'Button bed left', 'Button bed right', 'Rodret living room', 'Styrbar kitchen', 'Front door open notification',
  'Garage door open > 10 min', 'Electric blanket off', 'Aquarium light', 'Server rack temperature', 'Speedtest every hour', 'Old: test automation (disabled)', 'Copy of Welcome home'];
AUTOS.forEach((name, i) => ent('automation.' + slug(name), name.includes('disabled') ? 'off' : 'on', { id: String(1700000000000 + i * 7919), last_triggered: i % 4 ? '2026-10-1' + (i % 8) + 'T1' + (i % 10) + ':0' + (i % 6) + ':00.000000+00:00' : null, mode: 'single', current: 0, friendly_name: name }));
for (const [id, name, inst, latest] of [['home_assistant_core_update', 'Home Assistant Core Update', '2026.10.1', '2026.10.2'], ['home_assistant_operating_system_update', 'Home Assistant Operating System Update', '16.2', '16.2'],
  ['home_assistant_supervisor_update', 'Home Assistant Supervisor Update', '2026.10.0', '2026.10.0'], ['zigbee2mqtt_update', 'Zigbee2MQTT Update', '2.6.0-1', '2.6.1-1'], ['mosquitto_broker_update', 'Mosquitto broker Update', '6.5.1', '6.5.1'],
  ['hacs_update', 'HACS update', '2.0.5', '2.0.5'], ['file_editor_update', 'File editor Update', '5.8.0', '5.8.0']] as const)
  ent('update.' + id, inst === latest ? 'off' : 'on', { auto_update: false, display_precision: 0, installed_version: inst, in_progress: false, latest_version: latest, release_summary: inst === latest ? null : 'Lorem ipsum: a long release summary with **markdown**, bullet points and a link list. '.repeat(8), release_url: 'https://example.invalid/releases/' + latest, skipped_version: null, title: name.replace(/ Update$/i, ''), update_percentage: null, entity_picture: 'https://brands.home-assistant.io/_/hassio/icon.png', friendly_name: name, supported_features: 25 });
for (let i = 0; i < 6; i++) ent('camera.' + ['front_door', 'driveway', 'garden', 'garage', 'baby_monitor', 'shed'][i], i === 3 ? 'unavailable' : 'idle', { access_token: 'invented-camera-token-' + i, frontend_stream_type: 'hls', entity_picture: '/api/camera_proxy/camera.x?token=invented-' + i, friendly_name: ['Front door', 'Driveway', 'Garden', 'Garage', 'Baby monitor 👶', 'Shed'][i], supported_features: 2 });

// ---------------------------------------------------------------- router (an internet-access switch per known client) + NAS
const fritz = dev('fritz_box', 'FRITZ!Box 7590', 'utility', 'AVM', 'FRITZ!Box 7590 AX');
ent('sensor.fritz_box_7590_download_throughput', '1.42', meas('FRITZ!Box 7590 Download throughput', 'kB/s', 'data_rate'), { device: fritz });
ent('sensor.fritz_box_7590_upload_throughput', '0.31', meas('FRITZ!Box 7590 Upload throughput', 'kB/s', 'data_rate'), { device: fritz });
ent('sensor.fritz_box_7590_external_ip', '192.0.2.44', { icon: 'mdi:earth', friendly_name: 'FRITZ!Box 7590 External IP' }, { device: fritz });
ent('binary_sensor.fritz_box_7590_connection', 'on', { device_class: 'connectivity', friendly_name: 'FRITZ!Box 7590 Connection' }, { device: fritz });
ent('switch.fritz_box_7590_wi_fi_homenetwork', 'on', { icon: 'mdi:wifi', friendly_name: 'FRITZ!Box 7590 Wi-Fi HomeNetwork' }, { device: fritz });
ent('switch.fritz_box_7590_wi_fi_guest', 'off', { icon: 'mdi:wifi', friendly_name: 'FRITZ!Box 7590 Wi-Fi Guest' }, { device: fritz });
const CLIENTS = ['iPhone-15', 'Pixel-9', 'MacBook-Pro', 'ThinkPad-work', 'iPad', 'Kindle', 'Nintendo-Switch', 'PlayStation-5', 'Apple-TV', 'Chromecast', 'Sonos-Arc', 'Sonos-One',
  'Hue-Bridge', 'tado-IB', 'Envoy', 'Synology-NAS', 'Home-Assistant', 'Printer-HP', 'Robot-vacuum', 'Washer-wifi', 'Oven', 'Fridge', 'Thermostat-old', 'Doorbell', 'Camera-driveway', 'Camera-garden',
  'Baby-monitor', 'Laptop-2', 'Tablet-2', 'Smartwatch', 'ESP-co2-living-room', 'ESP-co2-bedroom', 'ESP-plant', 'ESP-watermeter', 'ESP-garage-opener', 'ESP-attic', 'ESP-energymonitor',
  'Shelly-boiler', 'Shelly-pump', 'Shelly-garden', 'Shelly-HT-outdoor', 'Shelly-HT-shed', 'Car', 'EV-charger', 'Heat-pump', 'HA-Paper-1A2B', 'Guest-phone', 'android-7f3a9c', 'unknown-device',
  'Raspberry-Pi', 'Zigbee-coordinator', 'Mesh-repeater-upstairs', 'Mesh-repeater-attic', 'Smart-TV', 'Soundbar', 'Weather-station', 'Door-lock', 'Airfryer', 'Air-purifier', 'Ventilation-unit'];
for (const [i, c] of CLIENTS.entries()) {
  const id = slug(c);
  ent('switch.' + id + '_internet_access', i % 17 === 5 ? 'off' : 'on', { icon: 'mdi:network', friendly_name: c + ' Internet Access' }, { device: fritz });
  ent('device_tracker.' + id, i % 4 ? 'home' : 'not_home', { source_type: 'router', ip: '192.168.178.' + (20 + i), mac: '02:00:00:00:' + hex(i, 2) + ':01', host_name: c, last_time_reachable: '2026-10-17T08:00:00+00:00', reason: 'unknown', friendly_name: c });
}
const nas = dev('synology_ds220', 'Synology NAS', 'utility', 'Synology', 'DS220+');
for (const [k, st, a] of [['cpu_utilization_total', '4', meas('Synology NAS CPU utilization (total)', '%')], ['memory_usage_real', '27.3', meas('Synology NAS Memory usage (real)', '%')],
  ['temperature', '44', T('Synology NAS Temperature')], ['download_throughput', '12.1', meas('Synology NAS Download throughput', 'kB/s', 'data_rate')],
  ['upload_throughput', '3.8', meas('Synology NAS Upload throughput', 'kB/s', 'data_rate')], ['volume_1_status', 'normal', { friendly_name: 'Synology NAS (Volume 1) Status' }],
  ['volume_1_used_space', '4.21', meas('Synology NAS (Volume 1) Used space', 'TB', 'data_size')], ['volume_1_volume_used', '78.9', meas('Synology NAS (Volume 1) Volume used', '%')],
  ['drive_1_status', 'normal', { friendly_name: 'Synology NAS (Drive 1) Status' }], ['drive_1_temperature', '38', T('Synology NAS (Drive 1) Temperature')],
  ['drive_2_status', 'normal', { friendly_name: 'Synology NAS (Drive 2) Status' }], ['drive_2_temperature', '39', T('Synology NAS (Drive 2) Temperature')]] as const)
  ent('sensor.synology_nas_' + k, st, a as Record<string, unknown>, { device: nas });
ent('binary_sensor.synology_nas_security_status', 'off', { device_class: 'safety', friendly_name: 'Synology NAS Security status' }, { device: nas });

// ---------------------------------------------------------------- Energy dashboard
/** get_config `time_zone` and `currency` (eink-ha-os#147). */
export const REAL_CONFIG = { time_zone: 'Europe/Amsterdam', currency: 'EUR' };

export const REAL_PREFS = {
  energy_sources: [
    { type: 'grid', flow_from: [1, 2].map((t) => ({ stat_energy_from: 'sensor.electricity_meter_energy_consumption_tarif_' + t, stat_cost: null, entity_energy_price: 'sensor.nordpool_kwh_nl_eur_3_10_021', number_energy_price: null })),
      flow_to: [1, 2].map((t) => ({ stat_energy_to: 'sensor.electricity_meter_energy_production_tarif_' + t, stat_compensation: null, entity_energy_price: 'sensor.nordpool_kwh_nl_eur_3_10_021', number_energy_price: null })), cost_adjustment_day: 0 },
    { type: 'solar', stat_energy_from: 'sensor.' + ENVOY + '_lifetime_energy_production', stat_rate: 'sensor.' + ENVOY + '_current_power_production', config_entry_solar_forecast: ['01JINVENTEDFORECAST0000000'] },
    { type: 'gas', stat_energy_from: 'sensor.gas_meter_gas_consumption', stat_cost: null, entity_energy_price: null, number_energy_price: 1.42 },
  ],
  device_consumption: ['washing_machine', 'tumble_dryer', 'dishwasher', 'coffee_maker'].map((d) => ({ stat_consumption: 'sensor.' + d + '_energy' }))
    .concat([{ stat_consumption: 'sensor.car_charge_energy_added' }, { stat_consumption: 'sensor.shelly_boiler_switch_0_energy' }]),
};
