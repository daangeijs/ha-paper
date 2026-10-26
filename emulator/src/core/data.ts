// Registries + mock data, ported 1:1 from Main.dc.html (script block, lines 1181–1483).
// Registries (WIDGET_TYPES, APPS, ENT keys) are used by the config validator;
// everything else is mock Home Assistant data for the emulator.
import { pad, kw, fmtNum } from './format.ts';
import { money } from './locale.ts';
import { tr, type Lang, type StrKey } from './strings.ts';

export const PAPER = '#ECEBE5', INK = '#111', G1 = '#555', G2 = '#A8A8A8';

export const PRICES = [0.22, 0.21, 0.20, 0.20, 0.21, 0.23, 0.27, 0.33, 0.35, 0.30, 0.26, 0.22, 0.19, 0.18, 0.19, 0.22, 0.27, 0.34, 0.38, 0.36, 0.31, 0.27, 0.25, 0.23];
export const USAGE = [0.25, 0.2, 0.2, 0.2, 0.2, 0.25, 0.45, 0.8, 0.6, 0.4, 0.35, 0.4, 0.5, 0.4, 0.35, 0.4, 0.6, 1.1, 1.3, 0.9, 0.7, 0.6, 0.4, 0.3];
export const SOLAR = Array.from({ length: 24 }, (_, h) => +(Math.max(0, Math.sin(((h + 0.5 - 8) / 10.5) * Math.PI)) * 2.4).toFixed(2));

/** presets: HA `preset_modes` (tado: home / away); the garage's plain thermostat has none (#148). */
export type Zone = { id: string; name: string; cur: number; set: number; presets: string[] };
export const ZONE_LIST: Zone[] = ([
  ['living', 'Living room', 20.4, 21], ['kitchen', 'Kitchen', 20.1, 20], ['dining', 'Dining room', 19.6, 20], ['hall', 'Hallway', 17.5, 17],
  ['office', 'Office', 19.1, 20], ['bedroom', 'Bedroom', 17.8, 18], ['kids', 'Kids room', 18.6, 19], ['guest', 'Guest room', 15.2, 15],
  ['bathroom', 'Bathroom', 21.2, 22], ['attic', 'Attic', 14.8, 15], ['laundry', 'Laundry', 16.0, 16], ['studio', 'Studio', 18.0, 19],
  ['toilet', 'Toilet', 17.0, 17], ['garage', 'Garage', 10.5, 10],
] as [string, string, number, number][]).map(([id, name, cur, set]) => ({ id, name, cur, set, presets: id === 'garage' ? [] : ['home', 'away'] }));
export const ZONE_NAME: Record<string, string> = Object.fromEntries(ZONE_LIST.map((z) => [z.id, z.name]));

// Lights (mock). In firmware: light.* entities grouped by their HA area.
export const ROOMS: [string, string][] = [['living', 'Living room'], ['kitchen', 'Kitchen'], ['dining', 'Dining'], ['hall', 'Hallway'], ['bedroom', 'Bedroom'], ['office', 'Office'], ['garden', 'Garden']];
export const ROOM_NAME: Record<string, string> = Object.fromEntries(ROOMS);
export type Light = { id: string; room: string; name: string; dim: boolean; on: boolean; b: number };
export const LIGHT_LIST: Light[] = ([
  ['living_ceiling', 'living', 'Ceiling', 1, 1, 80], ['living_floor', 'living', 'Floor lamp', 1, 1, 60], ['living_reading', 'living', 'Reading lamp', 1, 0, 70], ['living_tv', 'living', 'TV backlight', 0, 0, 100],
  ['kitchen_spots', 'kitchen', 'Spots', 1, 1, 100], ['kitchen_island', 'kitchen', 'Island pendants', 1, 1, 70], ['kitchen_cabinet', 'kitchen', 'Under-cabinet', 0, 0, 100],
  ['dining_pendant', 'dining', 'Pendant', 1, 0, 60],
  ['hall_ceiling', 'hall', 'Ceiling', 1, 0, 40], ['hall_stairs', 'hall', 'Stairs', 0, 0, 100],
  ['bedroom_ceiling', 'bedroom', 'Ceiling', 1, 0, 50], ['bedroom_left', 'bedroom', 'Bedside left', 1, 0, 30], ['bedroom_right', 'bedroom', 'Bedside right', 1, 0, 30],
  ['office_desk', 'office', 'Desk lamp', 1, 1, 100],
  ['garden_terrace', 'garden', 'Terrace', 0, 0, 100], ['garden_path', 'garden', 'Path', 0, 0, 100],
] as [string, string, string, number, number, number][]).map(([id, room, name, dim, on, b]) => ({ id, room, name, dim: !!dim, on: !!on, b }));
export const LIGHT: Record<string, Light> = Object.fromEntries(LIGHT_LIST.map((l) => [l.id, l]));

export function cheapestWindow(len: number, prices: number[] = PRICES): number {
  let best = 0, bestSum = Infinity;
  for (let i = 0; i <= 24 - len; i++) { const s = prices.slice(i, i + len).reduce((a, b) => a + b, 0); if (s < bestSum) { bestSum = s; best = i; } }
  return best;
}
export const CHEAP = cheapestWindow(3);

// ---------- Travel. Route tiles are user-defined (label + mode + entity, spec/SCHEMA.md); the emulator demo's
// routes and timetables live in src/emulator/demoTravel.ts.
export const MODE_ICON: Record<string, string> = {
  train: 'M7 3h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 11h16M8.5 21l1.5-3M15.5 21l-1.5-3M8 14.5h.01M16 14.5h.01',
  bus: 'M6 3h12a2 2 0 0 1 2 2v12H4V5a2 2 0 0 1 2-2zM4 11h16M7 17v3M17 17v3M8 14h.01M16 14h.01',
  car: 'M5 15l1.6-5a2 2 0 0 1 1.9-1.4h7a2 2 0 0 1 1.9 1.4L19 15M3 15h18v4H3zM6.5 19v2M17.5 19v2M7 17h.01M17 17h.01',
};
// ---------- Wi-Fi (mock scan). ESP32-S3: 2.4 GHz only, WPA2/WPA3-personal.
export type Network = { ssid: string; rssi: number; secure: boolean; failsWith?: string };
export const NETWORKS: Network[] = [
  { ssid: 'HomeNet', rssi: -48, secure: true },
  { ssid: 'HomeNet-Guest', rssi: -58, secure: true },
  { ssid: 'Phone hotspot', rssi: -66, secure: true },
  { ssid: 'Neighbour-2G', rssi: -74, secure: true, failsWith: 'Wrong password' },
  { ssid: 'Open-Cafe', rssi: -82, secure: false },
];
export const KB: Record<string, string[]> = {
  lower: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  upper: ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
  nums: ['1234567890', '-/:;()€&@"', '.,?!\'#%*+='],
};

export const REPO = 'daangeijs/ha-paper';
/** mDNS name. Firmware: ha-paper-<last 4 hex digits of the Wi-Fi MAC> (net/wifi_mgr.h hostname()), so two displays on
 *  one network don't clash. The emulator and the device simulator use this fixed fake id (also the firmware host-render
 *  placeholder, app/services.h). */
export const HOSTNAME = 'ha-paper-a1b2';
export const HOST = HOSTNAME + '.local';
/** The emulated display's address on the home network. Device QR codes use it (phones often can't resolve .local);
 *  text shows both, "ha-paper-a1b2.local or 192.168.1.42". */
export const SIM_IP = '192.168.1.42';
// Status icon set: 24-unit grid, drawn at 20 px, 2 px round stroke; only the moon is filled.
export const ICON = {
  offline: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5v.01M3 3l18 18',
  update: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  alert: 'M12 3l10 18H2zM12 10v4.5M12 17.5v.01',
  sync: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  check: 'M4 12.5l5 5L20 6.5',
  away: 'M3 11l9-7 9 7M5 10v10h14V10M9.5 15h5',
  night: 'M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z',
  light: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  unlinked: 'M9 15l6-6M10.5 6.5l1-1a4 4 0 0 1 5.7 5.7l-1 1M13.5 17.5l-1 1a4 4 0 0 1-5.7-5.7l1-1M3 3l3 3M18 18l3 3',
};
export const FW_INSTALLED = '0.1.0-alpha.4';   // latest tag; the firmware reports X4_FW_VERSION (git describe)
export type Release = { version: string; size: number; notes: string[] };
export const INITIAL_RELEASES: Record<'stable' | 'beta', Release> = {
  stable: { version: '0.4.0', size: 1.42, notes: ['Swipe left/right to change page', 'Lights grouped by room', 'Night face keeps time more accurately'] },
  beta: { version: '0.5.0-beta.1', size: 1.47, notes: ['Weather on the Home screen', 'Faster Home Assistant reconnect', 'Experimental: EV charging tile'] },
};

/** Live HA data (mock) and its derived values. */
export type HaData = { solar: number; home: number; batt: number; grid: number; soc: number;
  zones: Record<string, { cur: number; set: number }>; lights: Record<string, { on: boolean; b: number }> };
export type Derived = HaData & { usedToday: number; solarToday: number; heatingCount: number; exportToday: number; importToday: number };

/** `label`: English (config defaults, HA names); the display shows tr(lang, lk). */
type EntDef = { label: string; lk: StrKey; get: (d: Derived, lang?: Lang) => { v: string; u: string; sub: string } };
/** Stat tile subtitle (issue #28, spec/test-vectors/stat-sub.json): a fact or nothing, never filler like "Right now".
 *  Power tiles add today's energy; grid/battery keep the direction because the value is unsigned (kw()). */
const today = (kwh: number, lg: Lang) => tr(lg, 'kwhToday', fmtNum(kwh, 'kWh'));
const cheapAvg = () => PRICES.slice(CHEAP, CHEAP + 3).reduce((a, b) => a + b, 0) / 3;
const ENT_DEFS: Record<string, Omit<EntDef, 'label'>> = {
  'sensor.solar_power': { lk: 'solar', get: (d, lg = 'en') => ({ ...kw(d.solar), sub: d.solar > 0 ? today(d.solarToday, lg) : tr(lg, 'noSun') }) },
  'sensor.home_power': { lk: 'homeUse', get: (d, lg = 'en') => ({ ...kw(d.home), sub: today(d.usedToday, lg) }) },
  'sensor.grid_power': { lk: 'grid', get: (d, lg = 'en') => ({ ...kw(d.grid), sub: d.grid > 30 ? tr(lg, 'gridIn') + ' · ' + today(d.importToday, lg) : d.grid < -30 ? tr(lg, 'gridOut') + ' · ' + today(d.exportToday, lg) : tr(lg, 'balanced') }) },
  'sensor.battery_power': { lk: 'batteryFlow', get: (d, lg = 'en') => ({ ...kw(d.batt), sub: tr(lg, d.batt > 30 ? 'batCharging' : d.batt < -30 ? 'batDischarging' : 'idle') + ' · ' + fmtNum(d.soc, '%') + '%' }) },
  'sensor.energy_today': { lk: 'usedToday', get: (d) => ({ v: fmtNum(d.usedToday, 'kWh'), u: 'kWh', sub: '' }) },
  'sensor.solar_today': { lk: 'solarToday', get: (d, lg = 'en') => ({ v: fmtNum(d.solarToday, 'kWh'), u: 'kWh', sub: tr(lg, 'solarForecast', fmtNum(SOLAR.reduce((a, b) => a + b, 0), 'kWh')) }) },
  'sensor.grid_import_today': { lk: 'imported', get: (d) => ({ v: fmtNum(d.importToday, 'kWh'), u: 'kWh', sub: '' }) },
  'sensor.grid_export_today': { lk: 'exported', get: (d) => ({ v: fmtNum(d.exportToday, 'kWh'), u: 'kWh', sub: '' }) },
  'sensor.price_min': { lk: 'lowest', get: (_d, lg = 'en') => ({ v: money(Math.min(...PRICES)), u: '', sub: tr(lg, 'atHour', pad(PRICES.indexOf(Math.min(...PRICES))) + ':00') }) },
  'sensor.price_max': { lk: 'highest', get: (_d, lg = 'en') => ({ v: money(Math.max(...PRICES)), u: '', sub: tr(lg, 'atHour', pad(PRICES.indexOf(Math.max(...PRICES))) + ':00') }) },
  'sensor.price_cheap_window': { lk: 'cheapest3h', get: (_d, lg = 'en') => ({ v: pad(CHEAP) + '–' + pad(CHEAP + 3), u: '', sub: tr(lg, 'avgPrice', money(cheapAvg())) }) },
  'sensor.living_temperature': { lk: 'inside', get: (d, lg = 'en') => ({ v: fmtNum(d.zones.living.cur, '°C'), u: '°C', sub: d.heatingCount === 1 ? tr(lg, 'roomHeating1') : tr(lg, 'roomsHeating', d.heatingCount) }) },
};
export const ENT: Record<string, EntDef> = Object.fromEntries(Object.entries(ENT_DEFS).map(([id, e]) => [id, { ...e, label: tr('en', e.lk) }]));

// Apps group screens. Top-left switches app; the middle of the pager shows the pages inside the current app.
export type App = { id: string; title: string; desc: StrKey; icon: string };
export const APPS: App[] = [
  { id: 'home', title: 'Home', desc: 'appDescHome', icon: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6' },
  { id: 'house', title: 'House', desc: 'appDescHouse', icon: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0zM12 17h.01' },
  { id: 'travel', title: 'Travel', desc: 'appDescTravel', icon: 'M7 3h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 11h16M8.5 21l1.5-3M15.5 21l-1.5-3' },
  { id: 'settings', title: 'Settings', desc: 'appDescSettings', icon: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4' },
];
export const APP: Record<string, App> = Object.fromEntries(APPS.map((a) => [a.id, a]));

/** `label`: English (config, console defaults); the display and console show tr(lang, lk). */
/** `info`: what the setting does (#190): the console's (i), the hint on a tall Settings tile on the device. */
export type SettingDef = { label: string; lk: StrKey; info?: StrKey; fmt: (v: any, lang?: Lang) => string; step?: number; min?: number; max?: number; steps?: (string | number)[] };
const SETTING_DEFS: Record<string, Omit<SettingDef, 'label'>> = {
  brightness: { lk: 'setBrightness', fmt: (v, lg = 'en') => (v === 0 ? tr(lg, 'off') : v + '%'), step: 10, min: 0, max: 100 },
  warmth: { lk: 'setWarmth', fmt: (v) => v + '%', step: 10, min: 0, max: 100 },
  // Front light timeout (#220), seconds; 0 = never.
  lightTimeout: { lk: 'setLightTimeout', info: 'infoLightTimeout', fmt: (v, lg = 'en') => (v === 0 ? tr(lg, 'never') : v < 60 ? tr(lg, 'afterSec', v) : tr(lg, 'afterMin', v / 60)), steps: [30, 60, 120, 300, 0] },
  night: { lk: 'setNight', fmt: (v, lg = 'en') => (v === 'off' ? tr(lg, 'off') : v.split('-').map((x: string) => pad(+x)).join('–')), steps: ['off', '22-06', '23-07', '00-06'] },
  returnHome: { lk: 'setReturnHome', fmt: (v, lg = 'en') => (v === 0 ? tr(lg, 'never') : tr(lg, 'afterMin', v)), steps: [0, 1, 5, 15] },
  standby: { lk: 'setStandby', info: 'infoStandby', fmt: (v, lg = 'en') => (v === 0 ? tr(lg, 'never') : tr(lg, 'afterMin', v)), steps: [0, 10, 30, 60] },
  clock: { lk: 'setClock', fmt: (v, lg = 'en') => tr(lg, v === '24' ? 'hour24' : 'hour12'), steps: ['24', '12'] },
  interval: { lk: 'setInterval', info: 'infoInterval', fmt: (v, lg = 'en') => tr(lg, 'everySec', v), steps: [5, 10, 30, 60] },
  // Scheduled clean refresh (#26), minutes. Older screens.yaml files name the tile `fullEvery` (SETTING_CFG maps it here).
  cleanEvery: { lk: 'setCleanEvery', info: 'infoCleanEvery', fmt: (v, lg = 'en') => (v === 60 ? tr(lg, 'hourly') : v === 120 ? tr(lg, 'every2h') : tr(lg, 'everyMin', v)), steps: [30, 60, 120] },
  style: { lk: 'setStyle', fmt: (v, lg = 'en') => tr(lg, v === 'sleek' ? 'styleSleek' : 'styleClassic'), steps: ['classic', 'sleek'] },
  typeface: { lk: 'setTypeface', fmt: (v) => ({ archivo: 'Archivo', bricolage: 'Bricolage', fraunces: 'Fraunces', geist: 'Geist' } as Record<string, string>)[v] || String(v), steps: ['archivo', 'bricolage', 'fraunces', 'geist'] },
  surface: { lk: 'setSurface', fmt: (v, lg = 'en') => tr(lg, v === 'dots' ? 'surfDots' : 'surfDither'), steps: ['dither', 'dots'] },
  // Power (ROBUSTNESS_PLAN Phase 3, src/core/power.ts; glance #10). GET/PUT /settings `display`.
  powerSave: { lk: 'setPowerSave', info: 'infoPowerSave', fmt: (v, lg = 'en') => { const k = ({ off: 'psOff', night: 'psNight', standby: 'psStandby', glance: 'psGlance' } as Record<string, StrKey>)[v]; return k ? tr(lg, k) : String(v); }, steps: ['glance', 'night', 'standby', 'off'] },
  wakeEvery: { lk: 'setWakeEvery', info: 'infoWakeEvery', fmt: (v) => v + ' min', steps: [15, 30, 60] },
  liveMin: { lk: 'setLiveMin', info: 'infoLiveMin', fmt: (v) => v + ' min', steps: [1, 3, 5, 10] },
};
export const SETTINGS: Record<string, SettingDef> = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, { ...d, label: tr('en', d.lk) }]));
/** Settings tile key (screens.yaml) → emulator cfg key, where they differ. Legacy `fullEvery` tiles step the clean interval (#26, #44). */
export const SETTING_CFG: Record<string, string> = { fullEvery: 'cleanEvery' };
SETTINGS.fullEvery = SETTINGS.cleanEvery;

// ---------- Home Assistant entity registry (mock): what GET /api/v1/ha/entities lists for the console's entity picker.
/** `state`: HA's state when the display read the list (absent from firmware before #84). `dp`: HA display_precision (#85). */
/** One GET /ha/entities row; `area`: HA area id (entity or device area, #127), absent = none. */
export type HaEntity = { id: string; name: string; unit: string; state?: string; dp?: number; area?: string };
/** Extra HA entities (beyond the logical sensors and the lights) with a mock state. */
export const EXTRA_ENTITIES: (HaEntity & { state: string })[] = [
  { id: 'sensor.outdoor_temperature', name: 'Outdoor temperature', unit: '°C', state: '11.4' },
  { id: 'sensor.outdoor_humidity', name: 'Outdoor humidity', unit: '%', state: '78.4', dp: 0 },
  { id: 'sensor.phone_battery', name: 'Phone battery', unit: '%', state: '57' },
  { id: 'sensor.car_battery', name: 'Car battery', unit: '%', state: '82' },
  { id: 'binary_sensor.front_door', name: 'Front door', unit: '', state: 'off' },
  { id: 'binary_sensor.washing_machine', name: 'Washing machine running', unit: '', state: 'on' },
  { id: 'input_number.target_temp', name: 'Target temperature', unit: '°C', state: '20.5' },
  { id: 'number.ev_charge_limit', name: 'EV charge limit', unit: '%', state: '80' },
  { id: 'switch.coffee_machine', name: 'Coffee machine', unit: '', state: 'off' },
  { id: 'switch.garden_pump', name: 'Garden pump', unit: '', state: 'off' },
  { id: 'input_boolean.guest_mode', name: 'Guest mode', unit: '', state: 'off' },
  { id: 'fan.attic', name: 'Attic fan', unit: '', state: 'on' },
  { id: 'scene.movie_night', name: 'Movie night', unit: '', state: 'unknown' },   // scene tile (#146): unknown until it first runs
  { id: 'script.good_night', name: 'Good night', unit: '', state: 'off' },
  { id: 'sensor.garden_temperature', name: 'Garden temperature', unit: '°C', state: 'unavailable' },   // a Zigbee sensor with a flat battery (#86)
  // forecast series (#283): a rain nowcast with a `forecast` list of 5-minute {datetime, precipitation} entries ±2 h,
  // and a weather entity answering weather.get_forecasts (fake HA; the emulator draws core demoForecast)
  { id: 'binary_sensor.rain_expected', name: 'Rain expected', unit: '', state: 'on' },
  { id: 'weather.home', name: 'Home weather', unit: '', state: 'cloudy' },
];
const ENT_UNIT: Record<string, string> = { 'sensor.living_temperature': '°C' };
/** Everything the mock HA offers to the picker: logical sensors, lights, extras. */
export const HA_ENTITIES: HaEntity[] = [
  ...Object.keys(ENT).map((id) => ({ id, name: ENT[id].label, unit: ENT_UNIT[id] || (/_today$/.test(id) ? 'kWh' : /_power$/.test(id) ? 'W' : '') })),
  { id: 'sensor.home_battery_soc', name: 'Home battery', unit: '%' },
  ...LIGHT_LIST.map((l) => ({ id: 'light.' + l.id, name: ROOM_NAME[l.room] + ' · ' + l.name, unit: '', area: l.room })),
  ...ZONE_LIST.map((z) => ({ id: 'climate.' + z.id, name: z.name, unit: '°C', ...(ROOM_NAME[z.id] ? { area: z.id } : {}) })),   // zoneList picker (#127)
  ...EXTRA_ENTITIES.map(({ id, name, unit }) => ({ id, name, unit })),
];

/** Web console widget palette. Entity widgets ("Home Assistant") are added empty-handed: the console selects them so the user picks the entity. */
export const PALETTE = [
  { kind: 'ha', label: 'Sensor value', w: { type: 'stat' } },
  { kind: 'ha', label: 'Gauge (percentage)', w: { type: 'gauge', entity: 'sensor.home_battery_soc' } },
  { kind: 'ha', label: 'Switch', w: { type: 'switch' } },
  { kind: 'stat', label: 'Solar now', w: { type: 'stat', entity: 'sensor.solar_power' } },
  { kind: 'stat', label: 'Home use', w: { type: 'stat', entity: 'sensor.home_power' } },
  { kind: 'stat', label: 'Grid', w: { type: 'stat', entity: 'sensor.grid_power' } },
  { kind: 'stat', label: 'Battery flow', w: { type: 'stat', entity: 'sensor.battery_power' } },
  { kind: 'stat', label: 'Used today', w: { type: 'stat', entity: 'sensor.energy_today' } },
  { kind: 'stat', label: 'Solar today', w: { type: 'stat', entity: 'sensor.solar_today' } },
  { kind: 'stat', label: 'Inside temp', w: { type: 'stat', entity: 'sensor.living_temperature' } },
  { kind: 'stat', label: 'Cheapest 3h', w: { type: 'stat', entity: 'sensor.price_cheap_window' } },
  { kind: 'gauge', label: 'Home battery', w: { type: 'gauge' } },
  { kind: 'price', label: 'Price now', w: { type: 'price' } },
  { kind: 'clock', label: 'Clock (2 wide)', w: { type: 'clock', cs: 2 } },
  { kind: 'chart', label: 'Prices (4 wide)', w: { type: 'bars', series: 'prices', cs: 4 } },
  { kind: 'chart', label: 'Usage (2 wide)', w: { type: 'bars', series: 'usage', cs: 2 } },
  { kind: 'chart', label: 'Solar (2 wide)', w: { type: 'bars', series: 'solar', cs: 2 } },
  { kind: 'chart', label: 'History (4 wide)', w: { type: 'history', cs: 4 } },   // #267: any numeric sensor over a window
  { kind: 'climate', label: 'All rooms (full)', w: { type: 'zoneList', cs: 4, rs: 2 } },
  { kind: 'climate', label: 'Room thermostat (tall)', w: { type: 'thermo', rs: 2 } },
  { kind: 'light', label: 'All lights (full)', w: { type: 'lightList', cs: 4, rs: 2 } },
  { kind: 'light', label: 'Light', w: { type: 'switch' }, prefer: 'light' },   // lights first in the picker (#184)
  { kind: 'scene', label: 'Scene or script', w: { type: 'scene', cs: 2 } },
  { kind: 'scene', label: 'All lights off', w: { type: 'scene', scene: 'all_off', cs: 2 } },
  { kind: 'travel', label: 'Route', w: { type: 'route', cs: 2 } },
];
export const PAL_GROUPS: [string, string][] = [['ha', 'Home Assistant'], ['stat', 'Energy numbers'], ['price', 'Energy'], ['gauge', 'Energy'], ['chart', 'Charts'], ['clock', 'Basics'], ['travel', 'Travel'], ['light', 'Lights'], ['scene', 'Lights'], ['climate', 'Heating']];

export const SCHEMA: { type: string; fields: string }[] = [
  { type: 'stat', fields: 'entity: sensor.solar_power, sensor.home_power, …' }, { type: 'price', fields: 'price now, cheap/high label; label' },
  { type: 'bars', fields: 'series: prices | usage | solar, label' }, { type: 'gauge', fields: 'home battery' }, { type: 'clock', fields: 'time and date' },
  { type: 'route', fields: 'label, mode: train | bus | car, entity: sensor.…' }, { type: 'lightList', fields: 'all lights by area (full screen)' },
  { type: 'switch', fields: 'entity: switch.… | light.… | input_boolean.… | fan.…' }, { type: 'zoneList', fields: 'all climate entities (full screen)' },
  { type: 'thermo', fields: 'zone: climate object id, label' }, { type: 'history', fields: 'entity: sensor.… | input_number.… | number.…, window, bucket, agg, style, min, max, label; attribute, value, time, ahead (a list in an attribute); weather.…, forecast: hourly | daily' }, { type: 'scene', fields: 'entity: scene.… | script.…, label; none = all lights off' },
];

export const ENDPOINTS: [string, string, string, string][] = [
  ['GET', '/api/v1/status', 'Device, battery, Wi-Fi, Home Assistant link', 'read'],
  ['GET', '/api/v1/config', 'All screens as YAML (JSON with Accept header)', 'read'],
  ['PUT', '/api/v1/config', 'Replace all screens; checked first, applied with one redraw', 'write'],
  ['POST', '/api/v1/config/validate', 'Check a YAML file without applying it', 'read'],
  ['GET', '/api/v1/screens/{id}/preview.png', 'What the panel shows, 800 × 480', 'read'],
  ['GET', '/api/v1/screens/{id}/values', 'Each tile’s live value, formatted like the display', 'read'],
  ['POST', '/api/v1/display/refresh', 'Force one clean full redraw', 'write'],
  ['POST', '/api/v1/ota', 'Install the latest firmware release now', 'write'],
];
