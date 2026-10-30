// History tile series from an attribute or a weather forecast (#283).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { historySeriesVectors } from '../../scripts/gen-vectors.ts';
import { validateYaml } from './config.ts';
import { attrSamples, axisTicks, chartSpan, fromSamples, historyError, historySource, historySpec, joinSeries, parseTime, pastSpec } from './history.ts';
import { demoForecast, historyChart, joinState } from './historyChart.ts';
import { setHistorySource, setHistoryKey, bucketsFor, entitiesFor, entityIssue } from '../webconsole/configEdit.ts';
import { HA_ENTITIES } from './data.ts';

const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 26, 14, 37);
const yaml = (...w: string[]) => '# HA Paper display config\nversion: 1\nscreens:\n  - id: a\n    widgets:\n' + w.map((x) => '      - {' + x + '}\n').join('');

describe('history series vectors', () => {
  it('spec/test-vectors/history-series.json is in sync with the generator', () => {
    const disk = JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/history-series.json'), 'utf8'));
    expect(disk).toEqual(JSON.parse(JSON.stringify(historySeriesVectors())));
  });
});

describe('history series config', () => {
  it('picks the source from the keys', () => {
    expect(historySource({ entity: 'sensor.x' })).toBe('recorder');
    expect(historySource({ entity: 'weather.home' })).toBe('forecast');
    expect(historySource({ entity: 'weather.home', attribute: 'forecast' })).toBe('attribute');
  });
  it('accepts a rain nowcast and a weather forecast; the recorder keeps its domain message', () => {
    expect(validateYaml(yaml('type: history, entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, window: 2h, cs: 4'))).toMatchObject({ ok: true });
    expect(validateYaml(yaml('type: history, entity: weather.home, cs: 4'))).toMatchObject({ ok: true });
    expect(validateYaml(yaml('type: history, entity: binary_sensor.door'))).toMatchObject({ ok: false, message: 'history: “binary_sensor.door” is not a sensor / input_number / number entity' });
  });
  it('defaults: an attribute / forecast window looks ahead in full; a forecast bucket is at least its step', () => {
    const a = historySpec({ entity: 'binary_sensor.r', attribute: 'forecast', window: '2h', cs: 4 });
    expect(a).toMatchObject({ aheadMs: 2 * HOUR, bucketMs: 5 * MIN, source: { kind: 'attribute', attribute: 'forecast', value: 'value', time: 'datetime' } });
    const f = historySpec({ entity: 'weather.home', window: '24h', cs: 4 });
    expect(f).toMatchObject({ bucketMs: HOUR, source: { kind: 'forecast', value: 'temperature', forecast: 'hourly' } });
    expect(historySpec({ entity: 'sensor.x' })).not.toHaveProperty('source');
    expect(historyError({ entity: 'weather.home', forecast: 'daily', window: '6h' })).toBe('history: no bucket fits window 6h; set bucket');
  });
});

describe('history series data', () => {
  it('parses ISO times with and without an offset, and epoch seconds / ms', () => {
    expect(parseTime('2026-10-26T15:37:00+01:00', 0)).toBe(NOW);
    expect(parseTime('2026-10-26 15:37', 60)).toBe(NOW);
    expect(parseTime(NOW / 1000, 0)).toBe(NOW);
    expect(parseTime('soon', 0)).toBeNull();
  });
  it('a forward window starts at the bucket holding now and labels minutes ahead', () => {
    const s = { windowMs: 2 * HOUR, bucketMs: 5 * MIN, aheadMs: 2 * HOUR };
    expect(chartSpan(s, NOW, 60)).toEqual({ start: NOW - 2 * MIN, end: NOW - 2 * MIN + 2 * HOUR });
    expect(axisTicks(s, NOW, 60, 'en').map((t) => t.text)).toEqual(['Now', '+30', '+60', '+90']);
    expect(chartSpan({ windowMs: 2 * HOUR, bucketMs: 5 * MIN }, NOW, 60).end).toBe(NOW + 3 * MIN);   // recorder unchanged
  });
  it('buckets samples (mean of the samples) and marks the bucket holding now', () => {
    const sp = historySpec({ entity: 'binary_sensor.r', attribute: 'forecast', value: 'precipitation', window: '1h', bucket: '10m', ahead: '30m', style: 'bars' });
    const raw = [{ datetime: '2026-10-26T14:31:00Z', precipitation: 1 }, { datetime: '2026-10-26T14:39:00Z', precipitation: 3 }, { datetime: '2026-10-26T14:55:00Z', precipitation: '0.5' }];
    const ser = fromSamples(attrSamples(raw, sp.source!, sp.bucketMs, NOW, 60), sp, NOW, 60);
    expect(ser.values).toEqual([null, null, null, 2, null, 0.5]);
    const c = historyChart(sp, ser, 'ok', NOW, 60, 'en', String);
    expect(c.bars.findIndex((b) => b?.now)).toBe(3);
  });
  it('the demo nowcast goes through the parser into a shower ahead', () => {
    const sp = historySpec({ entity: 'binary_sensor.r', attribute: 'forecast', value: 'precipitation', window: '2h', cs: 4 });
    const ser = fromSamples(attrSamples(demoForecast('precipitation', 'datetime', 5 * MIN, NOW, 60, 2 * HOUR), sp.source!, sp.bucketMs, NOW, 60), sp, NOW, 60);
    expect(ser.values.filter((v) => v !== null)).toHaveLength(24);
    expect(Math.max(...(ser.values as number[]))).toBeGreaterThan(1);
  });
});

describe('history series console', () => {
  it('switching source resets keys and drops an entity the source cannot read', () => {
    const ws = [{ type: 'history', entity: 'sensor.outdoor_temperature', window: '24h', bucket: '30m' }];
    expect(setHistorySource(ws, 0, 'attribute')[0]).toEqual({ type: 'history', entity: 'sensor.outdoor_temperature', attribute: 'forecast', window: '2h' });
    expect(setHistorySource(ws, 0, 'forecast')[0]).toEqual({ type: 'history' });
    expect(setHistorySource([{ type: 'history', entity: 'weather.home', value: 'precipitation' }], 0, 'recorder')[0]).toEqual({ type: 'history' });
  });
  it('the picker lists entities the source reads; a forecast offers buckets of 1h and up', () => {
    const ids = (w: Record<string, string>) => entitiesFor(HA_ENTITIES, 'history', '', { type: 'history', ...w }).map((e) => e.id);
    expect(ids({ attribute: 'forecast' })).toContain('binary_sensor.rain_expected');
    expect(ids({ entity: 'weather.home' })).toEqual(['weather.home']);
    expect(ids({})).not.toContain('binary_sensor.rain_expected');
    expect(bucketsFor('24h', { type: 'history', entity: 'weather.home' })).toEqual(['1h', '2h', '3h', '6h', '12h']);
    expect(entityIssue({ type: 'history', entity: 'weather.home' }, HA_ENTITIES)).toBeNull();
  });
});

describe('past and future in one chart (#307)', () => {
  const now = Date.UTC(2026, 9, 26, 14, 37), tz = 60;
  const w = { type: 'history', entity: 'binary_sensor.rain_expected', attribute: 'forecast', value: 'precipitation', past: 'sensor.rain_rate', window: '3h', ahead: '2h', bucket: '10m', style: 'bars' };
  it('fetches the past part plus the open bucket and joins by bucket start', () => {
    expect(historyError(w)).toBeNull();
    const sp = historySpec(w), ps = pastSpec(sp);
    expect([ps.entity, ps.windowMs, ps.n]).toEqual(['sensor.rain_rate', 70 * MIN, 7]);
    const past = { start: chartSpan(ps, now, tz).start, bucketMs: 10 * MIN, values: [1, 2, 3, 4, 5, 6, 99] };
    const ahead = { start: chartSpan(sp, now, tz).start, bucketMs: 10 * MIN, values: Array.from({ length: 18 }, (_, i) => 100 + i) };
    const j = joinSeries(sp, past, ahead, now, tz);
    expect(j.values.slice(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 106]);
    const c = historyChart(sp, j, 'ok', now, tz, 'en', String);
    expect(c.split).toBe(0.3333);
    expect(c.bars.map((b) => !!b?.ahead).indexOf(true)).toBe(6);
  });
  it('a missing past fetch leaves gaps; the state joins', () => {
    const sp = historySpec(w), j = joinSeries(sp, null, null, now, tz);
    expect(j.values.every((v) => v === null)).toBe(true);
    expect(joinState('loading', 'none')).toBe('loading');
    expect(joinState('needsStats', 'none')).toBe('needsStats');
    expect(joinState('tooMany', 'ok')).toBe('ok');
  });
  it('the console gives a past entity a past part', () => {
    const ws = setHistoryKey([{ type: 'history', entity: 'binary_sensor.rain_expected', attribute: 'forecast', window: '2h' }], 0, 'past', 'sensor.rain_rate');
    expect(ws[0].ahead).toBe('1h');
    expect(historyError(ws[0])).toBeNull();
  });
});
