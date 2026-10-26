import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridFlows, statisticIds } from './energyPrefs.ts';
import { aliasesOf } from '../../server/device.ts';

const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'energy-prefs.json'), 'utf8')) as {
  cases: { name: string; prefs: { energy_sources: any[] }; grid: unknown[]; statistic_ids: string[]; sources: Record<string, string> }[];
};

describe('energy prefs, legacy and flat grid (spec/test-vectors/energy-prefs.json, #274)', () => {
  for (const c of v.cases) it(c.name, () => {
    expect(c.prefs.energy_sources.filter((s) => s?.type === 'grid').map(gridFlows)).toEqual(c.grid);
    expect(statisticIds(c.prefs)).toEqual(c.statistic_ids);
    const a = aliasesOf(c.prefs);
    for (const k of ['sensor.grid_power', 'sensor.energy_prices']) expect(a[k] ?? '').toBe(c.sources[k] ?? '');
  });
  it('flat and legacy name the same meters and price', () => {
    const legacy = gridFlows({ type: 'grid', flow_from: [{ stat_energy_from: 'sensor.a_in', entity_energy_price: 'sensor.p' }], flow_to: [{ stat_energy_to: 'sensor.a_out' }] });
    const flat = gridFlows({ type: 'grid', stat_energy_from: 'sensor.a_in', stat_energy_to: 'sensor.a_out', entity_energy_price: 'sensor.p' });
    expect(flat).toEqual(legacy);
  });
});
