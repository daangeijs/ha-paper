// History tile chart (#267): what the panel draws from a history.ts Series, in fractions of the plot area so the
// Classic and Modern templates (and later firmware ui_tiles / ui_sleek, #270) share one geometry. Pure.
import { axisTicks, bucketStart, chartSpan, lowHigh, yScale, type HistorySpec, type HistoryStyle, type Point, type Series, type Tick } from './history.ts';
import { tr, type Lang, type StrKey } from './strings.ts';
import { INK } from './data.ts';
import { HATCH, TRACK } from './panel.ts';

/** Dot diameter of the dots style (#304): fits the bucket pitch of a 4-wide tile, 4–8 px. */
export const dotPx = (n: number): number => Math.max(4, Math.min(8, Math.floor(440 / n) - 2));

/** ok: draw the series; loading: frame only (no fetch answered yet); none: no data in the window; tooMany: the
 *  history answer was over the frame cap; needsStats: no statistics and the window is over the 24 h fallback. */
export type HistState = 'ok' | 'loading' | 'none' | 'tooMany' | 'needsStats';
const STATE_TEXT: Partial<Record<HistState, StrKey>> = { none: 'histNone', tooMany: 'histTooMany', needsStats: 'histNeedsStats' };

/** A bar from b to t (0 = bottom, 1 = top of the plot; bars grow from zero, so b < zero for negatives). null = a gap.
 *  `now`: the latest bucket with data. */
export type HistBar = { b: number; t: number; now: boolean } | null;
export type XY = { x: number; y: number };
/** A value printed on the plot (#304, `labels: true`): beside its point (x, y), on the `side` with more room. */
export type HistLabel = { kind: 'max' | 'min' | 'last'; i: number; x: number; y: number; text: string; side: 'left' | 'right' };
export type HistoryChart = {
  style: HistoryStyle; n: number; state: HistState; stateText: string;
  bars: HistBar[];
  /** Line segments (a gap breaks the line). line / area: points at bucket centres; step (#304): each bucket a flat run
   *  between its edges, joined upright at the shared edge. area also fills each segment of 2+ points down to 0. */
  lines: XY[][];
  /** dots (#304): one point per bucket with data, at its centre. */
  dots: XY[];
  /** The latest point (line / area / step / dots), drawn as the big dot. */
  dot: XY | null;
  /** Height of the dashed reference line (#304 `threshold`), null when unset or outside the range. */
  threshold: number | null;
  labels: HistLabel[];
  /** Height of the zero line (bars), null when 0 is outside the range. */
  zero: number | null;
  ticks: Tick[]; low: string; high: string; lo: number; hi: number;
  /** Buckets of the low and high (-1 = none), for the redraw key. */
  lowI: number; highI: number;
};

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** The chart of one history tile. `fmt` formats a value for the low / high labels (number format, display_precision). */
export function historyChart(spec: HistorySpec, series: Series | null, state: HistState, now: number, tz: number, lang: Lang,
  fmt: (v: number) => string): HistoryChart {
  const n = spec.n, values = series && state === 'ok' ? series.values : Array<number | null>(n).fill(null);
  const st: HistState = state === 'ok' && values.every((v) => v === null) ? 'none' : state;
  const thr = spec.threshold ?? null;
  const { lo, hi } = yScale(values, spec.style, spec.min, spec.max, thr);
  const y = (v: number) => r4(clamp((v - lo) / (hi - lo)));
  const zero = lo <= 0 && hi >= 0 ? y(0) : null;
  // the latest bucket with data is marked (the open one, or the one before it right after a boundary); a window that
  // looks ahead (#283) marks the bucket holding now, when it has data
  let latest = -1; values.forEach((v, i) => { if (v !== null) latest = i; });
  if (spec.aheadMs) { const i = Math.round((bucketStart(now, spec.bucketMs, tz) - chartSpan(spec, now, tz).start) / spec.bucketMs); latest = values[i] == null ? -1 : i; }
  const bars: HistBar[] = spec.style === 'bars' ? values.map((v, i) => (v === null ? null : { b: y(Math.min(0, v)), t: y(Math.max(0, v)), now: i === latest })) : [];
  const lines: XY[][] = [], step = spec.style === 'step';
  if (spec.style === 'line' || spec.style === 'area' || step) {
    let seg: XY[] = [];
    values.forEach((v, i) => {
      if (v === null) { if (seg.length) lines.push(seg); seg = []; return; }
      if (step) seg.push({ x: r4(i / n), y: y(v) }, { x: r4((i + 1) / n), y: y(v) });
      else seg.push({ x: r4((i + 0.5) / n), y: y(v) });
    });
    if (seg.length) lines.push(seg);
  }
  const at = (i: number): XY => ({ x: r4((i + 0.5) / n), y: y(values[i] as number) });
  const dots = spec.style === 'dots' ? values.flatMap((v, i) => (v === null ? [] : [at(i)])) : [];
  const dot = spec.style !== 'bars' && latest >= 0 ? at(latest) : null;
  const lh = st === 'ok' && series ? lowHigh(series, spec.windowMs, tz, lang) : null;
  const threshold = thr !== null && st === 'ok' && thr >= lo && thr <= hi ? y(thr) : null;
  const labels: HistLabel[] = [];
  if (spec.labels && lh) {
    const put = (kind: HistLabel['kind'], i: number) => { const p = at(i); labels.push({ kind, i, ...p, text: fmt(values[i] as number), side: p.x < 0.5 ? 'right' : 'left' }); };
    put('max', lh.high.i);
    if (lh.low.i !== lh.high.i) put('min', lh.low.i);
    // the last value, unless it is (or sits next to) the max or min: one label per spot
    const near = (l: HistLabel, p: XY) => Math.abs(l.x - p.x) < 0.25 && Math.abs(l.y - p.y) < 0.25;
    if (latest >= 0 && !labels.some((l) => l.i === latest || near(l, at(latest)))) put('last', latest);
  }
  const k = STATE_TEXT[st];
  return {
    style: spec.style, n, state: st, stateText: k ? tr(lang, k) : '', bars, lines, dots, dot, threshold, labels, zero,
    ticks: axisTicks(spec, now, tz, lang).map((t) => ({ x: r4(t.x), text: t.text })),
    low: lh ? tr(lang, 'histLow', fmt(lh.low.v), lh.low.time) : '', high: lh ? tr(lang, 'histHigh', fmt(lh.high.v), lh.high.time) : '', lo, hi,
    lowI: lh ? lh.low.i : -1, highI: lh ? lh.high.i : -1,
  };
}

/** What a redraw compares (core values, never the formatted text): bar / point heights at the panel's pixel step
 *  (one per bucket, runs split by gaps), the state, the axis and the low / high buckets with their values at `dp`
 *  decimals; with a threshold its height, with labels the last label's bucket and value (#304). */
export function chartKey(c: HistoryChart, values: (number | null)[], dp = 1, px = 200): string {
  const q = (v: number) => Math.round(v * px);
  const y = (v: number) => r4(clamp((v - c.lo) / (c.hi - c.lo)));
  let body = '';
  if (c.style === 'bars') body = c.bars.map((b) => (b ? q(b.b) + ':' + q(b.t) : '_')).join(',');
  else if (c.state === 'ok') {
    let open = false;
    values.forEach((v) => {
      if (v === null) { open = false; return; }
      body += (body ? (open ? ',' : '|') : '') + q(y(v)); open = true;
    });
  }
  const v = (i: number) => (i < 0 ? '' : (values[i] as number).toFixed(dp));
  const last = c.labels.find((l) => l.kind === 'last');
  return c.state + ';' + body + ';' + c.ticks.map((t) => r4(t.x)).join(' ') + ';' + c.lowI + '=' + v(c.lowI) + ';' + c.highI + '=' + v(c.highI)
    + (c.threshold !== null ? ';t' + q(c.threshold) : '') + (last ? ';l' + last.i + '=' + v(last.i) : '');
}

/** A gap-free SVG path for one line segment in a 0–100 viewBox (y down). */
export const linePath = (seg: XY[]): string => seg.map((p, i) => (i ? 'L' : 'M') + (p.x * 100).toFixed(2) + ' ' + ((1 - p.y) * 100).toFixed(2)).join(' ');

/** The browser emulator's demo history (it has no recorder): a 5-minute sample of a daily curve by unit, with the
 *  sensor dropping out 02:20–03:10 every night (a gap). An unavailable entity has none. */
export function demoHistory(id: string, unit: string, from: number, now: number, tz: number): Point[] {
  const step = 5 * 60_000, out: Point[] = [];
  let seed = 0; for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  for (let t = Math.floor(from / step) * step; t <= now; t += step) {
    const day = (((t + tz * 60_000) / 86_400_000) % 1 + 1) % 1, noise = ((Math.sin(t / step * 12.9898 + seed) * 43758.5453) % 1 + 1) % 1 - 0.5;
    if (day >= 140 / 1440 && day < 190 / 1440) { out.push({ t, v: null }); continue; }
    const v = unit === '°C' ? 10 + 5 * Math.sin(2 * Math.PI * (day - 0.375)) + 0.6 * noise
      : unit === '%' ? 70 - 18 * Math.sin(2 * Math.PI * (day - 0.375)) + 4 * noise
        : Math.max(0, 40 + 35 * Math.sin(2 * Math.PI * (day - 0.3)) + 15 * noise);
    out.push({ t, v: Math.round(v * 10) / 10 });
  }
  return out;
}

/** The browser emulator's demo attribute / forecast list (#283; it has no HA): `{[time]: ISO, [value]: n}` entries
 *  from 2 h before `now` to `days` ahead, every `stepMs`. A rain-like field ("precipitation", "rain…") gets a shower
 *  peaking about an hour from now; anything else a daily temperature curve. Deterministic in (field, t). */
export function demoForecast(value: string, time: string, stepMs: number, now: number, tz: number, aheadMs: number): Record<string, string | number>[] {
  const out: Record<string, string | number>[] = [], rain = /precip|rain/i.test(value);
  const iso = (t: number) => { const d = new Date(t + tz * 60_000), sg = tz < 0 ? '-' : '+', a = Math.abs(tz);
    return d.toISOString().slice(0, 19) + sg + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
  for (let t = Math.floor(now / stepMs) * stepMs - 2 * 3_600_000; t <= now + aheadMs; t += stepMs) {
    const m = (t - now) / 60_000, day = (((t + tz * 60_000) / 86_400_000) % 1 + 1) % 1;
    const v = rain ? Math.max(0, 2.4 * Math.exp(-(((m - 55) / 22) ** 2)) + 0.6 * Math.exp(-(((m - 100) / 10) ** 2)) - 0.05) : 10 + 5 * Math.sin(2 * Math.PI * (day - 0.375));
    out.push({ [time]: iso(t), [value]: Math.round(v * 10) / 10 });
  }
  return out;
}

/** Template data of a chart (Device.tsx, both styles): percentages of the plot area. Past bars hatched, the open
 *  bucket solid ink: a pattern against a fill, so it reads on a 1-bit panel. A gap draws nothing. area (#304): each
 *  segment's polygon down to the plot bottom as a clip-path over the 25 % Track dither (pixel-exact, unlike an SVG
 *  pattern under a stretched viewBox). */
export function historyTile(c: HistoryChart) {
  const pct = (v: number) => (v * 100).toFixed(2) + '%';
  const poly = (seg: XY[]) => 'polygon(' + [{ x: seg[0].x, y: 0 }, ...seg, { x: seg[seg.length - 1].x, y: 0 }].map((p) => pct(p.x) + ' ' + pct(1 - p.y)).join(', ') + ')';
  const lineish = c.style === 'line' || c.style === 'area' || c.style === 'step';
  return {
    histStyle: c.style, isLine: lineish, isBarChart: c.style === 'bars', isStep: c.style === 'step', hasState: !!c.stateText, stateText: c.stateText,
    hBars: c.bars.map((b) => (b ? { gap: false, bottom: pct(b.b), h: 'max(3px, ' + pct(b.t - b.b) + ')', bg: b.now ? INK : HATCH } : { gap: true, bottom: '0%', h: '0px', bg: 'transparent' })),
    barGap: c.n > 48 ? '1px' : c.n > 24 ? '2px' : '4px',
    paths: c.lines.map(linePath), dot: c.dot ? { left: pct(c.dot.x), bottom: pct(c.dot.y) } : null,
    fills: c.style === 'area' ? c.lines.filter((s) => s.length > 1).map(poly) : [], fillBg: TRACK,
    dots: c.dots.map((p) => ({ left: pct(p.x), bottom: pct(p.y) })), dotPx: dotPx(c.n),
    thresholdPct: c.threshold === null ? null : pct(c.threshold),
    labels: c.labels.map((l) => ({ text: l.text, left: pct(l.x), bottom: pct(l.y), shift: l.side === 'right' ? '12px' : 'calc(-100% - 12px)' })),
    zeroPct: c.zero === null ? null : pct(c.zero),
    ticks: c.ticks.map((t) => ({ text: t.text, left: pct(t.x), shift: t.x < 0.06 ? '0' : t.x > 0.94 ? '-100%' : '-50%' })),
    low: c.low, high: c.high, hasLowHigh: !!c.low,
  };
}
