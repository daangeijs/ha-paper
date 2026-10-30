import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MORNING_IDLE, MORNING_MS, morningStep, morningUp, morningView } from './morning.ts';
import { morningVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'morning.json');

describe('good morning page (eink-ha-os#330)', () => {
  it('spec/test-vectors/morning.json is current', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(morningVectors())));
  });
  it('goes up once at the end of the window, for 20 minutes', () => {
    const t = (h: number, m = 0) => Date.UTC(2026, 9, 29, h, m);
    const base = { clockKnown: true, quiet: '23-07', enabled: true };
    let s = morningStep(MORNING_IDLE, { ...base, now: t(6, 59), hour: 6 });
    expect([s.armed, s.start]).toEqual([true, false]);
    s = morningStep(s, { ...base, now: t(7), hour: 7 });
    expect([s.armed, s.start, s.until]).toEqual([false, true, t(7) + MORNING_MS]);
    expect(morningUp(s, t(7, 19))).toBe(true);
    s = morningStep(s, { ...base, now: t(7, 5), hour: 7 });
    expect(s.start).toBe(false);   // once
    s = morningStep(s, { ...base, now: t(7, 20), hour: 7 });
    expect([s.end, s.until, morningUp(s, t(7, 20))]).toEqual([true, 0, false]);
  });
  it('drops rows without a source', () => {
    const v = morningView({ now: Date.UTC(2026, 9, 29, 6), tz: 60, lang: 'en', daily: null, hourly: null, events: null, bins: null });
    expect(v).toEqual({ head: 'Good morning', date: 'Thursday 29 October', weather: null, events: [], more: '', bins: [] });
  });
});
