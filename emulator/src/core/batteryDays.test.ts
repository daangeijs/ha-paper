import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAYS_CAP, anchorStep, battDaysLine, battEstimate, modelPctPerDay } from './batteryDays.ts';
import { batteryDaysVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'battery-days.json');

describe('battery days left (ha-paper#30, glance sleep face)', () => {
  it('battery-days.json is in sync', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(batteryDaysVectors());
  });
  it('the model alone gives a number from the first sleep', () => {
    const e = battEstimate(64, false, null, 1_762_000_000, modelPctPerDay(0, 0));
    expect(e.days).toBeGreaterThan(1);
    expect(battDaysLine('en', e)).toBe('Battery 64% · about ' + e.days + ' days left');
  });
  it('the measurement takes over as points drop', () => {
    const T = 1_762_000_000, m = modelPctPerDay(0, 0);
    const a = anchorStep(null, 80, false, T - 10 * 86400);
    const e = battEstimate(60, false, a, T, m);
    expect(e.weight).toBe(1);
    expect(e.days).toBe(30);
  });
  it('never under 1, never over the cap', () => {
    for (const pct of [0, 1, 50, 100]) for (const drop of [0, 1, 30]) {
      const e = battEstimate(pct, false, { epoch: 1_762_000_000 - 86400, pct: pct + drop }, 1_762_000_000, 1);
      expect(e.days).toBeGreaterThanOrEqual(1);
      expect(e.days).toBeLessThanOrEqual(DAYS_CAP + 1);
    }
  });
});
