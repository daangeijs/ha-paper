import { describe, it, expect } from 'vitest';
import { historySpec, type Series } from './history.ts';
import { chartKey, demoHistory, historyChart, historyTile, linePath } from './historyChart.ts';
import { HATCH } from './panel.ts';
import { INK } from './data.ts';

const HOUR = 3600_000, NOW = Date.UTC(2026, 9, 26, 14, 37);
const fmt = (v: number) => v.toFixed(1);
const spec = (w: Record<string, string | number>) => historySpec({ type: 'history', entity: 'sensor.x', ...w });
const ser = (values: (number | null)[], bucketMs = HOUR): Series => ({ start: NOW - values.length * bucketMs, bucketMs, values });

describe('history chart', () => {
  it('eink-ha-os#304 band: the mean line over a Track clip between max and min; a lone bucket or a missing side draws no band', () => {
    const c = historyChart(spec({ window: '6h', bucket: '1h', style: 'band' }), ser([10, 12, null, 14, 13, 12]), 'ok', NOW, 0, 'en', fmt,
      { lo: [9, 11, null, 13, 12, null], hi: [12, 13, null, 18, 14, 13] });
    expect(c.band.map((r) => r.map((p) => p.x))).toEqual([[0.0833, 0.25], [0.5833, 0.75]]);
    expect([c.lo, c.hi]).toEqual([8.1, 18.9]);   // the band's min / max widen the auto range
    const t = historyTile(c);
    expect(t.isLine).toBe(true); expect(t.fills).toHaveLength(2); expect(t.paths).toHaveLength(2);
    expect(c.extraKey.startsWith(';b')).toBe(true);
    expect(historyChart(spec({ window: '6h', bucket: '1h', style: 'band' }), ser([10, 12, 11, 14, 13, 12]), 'ok', NOW, 0, 'en', fmt, { lo: [9, 11, 10, 13, 12, 11] }).band).toEqual([]);
  });
  it('eink-ha-os#304 compare: a level tick over each bar, a dashed line under the others; ignored at another length or without data', () => {
    const bars = historyChart(spec({ window: '4h', bucket: '1h', style: 'bars' }), ser([1, 2, 3, 4]), 'ok', NOW, 0, 'en', fmt, { prev: [2, null, 6, 1] });
    expect(bars.hi).toBe(6); expect(bars.prevTicks).toEqual([0.3333, null, 1, 0.1667]);
    expect(historyTile(bars).hPrevTicks[1].gap).toBe(true);
    const dots = historyChart(spec({ window: '4h', bucket: '1h', style: 'dots' }), ser([1, 2, 3, 4]), 'ok', NOW, 0, 'en', fmt, { prev: [2, 3, null, 1] });
    expect(dots.prevLines.map((l) => l.length)).toEqual([2, 1]); expect(historyTile(dots).isLine).toBe(true);
    expect(historyChart(spec({ window: '4h', bucket: '1h' }), ser([1, 2, 3, 4]), 'ok', NOW, 0, 'en', fmt, { prev: [9, 9] }).prevLines).toEqual([]);
    const none = historyChart(spec({ window: '4h', bucket: '1h' }), ser([null, null, null, null]), 'ok', NOW, 0, 'en', fmt, { prev: [1, 2, 3, 4] });
    expect([none.state, none.prevLines, none.extraKey]).toEqual(['none', [], '']);
  });
  it('eink-ha-os#304 area: the line plus a fill polygon per run of 2+ points down to 0; a lone point gets no fill', () => {
    const c = historyChart(spec({ window: '6h', bucket: '1h', style: 'area' }), ser([10, 12, null, 14, null, 12]), 'ok', NOW, 0, 'en', fmt);
    expect(c.style).toBe('area'); expect(c.lines.map((l) => l.length)).toEqual([2, 1, 1]);
    const t = historyTile(c);
    expect(t.isLine).toBe(true); expect(t.fills).toHaveLength(1);
    expect(t.fills[0]).toMatch(/^polygon\(8\.33% 100\.00%, 8\.33% [\d.]+%, 25\.00% [\d.]+%, 25\.00% 100\.00%\)$/);
  });
  it('eink-ha-os#304 step: a flat run per bucket between its edges, broken at a gap', () => {
    const c = historyChart(spec({ window: '4h', bucket: '1h', style: 'step' }), ser([1, 2, null, 2]), 'ok', NOW, 0, 'en', fmt);
    expect(c.lines.map((l) => l.map((p) => p.x))).toEqual([[0, 0.25, 0.25, 0.5], [0.75, 1]]);
    expect(c.lines[0][1].y).toBe(c.lines[0][0].y);
  });
  it('eink-ha-os#304 dots: one per bucket with data, the latest also as the big dot', () => {
    const c = historyChart(spec({ window: '4h', bucket: '1h', style: 'dots' }), ser([1, null, 3, null]), 'ok', NOW, 0, 'en', fmt);
    expect(c.lines).toEqual([]); expect(c.dots.map((p) => p.x)).toEqual([0.125, 0.625]); expect(c.dot?.x).toBe(0.625);
  });
  it('eink-ha-os#304 threshold widens an auto range and is dashed; outside a fixed range it is not drawn', () => {
    const c = historyChart(spec({ window: '4h', bucket: '1h', threshold: 20 }), ser([10, 11, 12, 11]), 'ok', NOW, 0, 'en', fmt);
    expect(c.hi).toBeGreaterThan(20); expect(c.threshold).not.toBeNull();
    expect(historyTile(c).thresholdPct).toMatch(/%$/);
    const f = historyChart(spec({ window: '4h', bucket: '1h', threshold: 20, min: 0, max: 15 }), ser([10, 11, 12, 11]), 'ok', NOW, 0, 'en', fmt);
    expect(f.threshold).toBeNull();
  });
  it('eink-ha-os#304 labels: max, min, and last unless it shares their spot', () => {
    const c = historyChart(spec({ window: '6h', bucket: '1h', labels: 'true' }), ser([10, 14, 9, 11, 12, 11.5]), 'ok', NOW, 0, 'en', fmt);
    expect(c.labels.map((l) => [l.kind, l.i, l.text, l.side])).toEqual([['max', 1, '14.0', 'right'], ['min', 2, '9.0', 'right'], ['last', 5, '11.5', 'left']]);
    const n = historyChart(spec({ window: '6h', bucket: '1h', labels: 'true' }), ser([10, 11, 9, 11, 12, 14]), 'ok', NOW, 0, 'en', fmt);
    expect(n.labels.map((l) => l.kind)).toEqual(['max', 'min']);
    expect(historyChart(spec({ window: '6h', bucket: '1h' }), ser([1, 2, 3, 4, 5, 6]), 'ok', NOW, 0, 'en', fmt).labels).toEqual([]);
  });
  it('bars from zero; negatives below the zero line; a gap draws nothing; the latest bucket is marked', () => {
    const s = spec({ window: '6h', bucket: '1h', agg: 'max' });
    const c = historyChart(s, ser([2, -2, null, 4, 0, null]), 'ok', NOW, 0, 'en', fmt);
    expect(c.style).toBe('bars');
    expect([c.lo, c.hi]).toEqual([-2, 4]);
    expect(c.zero).toBeCloseTo(1 / 3, 3);
    expect(c.bars[0]).toEqual({ b: 0.3333, t: 0.6667, now: false });
    expect(c.bars[1]).toEqual({ b: 0, t: 0.3333, now: false });
    expect(c.bars[2]).toBeNull();
    expect(c.bars[4]).toEqual({ b: 0.3333, t: 0.3333, now: true });   // the open bucket is empty: the one before is the latest
    expect(c.low).toBe('Low -2.0 · ' + c.low.split(' · ')[1]);
    const t = historyTile(c);
    expect(t.hBars[3].bg).toBe(HATCH); expect(t.hBars[4].bg).toBe(INK); expect(t.hBars[2].gap).toBe(true);
  });
  it('line: auto range with padding, a gap breaks the line, a dot on the latest point', () => {
    const s = spec({ window: '6h', bucket: '1h' });
    const c = historyChart(s, ser([10, 12, null, 14, 13, 12]), 'ok', NOW, 0, 'en', fmt);
    expect(c.style).toBe('line');
    expect(c.lo).toBeCloseTo(9.6); expect(c.hi).toBeCloseTo(14.4);
    expect(c.lines.map((l) => l.length)).toEqual([2, 3]);
    expect(c.dot).toEqual({ x: 0.9167, y: c.lines[1][2].y });
    expect(linePath(c.lines[0])).toMatch(/^M8\.33 \d+\.\d+ L25\.00 /);
    expect(c.high).toMatch(/^High 14\.0 · \d\d:\d\d$/);
  });
  it('a configured min / max fixes the range', () => {
    const c = historyChart(spec({ window: '6h', bucket: '1h', min: '0', max: '20' }), ser([10, 12, 11, 14, 13, 12]), 'ok', NOW, 0, 'en', fmt);
    expect([c.lo, c.hi]).toEqual([0, 20]); expect(c.lines[0][0].y).toBe(0.5);
  });
  it('states: no data, too many changes, needs statistics, loading (frame only)', () => {
    const s = spec({ window: '6h', bucket: '1h' });
    expect(historyChart(s, ser([null, null, null, null, null, null]), 'ok', NOW, 0, 'en', fmt)).toMatchObject({ state: 'none', stateText: 'No history', low: '' });
    expect(historyChart(s, null, 'tooMany', NOW, 0, 'nl', fmt).stateText).toBe('Te veel wijzigingen');
    expect(historyChart(s, null, 'needsStats', NOW, 0, 'en', fmt).stateText).toBe('Needs long-term statistics');
    const l = historyChart(s, null, 'loading', NOW, 0, 'en', fmt);
    expect([l.stateText, l.lines.length, l.ticks.length > 0]).toEqual(['', 0, true]);
  });
  it('redraw key: values and pixels, not the language or number format', () => {
    const s = spec({ window: '24h', bucket: '1h' });
    const v = Array.from({ length: 24 }, (_, i) => 10 + Math.sin(i / 4));
    const en = historyChart(s, ser(v), 'ok', NOW, 60, 'en', fmt), nl = historyChart(s, ser(v), 'ok', NOW, 60, 'nl', (x) => x.toFixed(1).replace('.', ','));
    expect(chartKey(en, v)).toBe(chartKey(nl, v));
    const v2 = [...v]; v2[23] += 0.001;   // below a pixel and a decimal: same picture
    expect(chartKey(historyChart(s, ser(v2), 'ok', NOW, 60, 'en', fmt), v2)).toBe(chartKey(en, v));
    v2[23] += 1;
    expect(chartKey(historyChart(s, ser(v2), 'ok', NOW, 60, 'en', fmt), v2)).not.toBe(chartKey(en, v));
  });
  it('demo history: a 5-minute curve with a nightly gap', () => {
    const p = demoHistory('sensor.outdoor_temperature', '°C', NOW - 24 * HOUR, NOW, 0);
    expect(p.length).toBe(289);
    expect(p.some((x) => x.v === null)).toBe(true);
    expect(Math.max(...p.filter((x) => x.v !== null).map((x) => x.v as number))).toBeLessThan(17);
  });
});
