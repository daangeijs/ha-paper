import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyVectors } from '../../scripts/gen-vectors.ts';
import { validateYaml, toYaml, entityGaps } from './config.ts';
import { axisTicks, bucketize, chartSpan, dayLowHigh, defaultBucket, fromHistoryRows, fromStatistics, historyError, historySpec, lowHigh, parseSpan, resolveStyle, statsPeriod, statsType, yScale, type Point } from './history.ts';

const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 26, 14, 37);
const yaml = (...w: string[]) => '# HA Paper display config\nversion: 1\nscreens:\n  - id: a\n    widgets:\n' + w.map((x) => '      - {' + x + '}\n').join('');

describe('history vectors', () => {
  it('spec/test-vectors/history.json is in sync with the generator', () => {
    const disk = JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/history.json'), 'utf8'));
    expect(disk).toEqual(JSON.parse(JSON.stringify(historyVectors())));
  });
});

describe('history config', () => {
  it('parses spans with a unit only', () => {
    expect(parseSpan('30m')).toBe(30 * MIN);
    expect(parseSpan('7d')).toBe(7 * 24 * HOUR);
    expect(parseSpan(24)).toBeNull();
    expect(parseSpan('0h')).toBeNull();
    expect(parseSpan('1.5h')).toBeNull();
  });
  it('default bucket: ≤ 12 bars per column', () => {
    expect(defaultBucket(24 * HOUR, 4)).toBe(30 * MIN);
    expect(defaultBucket(24 * HOUR, 2)).toBe(HOUR);
    expect(defaultBucket(6 * HOUR, 4)).toBe(10 * MIN);
    expect(defaultBucket(7 * 24 * HOUR, 4)).toBe(6 * HOUR);
    expect(defaultBucket(97 * MIN, 1)).toBeNull();
  });
  it('accepts a full tile and keeps it through toYaml', () => {
    const r = validateYaml(yaml('type: history, entity: sensor.outdoor_temperature, window: 6h, bucket: 15m, agg: max, style: line, min: -5, max: 30.5, label: Outside, cs: 4'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(validateYaml(toYaml(r.config))).toEqual(r);
  });
  it('rejects bad keys with the tile line', () => {
    const bad = (w: string) => { const r = validateYaml(yaml('type: clock', w)); return r.ok ? 'ok' : r.line + ' ' + r.message; };
    expect(bad('type: history, entity: switch.pump')).toBe('7 history: “switch.pump” is not a sensor / input_number / number entity');
    expect(bad('type: history, entity: sensor.x, window: 12h, bucket: 5m')).toBe('7 history: 12h / 5m = 144 bars (2–96)');
    expect(bad('type: history, entity: sensor.x, max: -3, min: -2')).toBe('7 history: min must be below max');
  });
  it('allows 6 history tiles, not 7', () => {
    const six = Array.from({ length: 6 }, (_, i) => 'type: history, entity: sensor.s' + i);
    expect(validateYaml(yaml(...six)).ok).toBe(true);
    const r = validateYaml(yaml(...six, 'type: history, entity: sensor.s7'));
    expect(r).toEqual({ ok: false, line: 12, message: 'At most 6 history tiles' });
  });
  it('a history entity without a value is an entity gap', () => {
    expect(entityGaps([{ widgets: [{ type: 'history', entity: 'sensor.outdoor_temperature' }] }], () => 'unavailable')).toHaveProperty('sensor.outdoor_temperature');
  });
  it('fills defaults: auto style is a line for mean, bars otherwise', () => {
    expect(historySpec({ type: 'history', entity: 'sensor.x', cs: 4 })).toEqual({ entity: 'sensor.x', windowMs: 24 * HOUR, bucketMs: 30 * MIN, n: 48, agg: 'mean', style: 'line', min: null, max: null });
    expect(resolveStyle('change')).toBe('bars');
    expect(resolveStyle('mean', 'bars')).toBe('bars');
    expect(historyError({ entity: 'sensor.x', window: '7d', bucket: '1d' })).toBeNull();
  });
});

describe('history data', () => {
  const o = { windowMs: HOUR, bucketMs: 15 * MIN };   // span 14:00–15:00 UTC at tz 0 (open bucket 14:30–14:45)
  it('chooses the statistics period and type', () => {
    expect([1, 5, 30, 60, 360, 1440].map((m) => statsPeriod(m * MIN))).toEqual([null, '5minute', '5minute', 'hour', 'hour', 'day']);
    expect(statsType('last')).toBe('mean');
    expect(statsType('change')).toBe('change');
  });
  it('aligns buckets to local time', () => {
    expect(chartSpan(o, NOW, 0)).toEqual({ start: Date.UTC(2026, 9, 26, 13, 45), end: Date.UTC(2026, 9, 26, 14, 45) });
    expect(chartSpan({ windowMs: 24 * HOUR, bucketMs: HOUR }, NOW, 330).end).toBe(Date.UTC(2026, 9, 26, 15, 30));   // 20:07 local → bucket 20:00–21:00 local
  });
  it('weights the mean by time and carries the value in', () => {
    const s = chartSpan(o, NOW, 0).start;
    const pts: Point[] = [{ t: s - HOUR, v: 10 }, { t: s + 5 * MIN, v: 16 }, { t: s + 10 * MIN, v: null }, { t: s + 20 * MIN, v: 4 }];
    const mean = bucketize(pts, { ...o, agg: 'mean' }, NOW, 0).values;
    expect(mean[0]).toBeCloseTo((10 * 5 + 16 * 5) / 10);   // the gap does not count
    expect(mean[1]).toBe(4);
    expect(bucketize(pts, { ...o, agg: 'min' }, NOW, 0).values[1]).toBe(4);
    expect(bucketize(pts, { ...o, agg: 'max' }, NOW, 0).values[0]).toBe(16);
    expect(bucketize(pts, { ...o, agg: 'last' }, NOW, 0).values[0]).toBeNull();   // a gap at the bucket's end
    expect(bucketize(pts, { ...o, agg: 'change' }, NOW, 0).values.slice(0, 2)).toEqual([6, -12]);
  });
  it('reads HA history rows; non-numbers are gaps', () => {
    expect(fromHistoryRows([{ s: '2.5', lu: 2 }, { s: 'unavailable', lu: 1.5 }, { s: '1e3', lu: 3 }])).toEqual([{ t: 1500, v: null }, { t: 2000, v: 2.5 }, { t: 3000, v: 1000 }]);
  });
  it('combines statistics rows per bucket', () => {
    const s = chartSpan(o, NOW, 0).start;
    const rows = [0, 5, 10, 15].map((m, i) => ({ start: s + m * MIN, end: s + (m + 5) * MIN, mean: i + 1, min: i, max: i + 2, change: 0.5 }));
    expect(fromStatistics(rows, { ...o, agg: 'mean' }, NOW, 0).values.slice(0, 2)).toEqual([2, 4]);
    expect(fromStatistics(rows, { ...o, agg: 'change' }, NOW, 0).values.slice(0, 3)).toEqual([1.5, 0.5, null]);
    expect(fromStatistics(rows, { ...o, agg: 'last' }, NOW, 0).values[0]).toBe(3);
  });
});

describe('history chart', () => {
  it('bars from zero, lines auto-ranged', () => {
    expect(yScale([18, 22], 'bars')).toEqual({ lo: 0, hi: 22 });
    expect(yScale([18, 22], 'line')).toEqual({ lo: 17.6, hi: 22.4 });
    expect(yScale([18, 22], 'line', 15, 25)).toEqual({ lo: 15, hi: 25 });
  });
  it('low / high with the bucket time', () => {
    const lh = lowHigh({ start: Date.UTC(2026, 9, 26, 0), bucketMs: HOUR, values: [3, null, 1, 7] }, 24 * HOUR, 60, 'en');
    expect(lh?.low).toMatchObject({ v: 1, time: '03:00' });
    expect(lh?.high).toMatchObject({ v: 7, time: '04:00' });
  });
  it('axis: minutes, hours, weekdays', () => {
    expect(axisTicks({ windowMs: HOUR, bucketMs: 5 * MIN }, NOW, 60, 'en').map((t) => t.text)).toEqual(['-45', '-30', '-15', 'Now']);
    expect(axisTicks({ windowMs: 24 * HOUR, bucketMs: HOUR }, NOW, 60, 'nl').map((t) => t.text)).toEqual(['18', '00', '06', '12']);
    expect(axisTicks({ windowMs: 7 * 24 * HOUR, bucketMs: 6 * HOUR }, NOW, 60, 'nl').map((t) => t.text)).toEqual(['Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo', 'Ma']);
  });
});

describe('dayLowHigh (#260, the price chart)', () => {
  it('hourly and quarter-hourly days: earliest on a tie, times from midnight', () => {
    const h = dayLowHigh([3, 1, 5, 1, 5, ...Array(19).fill(2)], 'en');
    expect([h?.low.i, h?.low.time, h?.high.i, h?.high.time]).toEqual([1, '01:00', 2, '02:00']);
    const q = Array(96).fill(2); q[13] = 0.5; q[95] = 9;
    const r = dayLowHigh(q, 'nl');
    expect([r?.low.time, r?.high.time]).toEqual(['03:15', '23:45']);
    expect(dayLowHigh([], 'en')).toBeNull();
  });
});
