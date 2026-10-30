// A tiny fake Home Assistant for the device simulator (npm run device-sim -- --fake-ha).
//   GET/POST /auth/authorize   login page (any user name, "administrator" checkbox) → 302 redirect_uri?code&state
//   POST /auth/token           authorization_code (+ PKCE S256 when a challenge was sent) and refresh_token; 400 invalid_grant
//   POST /auth/revoke          revoke a refresh token (always 200, like HA)
//   POST /api/states/<id>      create/replace a state (admin only, like HA; 201 new, 200 existing): device health (eink-ha-os#32)
//   GET  /api/websocket        auth, auth/current_user, get_states, subscribe_entities, subscribe_events (state_changed),
//                              call_service (weather.get_forecasts, calendar.get_events with return_response, eink-ha-os#283, eink-ha-os#316), energy/get_prefs, config/area_registry/list, config/entity_registry/list,
//                              render_template (only the firmware's discovery / seed templates),
//                              recorder/statistics_during_period + history/history_during_period (./fake-ha-history.ts, eink-ha-os#266)
//   /__fake/*                  test control (standalone `npm run fake-ha`, e.g. for the QEMU firmware contract run):
//                              POST revoke-all · POST state {entity_id,state,attributes} · GET calls · POST llat {name,admin}
//                              · GET posted (every POST /api/states, newest last) · POST big-house {n} (eink-ha-os#57)
//                              · GET template-errors (undefined attribute reads in render_template, see templateWarnings)
//                              · POST seed-fail {error} (the seed template answers with an ERROR event; {} = normal)
//                              · POST restart {down_s} (HA restarts: sockets closed, port refused for down_s, tokens kept)
//                              · POST drop-ws (every WebSocket's TCP connection destroyed, no close frame)
//                              · POST tls {mode: ok|hang|slow|reset, delay_s} (new https connections: handshake as normal,
//                                never answered, answered after delay_s, or TCP reset on the ClientHello; eink-ha-os#87)
//                              · POST tls-reset (TCP reset on every open https connection, WebSockets included)
//                              · GET state: entities, refresh_tokens, connections, sessions (WebSocket auth_ok so far), users
//                              · GET entities: every entity_id (eink-ha-os#82: seeded tiles must name one of them)
//                              · POST price-sensor {entity_id?, days?} (a Frank Energie-shaped price sensor: `prices` =
//                                days × 96 quarter-hours {from,till,price} from local midnight, `prices_today` = today's 96, eink-ha-os#149)
//                              · POST language {language, number_format?} (get_config's `language`, eink-ha-os#98; the Dutch houses
//                                start with nl; number_format = the user profile's, frontend/get_user_data "language", eink-ha-os#110;
//                                time_zone / currency = get_config's, eink-ha-os#147)
//                              · GET history: recorder entities, seed, chatty, calls (statistics/history requests, newest
//                                last) · POST history {seed?, chatty?, entities?: [{id, model, kind?}], states?, reset_calls?}
//                                (states: put the recorder entities' current values into the house; chatty = sensor.chatty_power, eink-ha-os#266)
//                              · POST energy-prefs {variant: flat-grid|house} (energy/get_prefs with one HA 2025.12+ flat grid
//                                source sensor.flat_grid_* instead of the house's grid flows, eink-ha-os#274; house = back to normal)
// Houses: 'demo' (default) = the emulator's mock data (src/core/data.ts), changing periodically;
// 'stranger' = somebody else's HA (./fake-ha-stranger.ts, eink-ha-os#23) to test first-run screens; 'big' = demo + ~1200 entities
// with long attributes (./fake-ha-big.ts, eink-ha-os#57); 'dutch' / 'dutch-energy' = SolarEdge + P1 + Anker battery + tado, Dutch names,
// without / with an Energy dashboard (./fake-ha-dutch.ts, eink-ha-os#82); 'real' = ~1050 anonymised entities shaped like a real HA,
// with a device registry (areas via devices) and display_precision in the entity registry (./fake-ha-real.ts, eink-ha-os#88).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { ENT, LIGHT_LIST, PRICES, ROOMS, ROOM_NAME, SOLAR, USAGE, ZONE_LIST, CHEAP, EXTRA_ENTITIES, DEMO_BINS, demoBinState, DEMO_BIRDS, demoBirds } from '../src/core/data.ts';
import { pad } from '../src/core/format.ts';
import { demoForecast } from '../src/core/historyChart.ts';
import { DEMO_WEATHER_ATTRS } from '../src/core/weather.ts';
import { demoEvents } from '../src/core/agenda.ts';
import { LIGHT_GROUP_ATTRS, SEED_CAPS, sensorKind, type ClimateRow, type HaSnapshot, type LightRow, type SensorRow } from '../src/core/seed.ts';
import { acceptWebSocket, type WsConn } from './ws.ts';
import { BIG_HOUSE_EXTRA, bigHouseEntities } from './fake-ha-big.ts';
import { STRANGER_AREAS, STRANGER_CONFIG, STRANGER_ENTITIES, STRANGER_PREFS } from './fake-ha-stranger.ts';
import { DUTCH_AREAS, DUTCH_ENTITIES, DUTCH_PREFS } from './fake-ha-dutch.ts';
import { entityListAnswer } from '../src/core/entityList.ts';
import { DEMO_MEDIA } from '../src/core/data.ts';
import { REAL_AREAS, REAL_CONFIG, REAL_DEVICES, REAL_ENTITIES, REAL_PREFS, type RealDevice } from './fake-ha-real.ts';
import { pkceChallenge, randomToken } from './ha-client.ts';
import { FakeHistory, histEntity, type HistModel, type HistKind } from './fake-ha-history.ts';

export type EntityState = { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string };
type User = { id: string; name: string; isAdmin: boolean };
type Code = { clientId: string; redirectUri: string; challenge: string | null; user: User; exp: number };

export type House = 'demo' | 'stranger' | 'big' | 'dutch' | 'dutch-energy' | 'real';
export const HOUSES: House[] = ['demo', 'stranger', 'big', 'dutch', 'dutch-energy', 'real'];
export type FakeHaOptions = { port?: number; host?: string; tickMs?: number; accessTtlS?: number; version?: string; house?: House; log?: (m: string) => void };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nowIso = () => new Date().toISOString();

const UNITS: Record<string, string> = {
  'sensor.solar_power': 'W', 'sensor.home_power': 'W', 'sensor.grid_power': 'W', 'sensor.battery_power': 'W',
  'sensor.energy_today': 'kWh', 'sensor.solar_today': 'kWh', 'sensor.grid_import_today': 'kWh', 'sensor.grid_export_today': 'kWh',
  'sensor.price_min': '€/kWh', 'sensor.price_max': '€/kWh', 'sensor.living_temperature': '°C', 'sensor.electricity_price': '€/kWh', 'sensor.home_battery_soc': '%',
};

function initialStates(): Map<string, EntityState> {
  const h = new Date().getHours();
  const solar = Math.round(SOLAR[h] * 1000), home = Math.round(USAGE[h] * 1000);
  const sum = (a: number[], n: number) => a.slice(0, n).reduce((x, y) => x + y, 0);
  const vals: Record<string, string> = {
    'sensor.solar_power': String(solar), 'sensor.home_power': String(home), 'sensor.grid_power': String(home - solar), 'sensor.battery_power': '0',
    'sensor.energy_today': sum(USAGE, h).toFixed(2), 'sensor.solar_today': sum(SOLAR, h).toFixed(2),
    'sensor.grid_import_today': (sum(USAGE, h) * 0.6).toFixed(2), 'sensor.grid_export_today': (sum(SOLAR, h) * 0.4).toFixed(2),
    'sensor.price_min': Math.min(...PRICES).toFixed(2), 'sensor.price_max': Math.max(...PRICES).toFixed(2),
    'sensor.price_cheap_window': pad(CHEAP) + ':00', 'sensor.living_temperature': String(ZONE_LIST[0].cur),
    'sensor.electricity_price': PRICES[h].toFixed(2), 'sensor.home_battery_soc': '64',
  };
  const m = new Map<string, EntityState>();
  const put = (id: string, state: string, attributes: Record<string, unknown>) => m.set(id, { entity_id: id, state, attributes, last_changed: nowIso(), last_updated: nowIso() });
  for (const id of Object.keys(vals)) put(id, vals[id], { friendly_name: (ENT[id] && ENT[id].label) || id, ...(UNITS[id] ? { unit_of_measurement: UNITS[id] } : {}) });
  // Like the Nord Pool integration: 24 hourly prices for today on the Energy dashboard's price entity
  // (the firmware maps it onto sensor.energy_prices, core/entity_map.cpp).
  m.get('sensor.electricity_price')!.attributes.today = [...PRICES];
  for (const z of ZONE_LIST) put('climate.' + z.id, 'heat', { friendly_name: z.name, current_temperature: z.cur, temperature: z.set, hvac_modes: ['off', 'heat', 'auto'], preset_mode: 'home', ...(z.presets.length ? { preset_modes: z.presets } : {}) });
  for (const l of LIGHT_LIST) put('light.' + l.id, l.on ? 'on' : 'off', { friendly_name: ROOM_NAME[l.room] + ' ' + l.name, ...(l.dim ? { brightness: l.on ? Math.round(l.b * 2.55) : null, supported_color_modes: ['brightness'] } : { supported_color_modes: ['onoff'] }) });
  put('scene.all_off', 'unknown', { friendly_name: 'All lights off' });
  for (const e of EXTRA_ENTITIES) put(e.id, e.state, { friendly_name: e.name, ...(e.unit ? { unit_of_measurement: e.unit } : {}), ...(e.dc ? { device_class: e.dc } : {}),
    ...(e.id.startsWith('zone.') ? { persons: [], radius: 100, passive: false } : {}) });   // eink-ha-os#331: zone state = persons in it; POST /__fake/state sets it
  for (const id of ['sensor.living_temperature', 'sensor.outdoor_temperature']) m.get(id)!.attributes.device_class = 'temperature';
  m.get('sensor.outdoor_humidity')!.attributes.device_class = 'humidity';
  Object.assign(m.get('binary_sensor.rain_expected')!.attributes, { device_class: 'moisture', forecast: rainForecast(Date.now()) });
  // eink-ha-os#317: bin sensors in both shapes, dated from today (afvalwijzer date state; waste_collection_schedule days-to + daysTo)
  for (const b of DEMO_BINS) { const v = demoBinState(b, new Date()); put(b.id, v.state, { friendly_name: b.name, ...v.attrs }); }
  // eink-ha-os#332: the rare birds recipe's sensor (docs/recipes/rare-birds.md), made-up places, dated back from now
  { const v = demoBirds(new Date()); put(DEMO_BIRDS.id, v.state, v.attrs); }
  Object.assign(m.get('weather.home')!.attributes, DEMO_WEATHER_ATTRS);   // eink-ha-os#318: + feels, wind (Beaufort) for the weather tile
  Object.assign(m.get(DEMO_MEDIA.id)!.attributes, { media_title: DEMO_MEDIA.queue[0].title, media_artist: DEMO_MEDIA.queue[0].artist, volume_level: DEMO_MEDIA.volume,   // eink-ha-os#319
    is_volume_muted: false, media_content_type: 'music', media_position: 0, supported_features: DEMO_MEDIA.features });
  return m;
}

/** A rain nowcast attribute (eink-ha-os#283, shaped like a radar integration's): 5-minute {datetime (UTC ISO), precipitation
 *  (mm/h)} from 2 h before to 2 h after now, a shower about an hour ahead. */
export const rainForecast = (now: number) => demoForecast('precipitation', 'datetime', 5 * 60_000, now, 0, 2 * 3_600_000);
/** weather.get_forecasts (eink-ha-os#283): hourly = 48 h from the current hour, daily = 7 days from today (UTC), with
 *  temperature, precipitation and a condition. */
export function weatherForecast(type: string, now: number): Record<string, string | number>[] | null {
  const step = type === 'hourly' ? 3_600_000 : type === 'daily' ? 86_400_000 : 0; if (!step) return null;
  const n = type === 'hourly' ? 48 : 7, from = Math.floor(now / step) * step;
  const temp = demoForecast('temperature', 'datetime', step, from + 2 * 3_600_000, 0, n * step), rain = demoForecast('precipitation', 'datetime', step, from + 2 * 3_600_000, 0, n * step);
  return temp.filter((e) => Date.parse(String(e.datetime)) >= from).slice(0, n).map((e, i) => {
    const p = Number(rain.find((r) => r.datetime === e.datetime)?.precipitation ?? 0);
    // eink-ha-os#318: more conditions (the weather tile's drawings) and wind
    return { datetime: e.datetime, condition: p > 2 ? 'pouring' : p > 0.5 ? 'rainy' : i % 5 === 0 ? 'partlycloudy' : i % 3 === 1 ? 'sunny' : 'cloudy', temperature: e.temperature, precipitation: p,
      wind_speed: 3 + (i % 4), wind_bearing: (180 + i * 20) % 360, ...(type === 'daily' ? { templow: Number(e.temperature) - 6 } : {}) };
  });
}

const DEMO_PREFS = {
  energy_sources: [
    { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.grid_import_today', entity_energy_price: 'sensor.electricity_price' }], flow_to: [{ stat_energy_to: 'sensor.grid_export_today' }], cost_adjustment_day: 0 },
    { type: 'solar', stat_energy_from: 'sensor.solar_today', config_entry_solar_forecast: null },
    { type: 'battery', stat_energy_from: 'sensor.battery_discharge_today', stat_energy_to: 'sensor.battery_charge_today' },
  ],
  device_consumption: [],
};

/** POST /__fake/energy-prefs {variant: 'flat-grid'}: the house's grid sources replaced by one HA 2025.12+ flat grid
 * source (no flow_from / flow_to, eink-ha-os#274); {variant: 'house'} restores the house's prefs. */
export const FLAT_GRID = { type: 'grid', stat_energy_from: 'sensor.flat_grid_import', stat_energy_to: 'sensor.flat_grid_export', stat_cost: null,
  entity_energy_price: 'sensor.flat_grid_price', number_energy_price: null, entity_energy_price_export: 'sensor.flat_grid_price_export',
  number_energy_price_export: null, stat_rate: 'sensor.flat_grid_power', cost_adjustment_day: 0 };
export function flatGridPrefs(prefs: unknown): unknown {
  const p = (prefs && typeof prefs === 'object' ? prefs : { device_consumption: [] }) as { energy_sources?: { type?: string }[] };
  return { ...p, energy_sources: [FLAT_GRID, ...(p.energy_sources ?? []).filter((s) => s?.type !== 'grid')] };
}

/** areaOf: the area HA's area_id() template answers (the entity's own, else its device's). With a device registry
 *  (`reg`): the entity registry's own area_id, device_id, display_precision, and the devices. */
type DeviceReg = { devices: RealDevice[]; deviceOf: Map<string, string>; entityArea: Map<string, string>; dp: Map<string, number> };
type HouseData = { states: Map<string, EntityState>; prefs: unknown; areas: [string, string][]; areaOf: Map<string, string>; reg?: DeviceReg };
export function houseData(h: House): HouseData {
  if (h === 'real') {
    const states = new Map<string, EntityState>(); const areaOf = new Map<string, string>();
    const reg: DeviceReg = { devices: REAL_DEVICES, deviceOf: new Map(), entityArea: new Map(), dp: new Map() };
    const devArea = new Map(REAL_DEVICES.map((d) => [d.id, d.area]));
    for (const e of REAL_ENTITIES) {
      states.set(e.id, { entity_id: e.id, state: e.state, attributes: JSON.parse(JSON.stringify(e.attrs)), last_changed: nowIso(), last_updated: nowIso() });
      const area = e.area ?? (e.device ? devArea.get(e.device) : null);
      if (area) areaOf.set(e.id, area);
      if (e.device) reg.deviceOf.set(e.id, e.device);
      if (e.area) reg.entityArea.set(e.id, e.area);
      if (e.dp !== undefined) reg.dp.set(e.id, e.dp);
    }
    return { states, prefs: REAL_PREFS, areas: REAL_AREAS, areaOf, reg };
  }
  if (h === 'stranger' || h === 'dutch' || h === 'dutch-energy') {
    const states = new Map<string, EntityState>(); const areaOf = new Map<string, string>();
    for (const e of h === 'stranger' ? STRANGER_ENTITIES : DUTCH_ENTITIES) {
      states.set(e.id, { entity_id: e.id, state: e.state, attributes: JSON.parse(JSON.stringify(e.attrs)), last_changed: nowIso(), last_updated: nowIso() });
      if (e.area) areaOf.set(e.id, e.area);
    }
    if (h === 'stranger') return { states, prefs: STRANGER_PREFS, areas: STRANGER_AREAS, areaOf };
    return { states, prefs: h === 'dutch' ? null : DUTCH_PREFS, areas: DUTCH_AREAS, areaOf };
  }
  const areaOf = new Map<string, string>(LIGHT_LIST.map((l) => ['light.' + l.id, l.room]));
  for (const z of ZONE_LIST) if (ROOM_NAME[z.id]) areaOf.set('climate.' + z.id, z.id);
  areaOf.set('sensor.living_temperature', 'living');
  return { states: initialStates(), prefs: DEMO_PREFS, areas: ROOMS, areaOf };
}

/**
 * What HA renders for SEED_TEMPLATE (src/core/seed.ts), computed from states + areas without Jinja. HA's
 * states.<domain> runs in entity_id order. `deviceOf` (entity → device): a climate on a device with a device_tracker
 * is a vehicle's.
 */
export function seedAnswer(states: Iterable<EntityState>, areas: [string, string][], areaOf: Map<string, string>, deviceOf?: Map<string, string>): HaSnapshot {
  const all = [...states].sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
  const dom = (d: string) => all.filter((e) => e.entity_id.startsWith(d + '.'));
  const sensors: SensorRow[] = [];
  const n: Record<string, number> = { t: 0, p: 0, e: 0, b: 0 };
  const caps: Record<string, number> = SEED_CAPS;
  for (const e of dom('sensor')) {
    const dc = String(e.attributes.device_class || ''), u = String(e.attributes.unit_of_measurement || '');
    const name = String(e.attributes.friendly_name ?? e.entity_id);
    let k = sensorKind(dc, u, (e.entity_id + ' ' + name).toLowerCase()) || (e.entity_id.startsWith('sensor.x4_route_') ? 'r' : '');
    if (k === 't' && ['unknown', 'unavailable'].includes(e.state)) k = '';
    if (k && k !== 'r') { if (n[k] >= caps[k]) k = ''; else n[k]++; }
    if (k) sensors.push([e.entity_id, dc, (k === 't' && areaOf.get(e.entity_id)) || '', name, u]);
  }
  const tracked = new Set([...(deviceOf || [])].filter(([e]) => e.startsWith('device_tracker.')).map(([, d]) => d));
  const car = (id: string) => tracked.has(deviceOf?.get(id) ?? '');
  return {
    areas: areas.map(([a, n]) => [a, n]),
    climate: dom('climate').filter((e) => !car(e.entity_id))
      .map((e): ClimateRow => [e.entity_id, String(e.attributes.friendly_name ?? e.entity_id), areaOf.get(e.entity_id) || '', e.state]),
    vehicles: dom('climate').map((e) => e.entity_id).filter(car),
    lights: dom('light').slice(0, 150).map((e): LightRow => [e.entity_id, areaOf.get(e.entity_id) || '', LIGHT_GROUP_ATTRS.some((a) => e.attributes[a]) ? 'g' : '']),
    sensors,
    weather: dom('weather').filter((e) => typeof e.attributes.temperature === 'number').map((e) => e.entity_id),
  };
}

/** HA's message for `x.attributes.<name>` on an entity without it (jinja2 Undefined on a ReadOnlyDict). */
export const attrUndefined = (name: string) => "'homeassistant.util.read_only_dict.ReadOnlyDict object' has no attribute '" + name + "'";

/**
 * Real HA's undefined handling for attribute reads (eink-ha-os#58), without Jinja. In HA `s.attributes.name` on an entity that
 * lacks `name` is a jinja2 Undefined: `| default(…)` and `.get('name')` are fine, any other use (`or`, `in`, output)
 * is reported: render_template with report_errors sends a WARNING event per use and still renders, strict: true fails
 * the render. The fake flags every direct read `x.attributes.name` (not `.get(`, not followed by `| default`) inside
 * a `{% for x in states[.<domain>] … %}…{% endfor %}` loop, once per looped entity that lacks the attribute.
 */
export function templateWarnings(template: string, states: Iterable<EntityState>): string[] {
  const all = [...states];
  const out: string[] = [];
  for (const loop of template.matchAll(/\{%-?\s*for (\w+) in states(?:\.(\w+))?\b[^%]*%\}([\s\S]*?)\{%-?\s*endfor/g)) {
    const [, v, dom, body] = loop;
    const attrs = new Set<string>();
    for (const m of body.matchAll(new RegExp('\\b' + v + '\\.attributes\\.(\\w+)(\\s*\\|\\s*default\\b)?', 'g'))) if (m[1] !== 'get' && !m[2]) attrs.add(m[1]);
    for (const e of all) {
      if (dom && !e.entity_id.startsWith(dom + '.')) continue;
      for (const a of attrs) if (!(a in e.attributes)) out.push(attrUndefined(a));
    }
  }
  return out;
}

/** Fault for new https connections (POST /__fake/tls). */
export type TlsFault = 'ok' | 'hang' | 'slow' | 'reset';

export class FakeHa {
  server: Server;
  url = '';
  states: Map<string, EntityState>;
  house: House;
  /** get_config `language` (eink-ha-os#98). */
  language: string;
  /** User profile number_format (frontend/get_user_data key "language", eink-ha-os#110); null = never set in the profile. */
  numberFormat: string | null = null;
  /** get_config `time_zone` and `currency` (eink-ha-os#147); the stranger lives in London and pays in pounds. */
  timeZone: string;
  currency: string;
  prefs: unknown;
  areas: [string, string][];
  areaOf: Map<string, string>;
  /** Device registry of the house ('real'); none = every entity's area is its own, no devices. */
  reg?: DeviceReg;
  users = new Map<string, User>();
  codes = new Map<string, Code>();
  refresh = new Map<string, { user: User; clientId: string }>();
  access = new Map<string, { user: User; exp: number }>();
  conns = new Set<{ ws: WsConn; user: User | null; subs: Map<number, string[] | null | 'events'> }>();
  /** Every service call, newest last (for tests / the simulator log). */
  calls: { domain: string; service: string; data: Record<string, unknown> }[] = [];
  /** Every POST /api/states/<id> accepted, newest last (last 200). */
  posted: { entity_id: string; state: string; attributes: Record<string, unknown>; user: string; t: string }[] = [];
  /** Every undefined-attribute report a render_template produced (templateWarnings), newest last (last 200). */
  templateErrors: string[] = [];
  /** Test knob: answer the seed template with this ERROR event instead of a result (POST /__fake/seed-fail). */
  seedFail: string | null = null;
  /** Recorder: statistics + history series and the request log (eink-ha-os#266). */
  history = new FakeHistory();
  /** WebSocket sessions that got auth_ok since start (a reconnect after a fault adds one). */
  sessions = 0;
  private port = 0;
  private restarting?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;
  private opts: Required<Omit<FakeHaOptions, 'log'>> & { log: (m: string) => void };

  constructor(opts: FakeHaOptions = {}) {
    this.opts = { port: opts.port ?? 8123, host: opts.host ?? '0.0.0.0', tickMs: opts.tickMs ?? 5000, accessTtlS: opts.accessTtlS ?? 1800, version: opts.version ?? '2026.10.0', house: opts.house ?? 'demo', log: opts.log ?? (() => {}) };
    this.house = this.opts.house;
    this.language = this.house.startsWith('dutch') ? 'nl' : 'en';
    ({ time_zone: this.timeZone, currency: this.currency } = this.house === 'stranger' ? STRANGER_CONFIG : this.house === 'real' ? REAL_CONFIG : { time_zone: 'Europe/Amsterdam', currency: 'EUR' });
    const hd = houseData(this.house);
    this.states = hd.states; this.prefs = hd.prefs; this.areas = hd.areas; this.areaOf = hd.areaOf; this.reg = hd.reg;
    if (this.house === 'big') this.bigHouse(BIG_HOUSE_EXTRA);
    this.server = createServer(this.onRequest);
    this.server.on('upgrade', this.onUpgrade);
  }
  private onRequest = (req: IncomingMessage, res: ServerResponse) => { this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }); };
  private onUpgrade = (req: IncomingMessage, socket: Duplex) => {
    if (new URL(req.url || '/', 'http://x').pathname !== '/api/websocket') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const ws = acceptWebSocket(req, socket); if (ws) this.wsSession(ws);
  };
  private tlsServer?: HttpsServer;
  /** Accepts the TCP connections of the https port and hands them to tlsServer, unless tlsFault says otherwise. */
  private tlsFront?: NetServer;
  private tlsSockets = new Set<Socket>();
  tlsFault: { mode: TlsFault; delayMs: number } = { mode: 'ok', delayMs: 0 };
  /** https connections accepted so far, per fault mode they met. */
  tlsAccepted: Record<TlsFault, number> = { ok: 0, hang: 0, slow: 0, reset: 0 };

  /** The same HA (tokens, states) over https too: the QEMU contract suite's real TLS handshake on the device (eink-ha-os#79). */
  async listenTls(port: number, tls: { key: string | Buffer; cert: string | Buffer }): Promise<string> {
    const s = createHttpsServer(tls, this.onRequest);
    s.on('upgrade', this.onUpgrade);
    this.tlsServer = s;
    const front = createNetServer((sock) => this.onTlsSocket(sock));
    await new Promise<void>((r) => front.listen(port, this.opts.host, r));
    this.tlsFront = front;
    return 'https://localhost:' + (front.address() as AddressInfo).port;
  }
  private onTlsSocket(sock: Socket) {
    this.tlsSockets.add(sock);
    sock.on('close', () => this.tlsSockets.delete(sock));
    sock.on('error', () => {});
    const { mode, delayMs } = this.tlsFault;
    this.tlsAccepted[mode]++;
    if (mode === 'hang') return;   // TCP accepted, the ClientHello is never read
    if (mode === 'reset') { sock.once('data', () => sock.resetAndDestroy()); return; }
    const go = () => { if (!sock.destroyed) this.tlsServer!.emit('connection', sock); };
    if (mode === 'slow') setTimeout(go, delayMs).unref(); else go();
  }
  /** TCP reset on every open https connection (a router or HA proxy dropping the TLS session mid-stream). */
  resetTls(): number {
    const n = this.tlsSockets.size;
    for (const s of this.tlsSockets) s.resetAndDestroy();
    return n;
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(this.opts.port, this.opts.host, r));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = 'http://localhost:' + this.port;
    if (this.opts.tickMs > 0) this.tick = setInterval(() => this.wiggle(), this.opts.tickMs);
    return this.url;
  }
  async close() {
    clearInterval(this.tick);
    clearTimeout(this.restarting);
    for (const c of this.conns) c.ws.close();
    this.server.closeAllConnections();
    for (const s of this.tlsSockets) s.destroy();
    if (this.tlsFront?.listening) await new Promise<void>((r) => this.tlsFront!.close(() => r()));
    if (this.server.listening) await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Like an HA restart: WebSockets closed (1001), port refused for downMs, then back on the same port with every
   *  token and state kept. */
  restart(downMs: number) {
    if (this.restarting || !this.server.listening) return;
    for (const c of this.conns) c.ws.close(1001);
    this.server.closeAllConnections();
    this.server.close();
    // The https port goes down too, or a device linked over TLS never notices the restart (eink-ha-os#123).
    const front = this.tlsFront?.listening ? this.tlsFront : undefined;
    const tlsPort = front ? (front.address() as AddressInfo).port : 0;
    if (front) { for (const s of this.tlsSockets) s.destroy(); front.close(); }
    this.opts.log(`restart: down for ${downMs} ms`);
    this.restarting = setTimeout(() => {
      this.restarting = undefined;
      this.server.listen(this.port, this.opts.host, () => this.opts.log('restart: up again'));
      if (front) front.listen(tlsPort, this.opts.host);
    }, downMs);
  }

  /** Destroy every WebSocket's TCP connection without a close frame (a dropped connection). */
  dropWs() { for (const c of this.conns) c.ws.drop(); }

  /** Pre-issue a refresh token (the simulator's 'installed' preset starts already linked). */
  issueRefreshToken(name: string, clientId: string, isAdmin = false): string {
    const user: User = this.users.get(name) || { id: randomToken(8), name, isAdmin }; this.users.set(name, user);
    const t = randomToken(32); this.refresh.set(t, { user, clientId }); return t;
  }

  /** A long-lived access token (HA profile › Security), for POST /api/v1/ha/token. */
  issueLongLived(name: string, isAdmin = true): string {
    const user: User = this.users.get(name) || { id: randomToken(8), name, isAdmin }; this.users.set(name, user);
    const t = 'llat_' + randomToken(32); this.access.set(t, { user, exp: Number.MAX_SAFE_INTEGER }); return t;
  }

  adoptRefreshToken(token: string, clientId: string, name: string) {
    if (this.refresh.has(token)) return;
    const user: User = this.users.get(name) || { id: randomToken(8), name, isAdmin: false }; this.users.set(name, user);
    this.refresh.set(token, { user, clientId });
  }

  /** Revoke every refresh token (like deleting the X4 display's tokens in the HA profile page). */
  revokeAll() { this.refresh.clear(); this.access.clear(); for (const c of this.conns) c.ws.close(); }

  /** Replace the generated `*.bulk_*` entities with `n` new ones (0 = remove them): the big house (eink-ha-os#57). */
  bigHouse(n: number) {
    for (const id of [...this.states.keys()]) if (id.includes('.bulk_')) this.states.delete(id);
    for (const [id, state, attributes] of bigHouseEntities(n)) this.states.set(id, { entity_id: id, state, attributes, last_changed: nowIso(), last_updated: nowIso() });
  }

  /**
   * A Frank Energie-like price sensor (eink-ha-os#149): ~8.5 KB of JSON per 96 quarter-hour entries in `prices` (today and the
   * following days) plus today's again in `prices_today`. Prices in €/kWh with 6 decimals, local offsets.
   */
  priceSensor(id = 'sensor.frank_energie_prices_current_electricity_price_all_in', days = 2): EntityState {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const off = -midnight.getTimezoneOffset(), oh = pad(Math.floor(Math.abs(off) / 60)), om = pad(Math.abs(off) % 60);
    const iso = (t: number) => { const d = new Date(t + off * 60000); return d.toISOString().slice(0, 19) + (off < 0 ? '-' : '+') + oh + ':' + om; };
    const prices = Array.from({ length: Math.max(1, days) * 96 }, (_, i) => {
      const t = midnight.getTime() + i * 900_000;
      return { from: iso(t), till: iso(t + 900_000), price: Number((0.18 + 0.12 * Math.sin((i % 96) / 96 * 2 * Math.PI - 2) + (i % 7) * 0.001234).toFixed(6)) };
    });
    const now = Math.floor((Date.now() - midnight.getTime()) / 900_000);
    this.setState(id, String(prices[Math.min(now, prices.length - 1)].price), {
      unit_of_measurement: '€/kWh', device_class: 'monetary', friendly_name: 'Current electricity price (All-in)', icon: 'mdi:currency-eur',
      attribution: 'Data provided by Frank Energie', prices, prices_today: prices.slice(0, 96),
    }, true);
    return this.states.get(id)!;
  }

  /**
   * The firmware's device discovery template (core/entity_map.cpp deviceDiscoveryTemplate): per Energy meter, the power
   * and battery entities of the meter's device. [] per meter without a device registry (every house but 'real').
   */
  deviceDiscovery(template: string): [string, [string, string, string][]][] {
    let meters: string[] = [];
    try { meters = JSON.parse(/for m in (\[[^\]]*\])/.exec(template)?.[1] ?? '[]'); } catch { /* not the firmware's template */ }
    return meters.map((m) => {
      const d = this.reg?.deviceOf.get(m);
      const out: [string, string, string][] = [];
      if (d) for (const [id, dev] of this.reg!.deviceOf) {
        const a = this.states.get(id)?.attributes; const dc = String(a?.device_class ?? '');
        if (dev === d && (dc === 'power' || dc === 'battery')) out.push([id, dc, String(a?.unit_of_measurement ?? '')]);
      }
      return [m, out];
    });
  }

  historyInfo() {
    const h = this.history;
    return { seed: h.seed, chatty: h.chatty, entities: [...h.entities.values()].map((e) => ({ id: e.id, model: e.model, kind: e.kind, unit: e.unit, sample_s: e.sampleS })), calls: h.calls };
  }

  /** Set an entity state and push it to subscribers. */
  setState(id: string, state: string, attrs: Record<string, unknown> = {}, replaceAttrs = false) {
    const old = this.states.get(id);
    const attributes = { ...(old && !replaceAttrs ? old.attributes : {}), ...attrs };
    const changed = !old || old.state !== state;
    const ns: EntityState = { entity_id: id, state, attributes, last_changed: changed ? nowIso() : old!.last_changed, last_updated: nowIso() };
    this.states.set(id, ns);
    for (const c of this.conns) for (const [sid, filter] of c.subs) {
      if (filter === 'events') { c.ws.send(JSON.stringify({ id: sid, type: 'event', event: { event_type: 'state_changed', data: { entity_id: id, old_state: old || null, new_state: ns }, time_fired: ns.last_updated } })); continue; }
      if (filter && !filter.includes(id)) continue;
      const ev = old ? { c: { [id]: { '+': { s: state, a: attributes, lu: Date.parse(ns.last_updated) / 1000, ...(changed ? { lc: Date.parse(ns.last_changed) / 1000 } : {}) } } } } : { a: { [id]: compress(ns) } };
      c.ws.send(JSON.stringify({ id: sid, type: 'event', event: ev }));
    }
  }

  /** Periodic "live data": power values drift, sometimes a room temperature moves. */
  wiggle() {
    if (this.house !== 'demo' && this.house !== 'big') {
      const p = this.states.get('sensor.p1_meter_power');
      if (p) this.setState(p.entity_id, String(Math.max(90, Math.round(Number(p.state) + (Math.random() - 0.5) * 60))));
      return;
    }
    const num = (id: string) => Number(this.states.get(id)?.state || 0);
    const solar = Math.max(0, Math.round(num('sensor.solar_power') + (Math.random() - 0.5) * 120));
    const home = Math.max(80, Math.round(num('sensor.home_power') + (Math.random() - 0.5) * 80));
    this.setState('sensor.solar_power', String(solar));
    this.setState('sensor.home_power', String(home));
    this.setState('sensor.grid_power', String(home - solar - num('sensor.battery_power')));
    const rain = this.states.get('binary_sensor.rain_expected'), first = (rain?.attributes.forecast as { datetime?: string }[] | undefined)?.[0]?.datetime;
    if (rain && Date.now() - Date.parse(String(first)) >= 2 * 3_600_000 + 5 * 60_000) this.setState(rain.entity_id, rain.state, { forecast: rainForecast(Date.now()) });   // eink-ha-os#283: a new nowcast every 5 min
    if (Math.random() < 0.3) {
      const z = ZONE_LIST[Math.floor(Math.random() * ZONE_LIST.length)];
      const st = this.states.get('climate.' + z.id)!;
      const cur = Math.round(((st.attributes.current_temperature as number) + (Math.random() < 0.5 ? -0.1 : 0.1)) * 10) / 10;
      this.setState('climate.' + z.id, st.state, { current_temperature: cur });
      if (z.id === 'living') this.setState('sensor.living_temperature', String(cur));
    }
  }

  // ---------------------------------------------------------------- HTTP
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url || '/', 'http://x');
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const form = async () => new URLSearchParams(await readBody(req));

    if (u.pathname === '/auth/authorize' && req.method === 'GET') {
      const p = u.searchParams; const err = this.checkClient(p.get('client_id'), p.get('redirect_uri'));
      if (err) return send(400, page('Invalid request', '<p>' + esc(err) + '</p>'), 'text/html; charset=utf-8');
      const hidden = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method']
        .map((k) => '<input type="hidden" name="' + k + '" value="' + esc(p.get(k) || '') + '">').join('');
      return send(200, page('Sign in', '<p class="sub">Sign in to <b>Fake Home Assistant</b> to continue to<br><code>' + esc(p.get('client_id') || '') + '</code></p>' +
        '<form method="post" action="/auth/authorize">' + hidden +
        '<label>Username<input name="username" value="user" autofocus></label>' +
        '<label>Password<input name="password" type="password" value="anything"></label>' +
        '<label class="row"><input type="checkbox" name="admin" value="1" checked> Administrator</label>' +
        '<button>Log in</button></form><p class="hint">Any user name and password work. Uncheck “Administrator” to test the “admins only” rule.</p>'), 'text/html; charset=utf-8');
    }
    if (u.pathname === '/auth/authorize' && req.method === 'POST') {
      const p = await form(); const clientId = p.get('client_id') || '', redirectUri = p.get('redirect_uri') || '';
      const err = this.checkClient(clientId, redirectUri);
      if (err) return send(400, page('Invalid request', '<p>' + esc(err) + '</p>'), 'text/html; charset=utf-8');
      const name = (p.get('username') || 'user').trim() || 'user';
      const user: User = { id: this.users.get(name)?.id || randomToken(8), name, isAdmin: p.get('admin') === '1' };
      this.users.set(name, user);
      const code = randomToken(16);
      const challenge = p.get('code_challenge') || null;
      if (challenge && (p.get('code_challenge_method') || 'plain') !== 'S256') return send(400, page('Invalid request', '<p>Only S256 is supported</p>'), 'text/html; charset=utf-8');
      this.codes.set(code, { clientId, redirectUri, challenge, user, exp: Date.now() + 10 * 60_000 });
      const to = new URL(redirectUri); to.searchParams.set('code', code); if (p.get('state') != null) to.searchParams.set('state', p.get('state')!);
      this.opts.log('FAKE-HA ' + name + (user.isAdmin ? ' (admin)' : '') + ' signed in for ' + clientId + ' → 302 ' + to.origin + to.pathname);
      res.writeHead(302, { Location: to.toString() }); res.end(); return;
    }
    if (u.pathname === '/auth/token' && req.method === 'POST') {
      const p = await form(); const gt = p.get('grant_type');
      const bad = (error: string, desc: string) => send(400, { error, error_description: desc });
      if (gt === 'authorization_code') {
        const c = this.codes.get(p.get('code') || ''); this.codes.delete(p.get('code') || '');
        if (!c || c.exp < Date.now()) return bad('invalid_request', 'Invalid code');
        if (c.clientId !== p.get('client_id')) return bad('invalid_request', 'Invalid client id');
        if (c.challenge) {
          const v = p.get('code_verifier');
          if (!v || pkceChallenge(v) !== c.challenge) return bad('invalid_grant', 'PKCE verification failed');
        }
        const refresh = randomToken(32); this.refresh.set(refresh, { user: c.user, clientId: c.clientId });
        return send(200, { ...this.issueAccess(c.user), refresh_token: refresh, ha_auth_provider: 'homeassistant' });
      }
      if (gt === 'refresh_token') {
        const r = this.refresh.get(p.get('refresh_token') || '');
        if (!r) return bad('invalid_grant', 'Invalid refresh token');
        if (r.clientId !== p.get('client_id')) return bad('invalid_request', 'Invalid client id');
        return send(200, this.issueAccess(r.user));
      }
      return bad('unsupported_grant_type', 'Unsupported grant type');
    }
    if (u.pathname === '/auth/revoke' && req.method === 'POST') {
      const p = await form(); const t = p.get('token') || '';
      if (this.refresh.delete(t)) this.opts.log('FAKE-HA refresh token revoked');
      return send(200, '');
    }
    if (u.pathname === '/auth/providers' && req.method === 'GET') {   // HA 2023.12+ shape; the display's "is this HA?" probe
      return send(200, { providers: [{ name: 'Home Assistant Local', id: null, type: 'homeassistant' }], preselect_remember_me: true });
    }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      const a = this.bearer(req); if (!a) return send(401, '401: Unauthorized', 'text/plain');
      return send(200, { message: 'API running.' });
    }
    const stateId = /^\/api\/states\/([a-z0-9_]+\.[a-z0-9_]+)$/.exec(u.pathname)?.[1];
    if (stateId && req.method === 'POST') {   // HA api/__init__.py APIEntityStateView.post: @require_admin
      const a = this.bearer(req); if (!a?.user.isAdmin) return send(401, '401: Unauthorized', 'text/plain');
      let b: any; try { b = JSON.parse(await readBody(req)); } catch { return send(400, { message: 'Invalid JSON specified.' }); }
      if (!b || typeof b !== 'object' || b.state == null) return send(400, { message: 'No state specified.' });
      const isNew = !this.states.has(stateId);
      const attributes = b.attributes && typeof b.attributes === 'object' ? b.attributes : {};
      this.setState(stateId, String(b.state), attributes, true);
      this.posted.push({ entity_id: stateId, state: String(b.state), attributes, user: a.user.name, t: nowIso() });
      if (this.posted.length > 200) this.posted.shift();
      return send(isNew ? 201 : 200, this.states.get(stateId));
    }
    if (u.pathname.startsWith('/__fake/')) {
      if (u.pathname === '/__fake/revoke-all' && req.method === 'POST') { this.revokeAll(); return send(200, { ok: true }); }
      if (u.pathname === '/__fake/big-house' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); this.bigHouse(Math.max(0, Math.min(5000, Number(b.n ?? BIG_HOUSE_EXTRA)))); return send(200, { entities: this.states.size });
      }
      if (u.pathname === '/__fake/state' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); this.setState(String(b.entity_id), String(b.state), b.attributes || {}); return send(200, this.states.get(String(b.entity_id)));
      }
      if (u.pathname === '/__fake/language' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); this.language = String(b.language || this.language);
        if ('number_format' in b) this.numberFormat = b.number_format == null ? null : String(b.number_format);
        if (typeof b.time_zone === 'string') this.timeZone = b.time_zone;
        if (typeof b.currency === 'string') this.currency = b.currency;
        return send(200, { language: this.language, number_format: this.numberFormat, time_zone: this.timeZone, currency: this.currency });
      }
      if (u.pathname === '/__fake/calls' && req.method === 'GET') return send(200, this.calls);
      if (u.pathname === '/__fake/posted' && req.method === 'GET') return send(200, this.posted);
      if (u.pathname === '/__fake/template-errors' && req.method === 'GET') return send(200, this.templateErrors);
      if (u.pathname === '/__fake/entities' && req.method === 'GET') return send(200, [...this.states.keys()]);
      if (u.pathname === '/__fake/price-sensor' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); const e = this.priceSensor(b.entity_id ? String(b.entity_id) : undefined, Number(b.days ?? 2));
        return send(200, { entity_id: e.entity_id, entries: (e.attributes.prices as unknown[]).length, bytes: JSON.stringify(e.attributes).length });
      }
      if (u.pathname === '/__fake/energy-prefs' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); const house = houseData(this.house).prefs;
        this.prefs = b.variant === 'flat-grid' ? flatGridPrefs(house) : house; return send(200, this.prefs);
      }
      if (u.pathname === '/__fake/history' && req.method === 'GET') return send(200, this.historyInfo());
      if (u.pathname === '/__fake/history' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); const h = this.history;
        if (b.seed != null) h.seed = Number(b.seed);
        if (Array.isArray(b.entities)) { h.entities.clear(); for (const e of b.entities) h.entities.set(String(e.id), histEntity(String(e.id), e.model as HistModel, e.kind as HistKind | undefined)); }
        if (b.chatty != null) h.chatty = !!b.chatty;
        if (b.reset_calls) h.calls = [];
        if (b.states) for (const e of h.entities.values()) { const v = h.value(e, Date.now() / 1000); this.setState(e.id, v == null ? 'unavailable' : v.toFixed(e.dp), h.attributes(e)); }
        return send(200, this.historyInfo());
      }
      if (u.pathname === '/__fake/seed-fail' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); this.seedFail = b.error ? String(b.error) : null; return send(200, { seed_fail: this.seedFail });
      }
      if (u.pathname === '/__fake/llat' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); return send(200, { token: this.issueLongLived(String(b.name || 'user'), b.admin !== false) });
      }
      if (u.pathname === '/__fake/restart' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); const ms = Math.round(Number(b.down_s ?? 10) * 1000);
        res.on('finish', () => this.restart(ms)); return send(200, { down_s: ms / 1000 });
      }
      if (u.pathname === '/__fake/tls' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); const mode = String(b.mode ?? 'ok') as TlsFault;
        if (!(mode in this.tlsAccepted)) return send(400, { message: 'mode: ok, hang, slow or reset' });
        this.tlsFault = { mode, delayMs: Math.round(Number(b.delay_s ?? 0) * 1000) };
        return send(200, { mode, delay_s: this.tlsFault.delayMs / 1000 });
      }
      if (u.pathname === '/__fake/tls-reset' && req.method === 'POST') return send(200, { reset: this.resetTls() });
      if (u.pathname === '/__fake/drop-ws' && req.method === 'POST') { const n = this.conns.size; this.dropWs(); return send(200, { dropped: n }); }
      if (u.pathname === '/__fake/state' && req.method === 'GET') return send(200, { house: this.house, entities: this.states.size, refresh_tokens: this.refresh.size, connections: this.conns.size, sessions: this.sessions, users: [...this.users.keys()], tls: { ...this.tlsFault, accepted: this.tlsAccepted, open: this.tlsSockets.size } });
      return send(404, { message: 'Not found' });
    }
    if (u.pathname === '/' || u.pathname === '/manifest.json') return send(200, page('Fake Home Assistant', '<p>This is the device simulator\'s fake Home Assistant. ' + this.states.size + ' entities, ' + this.refresh.size + ' refresh tokens.</p>'), 'text/html; charset=utf-8');
    send(404, { message: 'Not found' });
  }

  /** HA accepts a redirect_uri on the same host as the client_id (no fetch needed). */
  private checkClient(clientId: string | null, redirectUri: string | null): string | null {
    let c: URL, r: URL;
    try { c = new URL(clientId || ''); r = new URL(redirectUri || ''); } catch { return 'Invalid client_id or redirect_uri'; }
    if (!/^https?:$/.test(c.protocol)) return 'Invalid client_id';
    if (c.host !== r.host || c.protocol !== r.protocol) return 'Invalid redirect URI (must be on the same host as client_id)';
    return null;
  }
  private issueAccess(user: User) {
    const t = randomToken(32); this.access.set(t, { user, exp: Date.now() + this.opts.accessTtlS * 1000 });
    return { access_token: t, token_type: 'Bearer', expires_in: this.opts.accessTtlS };
  }
  private bearer(req: IncomingMessage) {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || '')); const a = m && this.access.get(m[1]);
    return a && a.exp > Date.now() ? a : null;
  }

  // ---------------------------------------------------------------- WebSocket API
  private wsSession(ws: WsConn) {
    const c = { ws, user: null as User | null, subs: new Map<number, string[] | null | 'events'>() };
    this.conns.add(c);
    ws.onClose = () => this.conns.delete(c);
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: this.opts.version }));
    ws.onMessage = (text) => {
      let m: any; try { m = JSON.parse(text); } catch { return; }
      if (!c.user) {
        const a = m.type === 'auth' ? this.access.get(m.access_token) : undefined;
        if (!a || a.exp < Date.now()) { ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token or password' })); ws.close(); return; }
        c.user = a.user; this.sessions++; ws.send(JSON.stringify({ type: 'auth_ok', ha_version: this.opts.version })); return;
      }
      const ok = (result: unknown = null) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result }));
      const err = (code: string, message: string) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: false, error: { code, message } }));
      switch (m.type) {
        case 'ping': ws.send(JSON.stringify({ id: m.id, type: 'pong' })); return;
        case 'auth/current_user': return ok({ id: c.user.id, name: c.user.name, is_owner: false, is_admin: c.user.isAdmin, credentials: [{ auth_provider_type: 'homeassistant', auth_provider_id: null }], mfa_modules: [] });
        case 'get_states': return ok([...this.states.values()]);
        case 'frontend/get_user_data': {   // like HA: {value: data[key]}, null when the profile never saved it
          const lang = this.numberFormat == null ? null : { language: this.language, number_format: this.numberFormat, time_format: 'language' };
          return ok({ value: m.key == null ? (lang ? { language: lang } : {}) : m.key === 'language' ? lang : null });
        }
        case 'get_config': return ok({ location_name: 'Home', version: this.opts.version, time_zone: this.timeZone, currency: this.currency, language: this.language, unit_system: { temperature: '°C' } });
        case 'subscribe_entities': {
          const ids: string[] | null = Array.isArray(m.entity_ids) ? m.entity_ids : null;
          c.subs.set(m.id, ids); ok();
          this.opts.log('FAKE-HA subscribe_entities #' + m.id + ' (' + (ids ? ids.length + ' entities' : 'all') + ')');
          const a: Record<string, unknown> = {};
          for (const [id, s] of this.states) if (!ids || ids.includes(id)) a[id] = compress(s);
          ws.send(JSON.stringify({ id: m.id, type: 'event', event: { a } })); return;
        }
        case 'subscribe_events':
          if (m.event_type && m.event_type !== 'state_changed') return err('not_supported', 'Fake HA only streams state_changed');
          c.subs.set(m.id, 'events'); return ok();
        case 'unsubscribe_events': c.subs.delete(m.subscription); return ok();
        case 'call_service': return this.callService(m, ok, err);
        case 'energy/get_prefs': return this.prefs ? ok(this.prefs) : err('not_found', 'No prefs');   // HA without an Energy dashboard
        case 'config/area_registry/list': return ok(this.areas.map(([id, name]) => ({ area_id: id, name, aliases: [], floor_id: null, icon: null, labels: [], picture: null })));
        case 'render_template': {
          // No Jinja here: answer the two templates the firmware sends (net/ha_client.cpp, core/entity_map.cpp).
          const t = String(m.template || '');
          let result: string;
          if (t.includes('x4_seed')) result = JSON.stringify(seedAnswer(this.states.values(), this.areas, this.areaOf, this.reg?.deviceOf));
          else if (t.includes('states.light')) {
            const ids = [...this.states.keys()];
            result = JSON.stringify({ climate: ids.filter((id) => id.startsWith('climate.')), lights: ids.filter((id) => id.startsWith('light.')).map((id) => [id, this.areaOf.get(id) ?? '']) });
          } else if (t.includes('device_entities')) result = JSON.stringify(this.deviceDiscovery(t));
          else if (t.includes('input_boolean')) {   // entity picker list (GET /api/v1/ha/entities, eink-ha-os#150): {t, e: [[id, name, unit, state, area_id], …]}
            result = JSON.stringify(entityListAnswer(this.states.values(), (id) => this.areaOf.get(id) ?? ''));
          }
          else return err('template_error', 'Fake HA only renders the X4 discovery templates');
          const warns = templateWarnings(t, this.states.values());
          if (warns.length) {
            this.templateErrors.push(...warns); this.templateErrors.splice(0, Math.max(0, this.templateErrors.length - 200));
            this.opts.log('FAKE-HA render_template #' + m.id + ': ' + warns.length + ' undefined attribute reads (' + warns[0] + ')');
          }
          if (warns.length && m.strict) return err('template_error', warns[0]);
          ok();
          if (m.report_errors) for (const w of warns) ws.send(JSON.stringify({ id: m.id, type: 'event', event: { error: w, level: 'WARNING' } }));
          if (this.seedFail && t.includes('x4_seed')) { ws.send(JSON.stringify({ id: m.id, type: 'event', event: { error: this.seedFail, level: 'ERROR' } })); return; }
          ws.send(JSON.stringify({ id: m.id, type: 'event', event: { result, listeners: { all: false, entities: [], domains: [], time: false } } }));
          return;
        }
        case 'recorder/statistics_during_period':
        case 'history/history_during_period': {   // energy meter ids have no statistics here: {} as before
          const r = m.type === 'history/history_during_period' ? this.history.history(m, Date.now(), (id) => this.states.has(id)) : this.history.statistics(m, Date.now(), this.timeZone);
          if ('error' in r) return err(...r.error);
          const text = JSON.stringify({ id: m.id, type: 'result', success: true, result: r.result });
          const rows = Object.values(r.result).reduce((n, a) => n + a.length, 0);
          this.history.record({ type: m.type, ids: m.statistic_ids ?? m.entity_ids ?? [], ...(m.period ? { period: m.period } : {}), ...(m.types ? { types: m.types } : {}),
            start_time: String(m.start_time), ...(m.end_time ? { end_time: String(m.end_time) } : {}), rows, bytes: Buffer.byteLength(text), t: nowIso() });
          this.opts.log('FAKE-HA ' + m.type + ' #' + m.id + ': ' + rows + ' rows, ' + Buffer.byteLength(text) + ' B');
          ws.send(text); return;
        }
        case 'config/entity_registry/list': return ok([...this.states.keys()].map((id) => ({ entity_id: id, area_id: (this.reg ? this.reg.entityArea.get(id) : this.areaOf.get(id)) ?? null,
          device_id: this.reg?.deviceOf.get(id) ?? null, platform: id.startsWith('climate.') && this.house !== 'stranger' ? 'tado' : 'fake', disabled_by: null })));
        case 'config/device_registry/list': return ok((this.reg?.devices ?? []).map((d) => ({ id: d.id, name: d.name, name_by_user: null, area_id: d.area, manufacturer: d.manufacturer, model: d.model, disabled_by: null, entry_type: null, via_device_id: null })));
        case 'config/entity_registry/get_entries': {   // like HA: entity_id → entry (null when not in the registry)
          const ids: string[] = Array.isArray(m.entity_ids) ? m.entity_ids : [];
          return ok(Object.fromEntries(ids.map((id) => {
            if (!this.states.has(id)) return [id, null];
            const dp = this.reg ? this.reg.dp.get(id) : this.house === 'stranger' ? undefined : EXTRA_ENTITIES.find((e) => e.id === id)?.dp;
            return [id, { entity_id: id, platform: 'fake', options: dp === undefined ? {} : { sensor: { display_precision: dp } } }];
          })));
        }
        default: return err('unknown_command', 'Unknown command.');
      }
    };
  }

  private callService(m: any, ok: (r?: unknown) => void, err: (c: string, msg: string) => void) {
    const { domain, service } = m; const data = { ...(m.service_data || {}), ...(m.target || {}) };
    let ids: string[] = [].concat(data.entity_id || []);
    if (ids.includes('all')) ids = [...this.states.keys()].filter((id) => id.startsWith(domain + '.'));   // like HA: entity_id all = every entity of the domain
    if (data.area_id && domain === 'light') for (const area of [].concat(data.area_id)) for (const [id, a] of this.areaOf) if (a === area && id.startsWith('light.')) ids.push(id);
    this.calls.push({ domain, service, data });
    this.opts.log('FAKE-HA call_service ' + domain + '.' + service + ' ' + JSON.stringify(data));
    for (const id of ids) if (!this.states.has(id)) return err('not_found', 'Entity ' + id + ' not found');
    if (domain === 'light' && (service === 'turn_on' || service === 'turn_off' || service === 'toggle')) {
      for (const id of ids) {
        const cur = this.states.get(id)!; const on = service === 'toggle' ? cur.state !== 'on' : service === 'turn_on';
        const b = data.brightness_pct != null ? Math.round(Number(data.brightness_pct) * 2.55) : data.brightness != null ? Number(data.brightness) : (cur.attributes.brightness ?? 255);
        this.setState(id, on ? 'on' : 'off', 'supported_color_modes' in cur.attributes && (cur.attributes.supported_color_modes as string[]).includes('brightness') ? { brightness: on ? b : null } : {});
      }
    } else if (['switch', 'input_boolean', 'fan'].includes(domain) && (service === 'turn_on' || service === 'turn_off' || service === 'toggle')) {
      for (const id of ids) { const cur = this.states.get(id)!; this.setState(id, (service === 'toggle' ? cur.state !== 'on' : service === 'turn_on') ? 'on' : 'off', {}); }
    } else if (domain === 'climate' && service === 'set_temperature') {
      for (const id of ids) this.setState(id, this.states.get(id)!.state, { temperature: Number(data.temperature) });
    } else if (domain === 'climate' && service === 'set_preset_mode') {
      for (const id of ids) this.setState(id, this.states.get(id)!.state, { preset_mode: data.preset_mode });
    } else if (domain === 'scene' && service === 'turn_on') {   // like HA: a scene's state is when it last ran
      if (ids.includes('scene.all_off')) for (const l of LIGHT_LIST) if (this.states.get('light.' + l.id)?.state === 'on') this.setState('light.' + l.id, 'off', {});
      for (const id of ids) this.setState(id, nowIso(), {});
    } else if (domain === 'script' && service === 'turn_on') {   // eink-ha-os#146: script.good_night turns the demo lights off
      if (ids.includes('script.good_night')) for (const l of LIGHT_LIST) if (this.states.get('light.' + l.id)?.state === 'on') this.setState('light.' + l.id, 'off', {});
      for (const id of ids) this.setState(id, 'off', { last_triggered: nowIso() });
    } else if (domain === 'media_player') {   // eink-ha-os#319: the demo speaker steps through DEMO_MEDIA.queue; volume like HA (step 0.1)
      const q = DEMO_MEDIA.queue;
      for (const id of ids) {
        const cur = this.states.get(id)!, a = cur.attributes, at = Math.max(0, q.findIndex((x) => x.title === a.media_title));
        const track = (i: number) => ({ media_title: q[(i + q.length) % q.length].title, media_artist: q[(i + q.length) % q.length].artist, media_position: 0 });
        const vol = (v: number) => ({ volume_level: Math.round(Math.max(0, Math.min(1, v)) * 100) / 100 });
        if (service === 'media_play_pause') this.setState(id, cur.state === 'playing' ? 'paused' : 'playing', {});
        else if (service === 'media_next_track') this.setState(id, cur.state, track(at + 1));
        else if (service === 'media_previous_track') this.setState(id, cur.state, track(at - 1));
        else if (service === 'volume_up' || service === 'volume_down') this.setState(id, cur.state, vol(Number(a.volume_level ?? 0) + (service === 'volume_up' ? 0.1 : -0.1)));
        else if (service === 'volume_set') this.setState(id, cur.state, vol(Number(data.volume_level)));
        else if (service === 'play_media') this.setState(id, 'playing', { media_title: String(data.media_content_id), media_artist: '', media_content_type: data.media_content_type, media_position: 0 });
        else return err('not_found', 'Service ' + domain + '.' + service + ' not found.');
      }
    } else if (domain === 'weather' && service === 'get_forecasts') {   // eink-ha-os#283: a service with a response, like HA
      if (!m.return_response) return err('service_validation_error', 'Service call requires responses but caller did not ask for responses');
      const out: Record<string, { forecast: unknown[] }> = {};
      for (const id of ids) { const f = weatherForecast(String(data.type), Date.now()); if (!f) return err('service_validation_error', 'Weather entity does not support \'' + data.type + '\' forecast'); out[id] = { forecast: f }; }
      return ok({ context: { id: randomToken(12), parent_id: null, user_id: null }, response: out });
    } else if (domain === 'calendar' && service === 'get_events') {   // eink-ha-os#316: the demo calendars, events overlapping the window
      if (!m.return_response) return err('service_validation_error', 'Service call requires responses but caller did not ask for responses');
      const from = Date.parse(String(data.start_date_time ?? '')), to = Date.parse(String(data.end_date_time ?? ''));
      if (!Number.isFinite(from) || !Number.isFinite(to)) return err('invalid_format', 'start_date_time and end_date_time are required here');
      const tz = -new Date().getTimezoneOffset(), out: Record<string, { events: unknown[] }> = {};
      for (const id of ids) out[id] = { events: demoEvents(id, Date.now(), tz, from, to) };
      return ok({ context: { id: randomToken(12), parent_id: null, user_id: null }, response: out });
    } else if (domain !== 'homeassistant') return err('not_found', 'Service ' + domain + '.' + service + ' not found.');
    ok({ context: { id: randomToken(12), parent_id: null, user_id: null } });
  }
}

function compress(s: EntityState) { return { s: s.state, a: s.attributes, c: '', lc: Date.parse(s.last_changed) / 1000 }; }

export function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return readBuffer(req, limit).then((b) => b.toString('utf8'));
}
export function readBuffer(req: IncomingMessage, limit = 1 << 20): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; } parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function page(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + ' · Home Assistant</title>' +
    '<style>body{font:15px system-ui,sans-serif;background:#f2f4f9;margin:0;display:flex;justify-content:center;padding:48px 16px;color:#212121}' +
    'main{background:#fff;border-radius:12px;box-shadow:0 2px 8px #0002;padding:28px;width:100%;max-width:380px}h1{font-size:22px;margin:0 0 6px;color:#03a9f4}' +
    'label{display:flex;flex-direction:column;gap:4px;margin:12px 0;font-size:13px;color:#555}label.row{flex-direction:row;align-items:center;gap:8px;font-size:15px;color:#212121}' +
    'input:not([type=checkbox]){font:inherit;padding:10px;border:1px solid #ccc;border-radius:6px}button{margin-top:8px;width:100%;padding:12px;border:0;border-radius:6px;background:#03a9f4;color:#fff;font:600 15px system-ui}' +
    '.sub,.hint{color:#666;font-size:13px}code{font-size:12px}</style></head><body><main><h1>' + esc(title) + '</h1>' + body + '</main></body></html>';
}
