// eink-ha-os#84: build a screen in the console without YAML (tile edits in configEdit.ts), and the Values view shows the result.
import { describe, it, expect } from 'vitest';
import { defaultConfig, gridLayout, parseYaml, toYaml, type Config, type Widget } from '../core/config.ts';
import { HA_ENTITIES, type HaEntity } from '../core/data.ts';
import { Emulator } from '../emulator/Emulator.tsx';
import { addTile, entityIssue, entityValue, firstIssue, moveTile, nudgeTile, rankEntities, removeTile, resizeTile, setTileEntity, setTileLabel, titleIssue, type TileEdit } from './configEdit.ts';

const ok = (r: TileEdit) => { if (typeof r === 'string') throw new Error(r); return r; };
const cells = (ws: Widget[]) => gridLayout(ws).map((c) => (c ? c.col + ',' + c.row : null));

describe('tile edits (eink-ha-os#84)', () => {
  it('a user builds a screen: 4 tiles, rename one to "Battery %", reorder, delete, swap an entity; YAML and Values match', () => {
    let ws: Widget[] = [];
    ws = ok(addTile(ws, { type: 'stat', entity: 'sensor.outdoor_temperature' })).ws;
    ws = ok(addTile(ws, { type: 'gauge', entity: 'sensor.phone_battery' })).ws;
    ws = ok(addTile(ws, { type: 'bars', series: 'usage', cs: 2 })).ws;
    const r = ok(addTile(ws, { type: 'switch', entity: 'switch.coffee_machine' }));
    ws = r.ws;
    expect(r.sel).toBe(3);
    expect(cells(ws)).toEqual(['1,1', '2,1', '3,1', '1,2']);

    let label = '';   // typed one key at a time, like the controlled input
    for (const ch of 'Battery %') { ws = setTileLabel(ws, 1, label + ch, true); label = String(ws[1].label); }
    ws = setTileLabel(ws, 1, label);
    expect(ws[1].label).toBe('Battery %');

    ws = ok(moveTile(ws, 0, { tile: 1 })).ws;   // swap stat and gauge
    expect(cells(ws).slice(0, 2)).toEqual(['2,1', '1,1']);
    ws = ok(nudgeTile(ws, 3, 1, 0)).ws;         // switch one cell right (keyboard)
    expect(cells(ws)[3]).toBe('2,2');

    ws = removeTile(ws, 2);                      // the chart
    expect(ws.map((w) => w.type)).toEqual(['stat', 'gauge', 'switch']);
    ws = setTileEntity(ws, 0, 'input_number.target_temp');

    const cfg: Config = defaultConfig();
    cfg.screens.push({ id: 'mine', app: 'home', title: 'Mijn scherm', widgets: ws });
    expect(firstIssue(cfg, HA_ENTITIES)).toBeNull();
    const back = parseYaml(toYaml(cfg));
    expect(back.screens.at(-1)).toEqual(cfg.screens.at(-1));

    // Values view (eink-ha-os#122): each tile's value as the display formats it after the push
    const emu = new Emulator({});
    (emu as any).state = { ...emu.state, ha: { ...emu.state.ha, linked: true }, apps: back.apps, screens: back.screens };   // = after the push
    expect(emu.tileValues('mine')).toEqual(['20.5 °C', '57%', 'Off']);
  });

  it('add: full screen and no free spot are messages, inputs never change', () => {
    const full: Widget[] = [{ type: 'lightList', cs: 4, rs: 2 }];
    expect(addTile(full, { type: 'clock' })).toMatch(/Screen is full \(8 of 8 cells used\)/);
    const ws: Widget[] = [{ type: 'clock', cs: 4 }, { type: 'price', col: 2, row: 2 }];
    expect(addTile(ws, { type: 'bars', series: 'prices', cs: 3 })).toMatch(/No free spot/);
    expect(addTile(ws, { type: 'clock', cs: 2 }, [2, 2])).toMatch(/No room .* at that spot/);
    expect(ws).toEqual([{ type: 'clock', cs: 4 }, { type: 'price', col: 2, row: 2 }]);
  });

  it('nudge: edge = no change, onto a tile = swap, a wide tile that would stick out = message', () => {
    const ws: Widget[] = [{ type: 'clock' }, { type: 'price' }];
    expect(ok(nudgeTile(ws, 0, -1, 0)).ws).toBe(ws);
    expect(cells(ok(nudgeTile(ws, 0, 1, 0)).ws)).toEqual(['2,1', '1,1']);
    expect(cells(ok(nudgeTile(ws, 1, 0, 1)).ws)).toEqual(['1,1', '2,2']);
    expect(nudgeTile([{ type: 'clock', cs: 2, col: 3, row: 1 }], 0, 1, 0)).toMatch(/doesn’t fit/);
  });

  it('resize: no room → message', () => {
    const ws: Widget[] = [{ type: 'clock' }, { type: 'price', cs: 3, rs: 2 }];
    expect(resizeTile(ws, 0, 'cs', 2)).toMatch(/No room to make this tile 2×1/);
    expect(ok(resizeTile(ws, 0, 'rs', 2)).ws[0].rs).toBe(2);
    expect(ok(resizeTile([{ type: 'clock', cs: 2 }], 0, 'cs', 1)).ws[0]).toEqual({ type: 'clock' });
  });
});

describe('entity picker (eink-ha-os#84)', () => {
  it('ranks by fit: a gauge prefers %, a stat prefers W / °C / kWh, unitless last', () => {
    const g = rankEntities(HA_ENTITIES, 'gauge', '');
    const firstOther = g.findIndex((e) => e.unit !== '%');
    expect(firstOther).toBeGreaterThan(0);
    expect(g.slice(firstOther).some((e) => e.unit === '%')).toBe(false);
    const s = rankEntities(HA_ENTITIES, 'stat', '');
    expect(['W', 'kW', '°C', '°F', 'kWh', 'Wh', 'MWh']).toContain(s[0].unit);
    expect(s.at(-1)!.id.startsWith('binary_sensor.')).toBe(true);
    const sw = rankEntities(HA_ENTITIES, 'switch', '');
    expect(sw.findIndex((e) => e.id.startsWith('fan.'))).toBeGreaterThan(sw.findIndex((e) => e.id.startsWith('light.')));
    expect(rankEntities(HA_ENTITIES, 'gauge', 'phone').map((e) => e.id)).toEqual(['sensor.phone_battery']);
  });
  it('value: state + unit, On/Off, — for unknown or missing', () => {
    const e = (state?: string, unit = '°C'): HaEntity => ({ id: 'sensor.x', name: 'X', unit, state });
    expect(entityValue(e('11.4'))).toBe('11.4 °C');
    expect(entityValue(e('on', ''))).toBe('On');
    expect(entityValue(e('unavailable'))).toBe('—');
    expect(entityValue(e(undefined))).toBe('—');
    expect(entityValue(e('a very long state text here', ''))).toBe('a very long sta…');
  });
});

describe('inline validation (eink-ha-os#84)', () => {
  it('title and entity fields', () => {
    expect(titleIssue('  ')).toEqual({ msg: 'Give the screen a name.', hard: true });
    expect(titleIssue('Energie')).toBeNull();
    expect(entityIssue({ type: 'stat' }, HA_ENTITIES)).toEqual({ msg: 'Pick an entity below.', hard: true });
    expect(entityIssue({ type: 'switch', entity: 'sensor.outdoor_temperature' }, HA_ENTITIES)!.hard).toBe(true);
    expect(entityIssue({ type: 'gauge' }, HA_ENTITIES)).toBeNull();   // home battery
    expect(entityIssue({ type: 'stat', entity: 'sensor.not_there' }, HA_ENTITIES)).toMatchObject({ hard: false });
    expect(entityIssue({ type: 'stat', entity: 'sensor.not_there' }, null)).toBeNull();   // list not loaded yet
    expect(entityIssue({ type: 'gauge', entity: 'sensor.outdoor_temperature' }, HA_ENTITIES)!.msg).toMatch(/reports °C/);
    expect(entityIssue({ type: 'clock' }, HA_ENTITIES)).toBeNull();
  });
  it('firstIssue points at the screen and tile that block Push', () => {
    const cfg = defaultConfig();
    expect(firstIssue(cfg, HA_ENTITIES)).toBeNull();
    cfg.screens[1].widgets.push({ type: 'stat' });
    expect(firstIssue(cfg, HA_ENTITIES)).toEqual({ screen: 1, tile: cfg.screens[1].widgets.length - 1, msg: 'Pick an entity below.' });
    cfg.screens[0].title = '';
    expect(firstIssue(cfg, HA_ENTITIES)).toMatchObject({ screen: 0, tile: -1 });
  });
});
