import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armBootsLeft, armCount, armedBy, armFor, armUptime, earlyWake, glanceStep, liveNow, sleptSeconds, snapshotDiff, snapshotOf, tallyGlance, tallySleep, tallyWake, timerPpm, timerSeconds, wifiFast, TALLY_ZERO, type ArmRecord, type GlanceIn, type GlanceOut, type Snapshot, type WakeTally, type WifiCache, type WifiFast } from './glance.ts';
import { glanceWaitS } from './power.ts';

type V = {
  snapshotDiff: { name: string; prev: Snapshot | null; next: Snapshot; ignore: string[]; changed: string[] }[];
  glanceStep: { name: string; in: GlanceIn; out: GlanceOut }[];
  wifiFast: { name: string; cache: WifiCache; saved: number; now: number; fast: WifiFast }[];
  liveNow: { name: string; msSinceInput: number | null; liveMin: number; live: boolean }[];
  arm: { name: string; stored: Partial<ArmRecord> | null; version: string; ops: number; up?: [number, boolean]; boots: number; uptime: boolean; left: number; by: 'uptime' | 'boots' | null }[];
  tally: { name: string; ops: [string, ...any[]][]; expect: WakeTally }[];
  timer: {
    ppm: { name: string; prev: number; programmedS: number; realS: number; ppm: number }[];
    seconds: { name: string; realS: number; ppm: number; seconds: number }[];
    early: { name: string; wakeAt: number; now: number; early: 'go' | 'wait' | 'sleep' }[];
  };
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
    if (c.up) r = armUptime(r, c.up[0], c.up[1]);
    expect(r).toEqual({ version: c.version, boots: c.boots, uptime: c.uptime }); expect(armBootsLeft(r)).toBe(c.left); expect(armedBy(r)).toBe(c.by);
  });
  for (const c of v.tally) it('tally: ' + c.name, () => {
    let t = TALLY_ZERO;
    for (const o of c.ops) t = o[0] === 'wake' ? tallyWake(t, sleptSeconds(o[1], o[2], o[3])) : o[0] === 'glance' ? tallyGlance(t, o[1], o[2], o[3], o[4], o[5]) : tallySleep(t, o[1], o[2], o[3]);
    expect(t).toEqual(c.expect);
  });
  for (const c of v.timer.ppm) it('timerPpm: ' + c.name, () => expect(timerPpm(c.prev, c.programmedS, c.realS)).toBe(c.ppm));
  for (const c of v.timer.seconds) it('timerSeconds: ' + c.name, () => expect(timerSeconds(c.realS, c.ppm)).toBe(c.seconds));
  for (const c of v.timer.early) it('earlyWake: ' + c.name, () => expect(earlyWake(c.wakeAt, c.now)).toBe(c.early));
  it('snapshotOf hashes region text; equal text = equal hash', () => {
    const a = snapshotOf({ t0: '{"v":1}', t1: '{"v":2}' }), b = snapshotOf({ t0: '{"v":1}', t1: '{"v":3}' });
    expect(snapshotDiff(a, b)).toEqual(['t1']);
  });
  it('glanceWaitS: the next of midnight and the start of quiet hours (eink-ha-os#356)', () => {
    expect([[43200, 'off'], [43200, '23-07'], [82200, '23-07'], [3600, '23-07'], [72000, '00-06'], [0, 'off']].map(([t, q]) => glanceWaitS(t as number, q as string)))
      .toEqual([43200, 39600, 600, 79200, 14400, 86400]);
  });
});
