// First-run screens from the user's own Home Assistant (#23). Pure: HA snapshot in, screens config out.
// Runs once, on the first link, when the display has no saved screens.yaml yet. The firmware port is
// firmware/src/core/seed.cpp; both must produce the same YAML for spec/test-vectors/seed.json.
//
// Rules (a tile is only made when HA has a source for it, so a fresh dashboard shows no "—"):
//   overview  clock (cs 2) + up to 6 of: price, inside temperature, solar, home use, battery gauge, grid, outside temperature
//   prices    Energy dashboard has a price entity (or `live` has sensor.energy_prices): price + 24 h chart
//   energy    used / imported / exported today, home use; usage chart when the Energy dashboard has an import or solar
//             meter. Not made for home use alone (the overview has it)
//   solar     solar power, solar today, battery gauge, battery power; solar chart when the Energy dashboard has a solar meter
//   lights    any light.*: lightList; per area its group, else its bulbs; lights without an area left out (#152)
//   climate   any climate.* not on a vehicle: zoneList (title "Heating"); with a vehicle climate (#136: a climate on
//             a device that has a device_tracker, e.g. a Tesla) or a duplicate zone (#152: same area or friendly name,
//             e.g. a Better Thermostat wrapper; the one not off is kept) the zoneList names the others in `entities`
//   outside   an outdoor thermometer, never a forecast (max / min / today … tokens, #152); else a weather entity
//   rooms     ≥ 2 temperature sensors in different areas: one stat per area (label = area name), area order, max 8
//   travel    any sensor.x4_route_* exists (or is mapped): route tiles on it (cs 2, max 4, sorted by id)
// then `tail` (the Settings screens). Apps = the default apps that ended up with at least one screen.
//
// Every stat / gauge entity is a sensor from the template answer, i.e. in HA's state list (#82: demo ids on a real
// house showed "—" in 7 of 10 tiles). No sensor for a role = no tile. Per role, first hit wins:
//   1. HA has the logical id itself (sensor.solar_power …): that one, no label (the catalog's tile);
//   2. Energy dashboard (power roles): the source's power sensor (stat_rate | power[0].stat_rate | power_config.stat_rate),
//      else the sensor sharing the longest entity-id prefix (≥ 2 words) with the source's meters (same device, by name)
//      whose score is ≥ 0; imported / exported today: the same prefix test on the grid's flow_from / flow_to meters;
//   3. by kind + name: score = +2 per good word, −3 per bad word in "entity_id friendly name" (lower case); > 0 wins.
//      Imported / exported today must also name the grid (GRID_DAY), used today the house (HOUSE_DAY): an appliance
//      plug's "today consumption" is neither (#152). Lifetime meters only (no day counter) = no such tile.
// Ties: the higher score, then the first sensor. A sensor fills one role. Grid only (no solar or battery anywhere):
// the grid sensor becomes the home use tile.
// Kinds (sensorKind, same test as the template): temperature (available) | power (W / kW or device_class power) |
// energy today (kWh / Wh or device_class energy, and a day word as a whole token: `_last_seven_days` is not one) |
// charge (% with device_class battery or none). Power sensors of one phase (PHASE words) are left out. A device's own chip temperature (`…_device_temperature`, Zigbee2MQTT's
// diagnostic entity; HA's entity_category is not in a template's state) is no temperature (#136).
//
// Seed report (#89): what the seed decided per tile (SEED_TILES), so the console can say "N of M tiles filled" and
// why the others are missing. Filled: `entity` (when the tile has one) + `rule` (id | energy | device | name | area |
// grid | found). Dropped: `why` (no_energy | no_meter | no_sensor | none | few_rooms | overview_full).
import { DEFAULT_APPS, entityFits, ENTITY_DOMAINS, MAX_CELLS, cellsUsed, type Config, type Screen, type Widget } from './config.ts';

/** energy/get_prefs result (only the fields the seed reads). */
export type EnergyPrefs = { energy_sources?: Record<string, any>[] } | null;

/** One template `sensors` row: [entity_id, device_class, area_id | '', friendly name, unit]. */
export type SensorRow = [string, string, string, string, string?];

/**
 * What the seed needs from HA. `energy`: energy/get_prefs. `live`: logical ids (core/entities.h) that have a source
 * (firmware: EntityAdapter::sources()); only the price tile and travel routes read it. The rest is the answer of
 * SEED_TEMPLATE: `areas`: [area_id, name] in registry order; `climate`: climate.* ids, `vehicles`: climate.* ids on a
 * device with a device_tracker (not in `climate`, ClimateRow); `lights`: LightRow; `weather`: weather.* ids with a
 * temperature; `sensors`: temperature / power / energy-today / charge sensors and sensor.x4_route_* (SensorRow; area
 * only on temperatures).
 */
export type HaSnapshot = {
  energy?: EnergyPrefs; live?: string[];
  areas?: [string, string][]; climate?: (string | ClimateRow)[]; vehicles?: string[]; lights?: LightRow[]; sensors?: SensorRow[]; weather?: string[];
};
/** One template `climate` row: [climate id, friendly name, area_id | '', state] (#152; a bare id = no name / area / state). */
export type ClimateRow = [string, string, string, string];
/** One template `lights` row: [light id, area_id | '', 'g' when it is a group of lights (#152) | '']. */
export type LightRow = [string, string, string?];

/** Template answer caps per kind (SEED_TEMPLATE; the fake HA's seedAnswer). */
export const SEED_CAPS = { t: 60, p: 100, e: 40, b: 60 };
const DAY = ['today', 'vandaag', 'daily', 'dag', 'day'];
/** One of `words` as a whole token of "entity_id name" (lower case; anything but a-z 0-9 separates). */
const tokenRe = (words: string[]) => new RegExp('(^|[^a-z0-9])(' + words.join('|') + ')([^a-z0-9]|$)');
const DAY_RE = tokenRe(DAY);
const DEVICE_T = ['device_temperature', 'device temperature'];
/** One phase of a meter: bad for every power role, so not sent (#136: the answer's size). */
const PHASE = ['phase', 'fase', '_l1', '_l2', '_l3'];
/** Whole tokens of a temperature that is no reading of now (#152: "max temperature today" became Outside). */
const FORECAST = ['forecast', 'verwachting', 'max', 'min', 'maximum', 'minimum', 'high', 'low', 'today', 'tomorrow', 'vandaag', 'morgen',
  'daily', 'day', 'dag', 'apparent', 'feels', 'gevoel', 'gevoelstemperatuur', 'dew', 'dewpoint', 'dauwpunt'];
const FORECAST_RE = tokenRe(FORECAST);
/** A light group's attributes: HA group (entity_id), Hue / deCONZ room groups (#152). */
export const LIGHT_GROUP_ATTRS = ['entity_id', 'is_hue_group', 'is_deconz_group', 'lights'];

/**
 * One render_template the display sends on its first link (firmware: seedTemplate() in core/seed.cpp, same text;
 * spec/test-vectors/seed.json `template`). Capped per kind (SEED_CAPS) to keep the answer under ~20 KB on a big
 * install. The fake HA recognises it by the x4_seed marker.
 * Real HA (#58): `s.attributes.x` on an entity without x is an Undefined that HA reports (report_errors: a WARNING
 * event, strict: an error), so attributes are read with `.get()`; area_name / area_id can be None; temperature
 * sensors that are unknown / unavailable right now are left out (power sensors are kept: an inverter is
 * unavailable at night).
 */
export const SEED_TEMPLATE =
  "{# x4_seed #}{% set ns = namespace(a=[], l=[], s=[], c=[], v=[], w=[], t=0, p=0, e=0, b=0) %}" +
  "{% for a in areas() %}{% set ns.a = ns.a + [[a, area_name(a) or a]] %}{% endfor %}" +
  "{% for s in states.light %}{% if ns.l | length < 150 %}{% set ns.l = ns.l + [[s.entity_id, area_id(s.entity_id) or '', " +
  "'g' if " + LIGHT_GROUP_ATTRS.map((a) => "s.attributes.get('" + a + "')").join(' or ') + " else '']] %}{% endif %}{% endfor %}" +
  "{% for s in states.sensor %}{% set dc = s.attributes.get('device_class') or '' %}{% set u = s.attributes.get('unit_of_measurement') or '' %}" +
  "{% set n = (s.entity_id ~ ' ' ~ (s.name | string)) | lower %}" +
  "{% set k = 't' if dc == 'temperature' and not (" + DEVICE_T.map((d) => "'" + d + "' in n").join(' or ') + ") else '' if dc == 'temperature' else " +
  "'p' if (dc == 'power' or u in ['W', 'kW']) and not (" + PHASE.map((d) => "'" + d + "' in n").join(' or ') + ") else " +
  "'' if dc == 'power' or u in ['W', 'kW'] else " +
  "'e' if (dc == 'energy' or u in ['kWh', 'Wh']) and n | regex_search('" + DAY_RE.source + "') else " +
  "'b' if u == '%' and dc in ['battery', ''] else 'r' if s.entity_id.startswith('sensor.x4_route_') else '' %}" +
  "{% if k == 't' and (s.state in ['unknown', 'unavailable'] or ns.t >= " + SEED_CAPS.t + ") %}{% set k = '' %}{% endif %}" +
  "{% if k == 't' %}{% set ns.t = ns.t + 1 %}" +
  "{% elif k == 'p' %}{% if ns.p < " + SEED_CAPS.p + " %}{% set ns.p = ns.p + 1 %}{% else %}{% set k = '' %}{% endif %}" +
  "{% elif k == 'e' %}{% if ns.e < " + SEED_CAPS.e + " %}{% set ns.e = ns.e + 1 %}{% else %}{% set k = '' %}{% endif %}" +
  "{% elif k == 'b' %}{% if ns.b < " + SEED_CAPS.b + " %}{% set ns.b = ns.b + 1 %}{% else %}{% set k = '' %}{% endif %}{% endif %}" +
  "{% if k %}{% set ns.s = ns.s + [[s.entity_id, dc | string, (area_id(s.entity_id) or '') if k == 't' else '', s.name | string, u | string]] %}{% endif %}{% endfor %}" +
  "{% for s in states.climate %}{% set d = device_id(s.entity_id) %}" +
  "{% if d and device_entities(d) | select('match', 'device_tracker') | list %}{% set ns.v = ns.v + [s.entity_id] %}" +
  "{% else %}{% set ns.c = ns.c + [[s.entity_id, s.name | string, area_id(s.entity_id) or '', s.state]] %}{% endif %}{% endfor %}" +
  "{% for s in states.weather %}{% if s.attributes.get('temperature') is number %}{% set ns.w = ns.w + [s.entity_id] %}{% endif %}{% endfor %}" +
  "{{ {'areas': ns.a, 'climate': ns.c, 'vehicles': ns.v, 'lights': ns.l, 'sensors': ns.s, 'weather': ns.w} | tojson }}";

/** The template answer is a JSON object; anything else = the seed failed: save nothing, retry on the next link (#58). */
export function seedAnswerOk(text: string): boolean {
  try { const j = JSON.parse(text); return !!j && typeof j === 'object' && !Array.isArray(j); } catch { return false; }
}

/**
 * render_template event with report_errors: HA sends {error, level: 'WARNING'} for e.g. an undefined attribute and
 * keeps rendering; only a result (or an ERROR) ends the wait. Firmware: templateEventFinal in core/seed.cpp.
 */
export const templateEventFinal = (hasResult: boolean, level: string | null): boolean => hasResult || level !== 'WARNING';

const OUTSIDE = ['outdoor', 'outside', 'buiten', 'exterior', 'weather', 'weer', 'buienradar', 'openweathermap', 'knmi', 'forecast'];
const NOT_A_ROOM = ['cpu', 'processor', 'battery', 'chip', 'disk', 'nas', 'router', 'soc', 'fridge', 'freezer', 'koelkast', 'vriezer', 'water', 'boiler', 'pomp', 'pump'];
const LIVING = ['living', 'lounge', 'woon', 'family', 'sitting'];
const hasAny = (s: string, keys: string[]): boolean => { const l = s.toLowerCase(); return keys.some((k) => l.includes(k)); };
/** Area names go into a `label:` flow-map value: no , : { } [ ] # " (the parser would split or reject them). */
export const labelText = (s: string): string => s.replace(/[,:{}[\]#"]/g, '').trim();

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---- role words (seed.cpp has the same lists)
const SOLAR = ['solar', 'pv', 'zon', 'inverter', 'omvormer', 'envoy', 'enphase'];
const BATT = ['battery', 'batterij', 'accu', 'solarbank', 'solix', 'powerwall', 'storage'];
const HOME = ['home', 'house', 'huis', 'load'];
const GRID = ['grid', 'p1', 'dsmr', 'electricity_meter', 'netto', 'net_power', 'elektriciteitsnet'];
const IMPORT = ['import', 'afname', 'consum', 'deliver'];
const EXPORT = ['export', 'produc', 'return', 'teruglever', 'injection'];
type Role = { good: string[]; bad: string[] };
// an inverter's production beats its other sensors (Envoy: production, consumption, 16 microinverters)
const R_SOLAR: Role = { good: [...SOLAR, 'produc'], bad: [...BATT, ...HOME, ...GRID, ...PHASE, 'import', 'export', 'afname', 'teruglever', 'consum', 'verbruik'] };
const R_GRID: Role = { good: GRID, bad: [...SOLAR, ...BATT, ...HOME, ...PHASE, ...EXPORT] };
const R_BATT: Role = { good: BATT, bad: [...HOME, ...GRID, ...PHASE, 'pv', 'zon', 'inverter', 'omvormer'] };
// Envoy-S Metered: current_power_consumption is the house (its production is solar, its microinverters `inverter_*`)
const R_HOME: Role = { good: [...HOME, 'envoy', 'enphase'], bad: [...GRID, ...PHASE, 'pv', 'zon', 'inverter', 'omvormer', 'battery', 'batterij', 'charg', 'import', 'export', 'afname', 'teruglever', 'produc'] };
const R_SOC: Role = { good: ['soc', 'state_of_charge', 'charge', 'laadniveau', 'laadtoestand', 'solarbank', 'solix', 'powerwall', 'home_battery', 'thuisaccu', 'thuisbatterij'],
  bad: ['phone', 'pixel', 'iphone', 'ipad', 'tablet', 'watch', 'remote', 'laptop', 'button', 'motion', 'door', 'deur', 'window', 'raam'] };
const R_SOLAR_DAY: Role = R_SOLAR;
const R_IMPORT_DAY: Role = { good: IMPORT, bad: [...SOLAR, ...BATT, ...EXPORT] };
/** By name, a grid day counter must say grid or a grid direction (#152: an appliance plug's "today consumption" was
 *  Imported); whole-house use must say house / total (the same plug would be Used today). */
const GRID_DAY = [...GRID, 'import', 'export', 'afname', 'teruglever', 'injection'];
const HOUSE_DAY = [...HOME, 'total', 'totaal', 'energieverbruik', 'stroomverbruik', 'elektriciteitsverbruik'];
const R_EXPORT_DAY: Role = { good: EXPORT, bad: [...SOLAR, ...BATT, ...IMPORT] };
const R_USED_DAY: Role = { good: ['verbruik', 'usage', 'used', 'consumption', 'home', 'huis', 'house'], bad: [...SOLAR, ...BATT, ...GRID, 'import', 'export', 'afname', 'teruglever'] };

type Row = { id: string; cls: string; area: string; name: string; unit: string; text: string; kind: string };

/** Kind of a template row: 't' temperature, 'p' power, 'e' energy today, 'b' charge %, '' other. Same test as SEED_TEMPLATE. */
export function sensorKind(cls: string, unit: string, text: string): string {
  if (cls === 'temperature') return DEVICE_T.some((d) => text.includes(d)) ? '' : 't';
  if (cls === 'power' || unit === 'W' || unit === 'kW') return PHASE.some((d) => text.includes(d)) ? '' : 'p';
  if ((cls === 'energy' || unit === 'kWh' || unit === 'Wh') && DAY_RE.test(text)) return 'e';
  if (unit === '%' && (cls === 'battery' || cls === '')) return 'b';
  return '';
}

const objWords = (id: string): string[] => id.slice(id.indexOf('.') + 1).split('_');
/** Leading object-id words two entity ids share (sensor.p1_meter_power, sensor.p1_meter_energy_import → 2). */
export function sharedWords(a: string, b: string): number {
  const x = objWords(a), y = objWords(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}
const score = (t: string, r: Role): number =>
  r.good.reduce((s, k) => s + (t.includes(k) ? 2 : 0), 0) - r.bad.reduce((s, k) => s + (t.includes(k) ? 3 : 0), 0);

/** stat_rate | power[0].stat_rate | power_config.stat_rate (one entity, HA's sign). */
function rateOf(s: Record<string, any>): string {
  if (str(s.stat_rate)) return s.stat_rate;
  if (Array.isArray(s.power)) for (const p of s.power) if (str(p?.stat_rate)) return p.stat_rate;
  return s.power_config && typeof s.power_config === 'object' ? str(s.power_config.stat_rate) : '';
}

/** The tiles the seed reports on, in order, with the screen the console's "pick one" opens (#89). Travel is opt-in
 * (HA automations for sensor.x4_route_*) and not reported. */
export const SEED_TILES: [string, string][] = [
  ['price', 'overview'], ['inside', 'overview'], ['outside', 'overview'], ['solar_power', 'overview'], ['home_power', 'overview'],
  ['grid_power', 'overview'], ['battery_soc', 'overview'], ['battery_power', 'solar'], ['solar_today', 'solar'], ['solar_chart', 'solar'],
  ['energy_today', 'energy'], ['grid_import_today', 'energy'], ['grid_export_today', 'energy'], ['usage_chart', 'energy'],
  ['lights', 'lights'], ['heating', 'climate'], ['rooms', 'rooms'],
];
export type SeedRule = 'id' | 'energy' | 'device' | 'name' | 'area' | 'grid' | 'found';
export type SeedWhy = 'no_energy' | 'no_meter' | 'no_sensor' | 'none' | 'few_rooms' | 'overview_full';
export type SeedTile = { tile: string; screen: string; entity?: string; rule?: SeedRule; why?: SeedWhy };
export type SeedReport = { filled: number; total: number; tiles: SeedTile[] };

/** `tail`: screens appended after the HA screens (none: Settings is built into the display, #159). */
export function seedConfig(snap: HaSnapshot, tail: Screen[] = []): Config {
  return seedPlan(snap, tail).config;
}

/** seedConfig + the seed report (#89). Firmware: seedConfig(snap, tail, &report) + seedReportJson. */
export function seedPlan(snap: HaSnapshot, tail: Screen[] = []): { config: Config; report: SeedReport } {
  const live = new Set(snap.live || []);
  // ---- Energy dashboard
  let hasSolar = false, hasBattery = false, solarM = false, importM = false, price = false, energyOn = false, priceId = '';
  const rate = { solar: '', grid: '', battery: '' };
  const meters = { solar: [] as string[], grid: [] as string[], battery: [] as string[], import: [] as string[], export: [] as string[] };
  for (const s of snap.energy?.energy_sources || []) {
    if (!s || typeof s !== 'object') continue;
    const t = str(s.type);
    if (t !== 'solar' && t !== 'grid' && t !== 'battery') continue;
    energyOn = true;
    if (!rate[t]) rate[t] = rateOf(s);
    if (t === 'solar') { hasSolar = true; if (str(s.stat_energy_from)) { solarM = true; meters.solar.push(s.stat_energy_from); } }
    else if (t === 'battery') {
      hasBattery = true;
      for (const k of ['stat_energy_from', 'stat_energy_to']) if (str(s[k])) meters.battery.push(s[k]);
    } else {
      for (const f of Array.isArray(s.flow_from) ? s.flow_from : []) {
        if (!f || typeof f !== 'object') continue;
        if (str(f.stat_energy_from)) { importM = true; meters.grid.push(f.stat_energy_from); meters.import.push(f.stat_energy_from); }
        if (str(f.entity_energy_price)) { price = true; if (!priceId) priceId = f.entity_energy_price; }
      }
      for (const f of Array.isArray(s.flow_to) ? s.flow_to : []) if (f && typeof f === 'object' && str(f.stat_energy_to)) { meters.grid.push(f.stat_energy_to); meters.export.push(f.stat_energy_to); }
    }
  }
  if (live.has('sensor.energy_prices')) price = true;

  // ---- sensors in HA's state list
  const rows: Row[] = [];
  for (const s of snap.sensors || []) {
    if (!Array.isArray(s) || !entityFits(s[0], ENTITY_DOMAINS.stat)) continue;
    const r = { id: s[0], cls: str(s[1]), area: str(s[2]), name: str(s[3]), unit: str(s[4]), text: '', kind: '' };
    r.text = (r.id + ' ' + r.name).toLowerCase();
    r.kind = sensorKind(r.cls, r.unit, r.text);
    rows.push(r);
  }
  const used = new Set<string>();
  const how = new Map<string, SeedRule>();   // sensor id → the rule that picked it
  /** One role: identity, then the Energy dashboard's power sensor / meter device, then name words (see the header). */
  const pick = (logical: string, kind: string, role: Role, src: { rate: string; meters: string[] } | null, bonus = (_: Row) => 0, need: string[] = []): Row | null => {
    const free = rows.filter((r) => r.kind === kind && !used.has(r.id));
    const key = (r: Row) => 2 * score(r.text, role) + bonus(r);
    let b = free.find((r) => r.id === logical) || null, rule: SeedRule = 'id';
    if (!b && src?.rate) { b = free.find((r) => r.id === src.rate) || null; rule = 'energy'; }
    if (!b && src && src.meters.length) {
      rule = 'device';
      let bw = 0, bk = 0;
      for (const r of free) {
        const w = Math.max(...src.meters.map((m) => sharedWords(m, r.id)));
        if (w < 2 || score(r.text, role) < 0) continue;
        if (!b || w > bw || (w === bw && key(r) > bk)) { b = r; bw = w; bk = key(r); }
      }
    }
    if (!b) {
      let bk = 0;
      rule = 'name';
      for (const r of free) if (score(r.text, role) > 0 && (!need.length || hasAny(r.text, need)) && (!b || key(r) > bk)) { b = r; bk = key(r); }
    }
    if (b) { used.add(b.id); how.set(b.id, rule); }
    return b;
  };
  const solarP = pick('sensor.solar_power', 'p', R_SOLAR, { rate: rate.solar, meters: meters.solar });
  let gridP = pick('sensor.grid_power', 'p', R_GRID, { rate: rate.grid, meters: meters.grid });
  const battP = pick('sensor.battery_power', 'p', R_BATT, { rate: rate.battery, meters: meters.battery });
  let homeP = pick('sensor.home_power', 'p', R_HOME, null);
  const soc = pick('sensor.home_battery_soc', 'b', R_SOC, { rate: '', meters: meters.battery }, (r) => (r.cls === 'battery' ? 1 : 0));
  const solarD = pick('sensor.solar_today', 'e', R_SOLAR_DAY, null);
  const importD = pick('sensor.grid_import_today', 'e', R_IMPORT_DAY, { rate: '', meters: meters.import }, undefined, GRID_DAY);
  const exportD = pick('sensor.grid_export_today', 'e', R_EXPORT_DAY, { rate: '', meters: meters.export }, undefined, GRID_DAY);
  const usedD = pick('sensor.energy_today', 'e', R_USED_DAY, null, undefined, HOUSE_DAY);
  const anySolar = hasSolar || !!solarP || !!solarD, anyBattery = hasBattery || !!battP || !!soc;
  let gridIsHome = false;
  if (!homeP && gridP && !anySolar && !anyBattery) { homeP = gridP; gridP = null; gridIsHome = true; }

  // ---- rooms: temperature sensors (areas in registry order)
  const areas = (snap.areas || []).filter((a) => Array.isArray(a) && str(a[0]));
  const areaIdx = (id: string): number => { const i = areas.findIndex((a) => a[0] === id); return i < 0 ? areas.length : i; };
  const areaName = (id: string): string => { const a = areas.find((x) => x[0] === id); return a ? str(a[1]) : ''; };
  const temps = rows.filter((s) => s.kind === 't' && !hasAny(s.id, NOT_A_ROOM) && !hasAny(s.name, NOT_A_ROOM) && !FORECAST_RE.test(s.text));
  const outside = temps.find((s) => hasAny(s.id, OUTSIDE) || hasAny(s.name, OUTSIDE));
  // no outdoor thermometer: a weather entity's current temperature (#152)
  const weather = outside ? undefined : (snap.weather || []).find((w) => entityFits(w, ['weather']));
  // stable sort by area order (Array.prototype.sort is stable; the firmware uses std::stable_sort)
  const inRooms = temps.filter((s) => s !== outside && !hasAny(s.id, OUTSIDE) && !hasAny(s.name, OUTSIDE) && s.area && areaIdx(s.area) < areas.length)
    .sort((a, b) => areaIdx(a.area) - areaIdx(b.area));
  const perArea: Row[] = [];
  for (const s of inRooms) if (!perArea.some((p) => p.area === s.area)) perArea.push(s);
  const inside = perArea.find((s) => hasAny(s.area, LIVING) || hasAny(areaName(s.area), LIVING)) || perArea[0];

  const screens: Screen[] = [];
  const add = (id: string, app: string, title: string, widgets: Widget[]) => { if (widgets.length) screens.push({ id, app, title, widgets }); };
  const stat = (entity: string, label?: string): Widget => {
    const t = label === undefined ? '' : labelText(label);
    return t ? { type: 'stat', entity, label: t } : { type: 'stat', entity };
  };
  /** A role's tile: its logical id keeps the catalog's tile; any other sensor gets the role's label. */
  const role = (r: Row, logical: string, label: string): Widget => (r.id === logical ? stat(r.id) : stat(r.id, label));
  const gauge = (r: Row): Widget => (r.id === 'sensor.home_battery_soc' ? { type: 'gauge' } : { type: 'gauge', entity: r.id, label: 'Home battery' });
  const homeTile = (r: Row): Widget => (gridIsHome ? stat(r.id, 'Home use') : role(r, 'sensor.home_power', 'Home use'));

  // ---- Home app
  const over: Widget[] = [{ type: 'clock', cs: 2 }];
  const extra: [string, Widget][] = [];
  if (price) extra.push(['price', { type: 'price' }]);
  if (inside) extra.push(['inside', stat(inside.id, 'Inside')]);
  if (solarP) extra.push(['solar_power', role(solarP, 'sensor.solar_power', 'Solar')]);
  if (homeP) extra.push(['home_power', homeTile(homeP)]);
  if (soc) extra.push(['battery_soc', gauge(soc)]);
  if (gridP) extra.push(['grid_power', role(gridP, 'sensor.grid_power', 'Grid')]);
  if (outside || weather) extra.push(['outside', stat(outside ? outside.id : weather!, 'Outside')]);
  const full = new Set<string>();   // tiles the overview had no cell left for
  for (const [k, w] of extra) if (cellsUsed(over) + 1 <= MAX_CELLS) over.push(w); else full.add(k);
  add('overview', 'home', 'Home', over);
  if (price) add('prices', 'home', 'Energy prices', [{ type: 'price' }, { type: 'bars', series: 'prices', cs: 4 }]);
  const energy: Widget[] = [];
  if (usedD) energy.push(role(usedD, 'sensor.energy_today', 'Used today'));
  if (importD) energy.push(role(importD, 'sensor.grid_import_today', 'Imported'));
  if (exportD) energy.push(role(exportD, 'sensor.grid_export_today', 'Exported'));
  if (homeP) energy.push(homeTile(homeP));
  if (solarM || importM) energy.push({ type: 'bars', series: 'usage', cs: 4 });
  if (usedD || importD || exportD || solarM || importM) add('energy', 'home', 'Energy', energy);   // not for home use alone
  const solar: Widget[] = [];
  if (solarP) solar.push(role(solarP, 'sensor.solar_power', 'Solar'));
  if (solarD) solar.push(role(solarD, 'sensor.solar_today', 'Solar today'));
  if (soc) solar.push(gauge(soc));
  if (battP) solar.push(role(battP, 'sensor.battery_power', 'Battery'));
  if (solarM) solar.push({ type: 'bars', series: 'solar', cs: 4 });
  add('solar', 'home', anySolar && anyBattery ? 'Solar & battery' : anyBattery ? 'Battery' : 'Solar', solar);

  // ---- House app
  // lights (#152): per area its first group (a second integration's group of the same room is a duplicate) or else its
  // bulbs; lights without an area are left out. Nothing left out (or no light has an area) = every light (the default);
  // only area-less ones left out = `areas`; else the picks in `entities`, in area order.
  const lights = (snap.lights || []).filter((l) => Array.isArray(l) && entityFits(l[0], ['light'])).map((l) => ({ id: l[0], area: str(l[1]), group: l[2] === 'g' }));
  const lightAreas: string[] = [];
  for (const l of lights) if (l.area && !lightAreas.includes(l.area)) lightAreas.push(l.area);
  lightAreas.sort((a, b) => areaIdx(a) - areaIdx(b));
  const lightPicks: string[] = [];
  let grouped = false;
  for (const a of lightAreas) {
    const ls = lights.filter((l) => l.area === a), g = ls.find((l) => l.group);
    if (g) { lightPicks.push(g.id); grouped ||= ls.length > 1; } else lightPicks.push(...ls.map((l) => l.id));
  }
  if (lights.length) {
    const w: Widget = !lightAreas.length || lightPicks.length === lights.length ? { type: 'lightList', cs: 4, rs: 2 }
      : !grouped ? { type: 'lightList', areas: lightAreas.join(' '), cs: 4, rs: 2 } : { type: 'lightList', entities: lightPicks.join(' '), cs: 4, rs: 2 };
    add('lights', 'house', 'Lights', [w]);
  }
  // zones (#152): one per area / friendly name; of duplicates (a Better Thermostat wrapper next to its thermostat) the
  // first that is not off / unavailable. Any left out (or a vehicle's) = the zoneList names the rest.
  const idle = (z: { state: string }) => ['off', 'unavailable', 'unknown'].includes(z.state);
  const zones: { id: string; name: string; area: string; state: string }[] = [];
  let dupes = false;
  for (const c of snap.climate || []) {
    const z = typeof c === 'string' ? { id: c, name: '', area: '', state: '' }
      : Array.isArray(c) ? { id: str(c[0]), name: str(c[1]).trim().toLowerCase(), area: str(c[2]), state: str(c[3]) } : null;
    if (!z || !entityFits(z.id, ['climate'])) continue;
    const i = zones.findIndex((o) => (z.area && o.area === z.area) || (z.name && o.name === z.name));
    if (i < 0) { zones.push(z); continue; }
    dupes = true;
    if (idle(zones[i]) && !idle(z)) zones[i] = z;
  }
  const car = (snap.vehicles || []).some((c) => entityFits(c, ['climate']));   // zoneList's default is every climate
  if (zones.length) add('climate', 'house', 'Heating', [car || dupes ? { type: 'zoneList', entities: zones.map((z) => z.id).join(' '), cs: 4, rs: 2 } : { type: 'zoneList', cs: 4, rs: 2 }]);
  if (perArea.length >= 2) add('rooms', 'house', 'Rooms', perArea.slice(0, MAX_CELLS).map((s) => stat(s.id, areaName(s.area))));

  // ---- Travel app
  // Any sensor.x4_route_* in HA (or mapped in the settings): a user route on that entity, sorted by id; car when the
  // sensor reports minutes (a travel-time sensor). The tile's title is the sensor's friendly name.
  const RP = 'sensor.x4_route_';
  const routeIds = [...new Set([...live].filter((id) => id.startsWith(RP)).concat(rows.filter((r) => r.id.startsWith(RP)).map((r) => r.id)))].sort();
  add('travel', 'travel', 'Travel', routeIds.slice(0, 4).map((entity): Widget => {
    const car = rows.find((r) => r.id === entity)?.unit === 'min';
    return car ? { type: 'route', entity, mode: 'car', cs: 2 } : { type: 'route', entity, cs: 2 };
  }));

  const all = [...screens, ...tail.map((s) => ({ ...s, widgets: s.widgets.map((w) => ({ ...w })) }))];
  const config = { apps: DEFAULT_APPS.filter((a) => all.some((s) => s.app === a.id)).map((a) => ({ ...a })), screens: all };

  // ---- report (#89). Only overview tiles can be crowded out; the others also sit on their own screen.
  const onlyOverview = new Set(['inside', 'outside', 'grid_power']);
  const sensorTile = (r: Row | null | undefined, rule?: SeedRule): Partial<SeedTile> => (r ? { entity: r.id, rule: rule || how.get(r.id) } : { why: 'no_sensor' });
  const meter = (ok: boolean): Partial<SeedTile> => (ok ? { rule: 'energy' } : { why: energyOn ? 'no_meter' : 'no_energy' });
  const res: Record<string, Partial<SeedTile>> = {
    price: price ? (priceId ? { entity: priceId, rule: 'energy' } : { entity: 'sensor.energy_prices', rule: 'id' }) : { why: energyOn ? 'no_meter' : 'no_energy' },
    inside: sensorTile(inside, 'area'), outside: weather ? { entity: weather, rule: 'found' } : sensorTile(outside, 'name'), solar_power: sensorTile(solarP),
    home_power: sensorTile(homeP, gridIsHome ? 'grid' : undefined), grid_power: sensorTile(gridP), battery_soc: sensorTile(soc),
    battery_power: sensorTile(battP), solar_today: sensorTile(solarD), solar_chart: meter(solarM),
    energy_today: sensorTile(usedD), grid_import_today: sensorTile(importD), grid_export_today: sensorTile(exportD), usage_chart: meter(solarM || importM),
    lights: screens.some((s) => s.id === 'lights') ? { rule: 'found' } : { why: 'none' },
    heating: screens.some((s) => s.id === 'climate') ? { rule: 'found' } : { why: 'none' },
    rooms: perArea.length >= 2 ? { rule: 'area' } : { why: 'few_rooms' },
  };
  if (gridIsHome) delete res.grid_power;   // the grid meter is the home use tile
  for (const k of full) if (onlyOverview.has(k)) res[k] = { why: 'overview_full' };
  const tiles: SeedTile[] = SEED_TILES.filter(([k]) => res[k]).map(([tile, screen]) => ({ tile, screen, ...res[tile] }));
  return { config, report: { filled: tiles.filter((t) => !t.why).length, total: tiles.length, tiles } };
}
