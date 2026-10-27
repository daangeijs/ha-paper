import { describe, it, expect, vi, afterEach } from 'vitest';
import { changedRegions, serializeRegion, fnv1a } from './regions.ts';
import { decidePartial, decideNav, coalesceInput, minuteKeys, nextCleanMin, cleanDue, CLEAN_CAP, NAV_CLEAN, powerMoved, PowerHold, type RefreshInput, type CleanInput, type NavInput } from './refresh.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyedDebouncer, nextSetpoint } from './debounce.ts';
import { layoutLights, subPages, flatPages, stepPage, rects, SLEEK_GRID, PER_COL, lightGroupsOf, listPages, pickLights, pickZones, listCounts } from './paging.ts';
import { authorize, hashToken, newTokenSecret, maskToken, type StoredToken } from './auth.ts';
import { ROOMS, LIGHT_LIST } from './data.ts';
import { defaultScreens } from './config.ts';
import { listPickVectors, sceneActionVectors, statRawVectors } from '../../scripts/gen-vectors.ts';
import { kw, fmtValue, fewerDecimals, fitMiddle, fitValue, isNightHour, newer, numFormatOf, setNumFormat, type NumFormat } from './format.ts';

afterEach(() => { vi.useRealTimers(); });

describe('region diff', () => {
  const row = (cur: string) => serializeRegion({ name: 'Living room', cur, set: '21.0', dirty: true, inc: () => {} });
  it('no visible change → no regions', () => {
    expect(changedRegions({ h0: '10 rooms', 'z:living': row('20.4') }, { h0: '10 rooms', 'z:living': row('20.4') })).toEqual([]);
  });
  it('callbacks and dirty flags are not content', () => {
    expect(serializeRegion({ a: 1, dirty: true, hdrDirty: true, f: () => 1 })).toBe('{"a":1}');
  });
  it('one changed row → only that row', () => {
    expect(changedRegions({ h0: 'x', 'z:living': row('20.4'), 'z:hall': row('17.5') }, { h0: 'x', 'z:living': row('20.5'), 'z:hall': row('17.5') })).toEqual(['z:living']);
  });
  it('hash is stable', () => { expect(fnv1a('')).toBe(0x811c9dc5); expect(fnv1a('a')).toBe(0xe40c292c); });
});

describe('refresh policy', () => {
  const base = { reason: 'HA update', sleeping: false, quiet: false, sinceFull: 0, clockKnown: true };
  it('minute tick redraws only the clock windows (#38); the whole clock tile when the date changes', () => {
    expect(minuteKeys(['t0'], false)).toEqual(['time', 'k0']);
    expect(minuteKeys(['t0', 't3'], true)).toEqual(['time', 'k0', 'k3', 't0', 't3']);
  });
  it('clock known: partials never force a full; clock unset: CLEAN_CAP (#26)', () => {
    expect(decidePartial(base)).toEqual({ kind: 'partial', sinceFull: 1 });
    expect(decidePartial({ ...base, sinceFull: CLEAN_CAP - 1 })).toEqual({ kind: 'partial', sinceFull: CLEAN_CAP });
    expect(decidePartial({ ...base, sinceFull: CLEAN_CAP - 1, clockKnown: false })).toEqual({ kind: 'clean', reason: 'ghosting limit' });
  });
  it('no data redraws in standby or on the quiet face; only standby keeps its clock (#295)', () => {
    expect(decidePartial({ ...base, sleeping: true })).toEqual({ kind: 'skip', why: 'standby' });
    expect(decidePartial({ ...base, sleeping: true, reason: 'clock' }).kind).toBe('partial');
    expect(decidePartial({ ...base, quiet: true })).toEqual({ kind: 'skip', why: 'quiet' });
    expect(decidePartial({ ...base, quiet: true, reason: 'clock' })).toEqual({ kind: 'skip', why: 'quiet' });
  });
  it('navigation: fast, every NAV_CLEAN-th a clean (#197)', () => {
    let st = { navSinceClean: 0, sinceFull: 0, clockKnown: true }; const kinds: string[] = [];
    for (let i = 0; i < 2 * NAV_CLEAN; i++) {
      const d = decideNav(st); kinds.push(d.kind);
      st = d.kind === 'fast' ? { ...st, navSinceClean: d.navSinceClean, sinceFull: d.sinceFull } : { ...st, navSinceClean: 0, sinceFull: 0 };
    }
    expect(kinds.filter((k) => k === 'clean').length).toBe(2);
    expect(kinds[NAV_CLEAN - 1]).toBe('clean'); expect(kinds[2 * NAV_CLEAN - 1]).toBe('clean');
  });
  const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'refresh.json'), 'utf8')) as {
    partial: { name: string; input: RefreshInput; expect: object }[]; navigation: { name: string; input: NavInput; expect: object }[]; nextClean: { lastFullMin: number; everyMin: number; expect: number }[];
    cleanDue: (CleanInput & { name: string; expect: boolean })[]; input: { name: string; events: string[]; expect: number }[] };
  for (const c of v.partial) it('vector: ' + c.name, () => { expect(decidePartial(c.input)).toEqual(c.expect); });
  for (const c of v.navigation) it('vector: nav · ' + c.name, () => { expect(decideNav(c.input)).toEqual(c.expect); });
  it('vectors: next clean slot', () => { for (const c of v.nextClean) expect(nextCleanMin(c.lastFullMin, c.everyMin)).toBe(c.expect); });
  for (const c of v.cleanDue) it('vector: ' + c.name, () => { expect(cleanDue(c)).toBe(c.expect); });
  for (const c of v.input) it('vector: input · ' + c.name, () => { expect(coalesceInput(c.events.length)).toBe(c.expect); });
});

describe('debounce (tado)', () => {
  it('5 quick taps → one call, 1.5 s after the last', () => {
    vi.useFakeTimers();
    const deb = new KeyedDebouncer(); const calls: number[] = []; let set = 21;
    for (let i = 0; i < 5; i++) { set = nextSetpoint(set, 0.5); const v = set; deb.schedule('living', 1500, () => calls.push(v)); vi.advanceTimersByTime(300); }
    vi.advanceTimersByTime(1199); expect(calls).toEqual([]);
    vi.advanceTimersByTime(1); expect(calls).toEqual([23.5]);
  });
  it('keys are independent; setpoints clamp to 5–25', () => {
    vi.useFakeTimers();
    const deb = new KeyedDebouncer(); const calls: string[] = [];
    deb.schedule('a', 1500, () => calls.push('a')); deb.schedule('b', 1500, () => calls.push('b'));
    vi.advanceTimersByTime(1500); expect(calls.sort()).toEqual(['a', 'b']);
    expect(nextSetpoint(25, 0.5)).toBe(25); expect(nextSetpoint(5, -0.5)).toBe(5); expect(nextSetpoint(20.1, 0.5)).toBe(20.6);
  });
});

describe('paging', () => {
  const pages = layoutLights(ROOMS, LIGHT_LIST);
  it('lights: 2 × 5 per page, a header never ends a column, continued columns repeat the header', () => {
    expect(pages.every((p) => p.length === 2 * PER_COL)).toBe(true);
    for (const p of pages) for (const col of [p.slice(0, PER_COL), p.slice(PER_COL)]) {
      const last = col.filter((x) => x.kind !== 's').pop();
      expect(last?.kind).not.toBe('h');
      if (col[0].kind !== 's') expect(col[0].kind).toBe('h');
    }
    // a room longer than a column continues with a repeated "(cont.)" header
    const big = layoutLights([['a', 'A']], Array.from({ length: 7 }, (_, i) => ({ id: 'l' + i, room: 'a' })));
    expect(big[0][PER_COL]).toEqual({ kind: 'h', room: 'a', cont: true });
    expect(pages.flat().filter((x) => x.kind === 'l').length).toBe(LIGHT_LIST.length);
  });
  it('pager counts pages inside the current app; long lists add pages; wraps', () => {
    const sc = defaultScreens();
    const zones = Array.from({ length: 14 }, (_, k) => ({ id: 'z' + k })); const groups = lightGroupsOf(ROOMS, LIGHT_LIST);
    const pagesOf = (s: (typeof sc)[number]) => subPages(s, (w) => listPages(w, zones, groups));
    const house = flatPages(sc, 'house', pagesOf);
    expect(house.length).toBe(pages.length + 2);
    const climate = sc.findIndex((s) => s.id === 'climate');
    expect(stepPage(house, climate, 1, 1)).toEqual(house[0]);
    expect(flatPages(sc, 'home', pagesOf).length).toBe(4);
  });
  it('list picks (#127): order follows the pick, unknown ids skipped, nothing picked = all', () => {
    const groups = lightGroupsOf(ROOMS, LIGHT_LIST);
    expect(pickLights(groups, { type: 'lightList' })).toBe(groups);
    expect(pickLights(groups, { type: 'lightList', areas: 'kitchen nowhere living' }).map((g) => g.area)).toEqual(['kitchen', 'living']);
    expect(pickLights(groups, { type: 'lightList', areas: 'office', entities: 'light.office_desk light.hall_stairs light.living_tv light.hall_ceiling light.gone' }))
      .toEqual([{ area: 'office', ids: ['office_desk'] }, { area: 'hall', ids: ['hall_stairs', 'hall_ceiling'] }, { area: 'living', ids: ['living_tv'] }]);
    const zones = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(pickZones(zones, { type: 'zoneList', entities: 'climate.c climate.x climate.a climate.c' }).map((z) => z.id)).toEqual(['c', 'a']);
    expect(listPages({ type: 'lightList', entities: 'light.office_desk' }, zones, groups)).toBe(1);
    expect(listPages({ type: 'zoneList', entities: 'climate.x' }, zones, groups)).toBe(0);
  });
  it('list counts (#134): climate first, then lights, the cap in total', () => {
    expect(listCounts(14, 149, 80)).toEqual({ climate: { total: 14, shown: 14 }, lights: { total: 149, shown: 66 } });
    expect(listCounts(90, 5, 80)).toEqual({ climate: { total: 90, shown: 80 }, lights: { total: 5, shown: 0 } });
    expect(listCounts(3, 12)).toEqual({ climate: { total: 3, shown: 3 }, lights: { total: 12, shown: 12 } });
  });
  it('stat-raw.json is in sync (#161)', () => {
    expect(JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/stat-raw.json'), 'utf8'))).toEqual(statRawVectors());
  });
  it('scene-action.json is in sync', () => {
    expect(JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/scene-action.json'), 'utf8'))).toEqual(sceneActionVectors());
  });
  it('list-pick.json is in sync', () => {
    expect(JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/list-pick.json'), 'utf8'))).toEqual(listPickVectors());
  });
  it('grid placement → fixed rects', () => {
    expect(rects(defaultScreens()[0].widgets)[0]).toEqual({ x: 14, y: 72, w: 380, h: 191 });
    expect(rects([{ type: 'lightList', cs: 4, rs: 2 }, { type: 'clock' }])[1]).toBeNull();
    // Sleek (firmware kSleekGrid, gridSpan rounds the 185.5 px columns): #189 crops the preview with these
    expect(rects([{ type: 'clock' }, { type: 'bars', cs: 2 }, { type: 'zoneList', rs: 2 }], SLEEK_GRID))
      .toEqual([{ x: 14, y: 66, w: 186, h: 195 }, { x: 210, y: 66, w: 381, h: 195 }, { x: 601, y: 66, w: 185, h: 400 }]);
  });
});

describe('tokens', () => {
  const sec = newTokenSecret();
  const tok = (scope: 'ro' | 'rw'): StoredToken => ({ id: '1', name: 'Laptop', scope, created: '10:00', last: 'never', hash: hashToken(sec), masked: maskToken(sec) });
  it('401 missing / revoked, 403 read-only write, ok otherwise', () => {
    expect(authorize([tok('rw')], null, 'read')).toEqual({ code: 401, error: 'missing token' });
    expect(authorize([], sec, 'read')).toEqual({ code: 401, error: 'invalid or revoked token' });
    expect(authorize([tok('ro')], sec, 'write')).toEqual({ code: 403, error: 'token is read-only' });
    expect(authorize([tok('ro')], sec, 'read')).toBeNull();
    expect(authorize([tok('rw')], sec, 'write')).toBeNull();
    expect(sec).toMatch(/^x4_[a-z2-9]{26}$/);
  });
});

describe('format', () => {
  const fv = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'format.json'), 'utf8')) as {
    cases: { name: string; state: string; unit: string; dp?: number; out: string }[]; kw: { name: string; w: number; dp?: number; v: string; u: string }[];
    numberFormatOf: { name: string; ha: string | null; lang: 'en' | 'nl'; nf: NumFormat }[];
    localized: { name: string; nf: NumFormat; state: string; unit: string; dp?: number; out: string }[];
    localizedKw: { name: string; nf: NumFormat; w: number; dp?: number; v: string; u: string }[];
    fewerDecimals: { name: string; nf: NumFormat; in: string; out: string }[];
    fitValue: { name: string; nf: NumFormat; in: string; sizes: number[]; unit: number; maxW: number; out: string; size: number }[];
    fitMiddle: { name: string; in: string; sizes: number[]; maxW: number; out: string; size: number }[] };
  const inFmt = <T,>(nf: NumFormat, f: () => T): T => { setNumFormat(nf); try { return f(); } finally { setNumFormat('point'); } };
  it.each(fv.cases)('fmtValue: $name', (c) => { expect(fmtValue(c.state, c.unit, c.dp)).toBe(c.out); });
  it.each(fv.kw)('kw: $name', (c) => { expect(kw(c.w, c.dp)).toEqual({ v: c.v, u: c.u }); });
  it.each(fv.numberFormatOf)('numFormatOf: $name', (c) => { expect(numFormatOf(c.ha, c.lang)).toBe(c.nf); });
  it.each(fv.localized)('fmtValue $nf: $name', (c) => { expect(inFmt(c.nf, () => fmtValue(c.state, c.unit, c.dp))).toBe(c.out); });
  it.each(fv.localizedKw)('kw $nf: $name', (c) => { expect(inFmt(c.nf, () => kw(c.w, c.dp))).toEqual({ v: c.v, u: c.u }); });
  it.each(fv.fewerDecimals)('fewerDecimals $nf: $name', (c) => { expect(inFmt(c.nf, () => fewerDecimals(c.in))).toBe(c.out); });
  it.each(fv.fitValue)('fitValue $nf: $name', (c) => {
    const width = (v: string, size: number) => Math.floor(([...v].length * size) / 10) + c.unit;
    expect(inFmt(c.nf, () => fitValue(c.in, c.sizes, c.maxW, width))).toEqual({ value: c.out, size: c.size });
  });
  it.each(fv.fitMiddle)('fitMiddle: $name', (c) => {
    expect(fitMiddle(c.in, c.sizes, c.maxW, (v, size) => Math.floor(([...v].length * size) / 10))).toEqual({ value: c.out, size: c.size });
  });
  const db = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'deadband.json'), 'utf8')) as {
    moved: { name: string; shown: number; now: number; moved: boolean }[]; hold: { name: string; in: number[]; out: number[] }[] };
  it.each(db.moved)('deadband: $name', (c) => { expect(powerMoved(c.shown, c.now)).toBe(c.moved); });
  it.each(db.hold)('hold: $name', (c) => { const h = new PowerHold(); expect(c.in.map((w) => h.hold('k', w))).toEqual(c.out); });
  it('night window wraps midnight', () => { expect([22, 23, 0, 6, 7].map((h) => isNightHour(h, '23-07'))).toEqual([false, true, true, true, false]); });
  it('semver with pre-release', () => { expect(newer('0.5.0-beta.1', '0.3.0')).toBe(true); expect(newer('0.4.0-beta', '0.4.0')).toBe(false); });
});
