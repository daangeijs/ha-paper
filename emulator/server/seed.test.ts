// First link without saved screens → the device simulator builds them from the fake HA (#23).
import { describe, it, expect, afterEach } from 'vitest';
import { startSimulator, type RunningSim } from './index.ts';
import { houseData, templateWarnings } from './fake-ha.ts';
import { HaSocket } from './ha-client.ts';
import { SEED_TEMPLATE } from '../src/core/seed.ts';
import { defaultConfig } from '../src/core/config.ts';

const FAST = { wifiMs: 30, scanMs: 0, otaCheckMs: 20, otaStepMs: 10, rebootMs: 40, haRetryMs: 30 };
async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('first-run screens from Home Assistant (device simulator)', () => {
  let run: RunningSim | null = null;
  afterEach(async () => { await run?.close(); run = null; });
  const link = async (r: RunningSim) => {
    const token = r.fakeHa!.issueLongLived('alex', true);
    const res = await fetch(r.url + '/api/v1/ha/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(res.status).toBe(200);
    await until(() => r.sim.ha.connected, (c) => c);
  };

  it('stranger house: screens come from their HA, saved once; unlink + relink keeps them', async () => {
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', house: 'stranger', delays: FAST });
    expect(run.sim.p.screensSaved).toBe(false);
    await link(run);
    const p = run.sim.p;
    expect(p.screensSaved).toBe(true);
    expect(p.apps.map((a) => a.id)).toEqual(['home', 'house']);
    expect(p.screens.map((s) => s.id)).toEqual(['overview', 'energy', 'lights', 'climate', 'rooms']);
    // Settings is built into the display, not saved with the screens (#159)
    expect(run.sim.shown.map((s) => s.id)).toEqual(['overview', 'energy', 'lights', 'climate', 'rooms', 'display', 'style', 'power', 'updates', 'wifi', 'ha', 'about']);
    expect(run.sim.screenId()).toBe('overview');
    // every overview tile has a value: the HA sensors themselves (#82)
    // (ha.connected is set before subscribe_entities answers: wait for the values instead of racing them)
    const tiles = await until(() => Object.entries(run!.sim.regions()).filter(([k]) => k.startsWith('t')).map(([, v]) => v), (t) => !t.join(' ').includes('—'));
    expect(tiles.length).toBe(4);   // inside, home use (the P1 meter: grid only, #82), outside + clock
    const rev = p.configRev;
    await run.sim.unlink();
    await link(run);
    expect(run.sim.p.configRev).toBe(rev);
  });

  for (const house of ['dutch', 'dutch-energy'] as const) it(house + ' house (#82): every seeded tile names an HA entity and shows a value', async () => {
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', house, delays: FAST });
    await link(run);
    const p = run.sim.p;
    expect(p.screensSaved).toBe(true);
    const ids = p.screens.filter((s) => s.app === 'home').flatMap((s) => s.widgets).map((w) => w.entity).filter((e): e is string => typeof e === 'string');
    expect(ids).toContain('sensor.anker_solix_soc');
    for (const id of ids) expect(run.fakeHa!.states.has(id), id).toBe(true);
    expect(ids).not.toContain('sensor.anker_solix_battery_capacity');
    const tiles = await until(() => Object.entries(run!.sim.regions()).filter(([k]) => k.startsWith('t')).map(([, v]) => v), (t) => !t.join(' ').includes('—'));
    expect(tiles.length).toBe(7);   // clock + inside, solar, home use, battery, grid, outside
    expect(run.fakeHa!.templateErrors).toEqual([]);
  });

  it('real-HA undefined attributes (#58): the seed template reads none; the #23 template read device_class', () => {
    for (const h of ['stranger', 'demo'] as const) {
      const st = houseData(h).states.values();
      expect(templateWarnings(SEED_TEMPLATE, st)).toEqual([]);
    }
    const old = SEED_TEMPLATE.replace("s.attributes.get('device_class')", 's.attributes.device_class');
    const w = templateWarnings(old, houseData('stranger').states.values());
    expect(w.length).toBe(3);   // washing machine status, P1 tariff, hacs
    expect(w[0]).toBe("'homeassistant.util.read_only_dict.ReadOnlyDict object' has no attribute 'device_class'");
    expect(templateWarnings("{{ states | map(attribute='x') }}{% for s in states %}{{ s.attributes.unit_of_measurement | default('') }}{% endfor %}", houseData('stranger').states.values())).toEqual([]);
  });

  it('the fake HA reports undefined attributes like HA: WARNING events, then the result; strict fails', async () => {
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', house: 'stranger', delays: FAST });
    const sock = new HaSocket();
    await sock.connect(run.haUrl, run.fakeHa!.issueLongLived('alex', true));
    const warns: string[] = [];
    const old = SEED_TEMPLATE.replace("s.attributes.get('device_class')", 's.attributes.device_class');
    expect(JSON.parse(await sock.renderTemplate(old, 2000, (m) => warns.push(m))).areas.length).toBe(5);
    expect(warns.length).toBe(3);
    await expect(sock.command({ type: 'render_template', template: old, strict: true })).rejects.toThrow(/has no attribute 'device_class'/);
    sock.close();
  });

  it('a failed seed template saves nothing and retries on the next HA connection (#58)', async () => {
    const logs: string[] = [];
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', house: 'stranger', delays: FAST, log: (m) => logs.push(m) });
    const fake = run.fakeHa!;
    fake.seedFail = "UndefinedError: 'None' has no attribute 'lower'";
    const defaults = run.sim.p.screens.map((s) => s.id);
    await link(run);
    expect(run.sim.p.screensSaved).toBe(false);
    expect(run.sim.p.screens.map((s) => s.id)).toEqual(defaults);
    expect(logs.some((l) => l.includes("seed template failed · UndefinedError: 'None' has no attribute 'lower'"))).toBe(true);
    expect((await (await fetch(run.url + '/api/v1/console/state')).json()).seed_pending).toBe(true);
    fake.seedFail = null;
    for (const c of fake.conns) c.ws.close();   // HA restart: the display reconnects and seeds
    await until(() => !!run!.sim.p.screensSaved, (s) => s);
    expect(run.sim.p.screens.map((s) => s.id)).toContain('rooms');
    expect(fake.templateErrors).toEqual([]);
  });

  it('installed preset (the demo) keeps the demo screens', async () => {
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'installed', delays: FAST });
    await until(() => run!.sim.ha.connected, (c) => c);
    expect(run.sim.p.screens.map((s) => s.id)).toEqual(defaultConfig().screens.map((s) => s.id));   // no demo Travel screen (#145)
  });
});
