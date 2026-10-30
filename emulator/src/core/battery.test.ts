import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BATT_ZERO, GAUGE_ZERO, battHistory, battStep, gaugeStep } from './battery.ts';
import { batteryVectors, gaugeFilterVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'battery-history.json');

describe('battery history (eink-ha-os#231, GET /diagnostics battery)', () => {
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

describe('gaugeStep (eink-ha-os#327)', () => {
  const run = (reads: [number, boolean][], s = GAUGE_ZERO) => reads.map(([r, c]) => (s = gaugeStep(s, r, c)).shown);
  it('never rises without a charger: the rest rebound is held', () => expect(run([[92, false], [94, false], [93, false], [92, false]])).toEqual([92, 92, 92, 92]));
  it('falls pass at once', () => expect(run([[92, false], [90, false], [91, false]])).toEqual([92, 90, 90]));
  it('follows the gauge while charging', () => expect(run([[50, false], [52, true], [51, true], [53, false]])).toEqual([50, 52, 51, 51]));
  it('a big rise confirmed 3 reads in a row is taken; a break restarts the count', () =>
    expect(run([[40, false], [80, false], [80, false], [42, false], [80, false], [80, false], [80, false]])).toEqual([40, 40, 40, 40, 40, 40, 80]));
  it('not read keeps the state', () => expect(gaugeStep({ shown: 70, rise: 2 }, -1, false)).toEqual({ shown: 70, rise: 2 }));
});

it('gauge-filter.json is in sync', () => {
  expect(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'gauge-filter.json'), 'utf8'))).toEqual(gaugeFilterVectors());
});
