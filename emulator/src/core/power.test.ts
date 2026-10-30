import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { batteryLabel, CPU_MHZ, powerDecision, powerSource, secsUntil, sleepNowCheck, MAX_SLEEP_S, type PowerInputs, type SleepNowCheck } from './power.ts';

const dir = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'power');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

describe('powerDecision (spec/test-vectors/power)', () => {
  it('has vectors', () => { expect(files.length).toBeGreaterThanOrEqual(8); });
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { base: PowerInputs; cases: { name: string; input: Partial<PowerInputs>; expect: object }[] };
    describe(f, () => {
      for (const c of v.cases) it(c.name, () => {
        const i = { ...v.base, ...c.input };
        const d = powerDecision(i);
        expect(d).toMatchObject(c.expect);
        // invariants: a timer wake is always armed (≤ 8 h, in the future) unless only a button/charger may wake it
        if (d.deepSleepNow && !d.buttonWakeOnly) { expect(d.wakeAtEpoch! - i.nowEpoch).toBeGreaterThan(0); expect(d.wakeAtEpoch! - i.nowEpoch).toBeLessThanOrEqual(MAX_SLEEP_S); }
        if (i.otaPendingVerify || i.otaBusy || d.external || i.battery === null) expect(d.deepSleepNow).toBe(false);
      });
    });
  }
  it('secsUntil wraps midnight; same second = a full day', () => {
    expect(secsUntil(23 * 3600, 7 * 3600)).toBe(8 * 3600);
    expect(secsUntil(3 * 3600, 3 * 3600)).toBe(86400);
  });
});

describe('CPU_MHZ (eink-ha-os#177)', () => {
  it('full = 240 MHz, auto = 80 MHz (APB stays 80 MHz)', () => expect(CPU_MHZ).toEqual({ full: 240, auto: 80 }));
});

describe('powerSource / batteryLabel (spec/test-vectors/battery-label.json)', () => {
  const v = JSON.parse(readFileSync(join(dir, '..', 'battery-label.json'), 'utf8')) as { cases: { name: string; pct: number; charging: boolean; usb: boolean; source: string; label: string }[] };
  for (const c of v.cases) it(c.name, () => {
    expect(powerSource(c.charging, c.usb)).toBe(c.source);
    expect(batteryLabel(c.pct, c.charging, c.usb)).toBe(c.label);
  });
});

describe('sleepNowCheck (spec/test-vectors/sleep-now.json)', () => {
  const v = JSON.parse(readFileSync(join(dir, '..', 'sleep-now.json'), 'utf8')) as { base: PowerInputs; cases: { name: string; seconds: unknown; input: Partial<PowerInputs>; expect: SleepNowCheck }[] };
  for (const c of v.cases) it(c.name, () => expect(sleepNowCheck(c.seconds, { ...v.base, ...c.input })).toEqual(c.expect));
});
