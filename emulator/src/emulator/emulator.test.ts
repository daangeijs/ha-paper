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

describe('front light timeout (#220)', () => {
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

describe('ambient idle mode (#27)', () => {
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

describe('night face as a poster (#27)', () => {
  it('"as of HH:MM" only when the data is older than 30 min', () => {
    const now = new Date(2026, 9, 13, 23, 30);
    const fresh = harness({ simHour: 23, now, lastUpdate: new Date(now.getTime() - 5 * 60_000) }).emu;
    expect((fresh.renderVals() as any).nightAsOf).toBe('');
    const stale = harness({ simHour: 23, now, lastUpdate: new Date(now.getTime() - 45 * 60_000) }).emu;
    expect((stale.renderVals() as any).nightAsOf).toBe('as of 22:45');
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
    expect(emu.snapshot().apps.length).toBe(4);   // the console sees your own categories; Settings is built in (#159)
    expect(emu.state.apps.at(-1)!.id).toBe('settings');
    const d = emu.derive(emu.state.d, emu.state);
    expect(emu.vm({ type: 'stat', entity: 'sensor.outdoor_temperature' }, d)).toMatchObject({ label: 'Outdoor temperature', value: '11.4', unit: '°C' });
    const sw = emu.vm({ type: 'switch', entity: 'switch.garden_pump' }, d);
    expect(sw).toMatchObject({ isLight: true, value: 'Off', dimmable: false });
    sw.toggle();
    expect(emu.state.ent['switch.garden_pump']).toBe('on');
  });
  it('labels on price / bars / gauge / thermo; thermo without a zone; away only with an away-capable zone (#148)', () => {
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
  it('failure states (#86): unavailable / unknown → ring + reason, not "—"; entity_gaps; empty screen; offline since', async () => {
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
  it('Settings is built in (#159): a config without it still has the Settings app; Updates settings from the browser reach it', async () => {
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
  it('settings: entities overrides (tile source, #191) are stored and reported as sources', async () => {
    const { emu } = harness();
    await expect(emu.api.putSettings({ entities: { 'sensor.nope': 'sensor.x' } })).rejects.toThrow('entities: unknown logical id sensor.nope');
    const r = await emu.api.putSettings({ entities: { 'sensor.battery_power': '-sensor.inverter_battery_power' } });
    expect(r.entities).toEqual({ 'sensor.battery_power': '-sensor.inverter_battery_power' });
    expect(r.entity_sources!['sensor.battery_power']).toBe('-sensor.inverter_battery_power (override)');
    expect(emu.state.entities).toEqual(r.entities);
    expect((await emu.api.putSettings({ entities: { 'sensor.battery_power': null } })).entities).toEqual({});
  });
  it('settings: unknown keys → 422 naming the key (#43, spec/test-vectors/settings-put.json)', async () => {
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

describe('night mode', () => {
  it('23–07: no data redraws; tap = 60 s dashboard peek', () => {
    const { emu, logs } = harness({ simHour: 23 });
    emu.tick(false);
    expect(logs()[0]).toBe('HA update · night · not drawn');
    emu.nav(1, 'TOUCH ›');
    expect(emu.state.peekUntil).toBeGreaterThan(Date.now() + 59000);
    expect(emu.nightActive(emu.state)).toBe(false);
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
  it('Settings › Power steps Glance / Sleep at night / Standby + night / Always live, Check every, Live after a press', () => {
    const { emu } = harness();
    const p = emu.state.screens.findIndex((s) => s.id === 'power');
    (emu as any).state = { ...emu.state, idx: p, sub: 0 };
    const ws = emu.renderVals().widgets;
    expect(ws.map((w: any) => [w.label, w.value])).toEqual([['On battery', 'Glance'], ['Check every', '15 min'], ['Live after a press', '3 min']]);
    ws[0].inc(); expect(emu.renderVals().widgets[0].value).toBe('Sleep at night');
    emu.renderVals().widgets[0].inc(); expect(emu.renderVals().widgets[0].value).toBe('Standby + night');
    emu.renderVals().widgets[0].inc(); expect(emu.renderVals().widgets[0].value).toBe('Always live');
    emu.renderVals().widgets[1].inc(); expect(emu.state.cfg.wakeEvery).toBe(30);
    emu.renderVals().widgets[2].inc(); expect(emu.state.cfg.liveMin).toBe(5);
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

describe('glance (#10): deep sleep between timer wakes, redraw only on change', () => {
  const idle = (emu: Emulator, min = 4) => { emu.lastInput = Date.now() - min * 60_000; };
  const same = (emu: Emulator) => { (emu as any).dataPatch = (s: EmuState) => ({ d: s.d, lastUpdate: new Date() }); };
  it('default on battery: live for 3 min after input, then glance sleep with the dashboard kept (no refresh)', () => {
    const { emu, logs } = harness();
    expect(emu.state.cfg.powerSave).toBe('glance');
    idle(emu, 2); emu.powerTick(); expect(emu.state.asleep).toBeNull();   // live window
    idle(emu); const full = emu.state.fullCount;
    emu.powerTick();
    expect(emu.state.asleep).toMatchObject({ glance: true });
    expect(emu.state.asleep!.wakeAt! - Date.now()).toBeGreaterThan(14.9 * 60_000);
    expect(emu.state.fullCount).toBe(full);
    expect(emu.renderVals()).toMatchObject({ isSleeping: false, asleepLine: '' });
    expect(emu.renderVals().statusLine).toMatch(/· glance ·/);
    expect(logs().some((l) => l.startsWith('POWER deep sleep (glance)'))).toBe(true);
  });
  it('timer wake: unchanged values → no refresh; a changed value → one full refresh; back to sleep each time', () => {
    const { emu, logs } = harness();
    idle(emu); emu.powerTick(); same(emu);
    const full = emu.state.fullCount;
    vi.setSystemTime(emu.state.asleep!.wakeAt!); emu.powerTick();
    expect(emu.state.fullCount).toBe(full); expect(logs()).toContain('glance · no refresh');
    expect(emu.state.asleep).toMatchObject({ glance: true }); expect(emu.state.mode).toBe('main');   // no boot screen
    (emu as any).dataPatch = (s: EmuState) => ({ d: { ...s.d, zones: Object.fromEntries(Object.entries(s.d.zones).map(([k, z]) => [k, { ...z, cur: z.cur + 1 }])) }, lastUpdate: new Date() });
    vi.setSystemTime(emu.state.asleep!.wakeAt!); emu.powerTick();
    expect(emu.state.fullCount).toBe(full + 1); expect(emu.state.log.at(-1)!.msg).toMatch(/^POWER deep sleep \(glance\)/);
    expect(logs().some((l) => /glance wake · \d+ region\(s\) changed · changed/.test(l))).toBe(true);
  });
  it('HA unreachable: the wait doubles; the third failure draws the offline mark once', () => {
    const { emu } = harness();
    idle(emu); emu.powerTick();
    (emu as any).state = { ...emu.state, ha: { ...emu.state.ha, linked: false } };
    const full = emu.state.fullCount;
    vi.setSystemTime(emu.state.asleep!.wakeAt!); emu.powerTick();
    expect(emu.rtc.fails).toBe(1); expect(emu.state.asleep!.wakeAt! - Date.now()).toBe(30 * 60_000); expect(emu.state.fullCount).toBe(full);
    vi.setSystemTime(emu.state.asleep!.wakeAt!); emu.powerTick();
    vi.setSystemTime(emu.state.asleep!.wakeAt!); emu.powerTick();
    expect(emu.rtc).toMatchObject({ fails: 3, drawnOffline: true }); expect(emu.state.fullCount).toBe(full + 1); expect(emu.state.offline).toBe(true);
    vi.setSystemTime(emu.state.asleep!.wakeAt!); emu.powerTick();
    expect(emu.state.fullCount).toBe(full + 1);
  });
  it('Right / Power wake into live mode (a reset); touch and Left do not; a key held at boot keeps it live 10 min', () => {
    const { emu, logs } = harness();
    idle(emu); emu.powerTick();
    emu.nav(-1, 'BTN_PREV'); expect(emu.state.asleep).not.toBeNull();
    emu.nav(1, 'BTN_NEXT'); expect(emu.state.asleep).toBeNull(); expect(emu.state.mode).toBe('boot');
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

describe("Home Assistant's language (#98)", () => {
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

describe('Power hold (#258)', () => {
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
