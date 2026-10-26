import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AMBIENT_MS, BATT_LOW, STALE_MS, ambientDue, chromeFor, nightStale, type Chrome } from './ambient.ts';

const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'ambient.json'), 'utf8')) as {
  ambient_ms: number; batt_low: number; stale_s: number;
  due: { idleMs: number; menu: boolean; setup: boolean; expect: boolean }[];
  chrome: { ambient: boolean; battery: number; clockTile: boolean; expect: Chrome }[];
  stale: { nowSec: number; lastDataSec: number; expect: boolean }[];
};

describe('ambient idle mode (spec/test-vectors/ambient.json)', () => {
  it('constants', () => { expect(v.ambient_ms).toBe(AMBIENT_MS); expect(v.batt_low).toBe(BATT_LOW); expect(v.stale_s * 1000).toBe(STALE_MS); });
  for (const c of v.due) it('due ' + JSON.stringify(c), () => expect(ambientDue(c)).toBe(c.expect));
  for (const c of v.chrome) it('chrome ' + JSON.stringify(c), () => expect(chromeFor(c.ambient, c.battery, c.clockTile)).toEqual(c.expect));
  for (const c of v.stale) it('stale ' + JSON.stringify(c), () => expect(nightStale(c.nowSec * 1000, c.lastDataSec ? c.lastDataSec * 1000 : null)).toBe(c.expect));
});
