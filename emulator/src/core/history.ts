// History tile (#264, #265): config rules, time-weighted bucketing from HA statistics or history rows, low/high, axis.
// Pure; firmware core/history.cpp (#268) must match spec/test-vectors/history.json. Times are epoch ms, `tz` is the
// local UTC offset in minutes at `now` (DST changes inside the window are ignored).
import { tr, type Lang, type StrKey } from './strings.ts';

export const HISTORY_DOMAINS = ['sensor', 'input_number', 'number'];
export const HISTORY_AGGS = ['mean', 'max', 'min', 'last', 'change'] as const;
export type HistoryAgg = (typeof HISTORY_AGGS)[number];
export const HISTORY_STYLES = ['bars', 'line', 'area', 'step', 'dots', 'auto'] as const;
/** area: a line with a dithered fill under it; step: a step line (setpoints, prices); dots: one dot per bucket (#304). */
export type HistoryStyle = 'bars' | 'line' | 'area' | 'step' | 'dots';
export const MAX_HISTORY_TILES = 6;
export const MIN_BARS = 2, MAX_BARS = 96, BARS_PER_COL = 12;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const WINDOW_MIN = 10 * MIN, WINDOW_MAX = 7 * DAY, WINDOW_DEFAULT = '24h';
/** The bucket ladder: an explicit `bucket` must be one of these; the default is picked from it. */
export const BUCKETS = ['1m', '5m', '10m', '15m', '30m', '1h', '2h', '3h', '6h', '12h', '1d'];
/** Without long-term statistics the device falls back to history/history_during_period, for windows up to 24 h. */
export const HISTORY_FALLBACK_MAX = DAY;

const UNIT: Record<string, number> = { m: MIN, h: HOUR, d: DAY };
/** "30m" / "6h" / "7d" → ms; anything else (also a bare number) → null. */
export function parseSpan(v: unknown): number | null {
  const m = typeof v === 'string' ? v.match(/^(\d+)([mhd])$/) : null;
  return m && Number(m[1]) > 0 ? Number(m[1]) * UNIT[m[2]] : null;
}

/** Default bucket for a window on a tile `cs` columns wide: the smallest ladder step that divides the window into at
 *  most 12 × cs bars; else the dividing step with the fewest bars still in 2–96; else null (window needs a bucket).
 *  `minMs`: the data's own step (a forecast's hour or day, #283); shorter steps are skipped. */
export function defaultBucket(windowMs: number, cs = 1, minMs = 0): number | null {
  const fits = BUCKETS.map((b) => parseSpan(b) as number).filter((b) => b >= minMs && windowMs % b === 0 && windowMs / b >= MIN_BARS && windowMs / b <= MAX_BARS);
  return fits.find((b) => windowMs / b <= BARS_PER_COL * cs) ?? fits[fits.length - 1] ?? null;
}

const NUM = /^-?\d+(\.\d+)?$/;
const numOf = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && NUM.test(v) ? Number(v) : null);

// ---------- source (#283) ----------
/** Where the series comes from: the recorder (statistics / history), a list in an attribute of the entity, or a
 *  weather entity's forecast (weather.get_forecasts). Implied by the keys: `attribute` wins, then a weather.* entity. */
export type HistorySource = 'recorder' | 'attribute' | 'forecast';
export const ATTR_DOMAINS = ['sensor', 'binary_sensor', 'weather'];
export const FORECAST_TYPES = ['hourly', 'daily'] as const;
const FORECAST_STEP: Record<string, number> = { hourly: HOUR, daily: DAY };
/** Keys only a series from an attribute or a forecast reads. */
export const SOURCE_KEYS = ['attribute', 'value', 'time', 'ahead', 'forecast'] as const;
type W = Record<string, string | number | undefined>;
export const historySource = (w: W): HistorySource =>
  (w.attribute !== undefined ? 'attribute' : String(w.entity ?? '').startsWith('weather.') ? 'forecast' : 'recorder');
/** Entity domains a history widget accepts for its source (the recorder keeps the #265 list and message). */
export const historyDomains = (w: W): string[] => ({ recorder: HISTORY_DOMAINS, attribute: ATTR_DOMAINS, forecast: ['weather'] })[historySource(w)];
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `ahead`: 0 or a span; null = not a valid value. */
const aheadOf = (v: unknown): number | null => (v === 0 || v === '0' ? 0 : parseSpan(v));

/** A history widget's own rules (entity is checked by the shared domain rule first, historyDomains). null = valid. */
export function historyError(w: W): string | null {
  const winText = String(w.window ?? WINDOW_DEFAULT), win = parseSpan(winText);
  if (win === null || win < WINDOW_MIN || win > WINDOW_MAX) return 'history: window must be like 30m, 6h or 7d (10m–7d)';
  const src = historySource(w);
  if (src === 'recorder') { const k = SOURCE_KEYS.find((x) => w[x] !== undefined); if (k) return 'history: ' + k + ' needs an attribute or a weather entity'; }
  for (const k of ['attribute', 'value', 'time'] as const) if (w[k] !== undefined && !FIELD.test(String(w[k]))) return 'history: ' + k + ' must be an attribute name (letters, digits, _)';
  if (w.forecast !== undefined && (src !== 'forecast' || !(FORECAST_TYPES as readonly string[]).includes(String(w.forecast)))) return 'history: forecast must be hourly or daily, on a weather entity without attribute';
  const step = src === 'forecast' ? FORECAST_STEP[String(w.forecast ?? 'hourly')] : 0;
  if (w.bucket !== undefined && step && (parseSpan(w.bucket) ?? 0) < step) return 'history: ' + (step === DAY ? 'a daily forecast needs a bucket of 1d' : 'an hourly forecast needs a bucket of 1h') + ' or more';
  if (w.bucket !== undefined) {
    const b = BUCKETS.includes(String(w.bucket)) ? (parseSpan(w.bucket) as number) : null;
    if (b === null) return 'history: bucket must be one of ' + BUCKETS.join(' ');
    if (win % b !== 0) return 'history: bucket ' + w.bucket + ' does not divide window ' + winText;
    const n = win / b;
    if (n < MIN_BARS || n > MAX_BARS) return 'history: ' + winText + ' / ' + w.bucket + ' = ' + n + (n === 1 ? ' bar (' : ' bars (') + MIN_BARS + '–' + MAX_BARS + ')';
  } else if (defaultBucket(win, Number(w.cs) || 1, step) === null) return 'history: no bucket fits window ' + winText + '; set bucket';
  if (w.ahead !== undefined) {
    const a = aheadOf(w.ahead), b = w.bucket !== undefined ? (parseSpan(w.bucket) as number) : (defaultBucket(win, Number(w.cs) || 1, step) as number);
    if (a === null || a > win) return 'history: ahead must be 0 or like 30m or 2h, at most the window';
    if (a % b !== 0) return 'history: bucket ' + (w.bucket ?? b / MIN + 'm') + ' does not divide ahead ' + w.ahead;
  }
  if (w.agg !== undefined && !(HISTORY_AGGS as readonly string[]).includes(String(w.agg))) return 'history: agg must be ' + HISTORY_AGGS.join(', ');
  if (w.style !== undefined && !(HISTORY_STYLES as readonly string[]).includes(String(w.style))) return 'history: style must be bars, line, area, step, dots or auto';
  const lo = w.min === undefined ? undefined : numOf(w.min), hi = w.max === undefined ? undefined : numOf(w.max);
  if (lo === null || hi === null) return 'history: min and max must be numbers';
  if (lo !== undefined && hi !== undefined && lo >= hi) return 'history: min must be below max';
  if (w.threshold !== undefined && numOf(w.threshold) === null) return 'history: threshold must be a number';
  if (w.labels !== undefined && w.labels !== 'true' && w.labels !== 'false') return 'history: labels must be true or false';
  return null;
}

/** Where an attribute / forecast series is read (#283). value / time: the entry's fields (a list of plain numbers has
 *  neither); forecast: weather.get_forecasts type, forecast source only. */
export type SourceSpec = { kind: 'attribute' | 'forecast'; attribute: string; value: string; time: string; forecast?: 'hourly' | 'daily' };
export type HistorySpec = {
  entity: string; windowMs: number; bucketMs: number; n: number; agg: HistoryAgg; style: HistoryStyle;
  min: number | null; max: number | null;
  /** #304: a dashed reference line at this value; min / max / last values on the chart. Set only when configured. */
  threshold?: number; labels?: true;
  /** Part of the window after now (#283): 0 / absent = the bucket holding now is the last one (recorder); > 0 = it
   *  starts the last `aheadMs` of the window. Only attribute / forecast series; set only for them. */
  aheadMs?: number; source?: SourceSpec;
};
/** Auto style: a line for means, bars for max / min / last / change (Daan, #264). Other styles as written (#304). */
export const resolveStyle = (agg: HistoryAgg, style?: unknown): HistoryStyle =>
  (style !== 'auto' && (HISTORY_STYLES as readonly unknown[]).includes(style) ? (style as HistoryStyle) : agg === 'mean' ? 'line' : 'bars');
/** A validated history widget with every default filled in. */
export function historySpec(w: W): HistorySpec {
  const windowMs = parseSpan(w.window ?? WINDOW_DEFAULT) as number, src = historySource(w);
  const fc = src === 'forecast' ? (String(w.forecast ?? 'hourly') as 'hourly' | 'daily') : undefined;
  const bucketMs = w.bucket !== undefined ? (parseSpan(w.bucket) as number) : (defaultBucket(windowMs, Number(w.cs) || 1, fc ? FORECAST_STEP[fc] : 0) as number);
  const agg = (w.agg ?? 'mean') as HistoryAgg;
  const out: HistorySpec = { entity: String(w.entity), windowMs, bucketMs, n: windowMs / bucketMs, agg, style: resolveStyle(agg, w.style), min: w.min === undefined ? null : numOf(w.min), max: w.max === undefined ? null : numOf(w.max) };
  if (w.threshold !== undefined) out.threshold = numOf(w.threshold) as number;
  if (w.labels === 'true') out.labels = true;
  if (src === 'recorder') return out;
  // an attribute or forecast series looks ahead by default (a nowcast, a forecast): the whole window from now
  out.aheadMs = w.ahead !== undefined ? (aheadOf(w.ahead) as number) : windowMs;
  out.source = { kind: src, attribute: src === 'forecast' ? 'forecast' : String(w.attribute), value: String(w.value ?? (fc ? 'temperature' : 'value')), time: String(w.time ?? 'datetime'), ...(fc ? { forecast: fc } : {}) };
  return out;
}

// ---------- data source ----------

/** recorder/statistics_during_period `period` for a bucket; null = below 5 min, history rows only. */
export const statsPeriod = (bucketMs: number): '5minute' | 'hour' | 'day' | null => (bucketMs < 5 * MIN ? null : bucketMs < HOUR ? '5minute' : bucketMs < DAY ? 'hour' : 'day');
/** The one statistics type an agg needs (`last` reads the mean of the last row). */
export const statsType = (agg: HistoryAgg): 'mean' | 'min' | 'max' | 'change' => (agg === 'last' ? 'mean' : agg);
/** May this tile fall back to history/history_during_period when the entity has no statistics? */
export const historyFallbackOk = (s: HistorySpec): boolean => s.windowMs <= HISTORY_FALLBACK_MAX;

/** Start of the bucket holding `t`, aligned to local time (UTC + tz minutes). */
export const bucketStart = (t: number, bucketMs: number, tz: number): number => {
  const off = tz * MIN;
  return Math.floor((t + off) / bucketMs) * bucketMs - off;
};
export type SpanOpts = Pick<HistorySpec, 'windowMs' | 'bucketMs' | 'aheadMs'>;
/** The chart's span: `n` buckets. Without `aheadMs` the last one is open and holds `now`; with it (#283) the bucket
 *  holding `now` starts the last `aheadMs` of the window (aheadMs = windowMs: the first bucket holds now). */
export function chartSpan(s: SpanOpts, now: number, tz: number): { start: number; end: number } {
  const b = bucketStart(now, s.bucketMs, tz);
  const start = s.aheadMs ? b - (s.windowMs - s.aheadMs) : b + s.bucketMs - s.windowMs;
  return { start, end: start + s.windowMs };
}

export type Series = { start: number; bucketMs: number; values: (number | null)[] };
export type BucketOpts = Pick<HistorySpec, 'windowMs' | 'bucketMs' | 'agg' | 'aheadMs'>;

/** A statistics row as HA sends it (start / end in ms); the field named by statsType(agg) is read. */
export type StatRow = { start: number; end?: number; mean?: number | null; min?: number | null; max?: number | null; change?: number | null };
/** Buckets from statistics rows of the period statsPeriod() asked for. A row belongs to the bucket its start falls in.
 *  mean: weighted by row length; min / max: of the rows; change: sum; last: the mean of the latest row. No row = null. */
export function fromStatistics(rows: StatRow[], o: BucketOpts, now: number, tz: number): Series {
  const { start, end } = chartSpan(o, now, tz), n = o.windowMs / o.bucketMs, type = statsType(o.agg);
  const acc: { sum: number; w: number; v: number | null; at: number }[] = Array.from({ length: n }, () => ({ sum: 0, w: 0, v: null, at: -Infinity }));
  for (const r of rows) {
    const v = r[type];
    if (typeof v !== 'number' || !Number.isFinite(v) || r.start < start || r.start >= end) continue;
    const a = acc[Math.floor((r.start - start) / o.bucketMs)];
    if (o.agg === 'mean') { const w = (r.end ?? r.start) - r.start || 1; a.sum += v * w; a.w += w; }
    else if (o.agg === 'last') { if (r.start > a.at) { a.v = v; a.at = r.start; } }
    else a.v = a.v === null ? v : o.agg === 'min' ? Math.min(a.v, v) : o.agg === 'max' ? Math.max(a.v, v) : a.v + v;
  }
  return { start, bucketMs: o.bucketMs, values: acc.map((a) => (o.agg === 'mean' ? (a.w ? a.sum / a.w : null) : a.v)) };
}

/** A state change: value from `t` on; null = unavailable / unknown / not a number (a gap). */
export type Point = { t: number; v: number | null };
const STATE_NUM = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
/** history/history_during_period rows (minimal_response + no_attributes: {s, lu} with lu in seconds) → points. */
export const fromHistoryRows = (rows: { s: string; lu: number }[]): Point[] =>
  rows.map((r) => ({ t: Math.round(r.lu * 1000), v: STATE_NUM.test(r.s) ? Number(r.s) : null })).sort((a, b) => a.t - b.t);

/** Buckets from state changes as a time-weighted step function (as HA computes statistics). Each value holds until the
 *  next point, the last one until `now`; time before the first point and gap values count as no data.
 *  mean: weighted by time; min / max: of the values held inside the bucket (a value carried in counts);
 *  last: the value held at the bucket's end (or at `now` for the open bucket); change: the last value held in the
 *  bucket minus the last value held before it (or the first one in it). A bucket with no data = null. */
export function bucketize(points: Point[], o: BucketOpts, now: number, tz: number): Series {
  const { start } = chartSpan(o, now, tz), n = o.windowMs / o.bucketMs;
  const pts = [...points].sort((a, b) => a.t - b.t);
  const values: (number | null)[] = [];
  let carried: number | null = null;   // last non-gap value held before the current bucket (change)
  for (const p of pts) if (p.t < start && p.v !== null) carried = p.v;
  for (let i = 0; i < n; i++) {
    const a = start + i * o.bucketMs, e = Math.min(a + o.bucketMs, now);
    let sum = 0, dt = 0, lo: number | null = null, hi: number | null = null, endV: number | null = null, lastHeld: number | null = null;
    for (let k = 0; k < pts.length; k++) {
      const s0 = Math.max(pts[k].t, a), s1 = Math.min(k + 1 < pts.length ? pts[k + 1].t : now, e);
      if (s1 <= s0) continue;
      const v = pts[k].v;
      endV = v;
      if (v === null) continue;
      sum += v * (s1 - s0); dt += s1 - s0; lastHeld = v;
      lo = lo === null ? v : Math.min(lo, v); hi = hi === null ? v : Math.max(hi, v);
    }
    let out: number | null = null;
    if (e > a && dt > 0) {
      if (o.agg === 'mean') out = sum / dt;
      else if (o.agg === 'min') out = lo;
      else if (o.agg === 'max') out = hi;
      else if (o.agg === 'last') out = endV;
      else out = (lastHeld as number) - (carried ?? firstHeld(pts, a, e) ?? (lastHeld as number));
    }
    values.push(out);
    if (lastHeld !== null) carried = lastHeld;
  }
  return { start, bucketMs: o.bucketMs, values };
}
// ---------- attribute / forecast series (#283) ----------

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** An entry's time → epoch ms: ISO 8601 ("2026-10-26T14:05:00+01:00", "…Z", "2026-10-26 14:05", "2026-10-26"; no
 *  offset = local time) or a number (epoch seconds below 1e11, else ms). Anything else → null. */
export function parseTime(v: unknown, tz: number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e11 ? Math.round(v * 1000) : Math.round(v)) : null;
  const m = typeof v === 'string' ? v.trim().match(ISO) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  let off = tz;
  if (m[7] === 'Z') off = 0;
  else if (m[7]) { const z = m[7].replace(':', ''); off = (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5))); }
  return Date.UTC(y, mo - 1, d, h, mi, se) - off * MIN;
}

/** A sample: a value at a time (an attribute or forecast entry; not held until the next one). */
export type Sample = { t: number; v: number };
/** Samples from an attribute value (or a weather.get_forecasts `forecast` list): a list, or a JSON string of one.
 *  Objects: time from `src.time`, value from `src.value`; an entry without a valid time or a number is skipped.
 *  Plain numbers: one per bucket, the first in the bucket holding now. Anything else → []. */
export function attrSamples(raw: unknown, src: Pick<SourceSpec, 'value' | 'time'>, bucketMs: number, now: number, tz: number): Sample[] {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const t0 = bucketStart(now, bucketMs, tz), out: Sample[] = [];
  list.forEach((e, i) => {
    if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
      const t = parseTime((e as Record<string, unknown>)[src.time], tz), v = numOf((e as Record<string, unknown>)[src.value]);
      if (t !== null && v !== null && Number.isFinite(v)) out.push({ t, v });
    } else {
      const v = numOf(e);
      if (v !== null && Number.isFinite(v)) out.push({ t: t0 + i * bucketMs, v });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}
/** Buckets from samples: a sample belongs to the bucket its time falls in (fromStatistics with one-instant rows).
 *  mean: average of the samples; min / max; last: the latest sample; change: their sum. No sample = null. */
export const fromSamples = (samples: Sample[], o: BucketOpts, now: number, tz: number): Series =>
  fromStatistics(samples.map((p) => ({ start: p.t, mean: p.v, min: p.v, max: p.v, change: p.v })), o, now, tz);

/** The first non-gap value held inside [a, e). */
function firstHeld(pts: Point[], a: number, e: number): number | null {
  for (let k = 0; k < pts.length; k++) {
    const s1 = k + 1 < pts.length ? pts[k + 1].t : Infinity;
    if (pts[k].v !== null && Math.max(pts[k].t, a) < Math.min(s1, e)) return pts[k].v;
  }
  return null;
}

// ---------- chart ----------

/** Y range. Bars start from zero (the range always holds 0); other styles auto-range over the data with 10 % padding.
 *  A threshold (#304) counts as data when there is data. A configured min / max replaces its side. No data: 0–1. A
 *  flat line: value ± 1. */
export function yScale(values: (number | null)[], style: HistoryStyle, min: number | null = null, max: number | null = null, threshold: number | null = null): { lo: number; hi: number } {
  const d = values.filter((v): v is number => v !== null);
  if (d.length && threshold !== null) d.push(threshold);
  let lo = d.length ? Math.min(...d) : 0, hi = d.length ? Math.max(...d) : 1;
  if (d.length && style === 'bars') { lo = Math.min(0, lo); hi = Math.max(0, hi); if (lo === hi) hi = 1; }
  else if (d.length && lo === hi) { lo -= 1; hi += 1; }
  else if (d.length) { const pad = (hi - lo) * 0.1; lo -= pad; hi += pad; }
  if (min !== null) lo = min;
  if (max !== null) hi = max;
  if (lo >= hi) { if (min !== null) hi = lo + 1; else lo = hi - 1; }
  return { lo, hi };
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const local = (t: number, tz: number): Date => new Date(t + tz * MIN);
/** "Mo" / "Ma": the first two letters of the day name. */
const dayAbbr = (lang: Lang, wday: number): string => tr(lang, ('day' + wday) as StrKey).slice(0, 2);
/** Time of a bucket for the low / high label: "14:00", or "Tu 14:00" for windows over 48 h. */
export function pointTime(t: number, windowMs: number, tz: number, lang: Lang): string {
  const d = local(t, tz), hm = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  return windowMs > 2 * DAY ? dayAbbr(lang, d.getUTCDay()) + ' ' + hm : hm;
}

export type Extreme = { i: number; v: number; t: number; time: string };
/** Lowest and highest bucket (the earliest on a tie), with the bucket's start time; null when there is no data. */
export function lowHigh(s: Series, windowMs: number, tz: number, lang: Lang): { low: Extreme; high: Extreme } | null {
  let lo = -1, hi = -1;
  s.values.forEach((v, i) => {
    if (v === null) return;
    if (lo < 0 || v < (s.values[lo] as number)) lo = i;
    if (hi < 0 || v > (s.values[hi] as number)) hi = i;
  });
  if (lo < 0) return null;
  const ex = (i: number): Extreme => { const t = s.start + i * s.bucketMs; return { i, v: s.values[i] as number, t, time: pointTime(t, windowMs, tz, lang) }; };
  return { low: ex(lo), high: ex(hi) };
}

/** Low / high of one day in n equal buckets from local midnight (the price chart, #260): times "03:00" / "03:15". */
export function dayLowHigh(values: (number | null)[], lang: Lang): { low: Extreme; high: Extreme } | null {
  return values.length ? lowHigh({ start: 0, bucketMs: Math.floor(DAY / values.length), values }, DAY, 0, lang) : null;
}

export type Tick = { x: number; text: string };
/** X axis labels, x = 0…1 across the chart span. Windows ≤ 3 h: minutes before now ("-60 -30 Now"), and with
 *  `aheadMs` (#283) also after it ("Now +30 +60"), the smallest step with ≤ 5 ticks; ≤ 48 h: round local hours
 *  ("06 12 18"); longer: each local midnight with the day it starts ("Mo Tu …"). */
export function axisTicks(s: SpanOpts, now: number, tz: number, lang: Lang): Tick[] {
  const { start, end } = chartSpan(s, now, tz), w = s.windowMs, x = (t: number) => (t - start) / w;
  const out: Tick[] = [];
  if (w <= 3 * HOUR) {
    const after = (st: number) => (s.aheadMs ? Math.floor((end - now) / st) : 0);
    const step = [5, 10, 15, 30, 60].map((m) => m * MIN).find((st) => Math.floor((now - start) / st) + 1 + after(st) <= 5) as number;
    for (let t = now; t >= start; t -= step) out.unshift({ x: x(t), text: t === now ? tr(lang, 'now') : '-' + Math.round((now - t) / MIN) });
    for (let k = 1; k <= after(step); k++) out.push({ x: x(now + k * step), text: '+' + k * step / MIN });
    return out;
  }
  if (w <= 2 * DAY) {
    const ticksAt = (st: number) => { const r: number[] = []; for (let t = bucketStart(start, st, tz) + st; t < end; t += st) if (t > start) r.push(t); return r; };
    const step = [1, 2, 3, 6, 12, 24].map((h) => h * HOUR).find((st) => ticksAt(st).length <= 5) as number;
    for (const t of ticksAt(step)) out.push({ x: x(t), text: p2(local(t, tz).getUTCHours()) });
    return out;
  }
  for (let t = bucketStart(start, DAY, tz) + DAY; t < end; t += DAY) out.push({ x: x(t), text: dayAbbr(lang, local(t, tz).getUTCDay()) });
  return out;
}
