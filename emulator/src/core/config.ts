// screens.yaml: model, default config, parser/validator and serializer.
// Ported 1:1 from Main.dc.html (toYaml / parseYaml). The firmware must reject the same inputs with the
// same line numbers and messages: see spec/test-vectors/config/*.json (generated from this file).
import { APPS, ENT, ZONE_NAME, SETTINGS } from './data.ts';
import { entityGap, type EntityGap } from './format.ts';
import { HISTORY_DOMAINS, MAX_HISTORY_TILES, historyDomains, historyError } from './history.ts';

// `light` is the pre-0.5 single-light widget: parseYaml rewrites {type: light, light: x} to {type: switch, entity: light.x}.
export const WIDGET_TYPES = ['clock', 'stat', 'price', 'gauge', 'bars', 'route', 'lightList', 'switch', 'light', 'scene', 'zoneList', 'thermo', 'history', 'setting', 'ota', 'wifi', 'ha', 'about'];

// Home Assistant domains each entity widget accepts (entity = full HA entity_id, e.g. sensor.outdoor_temperature).
export const ENTITY_DOMAINS: Record<string, string[]> = {
  stat: ['sensor', 'binary_sensor', 'input_number', 'number', 'climate', 'weather'],   // climate / weather: a temperature (#161)
  gauge: ['sensor', 'input_number', 'number'],
  switch: ['switch', 'light', 'input_boolean', 'fan'],
  route: ['sensor'],
  history: HISTORY_DOMAINS,   // #265: numeric entities; an attribute / weather forecast series widens it (#283, historyDomains)
  scene: ['scene', 'script'],   // #146: scene.turn_on / script.turn_on; no entity = the built-in all lights off
};
/** Entity widgets that may leave `entity` out: gauge = the home battery; route = an empty user route (an old catalog
 *  route such as `route: car`, #145) that shows the gap state until the user picks its sensor; scene = all lights off
 *  (the pre-#146 `scene: all_off`). */
export const ENTITY_OPTIONAL = ['gauge', 'route', 'scene'];
/** What tapping a scene tile asks HA (#146): its scene / script entity → <domain>.turn_on, none → light.turn_off all.
 *  An entity wins over a `scene:` key (only all_off ever existed). */
export function sceneAction(w: Widget): { domain: string; service: string; data: Record<string, string> } {
  const e = typeof w.entity === 'string' ? w.entity : '';
  return e ? { domain: domainOf(e), service: 'turn_on', data: { entity_id: e } } : { domain: 'light', service: 'turn_off', data: { entity_id: 'all' } };
}
/** Route tile kinds (icon and how the entity is read, spec/SCHEMA.md); absent = train. */
export const ROUTE_MODES = ['train', 'bus', 'car'];
/** Bar chart series (spec/SCHEMA.md); anything else draws usage. */
export const BARS_SERIES = ['prices', 'usage', 'solar'];
export const GAUGE_DEFAULT_ENTITY = 'sensor.home_battery_soc';
export const domainOf = (entityId: string): string => entityId.split('.')[0];
/** HA entities of stat / gauge / switch / route tiles that have no value right now (#86): id → reason. Our own logical
 *  sensors (ENT) and the gauge's home battery are derived tiles, never listed; nor are scene tiles (a scene's state is
 *  "unknown" until it first runs, #146). GET /console/state `entity_gaps`. */
export function entityGaps(screens: { widgets: { type: string; entity?: unknown }[] }[], stateOf: (id: string) => string | undefined): Record<string, EntityGap> {
  const out: Record<string, EntityGap> = {};
  for (const sc of screens) for (const w of sc.widgets) {
    const id = w.entity;
    if (typeof id !== 'string' || !ENTITY_DOMAINS[w.type] || w.type === 'scene' || ENT[id] || id === GAUGE_DEFAULT_ENTITY) continue;
    const g = entityGap(stateOf(id)); if (g) out[id] = g;
  }
  return out;
}
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
/** Does `id` look like an HA entity_id of one of `domains`? */
export const entityFits = (id: unknown, domains: string[]): boolean => typeof id === 'string' && ENTITY_ID.test(id) && domains.includes(domainOf(id));
/** A space-separated list field (lightList areas / entities, zoneList entities, #127); absent = []. */
export const listOf = (w: Widget, k: string): string[] => (w[k] === undefined ? [] : String(w[k]).split(' ').filter(Boolean));
/** List tiles' pick fields (#127): field → HA domain of its entity ids, or null = HA area ids. Nothing picked = all. */
export const LIST_PICKS: Record<string, Record<string, string | null>> = { lightList: { areas: null, entities: 'light' }, zoneList: { entities: 'climate' } };
const AREA_ID = /^[a-z0-9_]+$/;
/** zoneList `labels` (#151): "climate.a=Name; climate.b=Other name" → [entity, label] in order, items trimmed, empty
 *  items skipped. Items without "=" come back with label "" (parseYaml rejects them). */
export const labelPairs = (v: unknown): [string, string][] => (v === undefined ? [] : String(v).split(';').map((x) => x.trim()).filter(Boolean)
  .map((x) => { const eq = x.indexOf('='); return eq < 0 ? [x, ''] : [x.slice(0, eq).trim(), x.slice(eq + 1).trim()]; }));
/** A zoneList's own name for a zone (#151), else undefined: the room keeps HA's name. */
export const zoneLabel = (w: Widget, zoneId: string): string | undefined => labelPairs(w.labels).find(([e, l]) => e === 'climate.' + zoneId && l)?.[1];

export type Widget = { type: string; cs?: number; rs?: number; [k: string]: string | number | undefined };
export type Screen = { id: string; app: string; title: string; widgets: Widget[] };
/** An app is a category of screens (the display's app switcher). */
export type AppDef = { id: string; title: string };
export type Config = { apps: AppDef[]; screens: Screen[] };

/** App switcher slots on the display; one is the built-in Settings app, so screens.yaml has at most MAX_USER_APPS. */
export const MAX_APPS = 8;
export const MAX_USER_APPS = MAX_APPS - 1;
/** Settings (#159): a fixed, built-in app, always last in the switcher; never part of screens.yaml. */
export const SETTINGS_APP: AppDef = { id: 'settings', title: 'Settings' };
/** Tiles that only exist on the fixed Settings pages: parseYaml drops them from user screens. */
export const SYSTEM_TILES = ['setting', 'ota', 'wifi', 'ha', 'about'];
/** Used when screens.yaml has no `apps:` section. */
export const DEFAULT_APPS: AppDef[] = APPS.filter((a) => a.id !== SETTINGS_APP.id).map((a) => ({ id: a.id, title: a.title }));
const isDefaultApps = (apps: AppDef[]): boolean => apps.length === DEFAULT_APPS.length && apps.every((a, i) => a.id === DEFAULT_APPS[i].id && a.title === DEFAULT_APPS[i].title);

export const MAX_CELLS = 8;
export const GRID_COLS = 4, GRID_ROWS = 2;
export const cellsOf = (w: Widget): number => ((w.cs as number) || 1) * ((w.rs as number) || 1);
export const cellsUsed = (widgets: Widget[]): number => widgets.reduce((a, w) => a + cellsOf(w), 0);

/** A widget's place on the 4 × 2 grid; col/row are 1-based. */
export type Cell = { col: number; row: number; cs: number; rs: number };
/** Pinned = the widget sets both `col` and `row` (screens.yaml); others auto-place. */
export const isPinned = (w: Widget): boolean => typeof w.col === 'number' && typeof w.row === 'number';
const spanOf = (w: Widget): [number, number] => [Math.min(GRID_COLS, (w.cs as number) || 1), Math.min(GRID_ROWS, (w.rs as number) || 1)];

/**
 * Where each widget lands (null = no room, not drawn). Pinned widgets first, at their col/row;
 * then the rest row-major from a forward-only cursor (firmware gridRects / CSS grid auto-placement).
 */
export function gridLayout(widgets: Widget[]): (Cell | null)[] {
  const occ = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(false));
  const free = (c: number, r: number, cs: number, rs: number) => {
    if (c < 0 || r < 0 || c + cs > GRID_COLS || r + rs > GRID_ROWS) return false;
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if (occ[y][x]) return false;
    return true;
  };
  const take = (c: number, r: number, cs: number, rs: number): Cell => {
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) occ[y][x] = true;
    return { col: c + 1, row: r + 1, cs, rs };
  };
  const out: (Cell | null)[] = widgets.map(() => null);
  widgets.forEach((w, i) => {
    if (!isPinned(w)) return;
    const [cs, rs] = spanOf(w); const c = (w.col as number) - 1, r = (w.row as number) - 1;
    if (free(c, r, cs, rs)) out[i] = take(c, r, cs, rs);
  });
  let cr = 0, cc = 0;
  widgets.forEach((w, i) => {
    if (isPinned(w)) return;
    const [cs, rs] = spanOf(w);
    for (let r = cr; r <= GRID_ROWS - rs && !out[i]; r++)
      for (let c = r === cr ? cc : 0; c <= GRID_COLS - cs && !out[i]; c++)
        if (free(c, r, cs, rs)) { out[i] = take(c, r, cs, rs); cr = r; cc = c + cs; }
  });
  return out;
}

const SCREEN_APP: Record<string, string> = { overview: 'home', energy: 'home', solar: 'home', prices: 'home', climate: 'house', lights: 'house' };

const DEFAULT_SCREENS_RAW: Omit<Screen, 'app'>[] = [
  { id: 'overview', title: 'Home', widgets: [
    { type: 'clock', cs: 2 }, { type: 'price' }, { type: 'stat', entity: 'sensor.living_temperature' },
    { type: 'stat', entity: 'sensor.solar_power' }, { type: 'stat', entity: 'sensor.home_power' }, { type: 'gauge' }, { type: 'stat', entity: 'sensor.grid_power' } ] },
  // Order inside each app = most used first.
  { id: 'prices', title: 'Energy prices', widgets: [
    { type: 'price' }, { type: 'stat', entity: 'sensor.price_cheap_window' }, { type: 'stat', entity: 'sensor.price_min' }, { type: 'stat', entity: 'sensor.price_max' },
    { type: 'bars', series: 'prices', cs: 4 } ] },
  { id: 'energy', title: 'Energy', widgets: [
    { type: 'stat', entity: 'sensor.energy_today' }, { type: 'stat', entity: 'sensor.grid_import_today' }, { type: 'stat', entity: 'sensor.grid_export_today' }, { type: 'stat', entity: 'sensor.home_power' },
    { type: 'bars', series: 'usage', cs: 4 } ] },
  { id: 'solar', title: 'Solar & battery', widgets: [
    { type: 'stat', entity: 'sensor.solar_power' }, { type: 'stat', entity: 'sensor.solar_today' }, { type: 'gauge' }, { type: 'stat', entity: 'sensor.battery_power' },
    { type: 'bars', series: 'solar', cs: 4 } ] },
  { id: 'lights', title: 'Lights', widgets: [{ type: 'lightList', cs: 4, rs: 2 }] },
  { id: 'climate', title: 'Heating', widgets: [{ type: 'zoneList', cs: 4, rs: 2 }] },
];
/** Fresh deep copy of the default screens (spec/default-screens.yaml). */
export const defaultScreens = (): Screen[] => JSON.parse(JSON.stringify(DEFAULT_SCREENS_RAW)).map((sc: Screen) => ({ ...sc, app: SCREEN_APP[sc.id] || 'home' }));
/** Default apps = the built-in apps that have a default screen (no Travel: routes are the user's own, #145). */
export const defaultConfig = (): Config => {
  const screens = defaultScreens();
  return { apps: DEFAULT_APPS.filter((a) => screens.some((s) => s.app === a.id)).map((a) => ({ ...a })), screens };
};

// The fixed Settings pages (#159), in order; = firmware core/config.cpp settingsScreens().
const SETTINGS_SCREENS: Omit<Screen, 'app'>[] = [
  { id: 'display', title: 'Display', widgets: [
    { type: 'setting', key: 'brightness' }, { type: 'setting', key: 'warmth' }, { type: 'setting', key: 'lightTimeout' }, { type: 'setting', key: 'night' },
    { type: 'setting', key: 'returnHome' }, { type: 'setting', key: 'standby' }, { type: 'setting', key: 'interval' }, { type: 'setting', key: 'cleanEvery' } ] },
  // Display is full (8 cells): the clock format sits with the look since #220.
  // Display styles (x4-display-styles): the look is a device setting; these tiles only step it (same screen as firmware/src/core/config.cpp).
  { id: 'style', title: 'Display style', widgets: [{ type: 'setting', key: 'style' }, { type: 'setting', key: 'typeface', cs: 2 }, { type: 'setting', key: 'surface' }, { type: 'setting', key: 'clock' }] },
  // Power saving (ROBUSTNESS_PLAN 3.1, glance #10, emulator DEVIATIONS 10). Two rows tall: room for each setting's hint (#190).
  { id: 'power', title: 'Power', widgets: [{ type: 'setting', key: 'powerSave', cs: 2, rs: 2 }, { type: 'setting', key: 'wakeEvery', rs: 2 }, { type: 'setting', key: 'liveMin', rs: 2 }] },
  { id: 'updates', title: 'Updates', widgets: [{ type: 'ota', cs: 4, rs: 2 }] },
  { id: 'wifi', title: 'Wi-Fi', widgets: [{ type: 'wifi', cs: 4, rs: 2 }] },
  { id: 'ha', title: 'Home Assistant', widgets: [{ type: 'ha', cs: 4, rs: 2 }] },
  { id: 'about', title: 'About', widgets: [{ type: 'about', cs: 4, rs: 2 }] },
];
export const settingsScreens = (): Screen[] => JSON.parse(JSON.stringify(SETTINGS_SCREENS)).map((sc: Screen) => ({ ...sc, app: SETTINGS_APP.id }));
/** What the display runs: the user's apps and screens, then the built-in Settings app and its fixed pages. */
export const withSettings = (cfg: Config): Config => {
  const u = userConfig(cfg);
  return { apps: [...u.apps, { ...SETTINGS_APP }], screens: [...u.screens, ...settingsScreens()] };
};
/** The part of a config that belongs in screens.yaml: no Settings app, no Settings screens. */
export const userConfig = (cfg: Config): Config => ({ apps: cfg.apps.filter((a) => a.id !== SETTINGS_APP.id), screens: cfg.screens.filter((s) => s.app !== SETTINGS_APP.id) });

// First-install screens (not part of the user's config): Wi-Fi on the display, then the browser.
export const SETUP_SCREENS: Record<'wifi' | 'web', Screen> = {
  wifi: { id: 'setup_wifi', app: 'setup', title: 'Connect to Wi-Fi', widgets: [{ type: 'wifi', cs: 4, rs: 2 }] },
  web: { id: 'setup_web', app: 'setup', title: 'Finish in your browser', widgets: [{ type: 'setupWeb', cs: 4, rs: 2 }] },
};

const has = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** Human label of a widget (web console tiles). `names`: HA friendly names by entity_id, when known. */
export function wLabel(w: Widget, names: Record<string, string> = {}): string {
  if (w.label) return String(w.label);
  if (['stat', 'switch', 'gauge', 'route', 'scene', 'history'].includes(w.type) && w.entity) {
    const e = String(w.entity);
    return (has(ENT, e) && ENT[e].label) || (has(names, e) && names[e]) || e;
  }
  if (w.type === 'thermo') return w.zone ? (has(ZONE_NAME, w.zone) && ZONE_NAME[w.zone as string]) || (has(names, 'climate.' + w.zone) && names['climate.' + w.zone]) || String(w.zone) : 'Room';
  if (w.type === 'setting') return (has(SETTINGS, w.key) && SETTINGS[w.key as string].label) || String(w.key);
  if (w.type === 'bars') return ({ prices: 'Prices chart', usage: 'Usage chart', solar: 'Solar chart' } as Record<string, string>)[w.series as string] || 'Chart';
  if ((w.type === 'lightList' || w.type === 'zoneList') && Object.keys(LIST_PICKS[w.type]).some((k) => listOf(w, k).length)) return w.type === 'lightList' ? 'Lights' : 'Rooms';
  return ({ clock: 'Clock', price: 'Price now', gauge: 'Home battery', lightList: 'All lights', scene: 'All lights off', zoneList: 'All rooms', ota: 'Updates', wifi: 'Wi-Fi', ha: 'Home Assistant', about: 'About', route: 'Route', stat: 'Sensor value', switch: 'Switch', history: 'History chart' } as Record<string, string>)[w.type] || w.type;
}

const yq = (t: string): string => (/[:#{}[\],"]|^\s|\s$/.test(t) ? JSON.stringify(t) : t);

/** `apps:` is written only when it differs from DEFAULT_APPS (so the default file stays spec/default-screens.yaml). */
export function toYaml(cfg: Config): string {
  const out = ['# HA Paper display config', 'version: 1'];
  if (!isDefaultApps(cfg.apps)) { out.push('apps:'); cfg.apps.forEach((a) => out.push('  - id: ' + a.id, '    title: ' + yq(a.title))); }
  out.push('screens:');
  cfg.screens.forEach((sc) => {
    out.push('  - id: ' + sc.id, '    app: ' + (sc.app || 'home'), '    title: ' + yq(sc.title), '    widgets:' + (sc.widgets.length ? '' : ' []'));
    sc.widgets.forEach((w) => out.push('      - {' + Object.keys(w).map((k) => k + ': ' + w[k]).join(', ') + '}'));
  });
  return out.join('\n') + '\n';
}

/** Thrown by parseYaml. `line` is 1-based. */
export class ConfigError extends Error {
  line: number;
  msg: string;
  constructor(line: number, msg: string) { super('line ' + line + ': ' + msg); this.line = line; this.msg = msg; }
}

/**
 * Line-based parser for the restricted screens.yaml dialect (see spec/SCHEMA.md).
 * Rules (each rejects with a line number): version != 1, apps after screens, duplicate app id, more than 8 apps,
 * widget/app/title before a screen, unknown app, widget outside "widgets:", malformed "key: value", unknown widget type,
 * stat/gauge/switch/route/scene entity not an HA entity_id of an allowed domain, lightList areas / entities or zoneList entities
 * not area ids / light / climate entity_ids (#127), a zoneList labels item that is not climate.<id>=Name (#151), unknown route,
 * a history tile's window / bucket / agg / style / min / max (history.ts historyError) or a 7th history tile (#265),
 * cs not 1–4, rs not 1–2,
 * col not 1–4 / row not 1–2 (they go together), a pinned tile that sticks out of the grid or overlaps an earlier pinned one,
 * unreadable line, no apps (empty "apps:"), no screens, duplicate screen id, more than 8 cells on a screen.
 * Without an `apps:` section the apps are DEFAULT_APPS; a screen without `app:` belongs to the first app.
 * Settings is built in (#159): an `apps:` entry `settings` is skipped, `app: settings` screens and settings tiles
 * (SYSTEM_TILES) are checked like any other, then dropped; the display adds the fixed pages (withSettings).
 */
export function parseYaml(text: string): Config {
  const lines = text.split('\n'); let screens: Screen[] | null = null, cur: Screen | null = null, inW = false; const at: Record<string, number> = {};
  let apps: AppDef[] | null = null, curApp: AppDef | null = null, appsAt = 0, sawSettings = false, histories = 0;
  const appList = (): AppDef[] => (apps?.length ? apps : DEFAULT_APPS);
  const fail = (n: number, msg: string): never => { throw new ConfigError(n, msg); };
  const unq = (v: string): string => { v = v.trim(); if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v; } } return v; };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; const n = i + 1;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^version:\s*(\S+)\s*$/))) { if (m[1] !== '1') fail(n, 'Only version 1 is supported'); }
    else if (/^apps:\s*$/.test(raw)) { if (screens) fail(n, '“apps:” must come before “screens:”'); apps = []; appsAt = n; curApp = null; }
    else if (/^screens:\s*$/.test(raw)) { screens = []; curApp = null; }
    else if ((m = raw.match(/^ {2}- id:\s*(\S+)\s*$/))) {
      if (!screens && apps) {
        if (m[1] === SETTINGS_APP.id) { sawSettings = true; curApp = { id: m[1], title: m[1] }; continue; }   // built in: skipped
        if (apps.some((a) => a.id === m![1])) fail(n, 'Duplicate app id “' + m[1] + '”');
        if (apps.length >= MAX_USER_APPS) fail(n, 'At most ' + MAX_USER_APPS + ' apps');
        curApp = { id: m[1], title: m[1] }; apps.push(curApp); continue;
      }
      if (!screens) return fail(n, '“screens:” must come first');
      cur = { id: m[1], app: appList().length ? appList()[0].id : 'home', title: m[1], widgets: [] }; at[m[1]] = n; screens.push(cur); inW = false;
    }
    else if ((m = raw.match(/^ {4}(app|title):\s*(.+)$/))) {
      if (curApp && !screens) { if (m[1] !== 'title') fail(n, 'Can’t read this line'); curApp.title = unq(m[2]); continue; }
      if (!cur) return fail(n, 'Belongs to no screen');
      cur[m[1] as 'app' | 'title'] = unq(m[2]);
      if (m[1] === 'app' && cur.app !== SETTINGS_APP.id && !appList().some((a) => a.id === cur!.app)) fail(n, 'Unknown app “' + cur.app + '” (' + appList().map((a) => a.id).join(', ') + ')');
    }
    else if (/^ {4}widgets:\s*(\[\])?\s*$/.test(raw)) { if (!cur) fail(n, 'Belongs to no screen'); inW = true; }
    else if ((m = raw.match(/^ {6}- \{(.*)\}\s*$/))) {
      if (!inW || !cur) return fail(n, 'Widget outside a “widgets:” list');
      let w: Record<string, string | number> = {};
      m[1].split(',').forEach((part) => { const kv = part.split(':'); if (kv.length < 2) fail(n, 'Expected key: value'); const k = kv[0].trim(); const v = kv.slice(1).join(':').trim(); w[k] = /^\d+$/.test(v) ? Number(v) : v; });
      if (!WIDGET_TYPES.includes(w.type as string)) fail(n, 'Unknown widget type “' + w.type + '”');
      if (w.type === 'light') {   // legacy single light → switch on light.<id>
        const nw: Record<string, string | number> = {};
        Object.keys(w).forEach((k) => { if (k === 'type') nw.type = 'switch'; else if (k === 'light') nw.entity = String(w.light).includes('.') ? String(w.light) : 'light.' + w.light; else nw[k] = w[k]; });
        w = nw;
      }
      const doms = w.type === 'history' ? historyDomains(w) : ENTITY_DOMAINS[w.type as string];   // #283: by source
      if (doms && (!ENTITY_OPTIONAL.includes(w.type as string) || w.entity !== undefined) && !entityFits(w.entity, doms))
        fail(n, w.type + ': “' + w.entity + '” is not a ' + doms.join(' / ') + ' entity');
      const picks = LIST_PICKS[w.type as string];
      if (picks) for (const k of Object.keys(picks)) for (const id of listOf(w as Widget, k)) {
        const dom = picks[k];
        if (dom ? !entityFits(id, [dom]) : !AREA_ID.test(id)) fail(n, w.type + ': “' + id + '” is not ' + (dom ? 'a ' + dom + ' entity' : 'an area id'));
      }
      if (w.type === 'zoneList') for (const [e, l] of labelPairs(w.labels))
        if (!entityFits(e, ['climate']) || !l) fail(n, 'zoneList: “' + e + '” in labels is not climate.<id>=Name');
      if (w.type === 'route' && w.mode !== undefined && !ROUTE_MODES.includes(w.mode as string)) fail(n, 'route: mode must be train, bus or car');
      if (w.cs && ![1, 2, 3, 4].includes(w.cs as number)) fail(n, 'cs must be 1–4');
      if (w.rs && ![1, 2].includes(w.rs as number)) fail(n, 'rs must be 1 or 2');
      if (w.col !== undefined || w.row !== undefined) {
        if (![1, 2, 3, 4].includes(w.col as number)) fail(n, 'col must be 1–4');
        if (![1, 2].includes(w.row as number)) fail(n, 'row must be 1 or 2');
        const [cs, rs] = spanOf(w as Widget);
        if ((w.col as number) + cs - 1 > GRID_COLS || (w.row as number) + rs - 1 > GRID_ROWS) fail(n, 'Does not fit at col ' + w.col + ', row ' + w.row);
        const pinned = [...cur.widgets.filter(isPinned), w as Widget];
        if (gridLayout(pinned)[pinned.length - 1] === null) fail(n, 'Overlaps another tile at col ' + w.col + ', row ' + w.row);
      }
      if (w.type === 'history') {
        const err = historyError(w);
        if (err) fail(n, err);
        if (++histories > MAX_HISTORY_TILES) fail(n, 'At most ' + MAX_HISTORY_TILES + ' history tiles');
      }
      cur.widgets.push(w as Widget);
    }
    else fail(n, 'Can’t read this line');
  }
  if (apps && !apps.length && !sawSettings) return fail(appsAt, 'No apps found');
  if (!screens || !screens.length) return fail(1, 'No screens found');
  const ids = new Set<string>();
  screens.forEach((sc) => {
    if (ids.has(sc.id)) fail(at[sc.id], 'Duplicate screen id “' + sc.id + '”'); ids.add(sc.id);
    const cells = cellsUsed(sc.widgets);
    if (cells > MAX_CELLS) fail(at[sc.id], '“' + sc.title + '” uses ' + cells + ' of 8 cells');
  });
  const user = screens.filter((sc) => sc.app !== SETTINGS_APP.id).map((sc) => ({ ...sc, widgets: sc.widgets.filter((w) => !SYSTEM_TILES.includes(w.type)) }));
  if (!user.length) return fail(1, 'No screens found');   // only Settings screens: nothing of your own (toYaml would not re-parse)
  return { apps: (apps?.length ? apps : DEFAULT_APPS).map((a) => ({ ...a })), screens: user };
}

export type ValidateResult = { ok: true; config: Config } | { ok: false; line: number; message: string };
/** Non-throwing wrapper (shape used by the test vectors and by PUT /config → 422). */
export function validateYaml(text: string): ValidateResult {
  try { return { ok: true, config: parseYaml(text) }; }
  catch (e) { if (e instanceof ConfigError) return { ok: false, line: e.line, message: e.msg }; throw e; }
}
