// Fault knobs of the fake HA for the endurance run (#48): restart and dropped WebSockets; the device relinks.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { startSimulator, type RunningSim } from './index.ts';
import { FakeHa, houseData } from './fake-ha.ts';

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

describe('fake HA fault control (#48)', () => {
  let run: RunningSim | null = null;
  afterEach(async () => { await run?.close(); run = null; });
  const ctl = (path: string, body?: unknown) => fetch(run!.fakeHa!.url + '/__fake/' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

  it('restart refuses the port for down_s, keeps tokens; drop-ws cuts the socket; the device relinks each time', async () => {
    run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', delays: FAST });
    const token = run.fakeHa!.issueLongLived('alex', true);
    const res = await fetch(run.url + '/api/v1/ha/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(res.status).toBe(200);
    await until(() => run!.sim.ha.connected, (c) => c);
    const s0 = (await ctl('state')).sessions as number;
    expect(s0).toBeGreaterThanOrEqual(1);

    expect(await ctl('restart', { down_s: 0.3 })).toEqual({ down_s: 0.3 });
    await until(() => run!.sim.ha.connected, (c) => !c);
    await expect(fetch(run.fakeHa!.url + '/__fake/state')).rejects.toThrow();   // port refused while down
    await until(() => run!.sim.ha.connected, (c) => c);
    const s1 = (await ctl('state')).sessions as number;
    expect(s1).toBeGreaterThan(s0);

    expect((await ctl('drop-ws', {})).dropped).toBe(1);
    await until(() => ctl('state'), (st) => st.sessions > s1 && st.connections === 1);
    expect(run.sim.ha.connected).toBe(true);
  });
});

describe('fake HA https faults (#87)', () => {
  const dir = join(import.meta.dirname, '..', '..', 'sim', 'qemu', 'tls');
  let ha: FakeHa | null = null;
  afterEach(async () => { await ha?.close(); ha = null; });
  /** One TLS handshake: 'ok' + ms, 'timeout' (no ServerHello within ms) or the socket error code. */
  const handshake = (port: number, ms: number) => new Promise<{ r: string; ms: number; close: () => void }>((resolve) => {
    const t0 = Date.now();
    const s = connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false });
    const done = (r: string) => { clearTimeout(t); resolve({ r, ms: Date.now() - t0, close: () => s.destroy() }); };
    const t = setTimeout(() => done('timeout'), ms);
    s.on('secureConnect', () => done('ok'));
    s.on('error', (e: NodeJS.ErrnoException) => done(e.code || 'error'));
  });

  it('hang never answers the ClientHello, slow answers late, reset cuts it; tls-reset resets open connections', async () => {
    ha = new FakeHa({ port: 0, host: '127.0.0.1', tickMs: 0 });
    const url = await ha.listen();
    const port = Number(new URL(await ha.listenTls(0, { cert: readFileSync(join(dir, 'ha.pem')), key: readFileSync(join(dir, 'ha.key')) })).port);
    const ctl = (path: string, body: unknown) => fetch(url + '/__fake/' + path, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
    const ok = await handshake(port, 2000); expect(ok.r).toBe('ok');

    expect(await ctl('tls', { mode: 'hang' })).toEqual({ mode: 'hang', delay_s: 0 });
    const hung = await handshake(port, 400); expect(hung.r).toBe('timeout'); hung.close();
    expect(await ctl('tls', { mode: 'slow', delay_s: 0.3 })).toEqual({ mode: 'slow', delay_s: 0.3 });
    const slow = await handshake(port, 2000); expect(slow.r).toBe('ok'); expect(slow.ms).toBeGreaterThanOrEqual(280); slow.close();
    await ctl('tls', { mode: 'reset' });
    expect((await handshake(port, 2000)).r).toBe('ECONNRESET');
    expect((await fetch(url + '/__fake/tls', { method: 'POST', body: '{"mode":"nope"}' })).status).toBe(400);

    ok.close();
    await ctl('tls', { mode: 'ok' });
    const s = connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false });
    await new Promise((r) => s.once('secureConnect', r));
    const cut = new Promise<string>((r) => s.on('error', (e: NodeJS.ErrnoException) => r(e.code || 'error')));
    expect((await ctl('tls-reset', {})).reset).toBeGreaterThanOrEqual(1);
    expect(await cut).toBe('ECONNRESET');
    const st = await fetch(url + '/__fake/state').then((r) => r.json());
    expect(st.tls).toMatchObject({ mode: 'ok', accepted: { ok: 2, hang: 1, slow: 1, reset: 1 } });
  });
});

describe('fake HA real-shaped house (#88)', () => {
  it('areas via devices: area_id() resolves the device, the entity registry keeps only its own; device discovery per meter', () => {
    const hd = houseData('real');
    expect(hd.states.size).toBeGreaterThan(1000);
    expect(hd.areaOf.get('light.living_room_ceiling')).toBe('living_room');   // device area only
    expect(hd.reg!.entityArea.has('light.living_room_ceiling')).toBe(false);
    expect(hd.areaOf.get('light.kitchen')).toBe('kitchen');                   // own area on the bridge (utility)
    expect(hd.areaOf.has('light.hue_color_lamp_3')).toBe(false);
    expect(hd.reg!.dp.get('sensor.weather_station_outdoor_temperature')).toBe(1);
    const ha = new FakeHa({ house: 'real', tickMs: 0 });
    const t = '{% for m in ["sensor.envoy_482100000000_lifetime_energy_production","sensor.home_energy_usage_today"] %}{% set d = device_id(m) %}{% for e in device_entities(d) %}';
    expect(ha.deviceDiscovery(t)).toEqual([
      ['sensor.envoy_482100000000_lifetime_energy_production', [['sensor.envoy_482100000000_current_power_production', 'power', 'W'], ['sensor.envoy_482100000000_current_power_consumption', 'power', 'W']]],
      ['sensor.home_energy_usage_today', []],
    ]);
    expect(new FakeHa({ tickMs: 0 }).deviceDiscovery(t).every(([, l]) => l.length === 0)).toBe(true);
  });
});
