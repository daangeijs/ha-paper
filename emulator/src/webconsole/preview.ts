// Values view of the screen editor (#83, #122): polls GET /screens/{id}/values for one screen at a time and puts each
// tile's live value where the editor shows its name. One request in flight at most; nothing while the tab is hidden;
// a screen switch, a config save or the tab coming back fetches at once (after the pending one), a timer tick during
// a slow request is dropped. ready: false (the display has not formatted that screen yet) asks again after 1 s.
// #189: alongside, GET /screens/{id}/preview.png every 15 s (an off-screen draw holds the display loop 1–2.6 s on
// QEMU); each card shows its tile cut from that picture (lists, charts: what the panel draws, not a one-line summary).
// 503 + Retry-After holds the next request that long.
import { useEffect, useRef, useState } from 'react';
import { gridLayout, type Widget } from '../core/config.ts';
import { gridSpan, rects, type GridMetrics, type Rect } from '../core/paging.ts';
import { ApiError, type DeviceApi, type ScreenValues } from './DeviceApi.ts';

export const PREVIEW_EVERY_MS = 5000;
export const PANEL_EVERY_MS = 15_000;
export const NOT_READY_RETRY_MS = 1000;
export type ScreenView = 'names' | 'values';
const VIEW_KEY = 'x4.screenView';

export function loadView(): ScreenView {
  try { return localStorage.getItem(VIEW_KEY) === 'values' ? 'values' : 'names'; } catch { return 'names'; }
}
export function saveView(v: ScreenView) {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode, storage off */ }
}
/** Advanced tab page (#191), remembered per browser like the screen view. */
export type AdvPage = 'yaml' | 'api' | 'logs';
const ADV_KEY = 'x4.advancedPage';
export function loadAdvPage(): AdvPage {
  try { const p = localStorage.getItem(ADV_KEY); return p === 'api' || p === 'logs' ? p : 'yaml'; } catch { return 'yaml'; }
}
export function saveAdvPage(p: AdvPage) {
  try { localStorage.setItem(ADV_KEY, p); } catch { /* private mode, storage off */ }
}

type Result<T> = { ok: true; v: T } | { ok: false; e: unknown };
type Doc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

export function createPoller<T>(load: (id: string) => Promise<T>, done: (id: string, r: Result<T>) => void,
  everyMs = PREVIEW_EVERY_MS, doc: Doc | undefined = globalThis.document) {
  let id: string | null = null, busy = false, again = false, timer: ReturnType<typeof setInterval> | null = null;
  const hidden = () => !!doc && doc.visibilityState === 'hidden';
  /** queue: run after the pending request instead of dropping (screen switch, save, tab visible again). */
  const run = (queue: boolean) => {
    if (id === null || hidden()) return;
    if (busy) { again = again || queue; return; }
    busy = true; const want = id;
    load(want).then((v) => done(want, { ok: true, v }), (e) => done(want, { ok: false, e })).finally(() => {
      busy = false;
      if (again) { again = false; run(false); }
    });
  };
  const vis = () => { if (!hidden()) run(true); };
  doc?.addEventListener('visibilitychange', vis);
  return {
    target(next: string | null) {
      if (next === id) return;
      id = next;
      if (timer) clearInterval(timer);
      timer = id === null ? null : setInterval(() => run(false), everyMs);
      run(true);
    },
    kick: () => run(true),
    stop() { id = null; if (timer) clearInterval(timer); timer = null; doc?.removeEventListener('visibilitychange', vis); },
  };
}

/** The value for draft tile `w` from the pushed screen's values: only while the draft tile at that index still shows
 *  the same thing (type and source); '' = keep the name. */
export function tileValueFor(w: Widget, pushed: Widget | undefined, value: string | undefined): string {
  if (!pushed || !value) return '';
  const src = (x: Widget) => [x.type, x.entity, x.zone, x.series, x.route, x.key].map((v) => String(v ?? '')).join('|');
  return src(w) === src(pushed) ? value : '';
}

export type LiveValues = { id: string; values: string[]; at: Date };

/** id: the screen to show, null = Values view off. rev: config revision (a save fetches at once). */
export function useScreenValues(api: DeviceApi, id: string | null, rev: number | undefined) {
  const [lv, setLv] = useState<LiveValues | null>(null);
  const [err, setErr] = useState<{ id: string; status: number; text: string } | null>(null);
  const want = useRef<string | null>(null);
  const poller = useRef<ReturnType<typeof createPoller<ScreenValues>> | null>(null);

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const p = createPoller((sid) => api.screenValues(sid), (sid, r) => {
      if (sid !== want.current) return;
      if (!r.ok) { setErr({ id: sid, status: r.e instanceof ApiError ? r.e.status : 0, text: r.e instanceof Error ? r.e.message : String(r.e) }); return; }
      if (!r.v.ready) { clearTimeout(retry); retry = setTimeout(() => p.kick(), NOT_READY_RETRY_MS); return; }
      setLv({ id: sid, values: r.v.values, at: new Date() }); setErr(null);
    });
    poller.current = p;
    p.target(want.current);
    return () => { clearTimeout(retry); p.stop(); poller.current = null; };
  }, [api]);
  useEffect(() => { want.current = id; poller.current?.target(id); }, [id]);
  const lastRev = useRef(rev);
  useEffect(() => { if (lastRev.current === rev) return; lastRev.current = rev; poller.current?.kick(); }, [rev]);

  const e = err && err.id === id ? err : null;
  return { lv: lv && lv.id === id && !e ? lv : null, err: e };
}

/** Per draft tile: its rectangle in the pushed screen's preview.png, or null when the card would not show that tile
 *  (other source, size or place than the pushed one, or the display places it elsewhere: it ignores pinned col/row). */
export function tileCrops(draft: Widget[], pushed: Widget[], grid: GridMetrics): (Rect | null)[] {
  const cells = gridLayout(draft), panel = rects(pushed, grid);
  return draft.map((w, j) => {
    const c = cells[j], r = panel[j];
    if (!c || !r || !tileValueFor(w, pushed[j], '-')) return null;
    const d = gridSpan(grid, c.col - 1, c.row - 1, c.cs, c.rs);
    return d.x === r.x && d.y === r.y && d.w === r.w && d.h === r.h ? r : null;
  });
}

/** #360: Values canvas = the panel below its header (side margin kept on top), so each cell has its crop's aspect at
 *  any window width. Aspect for CSS aspect-ratio, and a span's place in % of that box (same metrics as tileCrops). */
export function panelAspect(g: GridMetrics): string {
  return `800 / ${480 - g.top + g.side}`;
}
export function panelPlace(g: GridMetrics, col: number, row: number, cs: number, rs: number) {
  const r = gridSpan(g, col - 1, row - 1, cs, rs), y0 = g.top - g.side, h = 480 - y0;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return { position: 'absolute' as const, left: pct(r.x, 800), top: pct(r.y - y0, h), width: pct(r.w, 800), height: pct(r.h, h) };
}

export type PanelShot ={ id: string; url: string; at: Date };
const HELD = Symbol('held');

/** Poller for preview.png: a 503 holds every request (timer, kick) for Retry-After seconds, then asks once. */
export function createPanelPoller(load: (id: string) => Promise<Blob>, shot: (id: string, png: Blob) => void,
  doc: Doc | undefined = globalThis.document, now: () => number = Date.now) {
  let hold = 0, retry: ReturnType<typeof setTimeout> | undefined;
  const p = createPoller((sid) => (now() < hold ? Promise.reject(HELD) : load(sid)), (sid, r) => {
    if (r.ok) { shot(sid, r.v); return; }
    if (r.e instanceof ApiError && r.e.status === 503) {
      const ms = (r.e.retryAfter || 2) * 1000;
      hold = now() + ms; clearTimeout(retry); retry = setTimeout(() => p.kick(), ms);
    }
  }, PANEL_EVERY_MS, doc);
  return { ...p, stop() { clearTimeout(retry); p.stop(); } };
}

/** The pushed screen as the display draws it (object URL of the PNG); null until the first one or while off. */
export function useScreenPreview(api: DeviceApi, id: string | null, rev: number | undefined) {
  const [shot, setShot] = useState<PanelShot | null>(null);
  const want = useRef<string | null>(null);
  const poller = useRef<ReturnType<typeof createPanelPoller> | null>(null);

  useEffect(() => {
    const load = api.screenPreview?.bind(api);
    if (!load) return;
    const p = createPanelPoller(load, (sid, png) => { if (sid === want.current) setShot({ id: sid, url: URL.createObjectURL(png), at: new Date() }); });
    poller.current = p;
    p.target(want.current);
    return () => { p.stop(); poller.current = null; };
  }, [api]);
  useEffect(() => { want.current = id; poller.current?.target(id); }, [id]);
  const lastRev = useRef(rev);
  useEffect(() => { if (lastRev.current === rev) return; lastRev.current = rev; poller.current?.kick(); }, [rev]);
  const url = shot?.url;
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return shot && shot.id === id ? shot : null;
}
