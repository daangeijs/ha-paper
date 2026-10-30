// Bin day tile (#317): demo bin sensors (data.ts DEMO_BINS) through the display, both looks, the console editor.
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Emulator, type EmuState } from './Emulator.tsx';
import { HA_ENTITIES } from '../core/data.ts';
import { binRows, setBinLabel, toggleBin } from '../webconsole/binsEdit.ts';

const W = [
  { type: 'bins', entities: 'sensor.afval_papier sensor.afval_pmd sensor.waste_gft', labels: 'sensor.afval_papier=Paper; sensor.afval_pmd=Plastic', cs: 2 },
  { type: 'bins', entities: 'sensor.waste_gft' },
  { type: 'bins' },
];
function at(hour: number, look: 'classic' | 'geist', lang: 'en' | 'nl' = 'en') {
  const e = new Emulator({});
  const base = e.state;
  (e as any).state = { ...base, mode: 'main', setup: null, offline: false, simHour: hour, haLang: lang, wifi: { ...base.wifi, connected: 'HomeNet' }, ha: { ...base.ha, linked: true },
    screens: [{ id: 'bins', app: 'home', title: 'Bins', widgets: W }, ...base.screens.filter((s) => s.app === 'settings')], idx: 0, sub: 0,
    cfg: { ...base.cfg, ...(look === 'classic' ? { style: 'classic' } : { style: 'sleek', typeface: look }) } as EmuState['cfg'] };
  const h = renderToString(e.render());
  return { h: h.slice(h.indexOf('data-x4-screen')), vals: e.tileValues('bins')! };
}

describe('bins tile renders (#317)', () => {
  for (const look of ['classic', 'geist'] as const) it(look + ': tonight from 17:00, tomorrow before, 1-wide, no sensors', () => {
    const eve = at(19, look);
    expect(eve.h).toContain('data-x4-pill'); expect(eve.h).toContain('Tonight'); expect(eve.h).toContain('put out tonight');
    expect(eve.h).toContain('in 7 days'); expect(eve.h).toContain('Pick bin sensors in the browser');
    expect(eve.vals.slice(0, 2)).toEqual(['Paper · Tomorrow', 'GFT · in 7 days']);
    const noon = at(13, look);
    expect(noon.h).not.toContain('data-x4-pill'); expect(noon.h).toContain('Tomorrow · ');
    expect(at(19, look, 'nl').h).toContain('vanavond buiten zetten');
  });
});

describe('bins console editor (#317)', () => {
  it('lists likely bins first, ticks, names, unticks', () => {
    const rows = binRows(HA_ENTITIES, { type: 'bins' }, '');
    expect(rows.slice(0, 4).map((r) => r.id)).toEqual(['sensor.afval_papier', 'sensor.afval_pmd', 'sensor.waste_gft', 'sensor.waste_restafval']);
    let ws = toggleBin([{ type: 'bins' }], 0, 'sensor.waste_gft');
    ws = toggleBin(ws, 0, 'sensor.afval_papier');
    ws = setBinLabel(ws, 0, 'sensor.afval_papier', 'Paper; old=1, x');
    ws = setBinLabel(ws, 0, 'sensor.waste_gft', 'Green');
    expect(ws[0]).toEqual({ type: 'bins', entities: 'sensor.waste_gft sensor.afval_papier', labels: 'sensor.waste_gft=Green; sensor.afval_papier=Paper old 1 x' });
    expect(binRows(HA_ENTITIES, ws[0], '')[0]).toMatchObject({ id: 'sensor.waste_gft', on: true, label: 'Green' });
    ws = toggleBin(ws, 0, 'sensor.waste_gft');
    expect(ws[0]).toEqual({ type: 'bins', entities: 'sensor.afval_papier', labels: 'sensor.afval_papier=Paper old 1 x' });
  });
});
