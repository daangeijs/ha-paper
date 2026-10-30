// Acceptance checks (AGENT_README §5) against the real emulator state machine, without a DOM:
// setState is applied synchronously so the class can be driven directly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Emulator, type EmuState } from './Emulator.tsx';
import { toYaml, defaultConfig } from '../core/config.ts';
import { FW_INSTALLED } from '../core/data.ts';

function harness(patch: Partial<EmuState> = {}) {
  const emu = new Emulator({});
  (emu as any).setState = (p: any, cb?: () => void) => {
    const next = typeof p === 'function' ? p(emu.state, emu.props) : p;
    (emu as any).state = { ...emu.state, ...next }; cb?.();
  };
  const climate = emu.state.screens.findIndex((s) => s.id === 'climate');
  (emu as any).state = { ...emu.state, mode: 'main', setup: null, offline: false, simHour: 13,
    wifi: { ...emu.state.wifi, connected: 'HomeNet', saved: ['HomeNet'] }, ha: { ...emu.state.ha, linked: true }, idx: climate, ...patch };
  const logs = () => emu.state.log.map((l) => l.msg);
  return { emu, logs };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('redraw only what changed', () => {
  it('new data that changes nothing visible → no refresh at all', () => {
    const { emu, logs } = harness();
    const before = emu.state.partialCount;
    emu.commit({ d: { ...emu.state.d, solar: 1234, home: 777 } }, 'HA update'); // not shown on the Heating page
    expect(emu.state.partialCount).toBe(before);
    expect(logs()[0]).toBe('HA update · nothing visible changed · no redraw');
  });
  it('one changed row redraws only that row', () => {
    const { emu } = harness();
    const zones = { ...emu.state.d.zones, hall: { cur: 18.2, set: 17 } };
    emu.commit({ d: { ...emu.state.d, zones } }, 'HA update');
    expect(emu.state.dirty).toEqual(['z:hall']);
    expect(emu.state.log[0].msg).toBe('EPD partial (HA update · 1 region)');
  });
});

describe('front light timeout (eink-ha-os#220)', () => {
  const cfg = (p: object) => ({ ...new Emulator({}).state.cfg, returnHome: 0, brightness: 50, ...p });
  it('off after the timeout, brightness unchanged; the first key only turns it back on', () => {
    const { emu, logs } = harness({ idx: 0, cfg: cfg({ lightTimeout: 30 }) });
    emu.lastInput = Date.now() - 29_000; emu.idleCheck();
    expect(emu.state.lightOut).toBe(false);
    emu.lastInput = Date.now() - 30_000; emu.idleCheck();
    expect(emu.state.lightOut).toBe(true);
    expect(emu.state.cfg.brightness).toBe(50);
    expect(logs()).toContain('IDLE 30 s → front light off');
    const before = { idx: emu.state.idx, full: emu.state.fullCount, partial: emu.state.partialCount };
    (emu.renderVals() as any).hwNext();                      // consumed: no page turn, no redraw (not ambient yet)
    expect(emu.state.lightOut).toBe(false);
    expect({ idx: emu.state.idx, full: emu.state.fullCount, partial: emu.state.partialCount }).toEqual(before);
    expect(logs()).toContain('BTN_NEXT → light on (input consumed)');
    (emu.renderVals() as any).hwNext();
    expect(emu.state.idx).not.toBe(before.idx);
  });
  it('an HA update does not turn it on; Never keeps it on; brightness 0 consumes nothing; Power is not consumed', () => {
    const { emu } = harness({ cfg: cfg({ lightTimeout: 60 }) });
    emu.lastInput = Date.now() - 60_000; emu.idleCheck();
    emu.commit({ d: { ...emu.state.d, zones: { ...emu.state.d.zones, hall: { cur: 18.2, set: 17 } } } }, 'HA update');
    expect(emu.state.lightOut).toBe(true);
    const never = harness({ cfg: cfg({ lightTimeout: 0 }) }).emu;
    never.lastInput = Date.now() - 86_400_000; never.idleCheck();
    expect(never.state.lightOut).toBe(false);
    const dark = harness({ cfg: cfg({ brightness: 0, lightTimeout: 30 }) }).emu;
    dark.lastInput = Date.now() - 30_000; dark.idleCheck();
    expect(dark.wakeChrome('BTN_NEXT')).toBe(false);
    const pw = harness({ cfg: cfg({ lightTimeout: 30 }) }).emu;
    pw.lastInput = Date.now() - 30_000; pw.idleCheck();
    (pw.renderVals() as any).hwPower();
    expect(pw.state.sleeping).toBe(true); expect(pw.state.lightOut).toBe(false);
  });
  it('Settings › Display steps 30 s → 1 → 2 → 5 min → Never', () => {
    const { emu } = harness({ cfg: cfg({ lightTimeout: 30 }) });
    const st = emu.state.screens.findIndex((s) => s.id === 'display');
    (emu as any).state = { ...emu.state, idx: st, sub: 0 };
    const vals: string[] = [];
    for (let i = 0; i < 5; i++) { const w = emu.renderVals().widgets[2]; vals.push(w.value); w.inc(); }
    expect(emu.renderVals().widgets[2].label).toBe('Light off');
    expect(vals).toEqual(['after 30 s', 'after 1 min', 'after 2 min', 'after 5 min', 'Never']);
    expect(emu.state.cfg.lightTimeout).toBe(0);
  });
});

describe('ambient idle mode (eink-ha-os#27)', () => {
  it('60 s idle hides pager, battery, app label and (with a clock tile) the bar clock; first key brings them back only', () => {
    const { emu, logs } = harness({ idx: 0, cfg: { ...new Emulator({}).state.cfg, returnHome: 0 } });
    emu.lastInput = Date.now() - 59_000; emu.idleCheck();
    expect(emu.state.ambient).toBe(false);
    emu.lastInput = Date.now() - 60_000; emu.idleCheck();
    expect(emu.state.ambient).toBe(true);
    expect(emu.state.dirty).toEqual(['bar']);
    expect(emu.chromeOf(emu.state)).toEqual({ app: false, pager: false, battery: false, clock: false });   // Home has a clock tile
    const v: any = emu.renderVals();
    expect([v.chromeApp, v.chromePager, v.chromeBatt, v.chromeClock, v.hasSub]).toEqual([false, false, false, false, false]);
    const before = { idx: emu.state.idx, full: emu.state.fullCount };
    v.hwNext();                                              // consumed: no page turn
    expect(emu.state.ambient).toBe(false);
    expect({ idx: emu.state.idx, full: emu.state.fullCount }).toEqual(before);
    expect(logs()).toContain('BTN_NEXT → chrome back (input consumed)');
    (emu.renderVals() as any).hwNext();
    expect(emu.state.idx).not.toBe(before.idx);
  });
  it('a page without a clock tile keeps the bar clock; low battery keeps the battery', () => {
    const { emu } = harness({ ambient: true });
    expect(emu.chromeOf(emu.state)).toEqual({ app: false, pager: false, battery: false, clock: true });
    const low = new Emulator({ deviceBattery: 12 });
    expect(low.chromeOf({ ...emu.state }).battery).toBe(true);
  });
  it('not while a menu is open; status icons stay', () => {
    const { emu } = harness({ menu: 'apps', cfg: { ...new Emulator({}).state.cfg, returnHome: 0 } });
    emu.lastInput = Date.now() - 120_000; emu.idleCheck();
    expect(emu.state.ambient).toBe(false);
    const off = harness({ ambient: true, offline: true }).emu;
    expect((off.renderVals() as any).statusIcons.length).toBe(1);
  });
});

describe('quiet face (eink-ha-os#295)', () => {
  it('"as of HH:MM" only when the data is older than 30 min', () => {
    const now = new Date(2026, 9, 13, 23, 30);
    const fresh = harness({ simHour: 23, now, lastUpdate: new Date(now.getTime() - 5 * 60_000) }).emu;
    expect((fresh.renderVals() as any).face.foot).toBe('');
    const stale = harness({ simHour: 23, now, lastUpdate: new Date(now.getTime() - 45 * 60_000) }).emu;
    expect((stale.renderVals() as any).face.foot).toBe('as of 22:45');
  });
  it('"Back at 07:00", no clock; no weather, agenda or bins tile: no Tomorrow row (eink-ha-os#328)', () => {
    const v = harness({ simHour: 23 }).emu.renderVals() as any;
    expect(v.isQuiet).toBe(true);
    expect(v.face).toMatchObject({ title: 'Back at 07:00', head: '', items: [], facts: [], tap: true });
  });
  it('Tomorrow row from the weather, agenda and bins tiles, in that order (eink-ha-os#328)', () => {
    const e = new Emulator({});
    const screens = [...e.state.screens, { id: 'morning', app: e.state.screens[0].app, title: 'Morning', widgets: [
      { type: 'bins', entities: 'sensor.afval_papier sensor.afval_pmd', cs: 2 }, { type: 'agenda', entities: 'calendar.family', cs: 2, rs: 2 }, { type: 'weather', entity: 'weather.home', cs: 4 }] }];
    const v = harness({ simHour: 23, screens: screens as any }).emu.renderVals() as any;
    expect(v.face.head).toBe('Tomorrow');
    expect(v.face.items.map((r: any) => r.kind)).toEqual(['weather', 'event', 'bins']);
    expect(v.face.items[1]).toMatchObject({ bold: '09:00', text: 'Plumber, 2 h window' });
    expect(v.face.items[0].bold).toMatch(/^-?\d+° \/ -?\d+°$/);
    expect(v.face.items.at(-1)).toMatchObject({ kind: 'bins', bold: 'Afval papier', text: 'put out tonight' });
  });
  it('standby inside quiet hours shows the quiet face, not the standby face', () => {
    const v = harness({ simHour: 23, sleeping: true }).emu.renderVals() as any;
    expect(v.isQuiet).toBe(true); expect(v.isSleeping).toBe(false);
  });
});

describe('tado debounce', () => {
  it('5 quick taps on + → one climate.set_temperature', () => {
    const { emu, logs } = harness();
    for (let i = 0; i < 5; i++) { emu.setZone('living', 0.5); vi.advanceTimersByTime(250); }
    expect(emu.state.pending.living).toBe(true); // dotted underline while pending
    vi.advanceTimersByTime(1500);
    const calls = logs().filter((m) => m.startsWith('climate.set_temperature'));
    expect(calls).toEqual(['climate.set_temperature climate.living temperature=23.5']);
    vi.advanceTimersByTime(900);
    expect(emu.state.pending.living).toBeUndefined();
  });
});

describe('device API from the terminal', () => {
  it('read-only token → 403 on PUT; revoked token → 401', () => {
    const { emu } = harness();
    const { token } = emu.createToken('Laptop', 'ro');
    emu.termRun('export'); emu.termRun('get'); emu.termRun('edit'); emu.termRun('put');
    expect(emu.state.term.lines.map((l) => l.t)).toContain('HTTP 403 {"error":"token is read-only"}');
    emu.revokeToken(token.id); emu.termRun('status');
    expect(emu.state.term.lines.at(-1)!.t).toBe('HTTP 401 {"error":"invalid or revoked token"}');
  });
  it('read & write token → 200 applied with one full refresh', () => {
    const { emu } = harness();
    emu.createToken('Laptop', 'rw');
    emu.termRun('export'); emu.termRun('get'); emu.termRun('edit');
    const full = emu.state.fullCount;
    emu.termRun('put');
    expect(emu.state.term.lines.at(-1)!.t).toBe('HTTP 200 {"status":"applied","screens":8}');
    expect(emu.state.fullCount).toBe(full + 1);
    expect(emu.state.screens[1].id).toBe('morning');
  });
  it('PUT /config with a wrong-domain entity → 422 with the line number', async () => {
    const { emu } = harness();
    const bad = toYaml(defaultConfig()).replace('sensor.solar_power', 'switch.solar_power');
    expect(await emu.api.validateConfig(bad)).toEqual({ ok: false, error: 'line 16: stat: “switch.solar_power” is not a sensor / binary_sensor / input_number / number / climate / weather entity' });
  });
  it('custom categories reach the app switcher; switch widgets toggle mock HA entities', async () => {
    const { emu } = harness();
    const cfg = { apps: [{ id: 'garden', title: 'Garden' }, ...emu.state.apps], screens: [{ id: 'g', app: 'garden', title: 'Garden', widgets: [{ type: 'switch', entity: 'switch.garden_pump' }, { type: 'stat', entity: 'sensor.outdoor_temperature' }] }, ...emu.state.screens] };
    await emu.api.putConfig(cfg, 'test');
    expect(emu.state.apps[0]).toEqual({ id: 'garden', title: 'Garden' });
    expect(emu.snapshot().apps.length).toBe(4);   // the console sees your own categories; Settings is built in (eink-ha-os#159)
    expect(emu.state.apps.at(-1)!.id).toBe('settings');
    const d = emu.derive(emu.state.d, emu.state);
    expect(emu.vm({ type: 'stat', entity: 'sensor.outdoor_temperature' }, d)).toMatchObject({ label: 'Outdoor temperature', value: '11.4', unit: '°C' });
    const sw = emu.vm({ type: 'switch', entity: 'switch.garden_pump' }, d);
    expect(sw).toMatchObject({ isLight: true, value: 'Off', dimmable: false });
    sw.toggle();
    expect(emu.state.ent['switch.garden_pump']).toBe('on');
  });
  it('labels on price / bars / gauge / thermo; thermo without a zone; away only with an away-capable zone (eink-ha-os#148)', () => {
    const { emu } = harness();
    const d = emu.derive(emu.state.d, emu.state);
    expect(emu.vm({ type: 'price', label: 'Stroom' }, d)).toMatchObject({ label: 'Stroom', sLabel: 'Stroom' });
    expect(emu.vm({ type: 'price' }, d)).toMatchObject({ label: 'Price', sLabel: 'Power price' });
    expect(emu.vm({ type: 'bars', series: 'solar', label: 'Zon' }, d)).toMatchObject({ label: 'Zon' });
    expect(emu.vm({ type: 'gauge', label: 'Accu' }, d)).toMatchObject({ label: 'Accu', sLabel: 'Accu' });
    expect(emu.vm({ type: 'thermo', zone: 'office', label: 'Werk' }, d)).toMatchObject({ label: 'Werk' });
    const t = emu.vm({ type: 'thermo', rs: 2 }, d);
    expect(t).toMatchObject({ label: 'Room', value: '—', set: '—', sub: '' });
    t.inc();
    expect(emu.state.pending).toEqual({});
    (emu as any).state = { ...emu.state, zoneCount: 14 };
    expect(emu.vm({ type: 'zoneList', cs: 4, rs: 2 }, d).awayOk).toBe(true);
    expect(emu.vm({ type: 'zoneList', cs: 4, rs: 2, entities: 'climate.garage' }, d).awayOk).toBe(true);   // any zone in HA, like the display
  });
  it('failure states (eink-ha-os#86): unavailable / unknown → ring + reason, not "—"; entity_gaps; empty screen; offline since', async () => {
    const { emu } = harness();
    const d = emu.derive(emu.state.d, emu.state);
    expect(emu.vm({ type: 'stat', entity: 'sensor.garden_temperature' }, d)).toMatchObject({ gap: true, value: '', unit: '', sub: 'Unavailable' });
    emu.state.ent['switch.garden_pump'] = 'unknown';
    expect(emu.vm({ type: 'switch', entity: 'switch.garden_pump' }, d)).toMatchObject({ gap: true, gapText: 'Unknown' });
    expect(emu.vm({ type: 'gauge', entity: 'sensor.garden_temperature' }, d)).toMatchObject({ gap: true, pct: 0, sub: 'Unavailable' });
    expect(emu.vm({ type: 'stat', entity: 'sensor.nobody_has_this' }, d)).toMatchObject({ value: '—' });   // not received: unchanged
    await emu.api.putConfig({ apps: emu.state.apps, screens: [{ id: 'g', app: emu.state.apps[0].id, title: 'G', widgets: [{ type: 'stat', entity: 'sensor.garden_temperature' }, { type: 'switch', entity: 'switch.garden_pump' }, { type: 'stat', entity: 'sensor.solar_power' }] }, { id: 'e', app: emu.state.apps[0].id, title: 'E', widgets: [] }] }, 'test');
    (emu as any).state = { ...emu.state, session: { ...emu.state.session, signedIn: true } };
    expect(emu.snapshot().entityGaps).toEqual({ 'sensor.garden_temperature': 'unavailable', 'switch.garden_pump': 'unknown' });
    (emu as any).state = { ...emu.state, idx: 1, offline: true, lastUpdate: new Date(2026, 9, 17, 14, 5) };
    const v: any = emu.renderVals();
    expect(v.isEmpty).toBe(true); expect(v.emptyHint).toMatch(/^Add tiles at .+ or 192\.168\.1\.42\.$/);
    expect(v.statusIcons[0].text).toBe('since 14:05');
  });
  it('settings: PUT /settings validates and drives the device settings', async () => {
    const { emu } = harness();
    await expect(emu.api.putSettings({ display: { brightness: 150 } })).rejects.toThrow('display.brightness must be 0–100');
    const r = await emu.api.putSettings({ display: { brightness: 50, standby: '30' } });
    expect(r.display).toMatchObject({ brightness: 50, standby: '30' });
    expect(emu.state.cfg).toMatchObject({ brightness: 50, standby: 30 });
  });
  it('Settings is built in (eink-ha-os#159): a config without it still has the Settings app; Updates settings from the browser reach it', async () => {
    const { emu } = harness();
    await emu.api.putConfig({ apps: [{ id: 'home', title: 'Home' }], screens: [{ id: 'a', app: 'home', title: 'A', widgets: [{ type: 'clock' }] }] }, 'test');
    expect(emu.state.apps.map((a) => a.id)).toEqual(['home', 'settings']);
    expect(emu.state.screens.filter((s) => s.app === 'settings').map((s) => s.id)).toEqual(['display', 'style', 'power', 'updates', 'wifi', 'ha', 'about']);
    expect(emu.snapshot().screens.map((s) => s.id)).toEqual(['a']);
    const r = await emu.api.putSettings({ ota_channel: 'beta', display: { otaAuto: 'night' } });
    expect(r).toMatchObject({ ota_channel: 'beta', display: { otaAuto: 'night' } });
    expect(emu.state.ota).toMatchObject({ channel: 'beta', auto: 'night' });
    await expect(emu.api.putSettings({ ota_channel: 'nightly' as 'beta' })).rejects.toThrow('ota_channel must be stable or beta');
  });
  it('settings: entities overrides (tile source, eink-ha-os#191) are stored and reported as sources', async () => {
    const { emu } = harness();
    await expect(emu.api.putSettings({ entities: { 'sensor.nope': 'sensor.x' } })).rejects.toThrow('entities: unknown logical id sensor.nope');
    const r = await emu.api.putSettings({ entities: { 'sensor.battery_power': '-sensor.inverter_battery_power' } });
    expect(r.entities).toEqual({ 'sensor.battery_power': '-sensor.inverter_battery_power' });
    expect(r.entity_sources!['sensor.battery_power']).toBe('-sensor.inverter_battery_power (override)');
    expect(emu.state.entities).toEqual(r.entities);
    expect((await emu.api.putSettings({ entities: { 'sensor.battery_power': null } })).entities).toEqual({});
  });
  it('settings: unknown keys → 422 naming the key (eink-ha-os#43, spec/test-vectors/settings-put.json)', async () => {
    const { emu } = harness();
    await expect(emu.api.putSettings({ powerSave: 'auto' } as any)).rejects.toThrow('unknown key: powerSave');
    await expect(emu.api.putSettings({ display: { brightness: 50, sleepMode: 'auto' } } as any)).rejects.toThrow('unknown key: display.sleepMode');
    expect(emu.state.cfg.brightness).not.toBe(50);
  });
});

describe('OTA', () => {
  const run = (failMode: EmuState['failMode']) => {
    const { emu } = harness({ failMode });
    emu.checkUpdate(); vi.advanceTimersByTime(1400);
    expect(emu.state.ota.status).toBe('available');
    emu.install(); vi.advanceTimersByTime(20000);
    return emu;
  };
  it('bad download → nothing changes', () => {
    const emu = run('hash');
    expect(emu.state.ota.fw).toBe(FW_INSTALLED); expect(emu.state.ota.status).toBe('error'); expect(emu.state.mode).toBe('main');
  });
  it('won’t start → automatic rollback to the previous version', () => {
    const emu = run('boot');
    expect(emu.state.ota.fw).toBe(FW_INSTALLED); expect(emu.state.ota.msg).toContain('restored v' + FW_INSTALLED + ' automatically');
  });
  it('works → updated', () => {
    const emu = run('ok');
    expect(emu.state.ota.fw).toBe('0.4.0'); expect(emu.state.ota.status).toBe('updated');
  });
});

describe('first install + web console via DeviceApi', () => {
  it('unreachable before Wi-Fi; after Wi-Fi “finish in your browser”; one sign-in links + opens the configurator', async () => {
    const { emu } = harness({ wifi: { ...new Emulator({}).state.wifi }, ha: { ...new Emulator({}).state.ha, linked: false }, setup: null, mode: 'boot' });
    await expect(emu.api.getState()).rejects.toThrow(/can’t be reached/);
    emu.boot(); vi.advanceTimersByTime(1600);
    expect(emu.state.setup).toBe('wifi');
    emu.wifiConnect('HomeNet-Guest', 'longpassword'); vi.advanceTimersByTime(2200);
    expect(emu.state.setup).toBe('web');
    const st = await emu.api.getState();
    expect(st.ha.linked).toBe(false); expect(st.session.signedIn).toBe(false);
    const p = emu.api.signInWithHa('setup sign-in'); vi.advanceTimersByTime(1800); await p;
    const after = await emu.api.getState();
    expect(after.ha.linked).toBe(true); expect(after.session.signedIn).toBe(true); expect(emu.state.setup).toBeNull();
  });
  it('“Installed” simulation boots straight to Home', () => {
    const { emu } = harness({ wifi: { ...new Emulator({}).state.wifi }, ha: { ...new Emulator({}).state.ha }, mode: 'boot' });
    emu.installedSim(); vi.advanceTimersByTime(1600);
    expect(emu.state.mode).toBe('main'); expect(emu.state.setup).toBeNull(); expect(emu.state.idx).toBe(0);
    expect(emu.state.session.signedIn).toBe(true); expect(emu.state.wifi.connected).toBe('HomeNet');
  });
});

describe('quiet hours (eink-ha-os#295)', () => {
  it('23–07: no data redraws; a press = 60 s dashboard peek', () => {
    const { emu, logs } = harness({ simHour: 23 });
    emu.tick(false);
    expect(logs()[0]).toBe('HA update · quiet hours · not drawn');
    emu.nav(1, 'TOUCH ›');
    expect(emu.state.peekUntil).toBeGreaterThan(Date.now() + 59000);
    expect(emu.quietActive(emu.state)).toBe(false);
  });
  it('Power on the quiet face (also in standby) shows the dashboard; Power while peeking = standby = the quiet face', () => {
    const { emu } = harness({ simHour: 23, sleeping: true });
    emu.power();
    expect(emu.state.sleeping).toBe(false); expect(emu.quietActive(emu.state)).toBe(false);
    emu.power();
    expect(emu.state.sleeping).toBe(true); expect(emu.quietActive(emu.state)).toBe(true);
  });
  it('setup is never covered by the quiet face', () => {
    const { emu } = harness({ simHour: 23, setup: 'web' });
    expect(emu.quietActive(emu.state)).toBe(false);
  });
});

describe('Good morning page (eink-ha-os#330)', () => {
  // a config with the three sources: the demo weather, a calendar, the demo bins
  const withTiles = (emu: Emulator) => {
    const sc = emu.state.screens.map((x, i) => (i === 0 ? { ...x, widgets: [{ type: 'weather', entity: 'weather.home', cs: 4 }, { type: 'agenda', entities: 'calendar.family', cs: 2 }, { type: 'bins', entities: 'sensor.afval_papier sensor.afval_pmd', cs: 2 }] } : x));
    (emu as any).state = { ...emu.state, screens: sc };
  };
  const night = (emu: Emulator, h: number) => { (emu as any).state = { ...emu.state, simHour: h }; emu.componentDidUpdate(); };
  it('eink-ha-os#331: nobody home at the end of quiet hours (glance, emptyHouse on) → no page, disarmed', () => {
    const { emu, logs } = harness({ simHour: 23 });
    (emu as any).state = { ...emu.state, cfg: { ...emu.state.cfg, emptyHouse: 'zone.home' }, ent: { ...emu.state.ent, 'zone.home': '0' } };
    night(emu, 23); night(emu, 6); night(emu, 7);
    expect(emu.morningOn(emu.state)).toBe(false); expect(emu.state.morning).toEqual({ armed: false, until: 0 });
    expect(logs()).toContain('MORNING skipped · nobody home');
  });
  it('the first wake after quiet hours shows it once, with the rows that have a source; a press → the start page', () => {
    const { emu, logs } = harness({ simHour: 23, idx: 2 });
    withTiles(emu);
    night(emu, 23); night(emu, 6);
    expect(emu.state.morning.armed).toBe(true);
    night(emu, 7);
    expect(emu.morningOn(emu.state)).toBe(true); expect(emu.state.idx).toBe(0);
    expect(logs()).toContain('MORNING quiet hours over → Good morning page for 20 min');
    const v = emu.renderVals() as any;
    expect(v.isMorning).toBe(true);
    expect(v.morning.head).toBe('Good morning');
    expect(v.morning.weather?.temps).toMatch(/°/);
    expect(v.morning.events.length).toBeGreaterThan(0);
    expect(Object.keys(emu.regions(emu.state))).toEqual(['morning']);
    const full = emu.state.fullCount;
    v.hwNext();
    expect(emu.morningOn(emu.state)).toBe(false); expect(emu.state.idx).toBe(0);
    expect(emu.state.fullCount).toBe(full + 1);
    night(emu, 8);
    expect(emu.morningOn(emu.state)).toBe(false);   // once per night
  });
  it('20 minutes later the start page takes over; the setting off = no page', () => {
    const { emu, logs } = harness({ simHour: 6 });
    night(emu, 6); night(emu, 7);
    expect(emu.morningOn(emu.state)).toBe(true);
    (emu as any).state = { ...emu.state, now: new Date(emu.state.morning.until) }; emu.componentDidUpdate();
    expect(emu.morningOn(emu.state)).toBe(false);
    expect(logs()).toContain('MORNING 20 min over → start page');
    const off = harness({ simHour: 6 }).emu;
    (off as any).state = { ...off.state, cfg: { ...off.state.cfg, morning: false } };
    night(off, 6); night(off, 7);
    expect(off.morningOn(off.state)).toBe(false);
  });
  it('sparse: no weather, agenda or bins tile → greeting and date only', () => {
    const { emu } = harness({ simHour: 6 });
    (emu as any).state = { ...emu.state, screens: emu.state.screens.map((x) => ({ ...x, widgets: x.widgets.filter((w) => !['weather', 'agenda', 'next', 'bins'].includes(w.type)) })) };
    night(emu, 6); night(emu, 7);
    const m = (emu.renderVals() as any).morning;
    expect([m.weather, m.events, m.bins]).toEqual([null, [], []]);
  });
});

describe('display styles', () => {
  const home = (emu: Emulator) => emu.state.screens.findIndex((s) => s.id === 'overview');
  it('style switch = exactly one full refresh, then partial refresh works exactly as before', () => {
    const { emu, logs } = harness();
    const run = (look: Parameters<Emulator['setLook']>[0]) => {
      const full = emu.state.fullCount, partial = emu.state.partialCount;
      emu.setLook(look);
      expect(emu.state.fullCount).toBe(full + 1); expect(emu.state.partialCount).toBe(partial);
      vi.advanceTimersByTime(1000);
      expect(emu.state.fullCount).toBe(full + 1);   // no extra redraws afterwards
      // Same data change as in Classic: one changed room → one region, nothing else.
      const zones = { ...emu.state.d.zones, hall: { cur: emu.state.d.zones.hall.cur + 1, set: 17 } };
      emu.commit({ d: { ...emu.state.d, zones } }, 'HA update');
      expect(emu.state.dirty).toEqual(['z:hall']); expect(emu.state.partialCount).toBe(partial + 1);
      emu.commit({ d: { ...emu.state.d, solar: 4321 } }, 'HA update');   // not on the Heating page
      expect(emu.state.partialCount).toBe(partial + 1);
    };
    run('archivo');
    expect(logs()).toContain('SIM display style → Sleek · Archivo');
    expect(emu.state.cfg).toMatchObject({ style: 'sleek', typeface: 'archivo' });
    run('geist'); run('classic');
    expect(emu.state.cfg.style).toBe('classic');
  });
  it('regions() do not depend on the style (diffing stays on vm())', () => {
    const { emu } = harness({ idx: 0 });
    const classic = emu.regions(emu.state);
    emu.setLook('fraunces');
    expect(emu.regions(emu.state)).toEqual(classic);
  });
  it('default is Classic; Settings › Display style has the style / typeface / surface steppers (one full refresh each)', () => {
    const { emu } = harness();
    expect(emu.state.cfg).toMatchObject({ style: 'classic', typeface: 'archivo', surface: 'dither' });
    const st = emu.state.screens.findIndex((s) => s.id === 'style');
    expect(emu.state.screens[st - 1].id).toBe('display');
    (emu as any).state = { ...emu.state, idx: st, sub: 0 };
    const ws = emu.renderVals().widgets;
    expect(ws.map((w: any) => w.label)).toEqual(['Style', 'Typeface', 'Card surface', 'Clock']);
    const full = emu.state.fullCount, partial = emu.state.partialCount;
    ws[0].inc();
    expect(emu.state.cfg.style).toBe('sleek'); expect(emu.state.fullCount).toBe(full + 1); expect(emu.state.partialCount).toBe(partial);
    emu.renderVals().widgets[1].inc();
    expect(emu.state.cfg.typeface).toBe('bricolage'); expect(emu.state.fullCount).toBe(full + 2);
    expect(emu.renderVals().widgets[1]).toMatchObject({ sSetting: true, isSetting: false, value: 'Bricolage' });
  });
  it('Sleek render values: skinned widgets, fonts, page dots', () => {
    const { emu } = harness({ idx: 0 });
    (emu as any).state = { ...emu.state, idx: home(emu) };
    expect(emu.renderVals()).toMatchObject({ isClassic: true, isSleek: false, lookClass: 'look-classic', fontK: 1 });
    emu.setLook('archivo');
    const v = emu.renderVals();
    expect(v).toMatchObject({ isSleek: true, lookClass: 'look-sleek', fontS: '75%', fontK: 1.12, gridGap: '10px' });
    expect(v.widgets[0]).toMatchObject({ sClock: true, isClock: false, bg: '#111' });
    expect(v.pageDots.filter((d: any) => d.w === 22)).toHaveLength(1);
  });
  it('PUT /settings: style fields validate with the shared 422 messages; a new look is one full refresh', async () => {
    const { emu } = harness();
    await expect(emu.api.putSettings({ display: { style: 'modern' } as any })).rejects.toThrow('style must be classic or sleek');
    await expect(emu.api.putSettings({ display: { typeface: 'comic' } as any })).rejects.toThrow('typeface must be archivo, bricolage, fraunces or geist');
    await expect(emu.api.putSettings({ display: { surface: 'gray' } as any })).rejects.toThrow('surface must be dither or dots');
    const full = emu.state.fullCount, partial = emu.state.partialCount;
    const r = await emu.api.putSettings({ display: { style: 'sleek', typeface: 'geist' } });
    expect(r.display).toMatchObject({ style: 'sleek', typeface: 'geist', surface: 'dither' });
    expect(emu.state.fullCount).toBe(full + 1); expect(emu.state.partialCount).toBe(partial);
    expect((await emu.api.getSettings()).display.style).toBe('sleek');
  });
});

describe('power saving: asleep (deep sleep) vs sleeping (standby face)', () => {
  const standbyOn = (emu: Emulator) => { emu.lastInput = Date.now() - 60_000; (emu as any).state = { ...emu.state, sleeping: true, cfg: { ...emu.state.cfg, powerSave: 'standby', wakeEvery: 15 } }; };
  it('Settings › Power steps Glance / Standby / Always live, Quiet hours, Good morning page, Check every, Live after a press', () => {
    const { emu } = harness();
    const p = emu.state.screens.findIndex((s) => s.id === 'power');
    (emu as any).state = { ...emu.state, idx: p, sub: 0 };
    const ws = emu.renderVals().widgets;
    expect(ws.map((w: any) => [w.label, w.value])).toEqual([['On battery', 'Glance'], ['Quiet hours', '23–07'], ['Good morning', 'On'], ['Check every', '15 min'], ['Live after a press', '3 min']]);
    ws[0].inc(); expect(emu.renderVals().widgets[0].value).toBe('Standby');
    emu.renderVals().widgets[0].inc(); expect(emu.renderVals().widgets[0].value).toBe('Always live');
    emu.renderVals().widgets[1].inc(); expect(emu.state.cfg.quiet).toBe('00-06');
    emu.renderVals().widgets[2].inc(); expect(emu.state.cfg.morning).toBe(false);
    emu.renderVals().widgets[3].inc(); expect(emu.state.cfg.wakeEvery).toBe(30);
    emu.renderVals().widgets[4].inc(); expect(emu.state.cfg.liveMin).toBe(5);
  });
  it('standby + power saving → asleep with a 15-min timer; API unreachable; footer; timer wake → Connecting… → standby again', async () => {
    const { emu, logs } = harness();
    standbyOn(emu);
    const full = emu.state.fullCount;
    emu.powerTick();
    expect(emu.state.asleep).toMatchObject({ wasStandby: true });
    expect(emu.state.asleep!.wakeAt! - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(emu.state.fullCount).toBe(full + 1);
    expect(emu.renderVals()).toMatchObject({ isSleeping: true, asleepLine: expect.stringMatching(/^Asleep · wakes \d\d:\d\d · press power$/) });
    expect(emu.renderVals().statusLine).toMatch(/· asleep ·/);
    await expect(emu.api.getState()).rejects.toThrow();
    await expect(emu.api.putSettings({ display: { warmth: 50 } })).rejects.toThrow();
    emu.nav(-1, 'BTN_PREV'); emu.home('KEY_HOME');
    expect(emu.state.asleep).not.toBeNull();   // Left / Home don't wake
    vi.setSystemTime(emu.state.asleep!.wakeAt!);
    emu.powerTick();
    expect(emu.state.asleep).toBeNull(); expect(emu.state.mode).toBe('boot'); expect(emu.state.bootMsg).toBe('Connecting…');
    vi.advanceTimersByTime(1600);
    expect(emu.state.mode).toBe('main'); expect(emu.state.sleeping).toBe(true);
    expect(logs()).toContain('TIMER → wake from deep sleep (reset)');
  });
  it('never asleep with USB plugged, within 2 min of an API call, or with power saving off; Power key / USB wake it', async () => {
    const { emu } = harness();
    standbyOn(emu);
    emu.setUsb(true); emu.powerTick(); expect(emu.state.asleep).toBeNull();
    emu.setUsb(false);
    await emu.api.getSettings(); emu.powerTick(); expect(emu.state.asleep).toBeNull();   // recent API
    emu.lastApi = Date.now() - 120_000; emu.powerTick(); expect(emu.state.asleep).not.toBeNull();
    emu.power(); expect(emu.state.asleep).toBeNull(); expect(emu.state.mode).toBe('boot');
    vi.advanceTimersByTime(1600); expect(emu.state.sleeping).toBe(false);   // a key wake ends standby too
    standbyOn(emu); emu.powerTick(); expect(emu.state.asleep).not.toBeNull();
    emu.setUsb(true); expect(emu.state.asleep).toBeNull();   // the charger wakes it
    vi.advanceTimersByTime(1600);
    (emu as any).state = { ...emu.state, usb: false, cfg: { ...emu.state.cfg, powerSave: 'off' } };
    standbyOn(emu); (emu as any).state = { ...emu.state, cfg: { ...emu.state.cfg, powerSave: 'off' } };
    emu.powerTick(); expect(emu.state.asleep).toBeNull();
  });
});

describe('glance (eink-ha-os#10): deep sleep between timer wakes, redraw only on change', () => {
  const idle = (emu: Emulator, min = 4) => { emu.lastInput = Date.now() - min * 60_000; };
  const same = (emu: Emulator) => { (emu as any).dataPatch = (s: EmuState) => ({ d: s.d, lastUpdate: new Date() }); };
  it('default on battery: live for 3 min after input, then glance sleep: the sleep face, to the next transition (eink-ha-os#356)', () => {
    const { emu, logs } = harness();
    expect(emu.state.cfg.powerSave).toBe('glance');
    idle(emu, 2); emu.powerTick(); expect(emu.state.asleep).toBeNull();   // live window
    idle(emu); const full = emu.state.fullCount;
    emu.powerTick();
    expect(emu.state.asleep).toMatchObject({ glance: true });
    // 13:xx, quiet hours 23-07: quiet start is > 8 h away, so the 8 h cap (MAX_SLEEP_S)
    expect(emu.state.asleep!.wakeAt! - Date.now()).toBeGreaterThan(8 * 3600_000 - 1000);
    expect(emu.state.asleep!.wakeAt! - Date.now()).toBeLessThanOrEqual(8 * 3600_000);
    expect(emu.state.fullCount).toBe(full + 1);   // eink-ha-os#356: the sleep face goes up, one full refresh
    expect(emu.state.log.some((l) => l.msg === 'EPD clean refresh (sleep face)')).toBe(true);
    expect(emu.renderVals()).toMatchObject({ isSleeping: false, asleepLine: '', isGlanceFace: true, isNobodyHome: false, isQuiet: false });
    expect(emu.renderVals().statusLine).toMatch(/· glance ·/);
    // eink-ha-os#333, eink-ha-os#356: no time of day while asleep: "Asleep · press to wake" and the date, no dashboard
    const v: any = emu.renderVals();
    expect(v.face).toMatchObject({ title: 'Asleep · press to wake', sub: v.dateText, facts: [], tap: false });
    expect(v.face.title + v.face.sub).not.toMatch(/\d:\d/);
    expect(Object.keys(emu.regions(emu.state))).toEqual(['sleep']);
    expect(logs().some((l) => l.startsWith('POWER deep sleep (glance)'))).toBe(true);
  });
  // eink-ha-os#356: the wake is a transition, hours later; pin "drawn at" to the wake so only a change of the face redraws
  const wake = (emu: Emulator) => { const t = emu.state.asleep!.wakeAt!; vi.setSystemTime(t); emu.rtc = { ...emu.rtc, drawnAt: t }; emu.powerTick(); };
  it('transition wake: unchanged face → no refresh; a dashboard-only value → none; a new date → one full refresh', () => {
    const { emu, logs } = harness();
    idle(emu); emu.powerTick(); same(emu);
    const full = emu.state.fullCount;
    wake(emu);
    expect(emu.state.fullCount).toBe(full); expect(logs()).toContain('glance · no refresh');
    expect(emu.state.asleep).toMatchObject({ glance: true }); expect(emu.state.mode).toBe('main');   // no boot screen
    (emu as any).dataPatch = (s: EmuState) => ({ d: { ...s.d, zones: Object.fromEntries(Object.entries(s.d.zones).map(([k, z]) => [k, { ...z, cur: z.cur + 1 }])) }, lastUpdate: new Date() });
    wake(emu);
    expect(emu.state.fullCount).toBe(full); expect(emu.renderVals().isGlanceFace).toBe(true);
    (emu as any).dataPatch = (s: EmuState) => ({ now: new Date(s.now.getTime() + 86_400_000), lastUpdate: new Date() });
    wake(emu);
    expect(emu.state.fullCount).toBe(full + 1); expect(emu.renderVals().isGlanceFace).toBe(true); expect(emu.state.log[0].msg).toMatch(/^POWER deep sleep \(glance\)/);
    expect(logs().some((l) => /glance wake · \d+ region\(s\) changed · changed/.test(l))).toBe(true);
  });
  it('HA unreachable: no backoff (the next transition); the third failure draws the offline mark once; a new date is drawn', () => {
    const { emu } = harness();
    idle(emu); emu.powerTick();
    const first = emu.state.asleep!.wakeAt! - Date.now();
    (emu as any).state = { ...emu.state, ha: { ...emu.state.ha, linked: false } };
    const full = emu.state.fullCount;
    wake(emu);
    expect(emu.rtc.fails).toBe(1); expect(Math.abs(emu.state.asleep!.wakeAt! - Date.now() - first)).toBeLessThan(1000); expect(emu.state.fullCount).toBe(full);
    wake(emu); wake(emu);
    expect(emu.rtc).toMatchObject({ fails: 3, drawnOffline: true }); expect(emu.state.fullCount).toBe(full + 1); expect(emu.state.offline).toBe(true);
    wake(emu);
    expect(emu.state.fullCount).toBe(full + 1);
    (emu as any).state = { ...emu.state, now: new Date(emu.state.now.getTime() + 86_400_000) };   // midnight passed
    wake(emu);
    expect(emu.state.fullCount).toBe(full + 2);
  });
  it('Right / Power wake into live mode (a reset); touch and Left do not; a key held at boot keeps it live 10 min', () => {
    const { emu, logs } = harness();
    idle(emu); emu.powerTick();
    emu.nav(-1, 'BTN_PREV'); expect(emu.state.asleep).not.toBeNull();
    // eink-ha-os#299: asleep, the bar says when it updated instead of a live-looking clock
    expect(emu.renderVals().isGlanceFace).toBe(true);   // eink-ha-os#356: the sleep face
    emu.nav(1, 'BTN_NEXT'); expect(emu.state.asleep).toBeNull(); expect(emu.renderVals().isGlanceFace).toBe(false); expect(emu.state.mode).toBe('main');   // eink-ha-os#299: no boot screen
    expect(logs().some((l) => l.includes('button wake · held until data, no boot screen'))).toBe(true);
    emu.nav(1, 'BTN_NEXT'); expect(logs()).toContain('BTN_NEXT held at boot → live for 10 min, no deep sleep');
    vi.advanceTimersByTime(1600);
    idle(emu, 5); emu.powerTick(); expect(emu.state.asleep).toBeNull();   // held: 10 min
    vi.advanceTimersByTime(7 * 60_000); emu.powerTick(); expect(emu.state.asleep).toBeNull();
    vi.advanceTimersByTime(3 * 60_000); emu.powerTick(); expect(emu.state.asleep).toMatchObject({ glance: true });
  });
  it('first-boot safety and guards: not armed, USB, unconfirmed OTA → never asleep', () => {
    const { emu } = harness();
    idle(emu);
    emu.armLeft = 2; emu.powerTick(); expect(emu.state.asleep).toBeNull();
    emu.armLeft = 0; emu.setUsb(true); emu.powerTick(); expect(emu.state.asleep).toBeNull();
    emu.setUsb(false); (emu as any).state = { ...emu.state, ota: { ...emu.state.ota, pendingVerify: true } }; idle(emu);
    emu.powerTick(); expect(emu.state.asleep).toBeNull();
    (emu as any).state = { ...emu.state, ota: { ...emu.state.ota, pendingVerify: false } };
    emu.powerTick(); expect(emu.state.asleep).toMatchObject({ glance: true });
  });
});

describe('front light after a timer wake (eink-ha-os#357)', () => {
  it('a timer wake boots dark; the first key turns the light on and still counts; deep sleep shows no light', () => {
    const { emu } = harness({ cfg: { ...new Emulator({}).state.cfg, brightness: 40, powerSave: 'standby' } as any });
    expect(emu.renderVals().lightOpacity).toBeGreaterThan(0);
    (emu as any).state = { ...emu.state, asleep: { wakeAt: Date.now(), clock: '13:00', wasStandby: false } };
    expect(emu.renderVals().lightOpacity).toBe(0);
    emu.wakeUp('TIMER');
    expect(emu.state.bootDark).toBe(true); expect(emu.renderVals().lightOpacity).toBe(0);
    vi.advanceTimersByTime(1600);
    const idx = emu.state.idx;
    emu.nav(1, 'BTN_NEXT');
    expect(emu.state.bootDark).toBe(false); expect(emu.renderVals().lightOpacity).toBeGreaterThan(0);
    expect(emu.state.idx).not.toBe(idx);   // not consumed (unlike the eink-ha-os#220 timeout)
  });
  it('a button wake boots with the light on', () => {
    const { emu } = harness({ cfg: { ...new Emulator({}).state.cfg, brightness: 40, powerSave: 'standby' } as any });
    (emu as any).state = { ...emu.state, asleep: { wakeAt: null, clock: '13:00', wasStandby: false } };
    emu.wakeUp('BTN_POWER');
    expect(emu.state.bootDark).toBe(false); expect(emu.renderVals().lightOpacity).toBeGreaterThan(0);
  });
});

describe('empty-house sleep (eink-ha-os#331): 2 h glance and the Nobody home face while nobody is home', () => {
  const idle = (emu: Emulator, min = 4) => { emu.lastInput = Date.now() - min * 60_000; };
  const set = (emu: Emulator, p: Partial<EmuState>) => { (emu as any).state = { ...emu.state, ...p }; };
  const home = (emu: Emulator, n: string) => set(emu, { ent: { ...emu.state.ent, 'zone.home': n } });
  const on = (emu: Emulator, hour = 12) => set(emu, { simHour: hour, cfg: { ...emu.state.cfg, emptyHouse: 'zone.home', quiet: '23-07' } });
  it('off by default: nobody home changes nothing', () => {
    const { emu } = harness();
    expect(emu.state.cfg.emptyHouse).toBe('');
    home(emu, '0'); set(emu, { simHour: 12 }); idle(emu); emu.powerTick();
    expect(emu.state.asleep).toMatchObject({ glance: true }); expect(emu.renderVals().isNobodyHome).toBe(false);
    expect(emu.state.asleep!.wakeAt! - Date.now()).toBeLessThanOrEqual(8 * 3600_000);   // eink-ha-os#356: no 15 min wakes
  });
  it('nobody home: sleeps 2 h with the face up (one full refresh), counted; someone home again → glance sleep', () => {
    const { emu, logs } = harness();
    on(emu); home(emu, '0'); idle(emu); const full = emu.state.fullCount;
    emu.powerTick();
    expect(emu.state.asleep).toMatchObject({ glance: true });
    expect(emu.state.asleep!.wakeAt! - Date.now()).toBeGreaterThan(60 * 60_000);
    expect(logs().some((l) => l.startsWith('POWER deep sleep (empty house)'))).toBe(true);
    expect(emu.state.fullCount).toBe(full + 1); expect(emu.emptySleeps).toBe(1);
    const v: any = emu.renderVals();
    expect(v).toMatchObject({ isNobodyHome: true, isQuiet: false, isGlanceFace: false, face: { title: 'Nobody home', items: [], foot: '', tap: false } });
    expect(v.face.sub).toMatch(/^Next update ~\d\d:\d\d$/);   // eink-ha-os#333: no time of day
    expect(v.face.facts[0]).toMatchObject({ label: 'Inside' });
    // a timer wake that sees someone home: the glance sleep face (eink-ha-os#356), the normal interval
    home(emu, '2'); vi.setSystemTime(emu.state.asleep!.wakeAt!); emu.powerTick();
    expect(emu.renderVals().isNobodyHome).toBe(false); expect(emu.renderVals().isGlanceFace).toBe(true); expect(emu.state.log[0].msg).toMatch(/^POWER deep sleep \(glance\)/);
    expect(emu.state.log[1].msg).toBe('EPD clean refresh (glance: changed)');
    expect(emu.state.asleep!.wakeAt! - Date.now()).toBeLessThanOrEqual(8 * 3600_000);   // eink-ha-os#356: no 15 min wakes
  });
  it('quiet hours win: at night it stays the quiet face, no empty-house wake', () => {
    const { emu } = harness();
    on(emu, 2); home(emu, '0'); idle(emu); emu.powerTick();
    expect(emu.renderVals()).toMatchObject({ isQuiet: true, isNobodyHome: false });
    expect(emu.emptySleeps).toBe(0);
  });
  it('a button press wakes normally: the dashboard, live', () => {
    const { emu } = harness();
    on(emu); home(emu, '0'); idle(emu); emu.powerTick();
    expect(emu.renderVals().isNobodyHome).toBe(true);
    emu.nav(1, 'BTN_NEXT');
    expect(emu.state.asleep).toBeNull(); expect(emu.renderVals().isNobodyHome).toBe(false);
    emu.powerTick(); expect(emu.state.asleep).toBeNull();   // live window
  });
  it('unknown presence counts as someone home', () => {
    const { emu } = harness();
    on(emu); home(emu, 'unavailable'); idle(emu); emu.powerTick();
    expect(emu.renderVals().isNobodyHome).toBe(false); expect(emu.emptySleeps).toBe(0);
  });
});

describe("Home Assistant's language (eink-ha-os#98)", () => {
  it('Dutch HA: Dutch day name and our headings; screen titles stay; unlinked → English', () => {
    const { emu } = harness({ haLang: 'nl' });
    let v: any = emu.renderVals();
    expect(v.weekday).toMatch(/^(Zondag|Maandag|Dinsdag|Woensdag|Donderdag|Vrijdag|Zaterdag)$/);
    const zl = v.widgets.find((w: any) => w.isZoneList || w.sZones);
    expect(zl.summary).toMatch(/^\d+ kamers · \d+ verwarmen$/);
    expect(zl.awayLabel).toBe('Zet op Afwezig');
    expect(v.pageTitle).toBe('Heating');   // the user's screen title
    expect(emu.snapshot().language).toBe('nl');
    (emu as any).state = { ...emu.state, ha: { ...emu.state.ha, linked: false } };
    v = emu.renderVals();
    expect(v.weekday).toMatch(/day$/);
    expect(emu.snapshot().language).toBeNull();
  });
});

describe('Power hold (eink-ha-os#258)', () => {
  it('held 2 s → "Turned off" face, API unreachable, other keys ignored; Power boots it again', () => {
    const { emu, logs } = harness();
    emu.holdPowerSim();
    expect(emu.state.mode).toBe('off');
    expect(logs().some((m) => m.includes('turned off'))).toBe(true);
    emu.nav(1, 'BTN_NEXT');
    expect(emu.state.mode).toBe('off');
    emu.power();
    expect(emu.state.mode).toBe('boot');
  });
  it('a short press is still standby', () => {
    const { emu } = harness();
    emu.power();
    expect(emu.state.sleeping).toBe(true);
    expect(emu.state.mode).toBe('main');
  });
});
