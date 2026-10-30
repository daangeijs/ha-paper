// History tiles in the device simulator (#267): statistics first, history rows as the fallback, only the tiles of the
// app shown, "Too many changes" over the firmware's frame cap.
import { describe, it, expect, afterEach } from 'vitest';
import { startSimulator, type RunningSim } from './index.ts';
import { toYaml, validateYaml, type Config } from '../src/core/config.ts';
import { CHATTY_ID, histEntity } from './fake-ha-history.ts';

const FAST = { wifiMs: 30, scanMs: 0, otaCheckMs: 20, otaStepMs: 10, rebootMs: 40, haRetryMs: 30 };
async function until<T>(fn: () => T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (ok(v)) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
}
/** The link is up and its setup is done (#341). `ha.connected` turns true before subscribe_entities is answered; the
 *  first entity event comes after that answer, so by then the device's own fetchHistory('connected') has run. Without
 *  this, a late answer under load lands inside the test's fetch: a second ('again') fetch doubles the HA calls. */
const linked = (sim: RunningSim['sim']) => until(() => sim.ha.connected && sim.ha.lastEvent !== null, (c) => c);

describe('history tiles (device simulator)', () => {
  let run: RunningSim | null = null;
  afterEach(async () => { await run?.close(); run = null; });

  it('fetches the app shown only: statistics, history fallback, needs statistics, too many changes', async () => {
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'installed', delays: FAST });
    const sim = run.sim, fake = run.fakeHa!;
    await linked(sim);
    fake.history.entities.set(CHATTY_ID, histEntity(CHATTY_ID, 'power', 'none'));   // 1 Hz, no state_class: history rows only
    const cfg: Config = { apps: [...sim.p.apps, { id: 'weather', title: 'Weather' }, { id: 'meters', title: 'Meters' }], screens: [...sim.p.screens,
      { id: 'outside', app: 'weather', title: 'Outside', widgets: [
        { type: 'history', entity: 'sensor.outdoor_temperature', cs: 2 },                    // 24 h / 1 h: hour statistics, mean
        { type: 'history', entity: 'sensor.rain_total', window: '7d', agg: 'change', cs: 2 },   // 7 d / 12 h: hour statistics, change
        { type: 'history', entity: 'sensor.train_delay', window: '6h', agg: 'max', cs: 2 },     // no state_class: history rows
        { type: 'history', entity: 'sensor.train_delay', window: '7d', cs: 2 } ] },           // no statistics, over 24 h
      { id: 'power', app: 'meters', title: 'Power', widgets: [{ type: 'history', entity: CHATTY_ID, window: '6h', agg: 'max', cs: 4 }] }] };
    const v = validateYaml(toYaml(cfg)); expect(v.ok ? "" : v.line + ": " + v.message).toBe(""); if (!v.ok) return;
    fake.history.calls = [];
    sim.applyConfig(v.config, 'test');
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.history.calls).toEqual([]);   // Home has no history tile: nothing asked
    expect(sim.goTo('outside')).toBe(true);
    const st = await until(() => sim.histState(), (h) => h.length === 4 && h.every((x) => x.state !== 'loading'));
    expect(st.map((x) => [x.entity, x.window_ms / 3600_000, x.source, x.state])).toEqual([
      ['sensor.outdoor_temperature', 24, 'statistics', 'ok'], ['sensor.rain_total', 168, 'statistics', 'ok'],
      ['sensor.train_delay', 6, 'history', 'ok'], ['sensor.train_delay', 168, '', 'needsStats']]);
    expect(st[0].buckets).toBe(24); expect(st[0].filled).toBeGreaterThan(20);
    expect(st[2].filled).toBeGreaterThan(0);
    const calls = fake.history.calls;
    expect(calls.some((c) => c.ids.includes(CHATTY_ID))).toBe(false);   // the other app's tile is not fetched
    expect(calls.filter((c) => c.type === 'recorder/statistics_during_period').map((c) => c.period + ' ' + c.types)).toEqual(expect.arrayContaining(['hour mean', 'hour change', '5minute max']));
    const hist = calls.filter((c) => c.type === 'history/history_during_period');
    expect(hist.map((c) => c.ids.join())).toEqual(['sensor.train_delay']);
    // the tile's region carries the chart key, so a fetch redraws it once
    expect(sim.display.regions.t0).toMatch(/"chart":"ok;/);
    // another app: its tile only; a 1 Hz sensor's 6 h of rows is over 512 KB → "Too many changes"
    const before = calls.length;
    expect(sim.goTo('power')).toBe(true);
    const p = await until(() => sim.histState(), (h) => h.length === 1 && h[0].state !== 'loading');
    expect(p[0]).toMatchObject({ entity: CHATTY_ID, state: 'tooMany', source: 'history' });
    expect(p[0].bytes).toBeGreaterThan(512 * 1024);
    expect(fake.history.calls.slice(before).every((c) => c.ids.join() === CHATTY_ID)).toBe(true);
  }, 20000);

  it('reads an attribute series and a weather forecast (#283)', async () => {
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'installed', delays: FAST });
    const sim = run.sim, fake = run.fakeHa!;
    await linked(sim);
    const cfg: Config = { apps: [...sim.p.apps, { id: 'weather', title: 'Weather' }], screens: [...sim.p.screens,
      { id: 'rain', app: 'weather', title: 'Rain', widgets: [
        { type: 'history', entity: 'binary_sensor.rain_expected', attribute: 'forecast', value: 'precipitation', window: '2h', cs: 4 },   // 24 × 5 min ahead
        { type: 'history', entity: 'weather.home', window: '24h', cs: 2 },                     // hourly, 1 h bars
        { type: 'history', entity: 'weather.home', forecast: 'daily', window: '7d', cs: 2 } ] }] };
    const v = validateYaml(toYaml(cfg)); expect(v.ok ? '' : v.line + ': ' + v.message).toBe(''); if (!v.ok) return;
    fake.history.calls = [];
    sim.applyConfig(v.config, 'test');
    expect(sim.goTo('rain')).toBe(true);
    const st = await until(() => sim.histState(), (h) => h.length === 3 && h.every((x) => x.state !== 'loading'));
    expect(st.map((x) => [x.entity, x.source, x.state, x.buckets])).toEqual([
      ['binary_sensor.rain_expected', 'attribute', 'ok', 24], ['weather.home', 'forecast', 'ok', 24], ['weather.home', 'forecast', 'ok', 7]]);
    expect(st.every((x) => x.filled >= x.buckets - 1)).toBe(true);   // the hourly forecast starts at the next hour
    expect(fake.history.calls).toEqual([]);   // no recorder call
    expect(fake.calls.filter((c) => c.domain === 'weather').map((c) => c.data.type)).toEqual(['hourly', 'daily']);
  }, 20000);
});
