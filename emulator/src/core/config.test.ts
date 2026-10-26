import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, toYaml, validateYaml, defaultConfig, ConfigError, gridLayout, entityGaps, withSettings, userConfig, settingsScreens, SYSTEM_TILES, GAUGE_DEFAULT_ENTITY } from './config.ts';
import { settingsPages, DISPLAY_FIELDS } from './settings.ts';
import { configVectors, CONFIG_CASES } from '../../scripts/gen-vectors.ts';
import { PALETTE } from './data.ts';
import { LIST_BUDGET, LIST_MAX, entityListAnswer, listLowValue } from './entityList.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const VEC = join(ROOT, 'spec', 'test-vectors', 'config');

describe('screens.yaml parser (parity vectors)', () => {
  const files = readdirSync(VEC).filter((f) => f.endsWith('.json')).sort();
  it('has ≥ 15 vectors on disk, in sync with the generator', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.map((f) => f.replace(/\.json$/, ''))).toEqual(CONFIG_CASES.map((c) => c[0]).sort());
  });
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(VEC, f), 'utf8'));
    it(v.name, () => {
      const r = validateYaml(v.input);
      if (v.expect.ok) {
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.config.screens.map((s) => ({ id: s.id, app: s.app, title: s.title, widgets: s.widgets }))).toEqual(v.expect.screens.map(({ cells: _c, ...s }: any) => s));
          expect(r.config.apps).toEqual(v.expect.apps);
          expect(toYaml(r.config)).toBe(v.expect.yaml);
        }
      } else {
        expect(r).toEqual({ ok: false, line: v.expect.line, message: v.expect.message });
      }
    });
  }
  it('generator output matches the files on disk (run `npm run vectors` after changing the parser)', () => {
    const disk = files.map((f) => JSON.parse(readFileSync(join(VEC, f), 'utf8')));
    expect(configVectors().sort((a, b) => a.name.localeCompare(b.name))).toEqual(disk);
  });
  it('covers every validation message', () => {
    const msgs = configVectors().filter((v) => !v.expect.ok).map((v) => (v.expect as any).message as string);
    for (const re of [/Only version 1/, /must come first/, /Belongs to no screen/, /Unknown app/, /Widget outside/, /Expected key: value/, /Unknown widget type/, /is not a sensor/, /Duplicate app id/, /At most 7 apps/, /No apps found/, /must come before/, /route: mode must be/, /cs must be/, /rs must be/, /Can’t read this line/, /No screens found/, /Duplicate screen id/, /of 8 cells/])
      expect(msgs.some((m) => re.test(m)), String(re)).toBe(true);
  });
});

describe('toYaml / parseYaml', () => {
  it('default config serialises to exactly spec/default-screens.yaml + the Display style and Power screens', () => {
    const base = readFileSync(join(ROOT, 'spec', 'default-screens.yaml'), 'utf8');
    const style = '  - id: style\n    app: settings\n    title: Display style\n    widgets:\n      - {type: setting, key: style}\n      - {type: setting, key: typeface, cs: 2}\n      - {type: setting, key: surface}\n';
    // Power (glance, #10): same screen in the firmware's default config.
    const power = '  - id: power\n    app: settings\n    title: Power\n    widgets:\n      - {type: setting, key: powerSave, cs: 2}\n      - {type: setting, key: wakeEvery}\n      - {type: setting, key: liveMin}\n';
    expect(toYaml(defaultConfig())).toBe(base.replace('  - id: updates\n', style + power + '  - id: updates\n'));
  });
  it('round-trips', () => {
    const c = defaultConfig(); c.screens[0].title = 'Home: "main", {all}';
    expect(parseYaml(toYaml(c))).toEqual(c);
    const custom = { apps: [{ id: 'garden', title: 'Garden, back' }, { id: 'home', title: 'Home' }], screens: c.screens.map((s) => ({ ...s, app: s.app === 'home' ? 'home' : 'garden' })) };
    expect(parseYaml(toYaml(custom))).toEqual(custom);
  });
  it('throws ConfigError with line + msg', () => {
    try { parseYaml('version: 3\n'); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(ConfigError); expect((e as ConfigError).line).toBe(1); }
  });
});

describe('grid placement (col/row)', () => {
  const H = 'version: 1\nscreens:\n  - id: a\n    widgets:\n';
  const one = (...ws: string[]) => H + ws.map((w) => '      - {' + w + '}\n').join('');
  it('auto-places row-major when nothing is pinned', () => {
    expect(gridLayout([{ type: 'clock', cs: 2 }, { type: 'price' }, { type: 'gauge' }, { type: 'price' }])).toEqual([
      { col: 1, row: 1, cs: 2, rs: 1 }, { col: 3, row: 1, cs: 1, rs: 1 }, { col: 4, row: 1, cs: 1, rs: 1 }, { col: 1, row: 2, cs: 1, rs: 1 }]);
  });
  it('a pinned tile keeps its cell; the others flow around it', () => {
    expect(gridLayout([{ type: 'price' }, { type: 'gauge', col: 1, row: 1 }])).toEqual([{ col: 2, row: 1, cs: 1, rs: 1 }, { col: 1, row: 1, cs: 1, rs: 1 }]);
    expect(gridLayout([{ type: 'clock', col: 3, row: 2 }])).toEqual([{ col: 3, row: 2, cs: 1, rs: 1 }]);
  });
  it('a tile with no room is null', () => {
    expect(gridLayout([{ type: 'price', col: 2, row: 1 }, { type: 'bars', cs: 4 }, { type: 'bars', cs: 4 }])[2]).toBeNull();
  });
  it('validates col/row', () => {
    expect(validateYaml(one('type: clock, col: 2, row: 2'))).toMatchObject({ ok: true });
    expect(validateYaml(one('type: clock, col: 5, row: 1'))).toEqual({ ok: false, line: 5, message: 'col must be 1–4' });
    expect(validateYaml(one('type: clock, col: 1'))).toEqual({ ok: false, line: 5, message: 'row must be 1 or 2' });
    expect(validateYaml(one('type: clock, cs: 2, col: 4, row: 1'))).toEqual({ ok: false, line: 5, message: 'Does not fit at col 4, row 1' });
    expect(validateYaml(one('type: clock, cs: 2, col: 1, row: 1', 'type: price, col: 2, row: 1'))).toEqual({ ok: false, line: 6, message: 'Overlaps another tile at col 2, row 1' });
  });
  it('col/row round-trip through YAML', () => {
    const c = parseYaml(one('type: price, col: 3, row: 2'));
    expect(parseYaml(toYaml(c)).screens[0].widgets[0]).toEqual({ type: 'price', col: 3, row: 2 });
  });
});

describe('entityGaps (#86)', () => {
  it('lists tile entities HA has no value for; logical ids and the home battery never', () => {
    const screens = [{ widgets: [{ type: 'stat', entity: 'sensor.a' }, { type: 'switch', entity: 'switch.b' }, { type: 'gauge', entity: 'sensor.c' },
      { type: 'stat', entity: 'sensor.solar_power' }, { type: 'gauge', entity: GAUGE_DEFAULT_ENTITY }, { type: 'clock' }] }];
    const st: Record<string, string> = { 'sensor.a': 'unavailable', 'switch.b': 'unknown', 'sensor.c': '57', 'sensor.solar_power': 'unavailable', [GAUGE_DEFAULT_ENTITY]: 'unknown' };
    expect(entityGaps(screens, (id) => st[id])).toEqual({ 'sensor.a': 'unavailable', 'switch.b': 'unknown' });
  });
  it('scene tiles never (#146): a scene is unknown until it first runs', () => {
    expect(entityGaps([{ widgets: [{ type: 'scene', entity: 'scene.x' }, { type: 'scene', entity: 'script.y' }] }], () => 'unknown')).toEqual({});
  });
});

describe('entity list (#150, #146)', () => {
  it('scene / script get a budget; a never-run scene (unknown) is still pickable, an unavailable one is not', () => {
    expect(LIST_BUDGET.reduce((a, [, n]) => a + n, 0)).toBe(LIST_MAX);
    expect(LIST_BUDGET.map(([d]) => d)).toEqual(expect.arrayContaining(['scene', 'script']));
    const st = (entity_id: string, state: string) => ({ entity_id, state, attributes: {} });
    expect(listLowValue(st('scene.movie', 'unknown'))).toBe(false);
    expect(listLowValue(st('scene.movie', 'unavailable'))).toBe(true);
    expect(listLowValue(st('script.x', 'unknown'))).toBe(true);
    expect(entityListAnswer([st('scene.a', 'unknown'), st('script.b', 'off')], () => '').e.map((r) => r[0])).toEqual(['scene.a', 'script.b']);
  });
});

describe('built-in Settings (#159)', () => {
  it('withSettings appends the Settings app and its fixed pages once; userConfig takes them off again', () => {
    const dev = withSettings(defaultConfig());
    expect(dev.apps.at(-1)!.id).toBe('settings');
    expect(withSettings(dev)).toEqual(dev);
    expect(userConfig(dev)).toEqual(defaultConfig());
    expect(defaultConfig().screens.some((s) => s.app === 'settings' || s.widgets.some((w) => SYSTEM_TILES.includes(w.type)))).toBe(false);
  });
  it('the browser Settings page offers every setting of the device menu', () => {
    const keys = settingsPages().flatMap((p) => p.fields.map((f) => f.key));
    const tiles = settingsScreens().flatMap((s) => s.widgets).filter((w) => w.type === 'setting').map((w) => (w.key === 'interval' ? 'intervalSec' : String(w.key)));
    for (const k of tiles) expect(keys).toContain(k);
    for (const f of DISPLAY_FIELDS) expect(keys).toContain(f.key);
    expect(keys).toEqual(expect.arrayContaining(['ota_channel', 'otaAuto']));
  });
});

describe('user routes (#145)', () => {
  it('a route tile reports its sensor gap like any entity tile; no entity = no gap', () => {
    const screens = [{ widgets: [{ type: 'route', entity: 'sensor.commute' }, { type: 'route', route: 'car' }] }];
    expect(entityGaps(screens, () => 'unavailable')).toEqual({ 'sensor.commute': 'unavailable' });
  });
  it('the console palette and default screens carry no demo routes, rooms or devices', () => {
    for (const it of PALETTE) expect(String(it.w.entity ?? ''), it.label).not.toMatch(/living_ceiling|kitchen_spots|coffee|outdoor/);
    expect(PALETTE.filter((it) => it.w.type === 'route')).toEqual([{ kind: 'travel', label: 'Route', w: { type: 'route', cs: 2 } }]);
    expect(PALETTE.some((it) => it.kind === 'tado')).toBe(false);
    expect(defaultConfig().screens.some((s) => s.widgets.some((w) => w.type === 'route'))).toBe(false);
    expect(defaultConfig().apps.map((a) => a.id)).toEqual(['home', 'house']);
  });
});
