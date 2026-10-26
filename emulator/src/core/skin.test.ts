// skin(): the display-style layer over vm(). Classic adds only bg/fg/radius; Sleek swaps isX → sX and adds card data.
import { describe, it, expect } from 'vitest';
import { skin, lookOf, SURF, SK_ICON } from './skin.ts';
import { PAPER, INK, PRICES } from './data.ts';
import { TRACK, HATCH } from './panel.ts';

const base = { border: '2px solid #111', isGhost: false, cs: 1, rs: 1, isStat: false, isClock: false, isPrice: false, isGauge: false, isBars: false, isThermo: false,
  isZoneList: false, isLightList: false, isLight: false, isScene: false, isSetting: false, isRoute: false };

describe('skin()', () => {
  it('Classic adds only bg, fg and radius', () => {
    const v = { ...base, isStat: true, label: 'Solar', value: '2.4', unit: 'kW', sub: '' };
    const o = skin(v, 'classic', 13, 0);
    expect(Object.keys(o).filter((k) => !(k in v)).sort()).toEqual(['bg', 'fg', 'radius']);
    expect(o).toMatchObject({ ...v, bg: PAPER, fg: INK, radius: 10 });
  });
  it('is pure: the view model is not mutated', () => {
    const v = { ...base, isZoneList: true, rows: [{ key: 'z:a', heating: true }] };
    const copy = JSON.parse(JSON.stringify(v));
    skin(v, 'archivo', 13, 0);
    expect(v).toEqual(copy);
  });
  it('Sleek swaps every redesigned isX flag for sX; other widgets keep Classic + surface card', () => {
    for (const [is, s] of [['isStat', 'sStat'], ['isClock', 'sClock'], ['isPrice', 'sPrice'], ['isGauge', 'sGauge'], ['isBars', 'sBars'], ['isThermo', 'sThermo'],
      ['isZoneList', 'sZones'], ['isLightList', 'sLights'], ['isLight', 'sLight'], ['isScene', 'sScene'], ['isSetting', 'sSetting']]) {
      const o = skin({ ...base, [is]: true, rows: [], value: '1', set: '20', pct: 50, label: 'x', tag: 'NORMAL' }, 'geist', 13, 0);
      expect(o[is], is).toBe(false); expect(o[s], s).toBe(true);
    }
    const route = skin({ ...base, isRoute: true }, 'bricolage', 13, 0);
    expect(route).toMatchObject({ isRoute: true, bg: SURF, radius: 20, border: '0px solid transparent' });
    expect(skin({ ...base, isGhost: true, border: '2px dotted #111' }, 'archivo', 13, 0)).toMatchObject({ bg: 'transparent', border: '2px dotted #111' });
  });
  it('stat: icon by label, value size by length, spark bars for solar/usage only', () => {
    const o = skin({ ...base, isStat: true, label: 'Solar', value: '2.4' }, 'archivo', 13, 0);
    expect(o.icon).toBe(SK_ICON.Solar); expect(o.vs).toBe(62); expect(o.hasSpark).toBe(true); expect(o.spark).toHaveLength(24);
    expect(o.spark[13].c).toBe(INK); expect(o.spark[12].c).toBe(HATCH); expect(o.spark[14].c).toBe(TRACK);
    expect(o.spark.every((b: any) => b.h >= 8)).toBe(true);
    const g = skin({ ...base, isStat: true, label: 'Grid', value: '-1.25' }, 'archivo', 13, 0);
    expect(g.hasSpark).toBe(false); expect(g.vs).toBe(48); expect(skin({ ...base, isStat: true, label: '?', value: 'x' }, 'archivo', 0, 0).icon).toBe(SK_ICON._);
  });
  it('clock, price, gauge, thermo, lists, light, scene', () => {
    expect(skin({ ...base, isClock: true, rs: 2 }, 'archivo', 12, 0)).toMatchObject({ bg: INK, fg: PAPER, dayPct: 50, big: 150 });
    const p = skin({ ...base, isPrice: true, tag: 'HIGH' }, 'archivo', 18, 0);
    expect(p).toMatchObject({ chip: 'High', chipBg: INK, chipFg: PAPER });
    expect(p.cells[18]).toEqual({ c: INK, hh: 26 });
    expect(p.cells[PRICES.indexOf(Math.min(...PRICES))].c).toBe(PAPER);
    expect(skin({ ...base, isGauge: true, pct: 50 }, 'archivo', 0, 0).dash).toBe('144.5');
    expect(skin({ ...base, isThermo: true, value: '26,0', set: '14,0', curN: 26, setN: 14 }, 'archivo', 0, 0)).toMatchObject({ arc: '207.3' });
    const z = skin({ ...base, isZoneList: true, rows: [{ heating: true }, { heating: false }] }, 'archivo', 0, 0);
    expect(z).toMatchObject({ bg: PAPER, radius: 0 }); expect(z.rows[0].cbg).toBe(INK); expect(z.rows[1].cbg).toBe(SURF);
    const l = skin({ ...base, isLightList: true, rows: [{ isHeader: true }, { isLight: true, value: '70%' }, { isLight: true, value: 'Off' }] }, 'archivo', 0, 0);
    expect(l.rows[0]).toEqual({ isHeader: true }); expect(l.rows[1]).toMatchObject({ chipBg: INK, bw: 70 }); expect(l.rows[2]).toMatchObject({ chipBg: SURF, bw: 0 });
    expect(skin({ ...base, isLight: true, value: 'On' }, 'archivo', 0, 0)).toMatchObject({ bg: INK, fg: PAPER });
    expect(skin({ ...base, isScene: true }, 'archivo', 0, 0)).toMatchObject({ bg: INK, fg: PAPER });
  });
  it('lookOf maps the device settings onto the look', () => {
    expect(lookOf('classic', 'geist')).toBe('classic'); expect(lookOf('sleek', 'fraunces')).toBe('fraunces');
  });
});
