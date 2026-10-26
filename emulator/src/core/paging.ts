// Paging: long lists become extra pages; pager counts pages inside the current app; grid auto-placement.
// Ported from Main.dc.html (layoutLights, subPages, flat, rects).
import { listOf, type Screen, type Widget } from './config.ts';

export const PER_COL = 5, PER_PAGE = 10;

export type LightItem = { kind: 'h'; room: string; cont?: boolean } | { kind: 'l'; id: string; room: string } | { kind: 's' };

/**
 * Paginate grouped lights into 2 columns × 5 rows. Rules: never end a column on a room header;
 * a column that starts mid-room repeats the header ("cont.").
 */
export function layoutLights(rooms: [string, string][], lights: { id: string; room: string }[], perCol = PER_COL): LightItem[][] {
  const items: LightItem[] = [];
  rooms.forEach(([room]) => { const ls = lights.filter((l) => l.room === room); if (!ls.length) return; items.push({ kind: 'h', room }); ls.forEach((l) => items.push({ kind: 'l', id: l.id, room })); });
  const cols: LightItem[][] = []; let col: LightItem[] = [];
  const close = () => { while (col.length < perCol) col.push({ kind: 's' }); cols.push(col); col = []; };
  items.forEach((it) => {
    if (col.length === perCol) close();
    if (it.kind === 'h' && col.length === perCol - 1) close();
    if (col.length === 0 && it.kind === 'l') col.push({ kind: 'h', room: it.room, cont: true });
    col.push(it);
  });
  if (col.length) close();
  const pages: LightItem[][] = [];
  for (let i = 0; i < cols.length; i += 2) pages.push([...cols[i], ...(cols[i + 1] || Array(perCol).fill({ kind: 's' }))]);
  return pages;
}

/** Lights of one HA area, in display order. ids are object ids (light.<id>). */
export type LightGroup = { area: string; ids: string[] };
/** Lights grouped by area: areas in `rooms` order, lights in list order, empty areas dropped. */
export const lightGroupsOf = (rooms: [string, string][], lights: { id: string; room: string }[]): LightGroup[] =>
  rooms.map(([area]) => ({ area, ids: lights.filter((l) => l.room === area).map((l) => l.id) })).filter((g) => g.ids.length);
/** layoutLights over groups (a group keeps its own light order). */
export const layoutGroups = (groups: LightGroup[]): LightItem[][] =>
  layoutLights(groups.map((g) => [g.area, g.area]), groups.flatMap((g) => g.ids.map((id) => ({ id, room: g.area }))));

/**
 * What a lightList tile shows (#127): `areas` (HA area ids, each with all its lights) then `entities` (light.* in pick
 * order, grouped under their area; an area seen first here goes last). Order follows the pick; unknown ids are
 * skipped; nothing picked = every group.
 */
export function pickLights(groups: LightGroup[], w: Widget): LightGroup[] {
  const areas = listOf(w, 'areas'), ents = listOf(w, 'entities');
  if (!areas.length && !ents.length) return groups;
  const out: LightGroup[] = [];
  for (const a of areas) { const g = groups.find((x) => x.area === a); if (g && !out.some((x) => x.area === a)) out.push({ area: a, ids: [...g.ids] }); }
  for (const e of ents) {
    const g = groups.find((x) => x.ids.some((id) => 'light.' + id === e)); if (!g) continue;
    const id = e.slice(6); if (out.some((x) => x.ids.includes(id))) continue;
    const o = out.find((x) => x.area === g.area); if (o) o.ids.push(id); else out.push({ area: g.area, ids: [id] });
  }
  return out;
}

/** What a zoneList tile shows (#127): `entities` (climate.*) in pick order, unknown skipped; nothing picked = all. */
export function pickZones<Z extends { id: string }>(zones: Z[], w: Widget): Z[] {
  const ents = listOf(w, 'entities');
  if (!ents.length) return zones;
  const out: Z[] = [];
  for (const e of ents) { const z = zones.find((x) => 'climate.' + x.id === e); if (z && !out.includes(z)) out.push(z); }
  return out;
}

/** Climate + lights the display subscribes to when nothing narrows them (firmware net/ha_client, core/home.h). */
export const MAX_WATCHED = 80;
export type ListCount = { total: number; shown: number };
/** What an unpicked zoneList / lightList can show (#134, GET /ha/entities `lists`): climate first, then lights in HA
 *  order, MAX_WATCHED in total. A big house loses lights past the cap (14 climate + 149 lights → 66 lights). */
export function listCounts(climate: number, lights: number, cap = MAX_WATCHED): { climate: ListCount; lights: ListCount } {
  const c = Math.min(climate, cap);
  return { climate: { total: climate, shown: c }, lights: { total: lights, shown: Math.min(lights, cap - c) } };
}

/** Number of pages a screen needs: the most any widget needs (`pagesOf`: lightList / zoneList pages of its pick), min 1. */
export function subPages(sc: Screen, pagesOf: (w: Widget) => number): number {
  let n = 1;
  sc.widgets.forEach((w) => { n = Math.max(n, pagesOf(w)); });
  return n;
}
/** Pages of a list widget: zoneList ceil(zones / 10), lightList its light layout; others 1. */
export function listPages(w: Widget, zones: { id: string }[], groups: LightGroup[]): number {
  if (w.type === 'zoneList') return Math.ceil(pickZones(zones, w).length / PER_PAGE);
  if (w.type === 'lightList') return layoutGroups(pickLights(groups, w)).length;
  return 1;
}

export const appOfScreen = (sc: Screen | undefined): string => (sc && sc.app) || 'home';

/** Pages of ONE app, in order, as [screenIndex, subPage] pairs. */
export function flatPages(screens: Screen[], app: string, pagesOf: (sc: Screen) => number): [number, number][] {
  const out: [number, number][] = [];
  screens.forEach((sc, i) => { if ((sc.app || 'home') !== app) return; const n = pagesOf(sc); for (let p = 0; p < n; p++) out.push([i, p]); });
  return out;
}

/** Next position in the pager sequence (wraps). Returns [screenIndex, subPage]. */
export function stepPage(flat: [number, number][], idx: number, sub: number, dir: number): [number, number] {
  let pos = flat.findIndex(([i, p]) => i === idx && p === sub); if (pos < 0) pos = 0;
  return flat[(pos + dir + flat.length) % flat.length];
}

export type Rect = { x: number; y: number; w: number; h: number };
/** Panel grid per display style (firmware core/logic.h kClassicGrid / kSleekGrid). */
export type GridMetrics = { top: number; side: number; bottom: number; gap: number };
export const CLASSIC_GRID: GridMetrics = { top: 72, side: 14, bottom: 14, gap: 12 };
export const SLEEK_GRID: GridMetrics = { top: 66, side: 14, bottom: 14, gap: 10 };
/** Panel rectangle of a span on the 4 × 2 grid (firmware gridSpan). */
export function gridSpan(g: GridMetrics, col: number, row: number, cs: number, rs: number): Rect {
  const cw = (800 - 2 * g.side - 3 * g.gap) / 4, ch = (480 - g.top - g.bottom - g.gap) / 2;
  const cx = (k: number) => (k >= 4 ? 800 - g.side + g.gap : g.side + Math.round(k * (cw + g.gap)));
  const cy = (k: number) => (k >= 2 ? 480 - g.bottom + g.gap : g.top + Math.round(k * (ch + g.gap)));
  const x = cx(col), y = cy(row);
  return { x, y, w: cx(col + cs) - g.gap - x, h: cy(row + rs) - g.gap - y };
}
/** CSS-grid auto-placement (sparse, row-major) on the 4 × 2 grid → fixed panel rectangles for the firmware. */
export function rects(widgets: Widget[], g: GridMetrics = CLASSIC_GRID): (Rect | null)[] {
  const occ = [[0, 0, 0, 0], [0, 0, 0, 0]]; let cr = 0, cc = 0;
  return widgets.map((w) => {
    const cs = Math.min(4, (w.cs as number) || 1), rs = Math.min(2, (w.rs as number) || 1);
    for (let r = cr; r <= 2 - rs; r++) {
      for (let c = r === cr ? cc : 0; c <= 4 - cs; c++) {
        let ok = true;
        for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if (occ[y][x]) ok = false;
        if (ok) {
          for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) occ[y][x] = 1;
          cr = r; cc = c + cs;
          return gridSpan(g, c, r, cs, rs);
        }
      }
    }
    return null;
  });
}
