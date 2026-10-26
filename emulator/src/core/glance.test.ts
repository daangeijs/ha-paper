import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armBootsLeft, armCount, armFor, glanceStep, liveNow, sleptSeconds, snapshotDiff, snapshotOf, tallyGlance, tallySleep, tallyWake, wifiFast, TALLY_ZERO, type ArmRecord, type GlanceIn, type GlanceOut, type Snapshot, type WakeTally, type WifiCache, type WifiFast } from './glance.ts';
import { glanceWaitS } from './power.ts';

type V = {
  snapshotDiff: { name: string; prev: Snapshot | null; next: Snapshot; ignore: string[]; changed: string[] }[];
  glanceStep: { name: string; in: GlanceIn; out: GlanceOut }[];
  wifiFast: { name: string; cache: WifiCache; saved: number; now: number; fast: WifiFast }[];
  liveNow: { name: string; msSinceInput: number | null; liveMin: number; live: boolean }[];
  arm: { name: string; stored: ArmRecord | null; version: string; ops: number; boots: number; left: number }[];
  tally: { name: string; ops: [string, ...any[]][]; expect: WakeTally }[];
};
const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'glance.json'), 'utf8')) as V;

describe('glance (spec/test-vectors/glance.json)', () => {
  for (const c of v.snapshotDiff) it('snapshotDiff: ' + c.name, () => expect(snapshotDiff(c.prev, c.next, c.ignore)).toEqual(c.changed));
  for (const c of v.glanceStep) it('glanceStep: ' + c.name, () => expect(glanceStep(c.in)).toEqual(c.out));
  for (const c of v.wifiFast) it('wifiFast: ' + c.name, () => expect(wifiFast(c.cache, c.saved, c.now)).toBe(c.fast));
  for (const c of v.liveNow) it('liveNow: ' + c.name, () => expect(liveNow(c.msSinceInput, c.liveMin)).toBe(c.live));
  for (const c of v.arm) it('arm: ' + c.name, () => {
    let r = armFor(c.stored, c.version);
    for (let n = 0; n < c.ops; n++) r = armCount(r);
    expect(r).toEqual({ version: c.version, boots: c.boots }); expect(armBootsLeft(r)).toBe(c.left);
  });
  for (const c of v.tally) it('tally: ' + c.name, () => {
    let t = TALLY_ZERO;
    for (const o of c.ops) t = o[0] === 'wake' ? tallyWake(t, sleptSeconds(o[1], o[2], o[3])) : o[0] === 'glance' ? tallyGlance(t, o[1], o[2], o[3], o[4], o[5]) : tallySleep(t, o[1], o[2], o[3]);
    expect(t).toEqual(c.expect);
  });
  it('snapshotOf hashes region text; equal text = equal hash', () => {
    const a = snapshotOf({ t0: '{"v":1}', t1: '{"v":2}' }), b = snapshotOf({ t0: '{"v":1}', t1: '{"v":3}' });
    expect(snapshotDiff(a, b)).toEqual(['t1']);
  });
  it('glanceWaitS doubles per failure, 2 h cap', () => {
    expect([0, 1, 2, 3, 4, 9].map((f) => glanceWaitS(15, f))).toEqual([900, 1800, 3600, 7200, 7200, 7200]);
  });
});
