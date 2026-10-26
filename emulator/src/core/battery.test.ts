import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BATT_ZERO, battHistory, battStep } from './battery.ts';
import { batteryVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'battery-history.json');

describe('battery history (#231, GET /diagnostics battery)', () => {
  it('battery-history.json is in sync', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(batteryVectors());
  });
  it('USB unplugged logs at once, not only at the next sample', () => {
    const base = { epoch: 0, pct: 90, mv: 4100, chg: false, power: 'external power', rssi: -60 };
    let r = battStep(BATT_ZERO, { ...base, ms: 0, usb: true });
    r = battStep(r.s, { ...base, ms: 1000, usb: false });
    expect(r.log).toBe('90% 4100 mV · chg 0 · usb 0 · rssi -60');
    expect(battHistory(r.s).history.length).toBe(1);
  });
});
