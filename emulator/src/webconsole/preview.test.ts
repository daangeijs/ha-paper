import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPanelPoller, createPoller, PANEL_EVERY_MS, panelAspect, panelPlace, PREVIEW_EVERY_MS, tileCrops, tileValueFor } from './preview.ts';
import { CLASSIC_GRID, gridSpan, SLEEK_GRID } from '../core/paging.ts';
import { ApiError } from './DeviceApi.ts';
import { createHttpApi } from './httpApi.ts';
import { Emulator } from '../emulator/Emulator.tsx';

function fakeDoc() {
  const fns = new Set<() => void>();
  const d = { visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, f: () => void) => { fns.add(f); }, removeEventListener: (_: string, f: () => void) => { fns.delete(f); },
    set(v: DocumentVisibilityState) { d.visibilityState = v; fns.forEach((f) => f()); } };
  return d;
}
/** load() that resolves only when the test says so. */
function slowLoad() {
  const calls: { id: string; resolve: () => void }[] = [];
  return { calls, load: (id: string) => new Promise<string>((res) => { calls.push({ id, resolve: () => res(id) }); }) };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('Values view poller (eink-ha-os#83)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fetches at once, then every 5 s; stops when the view is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const l = slowLoad(); const got: string[] = [];
    const p = createPoller(l.load, (id) => got.push(id), PREVIEW_EVERY_MS, fakeDoc() as any);
    p.target('overview'); expect(l.calls.length).toBe(1);
    l.calls[0].resolve(); await flush(); expect(got).toEqual(['overview']);
    vi.advanceTimersByTime(5000); expect(l.calls.length).toBe(2);
    l.calls[1].resolve(); await flush();
    p.target(null); vi.advanceTimersByTime(20_000); expect(l.calls.length).toBe(2);
    p.stop();
  });

  it('never two requests at once: a tick during a slow one is dropped, a screen switch waits for it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const l = slowLoad(); const got: string[] = [];
    const p = createPoller(l.load, (id) => got.push(id), PREVIEW_EVERY_MS, fakeDoc() as any);
    p.target('a');
    vi.advanceTimersByTime(15_000); expect(l.calls.length).toBe(1);   // three ticks while pending
    p.target('b'); expect(l.calls.length).toBe(1);
    l.calls[0].resolve(); await flush();
    expect(l.calls.map((c) => c.id)).toEqual(['a', 'b']);              // b right after a, not before
    l.calls[1].resolve(); await flush(); expect(l.calls.length).toBe(2);
    expect(got).toEqual(['a', 'b']);
    p.stop();
  });

  it('pauses while the tab is hidden and fetches when it comes back', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const l = slowLoad(); const doc = fakeDoc();
    const p = createPoller(l.load, () => {}, PREVIEW_EVERY_MS, doc as any);
    p.target('a'); l.calls[0].resolve(); await flush();
    doc.set('hidden'); vi.advanceTimersByTime(60_000); expect(l.calls.length).toBe(1);
    doc.set('visible'); expect(l.calls.length).toBe(2);
    l.calls[1].resolve(); await flush();
    p.kick(); expect(l.calls.length).toBe(3);                             // config saved → at once
    p.stop(); l.calls[2].resolve(); await flush();
    doc.set('visible'); vi.advanceTimersByTime(60_000); expect(l.calls.length).toBe(3);
  });
});

describe('screen values (eink-ha-os#122)', () => {
  it('HTTP: same-origin JSON GET of /screens/{id}/values', async () => {
    let seen: [string, RequestInit | undefined] | null = null;
    const f = (async (u: string, init?: RequestInit) => { seen = [u, init];
      return new Response(JSON.stringify({ ready: true, values: ['11.4 °C', ''] }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await createHttpApi('/api/v1', { fetch: f }).screenValues('living room');
    expect(seen![0]).toBe('/api/v1/screens/living%20room/values');
    expect(seen![1]!.credentials).toBe('same-origin');
    expect(r).toEqual({ ready: true, values: ['11.4 °C', ''] });
  });
  it('HTTP: 404 comes back as ApiError with the device text', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'unknown screen' }), { status: 404 })) as unknown as typeof fetch;
    await expect(createHttpApi('/api/v1', { fetch: f }).screenValues('x')).rejects.toMatchObject({ status: 404, message: 'unknown screen' });
  });
  it('emulator: one value per tile, formatted like the display; unknown id → null', () => {
    const e = new Emulator({});
    const v = e.tileValues('overview')!;
    expect(v.length).toBe(e.state.screens.find((s) => s.id === 'overview')!.widgets.length);
    expect(v[0]).toMatch(/^\d{2}:\d{2}$/);          // clock
    expect(v[1]).toMatch(/^€ \d+\.\d{2}$/);         // price
    expect(v[2]).toMatch(/^\d+\.\d °C$/);           // living temperature
    expect(v[5]).toMatch(/^\d+%$/);                 // home battery gauge
    expect(e.tileValues('nope')).toBeNull();
    for (const s of e.state.screens) expect(e.tileValues(s.id)!.length, s.id).toBe(s.widgets.length);
  });
  it('emulator: decimal comma in Dutch, a word for an entity HA has no value for, counts for lists (eink-ha-os#161), "" for charts', () => {
    const e = new Emulator({});
    const ws = [{ type: 'stat', entity: 'input_number.target_temp' }, { type: 'stat', entity: 'sensor.outdoor_temperature' },
      { type: 'switch', entity: 'switch.garden_pump' }, { type: 'lightList', cs: 2 }, { type: 'zoneList', entities: 'climate.living climate.office', cs: 2 },
      { type: 'stat', entity: 'climate.living' }, { type: 'bars', series: 'prices', cs: 2 }];
    (e as any).state = { ...e.state, haLang: 'nl', ha: { ...e.state.ha, linked: true }, screens: [{ id: 't', app: 'home', title: 'T', widgets: ws }],
      ent: { ...e.state.ent, 'sensor.outdoor_temperature': 'unavailable', 'switch.garden_pump': 'unknown' } };
    expect(e.tileValues('t')).toEqual(['20,5 °C', 'Niet beschikbaar', 'Onbekend', '5 van 16 lampen aan', '2 van 2 verwarmen', '20,4 °C', '']);
  });
});

describe('tileValueFor', () => {
  it('a value only while the draft tile shows the same source as the pushed one', () => {
    const w = { type: 'stat', entity: 'sensor.a', label: 'A' };
    expect(tileValueFor(w, { type: 'stat', entity: 'sensor.a' }, '1 W')).toBe('1 W');
    expect(tileValueFor(w, { type: 'stat', entity: 'sensor.b' }, '1 W')).toBe('');
    expect(tileValueFor(w, undefined, '1 W')).toBe('');
    expect(tileValueFor(w, { type: 'stat', entity: 'sensor.a' }, '')).toBe('');
  });
});

describe('tile crops from preview.png (eink-ha-os#189)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const ws = [{ type: 'clock', cs: 2 }, { type: 'zoneList', cs: 2, rs: 2 }, { type: 'bars', series: 'solar', cs: 2 }];

  it('each tile at its panel rectangle, per display style', () => {
    expect(tileCrops(ws, ws, CLASSIC_GRID)).toEqual([{ x: 14, y: 72, w: 380, h: 191 }, { x: 406, y: 72, w: 380, h: 394 }, { x: 14, y: 275, w: 380, h: 191 }]);
    expect(tileCrops(ws, ws, SLEEK_GRID)[1]).toEqual({ x: 405, y: 66, w: 381, h: 400 });
  });
  it('none for a draft tile that is not the pushed one: other source, size or place, or pinned (the display ignores col/row)', () => {
    expect(tileCrops([ws[0], { ...ws[1], type: 'lightList' }, ws[2]], ws, CLASSIC_GRID).map((r) => !!r)).toEqual([true, false, true]);
    expect(tileCrops([{ ...ws[0], cs: 1 }, ws[1], ws[2]], ws, CLASSIC_GRID).map((r) => !!r)).toEqual([false, false, false]);
    expect(tileCrops([ws[0], ws[1]], ws, CLASSIC_GRID).length).toBe(2);
    const pinned = [{ type: 'clock', col: 3, row: 1 }];
    expect(tileCrops(pinned, pinned, CLASSIC_GRID)).toEqual([null]);
  });

  it('poller: every 15 s; a 503 holds every request for Retry-After seconds, then asks once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    let t = 0; const calls: string[] = []; const shots: string[] = [];
    let answer: () => Promise<Blob> = () => Promise.reject(new ApiError(503, 'display busy', 4));
    const p = createPanelPoller((id) => { calls.push(id); return answer(); }, (id) => shots.push(id), fakeDoc() as any, () => t);
    p.target('solar'); await flush(); expect(calls.length).toBe(1);
    t = 1000; p.kick(); await flush(); expect(calls.length).toBe(1);     // held: a save does not ask early
    answer = () => Promise.resolve(new Blob(['png']));
    t = 4000; vi.advanceTimersByTime(4000); await flush();
    expect(calls.length).toBe(2); expect(shots).toEqual(['solar']);
    vi.advanceTimersByTime(PANEL_EVERY_MS); await flush(); expect(calls.length).toBe(3);
    p.stop(); vi.advanceTimersByTime(60_000); expect(calls.length).toBe(3);
  });

  it('HTTP: GET preview.png → Blob; 503 → ApiError with retryAfter', async () => {
    let url = '';
    const ok = (async (u: string) => { url = u; return new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'Content-Type': 'image/png' } }); }) as unknown as typeof fetch;
    const b = await createHttpApi('/api/v1', { fetch: ok }).screenPreview!('my screen');
    expect(url).toBe('/api/v1/screens/my%20screen/preview.png'); expect(b.size).toBe(2);
    const busy = (async () => new Response(JSON.stringify({ error: 'display busy' }), { status: 503, headers: { 'Retry-After': '2' } })) as unknown as typeof fetch;
    await expect(createHttpApi('/api/v1', { fetch: busy }).screenPreview!('x')).rejects.toMatchObject({ status: 503, message: 'display busy', retryAfter: 2 });
  });
});

describe('panelPlace (eink-ha-os#360: Values cells keep their crop shape at any width)', () => {
  const f = (s: string) => Number.parseFloat(s) / 100;
  for (const g of [CLASSIC_GRID, SLEEK_GRID]) {
    it(`a span's box is its panel rectangle (= the crop), header cut (top ${g.top})`, () => {
      const [aw, ah] = panelAspect(g).split(' / ').map(Number);
      expect(aw).toBe(800); expect(ah).toBe(480 - g.top + g.side);
      for (const [col, row, cs, rs] of [[1, 1, 1, 1], [1, 1, 2, 1], [3, 2, 2, 1], [4, 1, 1, 2], [1, 1, 4, 2]]) {
        const p = panelPlace(g, col, row, cs, rs), r = gridSpan(g, col - 1, row - 1, cs, rs);
        expect(p.position).toBe('absolute');
        expect(f(p.left) * aw).toBeCloseTo(r.x, 6); expect(f(p.width) * aw).toBeCloseTo(r.w, 6);
        expect(f(p.top) * ah).toBeCloseTo(r.y - g.top + g.side, 6); expect(f(p.height) * ah).toBeCloseTo(r.h, 6);
      }
    });
  }
});
