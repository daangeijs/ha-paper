// Recorder data for the fake HA (eink-ha-os#266, plan in eink-ha-os#264): `recorder/statistics_during_period` and
// `history/history_during_period`, generated from deterministic seeded series (same seed + same time = same answer).
//
// Response shapes follow HA core (dev, 2026-10):
//   statistics: homeassistant/components/recorder/websocket_api.py ws_get_statistics_during_period /
//     _ws_get_statistics_during_period, and recorder/statistics.py _statistics_during_period_with_session,
//     _sorted_statistics_to_dict, _build_stats, _augment_result_with_change, _reduce_statistics_per_day.
//     result = {statistic_id: [{start, end, <type>…}]}, start/end = epoch *ms* ints; ids without statistics are absent
//     (all absent = {}); only the requested types appear, minus those no requested id can have (mean/min/max need a
//     mean type, sum/state need has_sum), null where one id lacks a type another has; "change" = sum − previous sum
//     (sum dropped unless asked); rows start at or after start_time (5minute/hour) or at local midnight (day); a period
//     row exists once the period is compiled (end ≤ now). 5-minute statistics are kept 10 days (purge_keep_days).
//   history: homeassistant/components/history/websocket_api.py ws_get_history_during_period, and
//     recorder/history/__init__.py _sorted_states_to_dict + recorder/models/state.py row_to_compressed_state.
//     result = {entity_id: [row…]} (entities without rows absent). First row: {s, a, lu} (no "a" with no_attributes;
//     "lc" only when it differs from lu), lu = start_time when it is the include_start_time_state row. minimal_response:
//     later rows {s, lu} and only when s changed. lu = epoch *seconds* float. start_time in the future → {}.
//     Errors: invalid_start_time, invalid_end_time, invalid_entity_ids.
// Not modelled: week/month/year periods (answer {}), `units` conversion, significant_changes_only (every sensor
// change with a unit is significant anyway), attribute-only changes.

export type HistModel = 'temperature' | 'rain_rate' | 'rain_total' | 'delay' | 'power';
/** measurement: mean/min/max statistics; total: sum/state (total_increasing); none: no state_class, history only. */
export type HistKind = 'measurement' | 'total' | 'none';
export type HistEntity = { id: string; model: HistModel; kind: HistKind; name: string; unit: string; sampleS: number; dp: number };
export type HistCall = { type: string; ids: string[]; period?: string; types?: string[]; start_time: string; end_time?: string; rows: number; bytes: number; t: string };

const MODELS: Record<HistModel, { kind: HistKind; name: string; unit: string; sampleS: number; dp: number; dc?: string }> = {
  temperature: { kind: 'measurement', name: 'Outdoor temperature', unit: '°C', sampleS: 300, dp: 1, dc: 'temperature' },
  rain_rate: { kind: 'measurement', name: 'Rain rate', unit: 'mm/h', sampleS: 300, dp: 1, dc: 'precipitation_intensity' },
  rain_total: { kind: 'total', name: 'Rain total', unit: 'mm', sampleS: 60, dp: 1, dc: 'precipitation' },
  delay: { kind: 'none', name: 'Train delay', unit: 'min', sampleS: 60, dp: 0 },
  power: { kind: 'measurement', name: 'Chatty power', unit: 'W', sampleS: 1, dp: 0, dc: 'power' },
};
export const DEFAULT_HISTORY: [string, HistModel][] = [
  ['sensor.outdoor_temperature', 'temperature'], ['sensor.rain_rate', 'rain_rate'], ['sensor.rain_total', 'rain_total'], ['sensor.train_delay', 'delay'],
];
/** 1 Hz changes: 24 h of history ≈ 2.8 MB, a 6 h slice ≈ 0.7 MB, both above the firmware's 512 KB frame cap. */
export const CHATTY_ID = 'sensor.chatty_power';
export function histEntity(id: string, model: HistModel, kind?: HistKind): HistEntity {
  const m = MODELS[model]; return { id, model, kind: kind ?? m.kind, name: m.name, unit: m.unit, sampleS: m.sampleS, dp: m.dp };
}

const DAY = 86400, KEEP_S = 10 * DAY, LONG_S = 365 * DAY;
const ORIGIN = Date.UTC(2026, 0, 1) / 1000;   // rain gauge installed: the counter's cumulative sum starts here
const METER_START = 1234.5;                     // rain gauge reading at ORIGIN (state ≠ sum, like a real meter)
const PERIOD_S: Record<string, number> = { '5minute': 300, hour: 3600 };

function mix(a: number, b: number, c: number): number {   // deterministic [0, 1)
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function strHash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const round = (v: number, dp: number) => Number(v.toFixed(dp));

/** Offset (ms) of `tz` from UTC at `ms`. */
function tzOffset(tz: string, ms: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** Local midnight (s) of the day holding `t` (s) in `tz`. */
export function localMidnight(tz: string, t: number): number {
  const ms = t * 1000, day = Math.floor((ms + tzOffset(tz, ms)) / 86400000) * 86400000;
  return (day - tzOffset(tz, day - tzOffset(tz, ms))) / 1000;
}

export class FakeHistory {
  seed = 42;
  entities = new Map<string, HistEntity>();
  calls: HistCall[] = [];
  private cum: number[] = [0];   // rain gauge mm at ORIGIN + k·300 s

  constructor() { for (const [id, model] of DEFAULT_HISTORY) this.entities.set(id, histEntity(id, model)); }
  get chatty() { return this.entities.has(CHATTY_ID); }
  set chatty(on: boolean) { if (on) this.entities.set(CHATTY_ID, histEntity(CHATTY_ID, 'power')); else this.entities.delete(CHATTY_ID); }
  record(c: HistCall) { this.calls.push(c); if (this.calls.length > 200) this.calls.shift(); }

  attributes(e: HistEntity): Record<string, unknown> {
    const m = MODELS[e.model];
    return { ...(e.kind === 'none' ? {} : { state_class: e.kind === 'total' ? 'total_increasing' : 'measurement' }), unit_of_measurement: e.unit, ...(m.dc ? { device_class: m.dc } : {}), friendly_name: e.name };
  }

  // ------------------------------------------------------------ series: value(t) of a sample at t (s); null = unavailable
  private rainRate(t: number): number {
    const slot = Math.floor(t / 300), block = Math.floor(t / 25200), s = this.seed;   // 7 h weather blocks
    if (mix(s, 1, block) >= 0.35) return 0;
    const from = block * 25200 + 3600 * (1 + 2 * mix(s, 2, block)), dur = 3600 * (0.5 + 2.5 * mix(s, 3, block)), peak = 0.5 + 6 * mix(s, 4, block);
    const x = (slot * 300 - from) / dur; if (x < 0 || x > 1) return 0;
    return round(peak * (1 - Math.abs(2 * x - 1)) * (0.7 + 0.6 * mix(s, 5, slot)), 1);
  }
  /** Rain gauge mm since ORIGIN: the integral of rainRate (5-minute slots, cached prefix sums). */
  private rainCum(t: number): number {
    const k = Math.max(0, Math.floor((t - ORIGIN) / 300));
    while (this.cum.length <= k) { const i = this.cum.length - 1; this.cum.push(this.cum[i] + this.rainRate(ORIGIN + i * 300) / 12); }
    return this.cum[k] + this.rainRate(ORIGIN + k * 300) * Math.max(0, t - ORIGIN - k * 300) / 3600;
  }
  value(e: HistEntity, t: number): number | null {
    const s = this.seed, k = Math.floor(t / e.sampleS), n = mix(s, strHash(e.id), k);
    switch (e.model) {
      case 'temperature': return round(10 + 5 * Math.sin(2 * Math.PI * (t / DAY - 0.375)) + 1.5 * Math.sin(2 * Math.PI * t / (3.3 * DAY)) + 0.4 * (n - 0.5), 1);
      case 'rain_rate': return this.rainRate(t);
      case 'rain_total': return round(Math.floor((METER_START + this.rainCum(t)) * 5 + 1e-9) / 5, 1);   // 0.2 mm tipping bucket
      case 'delay': {   // no trains 01:00–05:00 UTC; otherwise mostly on time, now and then 2–15 min late per 30 min
        if (((t % DAY) + DAY) % DAY < 4 * 3600 && ((t % DAY) + DAY) % DAY >= 3600) return null;
        const slot = Math.floor(t / 1800);
        return mix(s, 7, slot) < 0.25 ? Math.round(2 + 13 * mix(s, 8, slot)) : 0;
      }
      case 'power': return Math.round(450 + 250 * Math.sin(2 * Math.PI * t / DAY) + 120 * n);
    }
  }
  private str(e: HistEntity, v: number | null) { return v == null ? 'unavailable' : v.toFixed(e.dp); }
  /** Sample time k: on the sample grid plus a fixed per-entity sub-second offset (HA stores µs). */
  private at(e: HistEntity, k: number) { return k * e.sampleS + Math.floor(mix(this.seed, strHash(e.id), -1) * 1e6) / 1e6 * Math.min(1, e.sampleS); }
  /** Samples with from < t ≤ to, as [t, value]. */
  private *samples(e: HistEntity, from: number, to: number): Generator<[number, number | null]> {
    let k = Math.floor(from / e.sampleS) - 1;
    while (this.at(e, k) <= from) k++;
    for (; this.at(e, k) <= to; k++) yield [this.at(e, k), this.value(e, this.at(e, k))];
  }
  private valueAt(e: HistEntity, t: number) { let k = Math.floor(t / e.sampleS); if (this.at(e, k) > t) k--; return this.value(e, this.at(e, k)); }

  // ------------------------------------------------------------ history/history_during_period
  history(m: any, nowMs: number, exists: (id: string) => boolean): { result: Record<string, unknown[]> } | { error: [string, string] } {
    const start = parseTime(m.start_time); if (start == null) return { error: ['invalid_start_time', 'Invalid start_time'] };
    let end: number | null = null;
    if (m.end_time) { end = parseTime(m.end_time); if (end == null) return { error: ['invalid_end_time', 'Invalid end_time'] }; }
    const now = nowMs / 1000;
    if (start > now) return { result: {} };
    const ids: string[] = Array.isArray(m.entity_ids) ? m.entity_ids.map(String) : [];
    if (ids.some((id) => !exists(id) && !/^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$/.test(id))) return { error: ['invalid_entity_ids', 'Invalid entity_ids'] };
    const to = Math.min(end ?? now, now), keep = now - KEEP_S;
    const minimal = !!m.minimal_response, noAttr = !!m.no_attributes, withStart = m.include_start_time_state !== false;
    const result: Record<string, unknown[]> = {};
    for (const id of ids) {
      const e = this.entities.get(id); if (!e || to <= keep) continue;
      const rows: Record<string, unknown>[] = []; let prev: string | null = null;
      const full = (s: string, lu: number) => ({ s, ...(noAttr ? {} : { a: this.attributes(e) }), lu });
      const from = Math.max(start, keep);
      if (withStart && start >= keep) { prev = this.str(e, this.valueAt(e, start)); rows.push(full(prev, start)); }
      for (const [t, v] of this.samples(e, from, to)) {
        const s = this.str(e, v); if (s === prev) continue;
        rows.push(!minimal || !rows.length ? full(s, t) : { s, lu: t }); prev = s;
      }
      if (rows.length) result[id] = rows;
    }
    return { result };
  }

  // ------------------------------------------------------------ recorder/statistics_during_period
  statistics(m: any, nowMs: number, tz: string): { result: Record<string, Record<string, number | null>[]> } | { error: [string, string] } {
    const start = parseTime(m.start_time); if (start == null) return { error: ['invalid_start_time', 'Invalid start_time'] };
    let end: number | null = null;
    if (m.end_time) { end = parseTime(m.end_time); if (end == null) return { error: ['invalid_end_time', 'Invalid end_time'] }; }
    const ids: string[] = Array.isArray(m.statistic_ids) ? m.statistic_ids.map(String) : [];
    const period = String(m.period ?? '');
    if (!ids.length || !['5minute', 'hour', 'day', 'week', 'month', 'year'].includes(period)) return { error: ['invalid_format', "expected a non-empty statistic_ids and period 5minute|hour|day|week|month|year"] };
    const asked = new Set<string>(Array.isArray(m.types) ? m.types.map(String) : ['change', 'last_reset', 'max', 'mean', 'min', 'state', 'sum']);
    const ents = ids.map((id) => this.entities.get(id)).filter((e): e is HistEntity => !!e && e.kind !== 'none');
    if (!ents.length || (!(period in PERIOD_S) && period !== 'day')) return { result: {} };
    const types = new Set([...asked].map((t) => (t === 'change' ? 'sum' : t)));
    if (!ents.some((e) => e.kind === 'measurement')) for (const t of ['mean', 'min', 'max']) types.delete(t);
    if (!ents.some((e) => e.kind === 'total')) for (const t of ['sum', 'state']) types.delete(t);
    types.delete('last_reset');   // total_increasing: no last_reset column value worth modelling
    const now = nowMs / 1000, len = period === 'day' ? 3600 : PERIOD_S[period];
    const first = Math.max(Math.ceil((period === 'day' ? localMidnight(tz, start) : start) / len) * len, Math.ceil((now - (period === '5minute' ? KEEP_S : LONG_S)) / len) * len);
    const stop = end == null ? Infinity : period === 'day' ? localMidnight(tz, localMidnight(tz, end) + DAY + 12 * 3600) : end;   // HA: day end → next local midnight
    const result: Record<string, Record<string, number | null>[]> = {};
    for (const e of ents) {
      let rows: Record<string, number | null>[] = [];
      for (let s = first; s < stop && s + len <= now; s += len) { const r = this.bucket(e, s, s + len, types); if (r) rows.push(r); }
      if (period === 'day') rows = reduceDays(rows, types, tz);
      if (asked.has('change')) {
        let prev: number | null = e.kind === 'total' ? this.meterSum(e, rows.length ? rows[0].start! / 1000 : first) : null;
        for (const r of rows) {
          if (!('sum' in r)) continue;
          const sum = r.sum; if (!asked.has('sum')) delete r.sum;
          r.change = sum == null ? null : round(sum - (prev ?? 0), 3); if (sum != null) prev = sum;
        }
      }
      if (rows.length) result[e.id] = rows;
    }
    return { result };
  }
  /** total_increasing sum: growth of the state since the meter's first statistics (ORIGIN). */
  private meterSum(e: HistEntity, t: number) { return round((this.valueAt(e, t - 1e-6) ?? 0) - (this.valueAt(e, ORIGIN) ?? 0), 3); }
  /** One compiled period [s, e): time-weighted mean, min/max including the carried-in value; null outside the type. */
  private bucket(e: HistEntity, s: number, end: number, types: Set<string>): Record<string, number | null> | null {
    const r: Record<string, number | null> = { start: s * 1000, end: end * 1000 };
    if (e.kind === 'total') {
      const st = this.valueAt(e, end - 1e-6);   // last state of the period
      for (const t of ['mean', 'min', 'max']) if (types.has(t)) r[t] = null;
      if (types.has('state')) r.state = st;
      if (types.has('sum')) r.sum = this.meterSum(e, end);
      return r;
    }
    let v = this.valueAt(e, s), t0 = s, area = 0, covered = 0, lo = Infinity, hi = -Infinity;
    const add = (x: number | null, dt: number) => { if (x == null) return; area += x * dt; covered += dt; lo = Math.min(lo, x); hi = Math.max(hi, x); };
    for (const [t, x] of this.samples(e, s, end)) { add(v, t - t0); v = x; t0 = t; }
    add(v, end - t0);
    if (!covered) return null;   // unavailable all period: HA compiles no row
    if (types.has('mean')) r.mean = area / covered;
    if (types.has('min')) r.min = lo;
    if (types.has('max')) r.max = hi;
    for (const t of ['sum', 'state']) if (types.has(t)) r[t] = null;
    return r;
  }
}

/** HA _reduce_statistics_per_day: hourly rows → one row per local day, mean of means, min of mins, max of maxes, last state/sum. */
function reduceDays(rows: Record<string, number | null>[], types: Set<string>, tz: string): Record<string, number | null>[] {
  const out: Record<string, number | null>[] = [];
  let group: Record<string, number | null>[] = [];
  const flush = () => {
    if (!group.length) return;
    const d = localMidnight(tz, group[0].start! / 1000), r: Record<string, number | null> = { start: d * 1000, end: localMidnight(tz, d + DAY + 12 * 3600) * 1000 };
    const nums = (k: string) => group.map((g) => g[k]).filter((x): x is number => x != null);
    if (types.has('mean')) { const a = nums('mean'); r.mean = a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
    if (types.has('min')) { const a = nums('min'); r.min = a.length ? Math.min(...a) : null; }
    if (types.has('max')) { const a = nums('max'); r.max = a.length ? Math.max(...a) : null; }
    for (const k of ['state', 'sum']) if (types.has(k)) r[k] = group[group.length - 1][k];
    out.push(r); group = [];
  };
  for (const r of rows) {
    if (group.length && localMidnight(tz, r.start! / 1000) !== localMidnight(tz, group[0].start! / 1000)) flush();
    group.push(r);
  }
  flush();
  return out;
}

/** HA dt_util.parse_datetime: ISO 8601 → seconds since epoch; null = unparsable. A naive time is UTC here (HA: its time zone). */
function parseTime(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : v + 'Z');
  return Number.isNaN(ms) ? null : ms / 1000;
}
