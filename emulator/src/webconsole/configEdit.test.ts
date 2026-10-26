import { describe, it, expect } from 'vitest';
import { defaultConfig, parseYaml, toYaml, type Widget } from '../core/config.ts';
import { HA_ENTITIES, ROOMS } from '../core/data.ts';
import { bucketsFor, firstIssue, historyIssue, rankEntities, setHistoryKey } from './configEdit.ts';
import { addApp, capHides, cleanLabel, clearPicks, entitiesFor, entityIssue, hasLabelField, matches, moveApp, moveScreen, pickDomains, pickedEntity, pickGroups, removeApp, renameApp, setBarsSeries, setSceneAllOff, setTileEntity, slugify, togglePick } from './configEdit.ts';
import { presetHasAway } from '../core/format.ts';

describe('configEdit', () => {
  it('scene tile (#146): picks scene / script entities, an entity drops scene: all_off, all off drops the entity', () => {
    expect(entitiesFor(HA_ENTITIES, 'scene', '').map((e) => e.id)).toEqual(['scene.movie_night', 'script.good_night']);
    const ws: Widget[] = [{ type: 'scene', scene: 'all_off', cs: 2 }];
    expect(entityIssue(ws[0], HA_ENTITIES)).toBeNull();
    const picked = setTileEntity(ws, 0, 'script.good_night');
    expect(picked[0]).toEqual({ type: 'scene', cs: 2, entity: 'script.good_night' });
    expect(entityIssue(picked[0], HA_ENTITIES)).toBeNull();
    expect(entityIssue({ type: 'scene', entity: 'light.kitchen' }, HA_ENTITIES)?.hard).toBe(true);
    expect(setSceneAllOff(picked, 0)[0]).toEqual({ type: 'scene', cs: 2, scene: 'all_off' });
    expect(ws[0]).toEqual({ type: 'scene', scene: 'all_off', cs: 2 });   // untouched
  });
  it('slugify makes unique ids', () => {
    expect(slugify('Kids room', [])).toBe('kids_room');
    expect(slugify('Kids room', ['kids_room'])).toBe('kids_room_2');
    expect(slugify('!!!', [])).toBe('app');
  });
  it('moveScreen changes category and order without mutating', () => {
    const c = defaultConfig();
    const from = c.screens.findIndex((s) => s.id === 'lights');
    const r = moveScreen(c, from, 'home', 0);
    expect(r.cfg.screens[0]).toMatchObject({ id: 'lights', app: 'home' });
    expect(r.index).toBe(0);
    expect(c.screens[from].app).toBe('house');
    const r2 = moveScreen(c, 0, 'house', null);   // to the end of a category
    expect(r2.cfg.screens[r2.index]).toMatchObject({ id: 'overview', app: 'house' });
    expect(r2.cfg.screens[r2.index - 1].app).toBe('house');
  });
  it('categories: add, rename, reorder, remove only when empty, max 7 of your own (+ Settings, #159)', () => {
    let c = addApp(defaultConfig(), 'Garden') as ReturnType<typeof defaultConfig>;
    expect(c.apps.at(-1)).toEqual({ id: 'garden', title: 'Garden' });
    c = renameApp(c, 'garden', 'Tuin');
    expect(c.apps.at(-1)!.title).toBe('Tuin');
    expect(moveApp(c, 2, 0).apps[0].id).toBe('garden');   // default apps: home, house (#145); Settings is built in (#159)
    expect(removeApp(c, 'home')).toBe('Move or delete its screens first.');
    expect((removeApp(c, 'garden') as typeof c).apps.length).toBe(2);
    expect(addApp(c, ' ')).toBe('Give the category a name.');
    for (const t of ['a', 'b', 'c', 'd']) c = addApp(c, t) as typeof c;
    expect(c.apps.length).toBe(7);
    expect(addApp(c, 'x')).toMatch(/at most 8 categories, Settings included/);
  });
  it('entitiesFor filters by HA domain and search', () => {
    const sw = entitiesFor(HA_ENTITIES, 'switch', '');
    expect(sw.every((e) => ['switch', 'light', 'input_boolean', 'fan'].includes(e.id.split('.')[0]))).toBe(true);
    expect(sw.some((e) => e.id === 'light.kitchen_spots')).toBe(true);
    expect(entitiesFor(HA_ENTITIES, 'gauge', 'battery').map((e) => e.id)).toContain('sensor.phone_battery');
    expect(entitiesFor(HA_ENTITIES, 'gauge', '').some((e) => e.id.startsWith('binary_sensor.'))).toBe(false);
    expect(entitiesFor(HA_ENTITIES, 'clock', '')).toEqual([]);
  });
  it('matches / cleanLabel', () => {
    expect(matches('out temp', 'Outdoor temperature')).toBe(true);
    expect(matches('xyz', 'Outdoor')).toBe(false);
    expect(cleanLabel(' Door: {front}, back ')).toBe('Door front back');
  });
  it('cleanLabel keeps the space being typed (issue #80)', () => {
    let v = '';
    for (const ch of 'Batterij %') v = cleanLabel(v + ch, true);   // controlled input: cleaned on every keystroke
    expect(v).toBe('Batterij %');
    expect(cleanLabel('Température café ', true)).toBe('Température café ');
    expect(cleanLabel(' Batterij % ')).toBe('Batterij %');   // trimmed once editing ends
  });
  it('list picks (#127): toggled in pick order, empty = key removed, YAML round trip', () => {
    let ws: Widget[] = [{ type: 'lightList', cs: 4, rs: 2 }];
    ws = togglePick(ws, 0, 'areas', 'kitchen'); ws = togglePick(ws, 0, 'entities', 'light.hall_stairs'); ws = togglePick(ws, 0, 'areas', 'living');
    expect(ws[0]).toEqual({ type: 'lightList', cs: 4, rs: 2, areas: 'kitchen living', entities: 'light.hall_stairs' });
    const cfg = defaultConfig(); cfg.screens[0].widgets = ws;
    expect(parseYaml(toYaml(cfg)).screens[0].widgets[0]).toEqual(ws[0]);
    expect(togglePick(ws, 0, 'entities', 'light.hall_stairs')[0].entities).toBeUndefined();
    expect(clearPicks(ws, 0)[0]).toEqual({ type: 'lightList', cs: 4, rs: 2 });
  });
  it('list picker rows: lights by area (registry order, picked area marks its lights), climate flat, search', () => {
    const areas = ROOMS.map(([id, name]) => ({ id, name }));
    const g = pickGroups(HA_ENTITIES, areas, { type: 'lightList', areas: 'kitchen', entities: 'light.hall_stairs' }, '', 'No area');
    expect(g.map((x) => x.area)).toEqual(['living', 'kitchen', 'dining', 'hall', 'bedroom', 'office', 'garden']);
    expect(g[1]).toMatchObject({ name: 'Kitchen', on: true }); expect(g[1].rows.every((r) => r.on && r.viaArea)).toBe(true);
    expect(g[3].rows.find((r) => r.id === 'light.hall_stairs')).toMatchObject({ on: true, viaArea: false });
    expect(pickGroups(HA_ENTITIES, areas, { type: 'lightList' }, 'garden', '').map((x) => x.rows.length)).toEqual([2]);   // area name hit keeps its lights
    const z = pickGroups(HA_ENTITIES, areas, { type: 'zoneList', entities: 'climate.office' }, '', '');
    expect(z).toHaveLength(1); expect(z[0].rows.find((r) => r.id === 'climate.office')!.on).toBe(true);
    expect(pickGroups([{ id: 'light.x', name: 'X', unit: '' }], areas, { type: 'lightList' }, '', 'No area')).toEqual([{ area: '', name: 'No area', on: false, rows: [{ id: 'light.x', name: 'X', on: false, viaArea: false }] }]);
  });
  it('capHides (#134): only an unpicked list the subscription cap cuts short', () => {
    const lists = { climate: { total: 14, shown: 14 }, lights: { total: 149, shown: 66 } };
    expect(capHides({ type: 'lightList' }, lists)).toEqual([66, 149]);
    expect(capHides({ type: 'lightList', areas: 'kitchen' }, lists)).toBeNull();
    expect(capHides({ type: 'zoneList' }, lists)).toBeNull();
    expect(capHides({ type: 'zoneList' }, { ...lists, climate: { total: 90, shown: 80 } })).toEqual([80, 90]);
    expect(capHides({ type: 'lightList' }, undefined)).toBeNull();
    expect(capHides({ type: 'stat' }, lists)).toBeNull();
  });
  it('thermo zone picker (#148): climate entities, the pick writes the object id to zone:', () => {
    expect(pickDomains('thermo')).toEqual(['climate']);
    expect(entitiesFor(HA_ENTITIES, 'thermo', 'office').map((e) => e.id)).toEqual(['climate.office']);
    const ws: Widget[] = [{ type: 'thermo', rs: 2 }];
    expect(entityIssue(ws[0], HA_ENTITIES)).toEqual({ msg: 'Pick an entity below.', hard: true });
    const picked = setTileEntity(ws, 0, 'climate.office');
    expect(picked[0]).toEqual({ type: 'thermo', rs: 2, zone: 'office' });
    expect(pickedEntity(picked[0])).toBe('climate.office');
    expect(entityIssue(picked[0], HA_ENTITIES)).toBeNull();
    expect(entityIssue({ type: 'thermo', zone: 'cellar' }, HA_ENTITIES)?.hard).toBe(false);
    expect(ws[0].zone).toBeUndefined();   // input untouched
    expect(parseYaml(toYaml({ ...defaultConfig(), screens: [{ id: 'a', app: 'home', title: 'A', widgets: picked }] })).screens[0].widgets[0]).toEqual(picked[0]);
  });
  it('bars series (#148) and label fields on price / bars / thermo', () => {
    expect(setBarsSeries([{ type: 'bars', series: 'prices', cs: 4 }], 0, 'solar')[0]).toEqual({ type: 'bars', series: 'solar', cs: 4 });
    expect(['price', 'bars', 'thermo', 'gauge', 'stat', 'route'].every(hasLabelField)).toBe(true);
    expect(['clock', 'zoneList', 'lightList'].some(hasLabelField)).toBe(false);
  });
  it('history tile (#267): numeric entities, bucket choices per window, a new window drops a bucket that no longer fits', () => {
    const list = [...HA_ENTITIES, { id: 'sensor.weather_text', name: 'Weather', unit: '', state: 'sunny' }];
    const ids = entitiesFor(list, 'history', '').map((e) => e.id);
    expect(ids).toContain('sensor.outdoor_temperature'); expect(ids).toContain('input_number.target_temp');
    expect(ids).not.toContain('sensor.weather_text'); expect(ids).not.toContain('switch.coffee_machine');
    expect(rankEntities(list, 'history', 'outdoor temp')[0].id).toBe('sensor.outdoor_temperature');
    expect(bucketsFor('1h')).toEqual(['1m', '5m', '10m', '15m', '30m']);
    expect(bucketsFor('7d')).toEqual(['2h', '3h', '6h', '12h', '1d']);
    let ws: Widget[] = [{ type: 'history', entity: 'sensor.outdoor_temperature', cs: 4 }];
    ws = setHistoryKey(ws, 0, 'window', '1h'); ws = setHistoryKey(ws, 0, 'bucket', '1m');
    expect(ws[0]).toMatchObject({ window: '1h', bucket: '1m' });
    ws = setHistoryKey(ws, 0, 'window', '7d');
    expect(ws[0].bucket).toBeUndefined();
    expect(historyIssue(ws[0])).toBeNull();
    ws = setHistoryKey(setHistoryKey(ws, 0, 'min', '30'), 0, 'max', '-5');
    expect(historyIssue(ws[0])).toEqual({ msg: 'min must be below max', hard: true });
    const cfg = { ...defaultConfig(), screens: [{ id: 'a', app: 'home', title: 'A', widgets: ws }] };
    expect(firstIssue(cfg, list)).toEqual({ screen: 0, tile: 0, msg: 'min must be below max' });
    ws = setHistoryKey(ws, 0, 'max', ''); expect(ws[0].max).toBeUndefined(); expect(historyIssue(ws[0])).toBeNull();
    expect(parseYaml(toYaml({ ...cfg, screens: [{ ...cfg.screens[0], widgets: ws }] })).screens[0].widgets[0]).toEqual({ ...ws[0], min: 30 });   // the dialect reads a bare integer as a number
  });
  it('presetHasAway (#148): a list or its JSON text', () => {
    expect(presetHasAway(['home', 'away'])).toBe(true);
    expect(presetHasAway('["none","away"]')).toBe(true);
    expect(presetHasAway(['none', 'eco'])).toBe(false);
    expect(presetHasAway(undefined)).toBe(false);
    expect(presetHasAway('away')).toBe(false);
  });
});
