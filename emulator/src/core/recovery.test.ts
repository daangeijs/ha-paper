import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryInit, recoveryOffer, recoveryStep, crashStreak, isCrashLoop, RESET_HOLD_MS, RESET_CONFIRM_MS, RESTART_HOLD_MS,
  KEY_POWER, KEY_RIGHT, KEY_LEFT, KEY_OTHER } from './recovery.ts';

type Step = { t: number; keys: string; action: string; phase: string };
const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'recovery.json'), 'utf8')) as {
  hold_ms: number; confirm_ms: number; restart_hold_ms: number;
  cases: { name: string; offer?: number; steps: Step[] }[];
  crash_loops: { reasons: string[]; streak: number; loop: boolean }[];
};
const BIT: Record<string, number> = { P: KEY_POWER, R: KEY_RIGHT, L: KEY_LEFT, O: KEY_OTHER };
const bits = (k: string) => [...k].reduce((m, c) => m | BIT[c], 0);

describe('recovery (spec/test-vectors/recovery.json)', () => {
  it('timings', () => { expect(v.hold_ms).toBe(RESET_HOLD_MS); expect(v.confirm_ms).toBe(RESET_CONFIRM_MS);
    expect(v.restart_hold_ms).toBe(RESTART_HOLD_MS); });
  for (const c of v.cases) it(c.name, () => {
    let s = c.offer !== undefined ? recoveryOffer(c.offer) : recoveryInit();
    c.steps.forEach((st, i) => {
      const r = recoveryStep(s, st.t, bits(st.keys));
      expect({ i, action: r.action, phase: r.state.phase }).toEqual({ i, action: st.action, phase: st.phase });
      s = r.state;
    });
  });
  for (const c of v.crash_loops) it('crash loop ' + JSON.stringify(c.reasons), () => {
    expect(crashStreak(c.reasons)).toBe(c.streak);
    expect(isCrashLoop(c.reasons)).toBe(c.loop);
  });
});
