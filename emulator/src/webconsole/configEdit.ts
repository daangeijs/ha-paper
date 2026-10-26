// Pure edits of a screens.yaml Config for the web console's screen builder (categories = apps, screens, entity
// picker, tiles). Each returns a new Config / widget list (or an error string) and never mutates its input.
import { ENTITY_DOMAINS, GRID_COLS, GRID_ROWS, LIST_PICKS, MAX_APPS, MAX_USER_APPS, MAX_CELLS, cellsUsed, domainOf, entityFits, gridLayout, listOf, wLabel, type Config, type Widget } from '../core/config.ts';
import type { HaEntity } from '../core/data.ts';
import type { ListCount } from '../core/paging.ts';

const clone = (c: Config): Config => JSON.parse(JSON.stringify(c));

/** "Kids room" → "kids_room" (unique among `taken`: kids_room_2, …). */
export function slugify(title: string, taken: string[]): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'app';
  let id = base, n = 2;
  while (taken.includes(id)) id = base + '_' + n++;
  return id;
}

/**
 * Move screen `from` into category `app`, before screen index `before` (null = after the category's last screen).
 * Returns the new config and the moved screen's new index.
 */
export function moveScreen(cfg: Config, from: number, app: string, before: number | null): { cfg: Config; index: number } {
  const c = clone(cfg);
  const [sc] = c.screens.splice(from, 1);
  sc.app = app;
  let at: number;
  if (before != null) at = before > from ? before - 1 : before;
  else {
    let last = -1; c.screens.forEach((x, i) => { if (x.app === app) last = i; });
    at = last >= 0 ? last + 1 : c.screens.length;
  }
  c.screens.splice(at, 0, sc);
  return { cfg: c, index: at };
}

export function addApp(cfg: Config, title: string): Config | string {
  const t = title.trim();
  if (!t) return 'Give the category a name.';
  if (cfg.apps.length >= MAX_USER_APPS) return 'The display shows at most ' + MAX_APPS + ' categories, Settings included.';
  const c = clone(cfg);
  c.apps.push({ id: slugify(t, c.apps.map((a) => a.id)), title: t });
  return c;
}

export function renameApp(cfg: Config, id: string, title: string): Config {
  const c = clone(cfg);
  const a = c.apps.find((x) => x.id === id); if (a && title.trim()) a.title = title.trim();
  return c;
}

/** Only empty categories can go, and one always stays. */
export function removeApp(cfg: Config, id: string): Config | string {
  if (cfg.screens.some((s) => s.app === id)) return 'Move or delete its screens first.';
  if (cfg.apps.length <= 1) return 'Keep at least one category.';
  const c = clone(cfg); c.apps = c.apps.filter((a) => a.id !== id);
  return c;
}

/** Reorder categories: move category `from` before category index `before` (null = last). */
export function moveApp(cfg: Config, from: number, before: number | null): Config {
  const c = clone(cfg);
  const [a] = c.apps.splice(from, 1);
  const at = before == null ? c.apps.length : before > from ? before - 1 : before;
  c.apps.splice(at, 0, a);
  return c;
}

/** Case-insensitive match of every word in `q` against any of `fields`. */
export const matches = (q: string, ...fields: string[]): boolean => {
  const hay = fields.join(' ').toLowerCase();
  return q.trim().toLowerCase().split(/\s+/).every((w) => !w || hay.includes(w));
};

/** Domains of the console's single-entity picker: the entity widgets, and a thermo's zone (a climate entity whose
 *  object id goes in `zone:`, #148). undefined = the tile has no picker. */
export const pickDomains = (widgetType: string): string[] | undefined => ENTITY_DOMAINS[widgetType] || (widgetType === 'thermo' ? ['climate'] : undefined);
/** The entity a tile's picker has selected: `entity`, a thermo's climate.<zone>, '' = none. */
export const pickedEntity = (w: Widget): string => (w.type === 'thermo' ? (w.zone ? 'climate.' + w.zone : '') : typeof w.entity === 'string' ? w.entity : '');
/** Tiles with a name field: the entity widgets plus price, bars and thermo (#148: the panel draws the label). */
export const hasLabelField = (widgetType: string): boolean => !!pickDomains(widgetType) || widgetType === 'price' || widgetType === 'bars';

/** HA entities a widget type can show (pickDomains), filtered by the search text. */
export function entitiesFor(list: HaEntity[], widgetType: string, q: string): HaEntity[] {
  const doms = pickDomains(widgetType) || [];
  return list.filter((e) => doms.includes(e.id.split('.')[0]) && matches(q, e.name, e.id));
}

/** Widget values live in one-line flow maps: no , { } : and no surrounding spaces. Spaces, %, accents are fine.
 *  `typing`: the input is cleaned on every keystroke, so keep a trailing space (issue #80: "Batterij %" became "Batterij%"). */
export const cleanLabel = (s: string, typing = false): string => {
  const v = s.replace(/[,{}:#"]/g, ' ').replace(/\s+/g, ' ');
  return typing ? v.trimStart() : v.trim();
};

// ---- tiles on one screen (4 × 2 grid, core gridLayout). Each returns the new widget list and the tile to select, or
// the message to show. Moving a tile pins every tile where it is now (col/row), so the others do not reshuffle.
export type TileEdit = { ws: Widget[]; sel: number } | string;
const cloneWs = (ws: Widget[]): Widget[] => JSON.parse(JSON.stringify(ws));
export const tileSize = (w: Widget): string => ((w.cs as number) || 1) + '×' + ((w.rs as number) || 1);
/** Every tile placed and ≤ 8 cells. */
export const fitsGrid = (ws: Widget[]): boolean => cellsUsed(ws) <= MAX_CELLS && gridLayout(ws).every(Boolean);
const pinAll = (ws: Widget[]): Widget[] => { gridLayout(ws).forEach((c, i) => { if (c) { ws[i].col = c.col; ws[i].row = c.row; } }); return ws; };

/** Add `w` at `cell` ([col, row], 1-based) or at the first free spot. */
export function addTile(ws: Widget[], w: Widget, cell?: [number, number]): TileEdit {
  const nw: Widget = { ...w };
  const what = '“' + wLabel(nw) + '” (' + tileSize(nw) + ')';
  if (cellsUsed(ws) + cellsUsed([nw]) > MAX_CELLS) return 'Screen is full (' + cellsUsed(ws) + ' of 8 cells used). Remove a tile to add ' + what + '.';
  let out = cloneWs(ws);
  if (cell) { out = pinAll(out); nw.col = cell[0]; nw.row = cell[1]; }
  out.push(nw);
  if (!fitsGrid(out)) return cell ? 'No room for ' + what + ' at that spot.' : 'No free spot for ' + what + '. Make room or drop it on an empty cell.';
  return { ws: out, sel: out.length - 1 };
}

/** Move tile `from` to a cell, or swap it with another tile. */
export function moveTile(ws: Widget[], from: number, to: { cell: [number, number] } | { tile: number }): TileEdit {
  if ('tile' in to && to.tile === from) return { ws, sel: from };
  const out = pinAll(cloneWs(ws)); const w = out[from];
  if ('tile' in to) { const o = out[to.tile]; [w.col, w.row, o.col, o.row] = [o.col, o.row, w.col, w.row]; }
  else { w.col = to.cell[0]; w.row = to.cell[1]; }
  if (!fitsGrid(out)) return 'A ' + tileSize(w) + ' tile doesn’t fit there.';
  return { ws: out, sel: from };
}

/** Keyboard move: one cell left / right / up / down; onto another tile = swap with it. At the edge: no change. */
export function nudgeTile(ws: Widget[], i: number, dx: number, dy: number): TileEdit {
  const lay = gridLayout(ws); const c = lay[i]; if (!c) return 'This tile has no room on the screen.';
  const col = c.col + dx, row = c.row + dy;
  if (col < 1 || col > GRID_COLS || row < 1 || row > GRID_ROWS) return { ws, sel: i };
  const other = lay.findIndex((o, j) => j !== i && !!o && col >= o.col && col < o.col + o.cs && row >= o.row && row < o.row + o.rs);
  return moveTile(ws, i, other >= 0 ? { tile: other } : { cell: [col, row] });
}

export function removeTile(ws: Widget[], i: number): Widget[] { const out = cloneWs(ws); out.splice(i, 1); return out; }

export function resizeTile(ws: Widget[], i: number, k: 'cs' | 'rs', n: number): TileEdit {
  const out = cloneWs(ws); if (n === 1) delete out[i][k]; else out[i][k] = n;
  if (!fitsGrid(out)) return 'No room to make this tile ' + tileSize(out[i]) + '. Move or remove another tile first.';
  return { ws: out, sel: i };
}

/** Swap the entity a tile shows. */
/** Pick the tile's entity; a scene tile drops `scene: all_off` (the entity wins, #146). */
export function setTileEntity(ws: Widget[], i: number, id: string): Widget[] {
  const out = cloneWs(ws);
  if (out[i].type === 'thermo') { out[i].zone = id.slice(id.indexOf('.') + 1); return out; }   // #148: zone = climate object id
  out[i].entity = id; if (out[i].type === 'scene') delete out[i].scene; return out;
}
/** A bar chart's series (#148). */
export function setBarsSeries(ws: Widget[], i: number, series: string): Widget[] { const out = cloneWs(ws); out[i].series = series; return out; }
/** A scene tile back to the built-in all lights off (#146). */
export function setSceneAllOff(ws: Widget[], i: number): Widget[] { const out = cloneWs(ws); delete out[i].entity; out[i].scene = 'all_off'; return out; }

// ---- list picks (#127): lightList areas / entities, zoneList entities (space-separated, order = pick order) ----
/** Add `id` to the tile's `key` list (at the end) or take it out; an empty list removes the key (= show all). */
export function togglePick(ws: Widget[], i: number, key: string, id: string): Widget[] {
  const out = cloneWs(ws); const cur = listOf(out[i], key);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  if (next.length) out[i][key] = next.join(' '); else delete out[i][key];
  return out;
}
/** Drop every pick: the tile shows everything again. */
export function clearPicks(ws: Widget[], i: number): Widget[] {
  const out = cloneWs(ws); for (const k of Object.keys(LIST_PICKS[out[i].type] || {})) delete out[i][k];
  return out;
}
/** An unpicked lightList / zoneList the display's subscription cap cuts short (#134): [shown, total], else null. */
export function capHides(w: Widget, lists: { climate: ListCount; lights: ListCount } | undefined): [number, number] | null {
  if (!lists || !LIST_PICKS[w.type] || Object.keys(LIST_PICKS[w.type]).some((k) => listOf(w, k).length)) return null;
  const c = w.type === 'lightList' ? lists.lights : lists.climate;
  return c.shown < c.total ? [c.shown, c.total] : null;
}
export type PickRow = { id: string; name: string; on: boolean; viaArea: boolean };
export type PickGroup = { area: string; name: string; on: boolean; rows: PickRow[] };
/**
 * The list picker of a lightList (lights by HA area, areas in registry order, "no area" last) or zoneList (climate
 * entities, one group with area ''). `on`: picked; `viaArea`: shown because its area is picked. Search matches the
 * name, entity id or area name; an area whose name matches keeps all its lights.
 */
export function pickGroups(list: HaEntity[], areas: { id: string; name: string }[], w: Widget, q: string, noArea: string): PickGroup[] {
  const lights = w.type === 'lightList'; const dom = lights ? 'light' : 'climate';
  const ents = listOf(w, 'entities'), picked = listOf(w, 'areas');
  const mine = list.filter((e) => e.id.split('.')[0] === dom);
  if (!lights) return [{ area: '', name: '', on: false, rows: mine.filter((e) => matches(q, e.name, e.id)).map((e) => ({ id: e.id, name: e.name, on: ents.includes(e.id), viaArea: false })) }];
  const order = [...areas.map((a) => a.id), ...new Set(mine.map((e) => e.area || '').filter((a) => a && !areas.some((x) => x.id === a))), ''];
  const nameOf = (a: string) => (a ? areas.find((x) => x.id === a)?.name || a : noArea);
  return order.map((a) => {
    const areaOn = !!a && picked.includes(a); const hit = !!a && matches(q, nameOf(a), a);
    const rows = mine.filter((e) => (e.area || '') === a && (hit || matches(q, e.name, e.id)))
      .map((e) => ({ id: e.id, name: e.name, on: areaOn || ents.includes(e.id), viaArea: areaOn }));
    return { area: a, name: nameOf(a), on: areaOn, rows };
  }).filter((g) => g.rows.length);
}

/** Tile name; empty = the Home Assistant name. */
export function setTileLabel(ws: Widget[], i: number, label: string, typing = false): Widget[] {
  const out = cloneWs(ws); const v = cleanLabel(label, typing);
  if (v) out[i].label = v; else delete out[i].label;
  return out;
}

// ---- entity picker: best fit for the widget first (a gauge fills 0–100 %; a stat shows power, energy, temperature)
const STAT_UNITS = ['W', 'kW', '°C', '°F', 'kWh', 'Wh', 'MWh'];
/** 0 = best. */
export function entityFit(e: HaEntity, widgetType: string): number {
  const dom = domainOf(e.id);
  if (widgetType === 'gauge') return e.unit === '%' ? 0 : e.unit ? 2 : 3;
  if (widgetType === 'stat') return STAT_UNITS.includes(e.unit) ? 0 : e.unit ? 1 : dom === 'binary_sensor' ? 3 : 2;
  if (widgetType === 'switch') return dom === 'switch' || dom === 'light' ? 0 : 1;
  return 0;
}
/** entitiesFor, best fit first, then by name. */
export function rankEntities(list: HaEntity[], widgetType: string, q: string): HaEntity[] {
  return entitiesFor(list, widgetType, q).map((e) => ({ e, f: entityFit(e, widgetType) }))
    .sort((a, b) => a.f - b.f || a.e.name.localeCompare(b.e.name) || (a.e.id < b.e.id ? -1 : 1)).map((x) => x.e);
}
/** "21.4 °C", "On", "—" (unknown, unavailable or not sent). */
export function entityValue(e: HaEntity): string {
  const s = e.state;
  if (s == null || s === '' || s === 'unknown' || s === 'unavailable') return '—';
  if (s === 'on' || s === 'off') return s === 'on' ? 'On' : 'Off';
  const v = s.length > 16 ? s.slice(0, 15) + '…' : s;
  return e.unit ? v + ' ' + e.unit : v;
}

// ---- inline validation, shown at the field; `hard` blocks Push
export type Issue = { msg: string; hard: boolean };
export const titleIssue = (title: string): Issue | null => (title.trim() ? null : { msg: 'Give the screen a name.', hard: true });
/** Entity field of a stat / gauge / switch tile. `list`: HA's entity list once loaded (null = not loaded yet). */
export function entityIssue(w: Widget, list: HaEntity[] | null): Issue | null {
  if (w.type === 'thermo') {   // #148: the zone picker
    if (!w.zone) return { msg: 'Pick an entity below.', hard: true };
    const id = 'climate.' + w.zone;
    return list && !list.some((x) => x.id === id) ? { msg: 'Home Assistant’s entity list does not have “' + id + '”. The tile shows “—” until Home Assistant reports it.', hard: false } : null;
  }
  const doms = ENTITY_DOMAINS[w.type]; if (!doms) return null;
  if ((w.type === 'gauge' || w.type === 'scene') && w.entity === undefined) return null;   // the home battery / all lights off
  if (!w.entity) return { msg: 'Pick an entity below.', hard: true };
  if (!entityFits(w.entity, doms)) return { msg: '“' + w.entity + '” is not a ' + doms.join(' / ') + ' entity.', hard: true };
  if (!list) return null;
  const e = list.find((x) => x.id === w.entity);
  if (!e) return { msg: 'Home Assistant’s entity list does not have “' + w.entity + '”. The tile shows “—” until Home Assistant reports it.', hard: false };
  if (w.type === 'gauge' && e.unit !== '%') return { msg: 'A gauge fills from 0 to 100 %; this entity reports ' + (e.unit || 'no unit') + '. A sensor value tile fits better.', hard: false };
  return null;
}
/** First hard issue in the config: the screen (and tile, -1 = the title) to show it on. */
export function firstIssue(cfg: Config, list: HaEntity[] | null): { screen: number; tile: number; msg: string } | null {
  for (let s = 0; s < cfg.screens.length; s++) {
    const sc = cfg.screens[s];
    const t = titleIssue(sc.title); if (t) return { screen: s, tile: -1, msg: t.msg };
    for (let i = 0; i < sc.widgets.length; i++) {
      const e = entityIssue(sc.widgets[i], list);
      if (e?.hard) return { screen: s, tile: i, msg: e.msg };
    }
  }
  return null;
}
