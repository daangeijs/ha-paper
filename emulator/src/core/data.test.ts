import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENT, PRICES, CHEAP, type Derived } from './data.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'stat-sub.json');

describe('stat tile subtitle (spec/test-vectors/stat-sub.json)', () => {
  const v = JSON.parse(readFileSync(file, 'utf8')) as { data: Partial<Derived>; cases: { name: string; entity: string; data?: Partial<Derived>; sub: string }[] };
  it('has vectors', () => { expect(v.cases.length).toBeGreaterThanOrEqual(10); });
  for (const c of v.cases) it(c.name, () => {
    const d = { zones: {}, lights: {}, heatingCount: 0, ...v.data, ...c.data } as Derived;
    expect(ENT[c.entity].get(d).sub).toBe(c.sub);
  });
  it('cheapest window: the window average, not advice', () => {
    const avg = (PRICES[CHEAP] + PRICES[CHEAP + 1] + PRICES[CHEAP + 2]) / 3;
    expect(ENT['sensor.price_cheap_window'].get({} as Derived).sub).toBe('Avg €' + avg.toFixed(2));
  });
  it('one room heating is singular', () => {
    const d = { zones: { living: { cur: 20.5, set: 21 } }, heatingCount: 1 } as unknown as Derived;
    expect(ENT['sensor.living_temperature'].get(d).sub).toBe('1 room heating');
  });
});
