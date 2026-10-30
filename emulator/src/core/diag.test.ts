import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagPush, diagTouch, lastCrash, isCrash } from './diag.ts';
import { diagVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'diag.json');

describe('boot / crash ring (GET /diagnostics)', () => {
  it('newest first, 8 kept, touch only changes the running boot', () => {
    let r = diagPush([], 'POWERON', '0.3.0', null);
    for (let i = 0; i < 9; i++) r = diagPush(r, 'SW', '0.3.0', null);
    expect(r.length).toBe(8);
    r = diagTouch(r, 42, 1000, 0);
    expect(r[0].uptime_s).toBe(42); expect(r[0].last_seen).toBeNull(); expect(r[1].uptime_s).toBe(0);
  });
  it('last crash = the boot that crashed (the one before the crash reset)', () => {
    let r = diagTouch(diagPush([], 'POWERON', '0.3.0', null), 3600, 1, 1760000000);
    r = diagPush(r, 'PANIC', '0.3.0', 'boom');
    expect(lastCrash(r)).toEqual({ reason: 'PANIC', panic: 'boom', version: '0.3.0', uptime_s: 3600, last_seen: 1760000000 });
    expect(['PANIC', 'INT_WDT', 'TASK_WDT', 'WDT', 'BROWNOUT', 'CPU_LOCKUP'].every(isCrash)).toBe(true);
    expect(['POWERON', 'SW', 'EXT', 'DEEPSLEEP'].some(isCrash)).toBe(false);
  });
  it('hw: the raw reset cause is kept next to the IDF reason; it never changes crash (eink-ha-os#241)', () => {
    const r = diagPush(diagPush([], 'POWERON', '0.3.0', null), 'TASK_WDT', '0.3.0', null, 'CORE_MWDT0');
    expect(r[0].hw).toBe('CORE_MWDT0'); expect(r[1].hw).toBeNull(); expect(lastCrash(r)?.reason).toBe('TASK_WDT');
  });
  it('diag.json is in sync', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(diagVectors());
  });
});
