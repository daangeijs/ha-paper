// Tile source in the screen editor (#191): which tiles read a logical id, the provenance line, the shared warning,
// and picks that apply at once (PUT /settings `entities`).
import { describe, expect, it } from 'vitest';
import type { Config } from '../core/config.ts';
import { tr, trMsg, type Lang, type StrKey } from '../core/strings.ts';
import type { DeviceSettings, SettingsPatch } from '../core/settings.ts';
import { logicalSource, sharedLine, sharedWith, sourcePatch, tileLogical } from './tileSource.ts';

const T = (lang: Lang) => (k: StrKey, ...a: (string | number)[]) => tr(lang, k, ...a);
const t = T('en');
const tm = (s: string) => trMsg('en', s);
const cfg: Config = { apps: [{ id: 'home', title: 'Home' }], screens: [
  { id: 'energy', app: 'home', title: 'Energy', widgets: [{ type: 'stat', entity: 'sensor.solar_power' }, { type: 'bars', series: 'solar' }, { type: 'stat', entity: 'sensor.living_room_temperature' }, { type: 'stat', entity: 'sensor.solar_power', label: 'Zon' }] },
  { id: 'prices', app: 'home', title: 'Prices', widgets: [{ type: 'price' }, { type: 'bars', series: 'prices' }, { type: 'gauge' }, { type: 'stat', entity: 'sensor.solar_power' }] },
] };
const settings = (src: Record<string, string>, entities: Record<string, string> = {}): DeviceSettings => ({ display: {} as DeviceSettings['display'], name: 'x', entities, entity_sources: src });
const list = [{ id: 'sensor.p1_power', name: 'P1 power', unit: 'W', state: '-620' }, { id: 'sensor.inverter', name: 'Inverter', unit: 'W', state: '1812' }];
function source(st: DeviceSettings, flip = false, q = '') {
  const puts: { patch: SettingsPatch; done: string }[] = [];
  const v = logicalSource({ id: 'sensor.solar_power', settings: st, list, ready: true, q, flip, t, tm, put: (patch, done) => puts.push({ patch, done }) });
  return { v, puts };
}

describe('tile source (#191)', () => {
  it('which logical id a tile reads; tiles with their own entity read none', () => {
    expect(cfg.screens[0].widgets.map(tileLogical)).toEqual(['sensor.solar_power', 'sensor.solar_hourly', null, 'sensor.solar_power']);
    expect(cfg.screens[1].widgets.map(tileLogical)).toEqual(['sensor.energy_prices', 'sensor.energy_prices', 'sensor.home_battery_soc', 'sensor.solar_power']);
    expect(tileLogical({ type: 'bars' })).toBe('sensor.energy_usage_hourly');
    expect(tileLogical({ type: 'gauge', entity: 'sensor.phone_battery' })).toBeNull();
    expect(tileLogical({ type: 'route', entity: 'sensor.x4_route_work' })).toBeNull();
  });
  it('shared: every other tile on any screen with the same logical id; the warning names them (EN, NL)', () => {
    expect(sharedWith(cfg, 0, 0)).toEqual([{ screen: 0, tile: 3 }, { screen: 1, tile: 3 }]);
    expect(sharedWith(cfg, 0, 2)).toEqual([]);
    expect(sharedWith(cfg, 1, 0)).toEqual([{ screen: 1, tile: 1 }]);
    expect(sharedLine(t, ['Zon', 'Solar now (Prices)'])).toBe('Also used by 2 other tiles: Zon and Solar now (Prices). A change here changes them too.');
    expect(sharedLine(t, ['A', 'B', 'C'])).toBe('Also used by 3 other tiles: A, B and C. A change here changes them too.');
    expect(sharedLine(t, ['Price chart'])).toBe('Also used by 1 other tile: Price chart. A change here changes it too.');
    expect(sharedLine(t, [])).toBe('');
    expect(sharedLine(T('nl'), ['A', 'B'])).toBe('Ook gebruikt door 2 andere tegels: A en B. Een wijziging hier verandert die ook.');
  });
  it('provenance: from Energy dashboard, picked by you, same id in HA, none; with the live value', () => {
    const energy = source(settings({ 'sensor.solar_power': 'sensor.inverter (energy)' })).v;
    expect([energy.entity, energy.from, energy.now, energy.manual]).toEqual(['sensor.inverter', 'from Energy dashboard', 'Now 1812 W', false]);
    expect(source(settings({ 'sensor.solar_power': 'sensor.inverter (device)' })).v.from).toBe('from Energy dashboard');
    const mine = source(settings({ 'sensor.solar_power': '-sensor.p1_power (override)' }, { 'sensor.solar_power': '-sensor.p1_power' })).v;
    expect([mine.entity, mine.from, mine.manual]).toEqual(['−sensor.p1_power', 'picked by you', true]);
    expect(mine.flips.find((f) => f.on)?.label).toBe('Flip sign');
    expect(source(settings({ 'sensor.solar_power': 'sensor.solar_power (identity)' })).v.from).toBe('same id in HA');
    const none = source(settings({})).v;
    expect([none.entity, none.from, none.now]).toEqual(['—', 'none', '']);
  });
  it('picking an entity applies at once: PUT /settings entities, the chosen sign included', () => {
    const { v, puts } = source(settings({ 'sensor.solar_power': 'sensor.inverter (energy)' }), true);
    v.entities.find((e) => e.id === 'sensor.p1_power')!.pick();
    expect(puts).toEqual([{ patch: { entities: { 'sensor.solar_power': '-sensor.p1_power' } }, done: 'Saved · Solar power now reads sensor.p1_power' }]);
    // a typed id the list does not carry is saved too, with the warning
    const typed = source(settings({}), false, 'sensor.not_listed');
    expect(typed.v.typed).toBe('sensor.not_listed');
    typed.v.useTyped();
    expect(typed.puts[0].patch).toEqual({ entities: { 'sensor.solar_power': 'sensor.not_listed' } });
  });
  it('flip and Use automatic save at once; flipping before any pick only sets the choice', () => {
    const manual = source(settings({}, { 'sensor.solar_power': 'sensor.p1_power' }));
    manual.v.flips[1].apply(); manual.v.auto();
    expect(manual.puts.map((p) => p.patch)).toEqual([sourcePatch('sensor.solar_power', 'sensor.p1_power', true), { entities: { 'sensor.solar_power': null } }]);
    const auto = source(settings({}));
    auto.v.flips[1].apply();
    expect(auto.puts).toEqual([]);
  });
});
