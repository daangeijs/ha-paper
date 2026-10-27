import { describe, expect, it } from 'vitest';
import { hourlyStatistics, localDay, SOLAR_HOURLY, statsDayRoll, USAGE_HOURLY } from './energyHourly.ts';
import { metersOf } from './energyPrefs.ts';

const H = 3600000, MID = Date.UTC(2026, 9, 27, 23);   // 2026-10-28 00:00 CET (tz +60)
const m = metersOf({ energy_sources: [{ type: 'solar', stat_energy_from: 'sensor.pv' }, { type: 'grid', stat_energy_from: 'sensor.imp' }] });
const rows = (from: number, xs: number[]) => xs.map((change, k) => ({ start: from + k * H, change }));

describe('energy hourly (#308)', () => {
  it('drops rows of another local day', () => {
    const out = hourlyStatistics({ 'sensor.pv': rows(MID - 2 * H, [1, 1, 0.5]), 'sensor.imp': rows(MID - 2 * H, [2, 2, 0.25]) }, m, MID + 1.5 * H, 60);
    expect(out[SOLAR_HOURLY].today?.[0]).toBe(0.5);
    expect(out[USAGE_HOURLY].state).toBe(0.75);
    expect(out[SOLAR_HOURLY].today?.slice(1).every((x) => x === 0)).toBe(true);
  });
  it('an answer that crossed midnight is all zero', () => {
    const out = hourlyStatistics({ 'sensor.pv': rows(MID - 2 * H, [1, 1]) }, m, MID + 10000, 60);
    expect(out['sensor.solar_today'].state).toBe(0);
  });
  it('rolls at local midnight, not UTC midnight, and only with an answer', () => {
    const owned = [SOLAR_HOURLY, 'sensor.solar_today'];
    expect(statsDayRoll(localDay(MID - H, 60), owned, MID - 1000, 60).roll).toBe(false);
    const r = statsDayRoll(localDay(MID - H, 60), owned, MID + 1000, 60);
    expect(r.roll).toBe(true);
    expect(r.out[SOLAR_HOURLY]).toEqual({ state: 0, today: Array(24).fill(0) });
    expect(r.out['sensor.solar_today']).toEqual({ state: 0 });
    expect(statsDayRoll(localDay(MID + 0.5 * H, 60), owned, MID + 1.2 * H, 60).roll).toBe(false);
    expect(statsDayRoll(null, owned, MID + 1000, 60).roll).toBe(false);
  });
});
