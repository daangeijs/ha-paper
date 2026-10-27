import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LIGHT_TIMEOUT, LIGHT_TIMEOUTS, frontlightPct, lightTimedOut, lightWakeConsumes } from './frontlight.ts';

type L = { brightness: number; standby: boolean; lightOut: boolean };
const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'frontlight.json'), 'utf8')) as {
  timeouts: number[]; default: number;
  timedOut: { idleMs: number; timeoutSec: number; expect: boolean }[];
  level: (L & { expect: number })[];
  consume: (L & { quiet: boolean; power: boolean; expect: boolean })[];
};

describe('front light timeout (spec/test-vectors/frontlight.json)', () => {
  it('choices and default', () => { expect(v.timeouts).toEqual(LIGHT_TIMEOUTS); expect(v.default).toBe(DEFAULT_LIGHT_TIMEOUT); });
  for (const c of v.timedOut) it('timedOut ' + JSON.stringify(c), () => expect(lightTimedOut(c.idleMs, c.timeoutSec)).toBe(c.expect));
  for (const c of v.level) it('level ' + JSON.stringify(c), () => expect(frontlightPct(c)).toBe(c.expect));
  for (const c of v.consume) it('consume ' + JSON.stringify(c), () => expect(lightWakeConsumes(c)).toBe(c.expect));
});
