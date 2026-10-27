import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_QUIET, PEEK_MS, QUIET_STEPS, inQuietHours, peekOnBoot, quietBackAt, quietTiles, type WakeKind } from './quiet.ts';

const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'quiet.json'), 'utf8')) as {
  steps: string[]; default: string; peekMs: number;
  inWindow: { hour: number; window: string; expect: boolean }[];
  backAt: { window: string; clock: string; expect: string }[];
  tiles: { name: string; types: string[]; expect: number[] }[];
  peekOnBoot: { wake: WakeKind; expect: boolean }[];
};

describe('quiet hours (spec/test-vectors/quiet.json)', () => {
  it('steps, default, peek', () => { expect(v.steps).toEqual(QUIET_STEPS); expect(v.default).toBe(DEFAULT_QUIET); expect(v.peekMs).toBe(PEEK_MS); });
  for (const c of v.inWindow) it('inWindow ' + JSON.stringify(c), () => expect(inQuietHours(c.hour, c.window)).toBe(c.expect));
  for (const c of v.backAt) it('backAt ' + JSON.stringify(c), () => expect(quietBackAt(c.window, c.clock)).toBe(c.expect));
  for (const c of v.tiles) it('tiles: ' + c.name, () => expect(quietTiles(c.types)).toEqual(c.expect));
  for (const c of v.peekOnBoot) it('peekOnBoot ' + c.wake, () => expect(peekOnBoot(c.wake)).toBe(c.expect));
});
