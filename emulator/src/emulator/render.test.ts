// Smoke test: every device screen/state and every web-console page renders without throwing.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Emulator, type EmuState } from './Emulator.tsx';
import { WebConsole } from '../webconsole/WebConsole.tsx';
import { DeviceTab } from '../webconsole/pages/DeviceTab.tsx';
import { AdvancedTab } from '../webconsole/pages/AdvancedTab.tsx';
import { settingsPages } from '../core/settings.ts';
import { useConsole } from '../webconsole/useConsole.ts';
import { graysIn } from '../core/panel.ts';

function emu(patch: Partial<EmuState> = {}) {
  const e = new Emulator({});
  (e as any).state = { ...e.state, mode: 'main', setup: null, offline: false, simHour: 13, wifi: { ...e.state.wifi, connected: 'HomeNet' }, ha: { ...e.state.ha, linked: true }, ...patch };
  return e;
}
const html = (e: Emulator) => renderToString(e.render());

describe('device renders', () => {
  it('every screen and sub-page (linked)', () => {
    const e = emu({ zoneCount: 14 });
    e.state.screens.forEach((sc, idx) => {
      for (let sub = 0; sub < e.subPages(sc, e.state); sub++) {
        const out = html(emu({ idx, sub, zoneCount: 14 }));
        expect(out.includes(sc.title.replace(/&/g, '&amp;')), sc.id + ' ' + sub).toBe(true);
      }
    });
  });
  it('never linked: link card on Home, ghosts + card elsewhere', () => {
    expect(html(emu({ ha: { ...emu().state.ha, linked: false }, idx: 0 }))).toContain('Link Home Assistant');
    expect(html(emu({ ha: { ...emu().state.ha, linked: false }, idx: 1 }))).toContain('Energy prices needs Home Assistant');
  });
  it('menus, setup, overlays', () => {
    expect(html(emu({ menu: 'apps' }))).toContain('All apps');
    expect(html(emu({ menu: 'pages' }))).toContain('All pages');
    for (const view of ['list', 'pw', 'connecting', 'phone'] as const) html(emu({ setup: 'wifi', wifi: { ...emu().state.wifi, connected: null, view, target: 'HomeNet', pw: 'abc' } }));
    expect(html(emu({ setup: 'web' }))).toContain('Finish in your browser');
    const night = html(emu({ simHour: 23 }));
    expect(night).not.toContain('Night mode until'); expect(night).not.toContain('tap anywhere'); expect(night).toContain('Back at 07:00');
    expect(html(emu({ ambient: true }))).not.toContain('All pages in this app');
    expect(html(emu({ sleeping: true }))).toContain('Standby');
    expect(html(emu({ mode: 'updating', upd: { version: '0.4.0', pct: 40, step: 'Downloading firmware.bin' } }))).toContain('Updating to');
    const long = html(emu({ mode: 'updating', upd: { version: '0.1.0-alpha.6-devtest-212-199-gbf929d4-and-a-much-longer-tail-that-goes-on-and-on-and-on-xy', pct: 40, step: 'x' } }));
    expect(long).toMatch(/>v0\.1\.0-alpha\.6-[^<]*…[^<]*-on-xy<\/div>/);   // #215
    const local = html(emu({ mode: 'updating', upd: { version: '', pct: 0, step: 'Checking SHA-256' } }));   // upload, no manifest (#237)
    expect(local).toContain('Updating to'); expect(local).not.toMatch(/>v<\/div>/);
    expect(html(emu({ mode: 'boot' }))).toContain('Connecting to Home Assistant');
    const ha = emu().state.ha;
    expect(html(emu({ idx: emu().state.screens.findIndex((s) => s.id === 'ha'), ha: { ...ha, view: 'link' } }))).toContain('Simulate phone');
  });
});

// Issue #38: every screen a partial refresh can redraw is black/white only (core/panel.ts GRAYS). Boot is exempt (full
// refresh only); the Sleek card surface SURF is not in GRAYS (open dither/dots decision).
describe('B/W-only rule (lint)', () => {
  const screen = (e: Emulator) => { const h = html(e); return h.slice(h.indexOf('data-x4-screen')); };
  const looks = [{ style: 'classic', typeface: 'archivo' }, ...['archivo', 'bricolage', 'fraunces', 'geist'].map((typeface) => ({ style: 'sleek', typeface }))] as const;
  it('every screen, sub-page and state, both styles', () => {
    for (const look of looks) {
      const base = emu({ zoneCount: 14 });
      const at = (patch: Partial<EmuState>) => emu({ zoneCount: 14, ...patch, cfg: { ...base.state.cfg, ...look } as EmuState['cfg'] });
      const states: [string, Partial<EmuState>][] = [];
      base.state.screens.forEach((sc, idx) => { for (let sub = 0; sub < base.subPages(sc, base.state); sub++) states.push([sc.id + ' ' + sub, { idx, sub }]); });
      const ha = base.state.ha, wifi = base.state.wifi;
      states.push(['ambient', { ambient: true }], ['ambient lights', { ambient: true, idx: 4 }], ['apps', { menu: 'apps' }], ['pages', { menu: 'pages' }], ['night', { simHour: 23 }], ['standby', { sleeping: true }],
        ['never linked home', { ha: { ...ha, linked: false }, idx: 0 }], ['never linked prices', { ha: { ...ha, linked: false }, idx: 1 }],
        ['setup web', { setup: 'web' }], ['updating', { mode: 'updating', upd: { version: '0.4.0', pct: 40, step: 'Downloading firmware.bin' } }]);
      for (const view of ['list', 'pw', 'connecting', 'phone'] as const) states.push(['wifi ' + view, { setup: 'wifi', wifi: { ...wifi, connected: null, view, target: 'HomeNet', pw: 'abc' } }]);
      for (const [name, patch] of states) expect(graysIn(screen(at(patch))), look.style + '/' + look.typeface + ' ' + name).toEqual([]);
      expect(screen(at({})).includes('look-sleek')).toBe(look.style === 'sleek');
    }
  });
  it('sees gray where it is allowed (boot face)', () => expect(graysIn(screen(emu({ mode: 'boot' })))).toEqual(['#555']));
});

// Agenda and Next tiles (#316): the demo week at Wed 28 Oct 07:42, Classic and Modern, black / white only.
describe('agenda tiles render', () => {
  beforeAll(() => { vi.stubEnv('TZ', 'Europe/Amsterdam'); });
  afterAll(() => { vi.unstubAllEnvs(); });
  const W = [{ type: 'agenda', entities: 'calendar.family calendar.work', cs: 2, rs: 2 }, { type: 'next', entities: 'calendar.family calendar.work', cs: 2 }, { type: 'next', entities: 'calendar.work', cs: 2 }];
  for (const look of ['classic', 'geist'] as const) it(look + ': today first, the countdown pill, glyphs kept', () => {
    const base = emu();
    const e = emu({ now: new Date(2026, 9, 28, 7, 42), simHour: null, screens: [{ id: 'cal', app: 'home', title: 'Today', widgets: W } as any, ...base.state.screens.filter((s) => s.app === 'settings')], idx: 0, sub: 0,
      cfg: { ...base.state.cfg, ...(look === 'classic' ? { style: 'classic' } : { style: 'sleek', typeface: look }) } as EmuState['cfg'] });
    const h = html(e).slice(html(e).indexOf('data-x4-screen'));
    expect(h).toContain('Today · Wed 28'); expect(h).toContain('Dentist'); expect(h).toContain('Book club at Zoë’s'); expect(h).toContain('+6 more this week');
    expect(h).toContain('in 48 min'); expect(h).toContain('Lunch with the team'); expect(h).toContain('data-x4-pill');
    expect(graysIn(h)).toEqual([]);
  });
});

// History tile (#267): Classic and Modern, bars and line, the states without a chart; black / white only.
describe('history tile renders', () => {
  beforeAll(() => { vi.stubEnv('TZ', 'Europe/Amsterdam'); });
  afterAll(() => { vi.unstubAllEnvs(); });
  const W = [{ type: 'history', entity: 'sensor.outdoor_temperature', cs: 4 }, { type: 'history', entity: 'sensor.outdoor_humidity', window: '6h', agg: 'max', cs: 2 },
    { type: 'history', entity: 'sensor.garden_temperature', cs: 2 }];
  const at = (look: 'classic' | 'geist', widgets: object[] = W) => {
    const base = emu();
    const e = emu({ now: new Date(2026, 9, 26, 13, 20), screens: [{ id: 'hist', app: 'home', title: 'History', widgets } as any, ...base.state.screens.filter((s) => s.app === 'settings')], idx: 0, sub: 0,
      cfg: { ...base.state.cfg, ...(look === 'classic' ? { style: 'classic' } : { style: 'sleek', typeface: look }) } as EmuState['cfg'] });
    const h = html(e); return h.slice(h.indexOf('data-x4-screen'));
  };
  for (const look of ['classic', 'geist'] as const) it(look + ': line for a mean, bars for a max, low / high with times, axis, no history', () => {
    const h = at(look);
    expect(h).toContain('data-x4-history="line"'); expect(h).toContain('data-x4-history="bars"');
    expect(h).toMatch(/Low 5\.0 · 03:00/); expect(h).toMatch(/High 15\.1 · 14:30/);
    expect(h).toMatch(/>18<\/span>.*>00<\/span>.*>06<\/span>.*>12<\/span>/s);
    expect(h).toContain('No history');
    expect(h).toContain('vector-effect="non-scaling-stroke"');
    expect(graysIn(h)).toEqual([]);
  });
  it('7 d: weekday ticks and day + time on low / high; 1 h: minutes before now', () => {
    const h = at('classic', [{ type: 'history', entity: 'sensor.outdoor_temperature', window: '7d', agg: 'max', cs: 4 }, { type: 'history', entity: 'sensor.outdoor_temperature', window: '1h', cs: 4, label: 'Last hour' }]);
    expect(h).toMatch(/Low [\d.]+ · (Mo|Tu|We|Th|Fr|Sa|Su) \d\d:\d\d/);
    expect(h).toContain('>-30</span>'); expect(h).toContain('>Now</span>'); expect(h).toContain('Last hour');
  });
  for (const look of ['classic', 'geist'] as const) it(look + ': a rain nowcast ahead and an hourly weather forecast (#283)', () => {
    const h = at(look, [{ type: 'history', entity: 'binary_sensor.rain_expected', attribute: 'forecast', value: 'precipitation', window: '2h', style: 'bars', cs: 4, label: 'Rain' },
      { type: 'history', entity: 'weather.home', window: '24h', cs: 4 }]);
    expect(h).toContain('>Now</span>'); expect(h).toContain('>+30</span>'); expect(h).toContain('>+90</span>');
    expect(h).toMatch(/Low 0\.0 · \d\d:\d\d/); expect(h).toMatch(/High \d+\.\d · \d\d:\d\d/);
    expect(h).toContain('data-x4-history="line"'); expect(h).toContain('Home weather');
    expect(graysIn(h)).toEqual([]);
  });
});

// Car route (#303): cs ≥ 3 shows the arrival time as a second big value with a caption; cs 2 keeps the one line.
describe('car route renders', () => {
  const at = (cs: number, look: 'classic' | 'geist', lang: 'en' | 'nl' = 'en') => {
    const base = emu();
    const e = emu({ haLang: lang, screens: [{ id: 'car', app: 'home', title: 'Drive', widgets: [{ type: 'route', route: 'car', cs }] } as any, ...base.state.screens.filter((s) => s.app === 'settings')], idx: 0, sub: 0,
      cfg: { ...base.state.cfg, ...(look === 'classic' ? { style: 'classic' } : { style: 'sleek', typeface: look }) } as EmuState['cfg'] });
    const h = html(e); return h.slice(h.indexOf('data-x4-screen'));
  };
  for (const look of ['classic', 'geist'] as const) it(look + ': cs 4 big arrival + caption, cs 2 inline', () => {
    const wide = at(4, look);
    expect(wide).toContain('arrive if you leave now'); expect(wide).not.toMatch(/arrive \d\d:\d\d/);
    expect(wide).toMatch(/font-size:52px[^>]*>\d\d:\d\d</);
    expect(at(3, look, 'nl')).toContain('aankomst als je nu vertrekt');
    expect(at(2, look)).toMatch(/arrive \d\d:\d\d if you leave now/);
  });
});

// Price chart (#260): today's low / high with times under the bars, and a caret over the hour now in Classic.
describe('price chart renders', () => {
  const at = (look: 'classic' | 'geist', lang: 'en' | 'nl' = 'en') => {
    const base = emu();
    const e = emu({ now: new Date(2026, 9, 26, 9, 20), simHour: 9, haLang: lang, screens: [{ id: 'pr', app: 'home', title: 'Prices', widgets: [{ type: 'bars', series: 'prices', cs: 4 }, { type: 'bars', series: 'usage', cs: 4 }] } as any, ...base.state.screens.filter((s) => s.app === 'settings')], idx: 0, sub: 0,
      cfg: { ...base.state.cfg, ...(look === 'classic' ? { style: 'classic' } : { style: 'sleek', typeface: look }) } as EmuState['cfg'] });
    const h = html(e); return h.slice(h.indexOf('data-x4-screen'));
  };
  for (const look of ['classic', 'geist'] as const) it(look + ': low / high once (prices only), black / white only', () => {
    const h = at(look);
    expect(h).toContain('Low 0.18 · 13:00'); expect(h).toContain('High 0.38 · 18:00');
    expect(h.split('data-x4-lowhigh').length - 1).toBe(1);
    expect(h.split('data-x4-now').length - 1).toBe(look === 'classic' ? 1 : 0);
    expect(graysIn(h)).toEqual([]);
  });
  it('Dutch: decimal comma', () => {
    const h = at('classic', 'nl');
    expect(h).toContain('Laag 0,18 · 13:00'); expect(h).toContain('Hoog 0,38 · 18:00');
  });
});

describe('web console renders', () => {
  const api = emu().api;
  const snap = (patch: object = {}) => ({ ...emu().snapshot(), ...patch });
  const page = (s: any) => renderToString(createElement(WebConsole, { api, osName: 'HA Paper', chrome: true, initial: s }));
  it('all phases', () => {
    expect(page(null)).toContain('This site can’t be reached');
    expect(page(snap({ setup: 'wifi', softAp: true }))).toContain('Set up your display');
    expect(page(snap({ ha: { linked: false, revoked: false, server: 'h', user: 'u', discovered: [] } }))).toContain('Link Home Assistant');
    expect(page(snap({ session: { signedIn: false, user: 'u', admin: false } }))).toContain('Sign in with Home Assistant');
    expect(page(snap({ session: { signedIn: true, user: 'u', admin: true } }))).toContain('Push to display');
    // #191: three tabs, no Data sources
    const tabs = page(snap({ session: { signedIn: true, user: 'u', admin: true } }));
    for (const tab of ['>Screens</button>', '>Device settings</button>', '>Advanced</button>']) expect(tabs).toContain(tab);
    expect(tabs).not.toContain('Data sources'); expect(tabs).not.toContain('API access');
  });
  it('signed out: device mark, name as heading, tagline, one button, one short line; no version, no admin paragraph (#142)', () => {
    const out = page(snap({ firmware: '9.8.7', session: { signedIn: false, user: 'u', admin: false } }));
    expect(out).toMatch(/<h1[^>]*>Living room display<\/h1>/);
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(out).toContain('Your home, on paper.');
    expect(out).toContain('You sign in on your own Home Assistant.');
    expect(out).not.toContain('9.8.7');
    expect(out).not.toContain('administrator');
    expect(out.match(/<button/g)?.length).toBe(1);
  });
  it('screens: Names/Values toggle in the top bar; Values (remembered per browser) keeps the tile grid, values in place of names (#83, #122)', () => {
    const admin = snap({ session: { signedIn: true, user: 'u', admin: true } });
    const names = page(admin);
    expect(names).toContain('aria-label="Screen view"'); expect(names).toContain('Search widgets');
    // #84: add a tile without dragging, tiles reachable by keyboard, YAML only under Advanced
    expect(names).toContain('aria-label="Add a tile"'); expect(names).toMatch(/<optgroup label="Charts">/);
    expect(names).toMatch(/<button type="button" aria-pressed="false" aria-label="[^"]+, column 1, row 1"/);
    expect(names).toContain('>Advanced</button>'); expect(names).not.toContain('>YAML</button>');
    vi.stubGlobal('localStorage', { getItem: () => 'values', setItem: () => {} });
    try {
      const values = page(admin);
      expect(values).toContain('Loading…'); expect(values).not.toContain('Search widgets'); expect(values).not.toContain('<img');
      expect(values).toMatch(/<button type="button" aria-pressed="false" aria-label="[^"]+, column 1, row 1"/);
    } finally { vi.unstubAllGlobals(); }
  });
  it('failure states (#86): HA unreachable is one calm line under the header; a tile without a value says why', () => {
    const admin = { session: { signedIn: true, user: 'u', admin: true } };
    expect(page(snap(admin))).not.toContain('can’t reach Home Assistant');
    expect(page(snap({ ...admin, offline: true }))).toContain('The display can’t reach Home Assistant. It shows the last values it had and keeps trying.');
    const sc = snap(admin).screens;
    const gap = { ...sc[0], widgets: [{ type: 'stat', entity: 'sensor.garden_temperature' }] };
    const out = page(snap({ ...admin, screens: [gap, ...sc.slice(1)], entityGaps: { 'sensor.garden_temperature': 'unavailable' } }));
    expect(out).toContain('Unavailable in Home Assistant');
    expect(page(snap({ ...admin, language: 'nl', screens: [gap, ...sc.slice(1)], entityGaps: { 'sensor.garden_temperature': 'unknown' } }))).toContain('Onbekend in Home Assistant');
  });
  const unlinked = (server: string, discovered: string[]) => ({ ha: { linked: false, revoked: false, server, user: '', discovered } });
  const words = (h: string) => h.replace(/<(details|script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  it('link page: one sentence and the button; the key and the dedicated-user route behind disclosures (#22, #55)', () => {
    const out = page(snap(unlinked('http://homeassistant.local:8123', ['http://homeassistant.local:8123'])));
    expect(out).toMatch(/<details[^>]*><summary[^>]*>What does the display store\?<\/summary>/);
    expect(out).toContain('can do what that account can do');
    expect(out).toMatch(/<details[^>]*><summary[^>]*>Advanced: a separate Home Assistant user<\/summary>/);
    expect(out).not.toContain('Tip: sign in');
    const card = out.slice(out.indexOf('Link Home Assistant'));
    expect(words(card)).toBeLessThan(40);   // was ~150 words before #55
  });
  it('link page says "Found on your network" only for an address mDNS found (#54)', () => {
    const found = page(snap(unlinked('http://homeassistant.local:8123', ['http://homeassistant.local:8123'])));
    expect(found).toContain('Found <b>homeassistant.local:8123</b> on your network');
    expect(found).toContain('Change'); expect(found).not.toContain('Home Assistant address');
    const typed = page(snap(unlinked('https://ha.example.com', [])));
    expect(typed).toContain('Home Assistant at <b>https://ha.example.com</b>');
    expect(typed).not.toContain('on your network');
    const none = page(snap(unlinked('', [])));
    expect(none).toContain('Home Assistant address'); expect(none).not.toContain('placeholder=');   // #183: a hint, not a fake value
    expect(none).toContain('The address you open Home Assistant with, like homeassistant.local:8123');
    expect(none).not.toContain('on your network');
  });
  it('a non-admin session is view-only, says so, and offers an admin sign-in (#22)', () => {
    const out = page(snap({ session: { signedIn: true, user: 'kid', admin: false } }));
    expect(out).toContain('View only');
    expect(out).toContain('not a Home Assistant administrator');
    expect(out).toContain('Sign in as an admin');
    expect(out).not.toContain('Push to display');
  });
  it('device settings (#190): Wi-Fi on one line, Change opens the form; an (i) per explained setting', () => {
    const s = snap({ session: { signedIn: true, user: 'u', admin: true } });
    const groups = (open: boolean) => settingsPages().map((p) => ({ id: p.id, title: p.title, fields: p.fields.map((f) => ({ key: f.key, label: f.key, info: f.info ? 'INFO ' + f.key : '',
      infoOpen: open, toggleInfo: () => {}, value: '', options: [], change: () => {} })) }));
    const render = (patch: object) => renderToString(createElement(() => {
      const web = useConsole(api, s);
      return createElement(DeviceTab, { v: { web: { ...web, settingsReady: true, ...patch } as typeof web, osName: 'HA Paper' } });
    }));
    const folded = render({ settingsGroups: groups(false) });
    expect(folded).toContain('aria-label="Change Wi-Fi network"'); expect(folded).not.toContain('type="password"');
    for (const k of ['powerSave', 'wakeEvery', 'liveMin', 'intervalSec', 'standby', 'cleanEvery', 'haReport']) expect(folded).toContain('aria-label="About ' + k + '"');
    expect(folded).not.toContain('aria-label="About brightness"'); expect(folded).not.toContain('INFO ');
    const open = render({ settingsGroups: groups(true), wifiOpen: true });
    expect(open).toContain('type="password"'); expect(open).toContain('INFO powerSave');
  });
  it('advanced (#191): sidebar with Screens as YAML and API, one page at a time', () => {
    const s = snap({ session: { signedIn: true, user: 'u', admin: true } });
    const render = (patch: object) => renderToString(createElement(() => {
      const web = useConsole(api, s);
      return createElement(AdvancedTab, { v: { web: { ...web, ...patch } as typeof web, osName: 'HA Paper' } });
    }));
    const yaml = render({ isYaml: true });
    expect(yaml).toContain('Screens as YAML'); expect(yaml).toContain('Validate'); expect(yaml).not.toContain('Create token');
    const apiPage = render({ isApi: true });
    expect(apiPage).toContain('Create token'); expect(apiPage).toContain('API description (OpenAPI)'); expect(apiPage).not.toContain('Validate');
  });
});
