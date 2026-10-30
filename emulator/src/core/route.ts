// Route tile departures from an HA entity's attributes (spec/SCHEMA.md "Route sensors", eink-ha-os#145, eink-ha-os#275).
// = firmware core/home.cpp routeState(); vectors: spec/test-vectors/route-departures.json.
import { tr, type Lang } from './strings.ts';

export type RouteDeparture = { time: string; delay: number; cancelled: boolean; info: string };

const p2 = (n: number) => String(n).padStart(2, '0');
const hm = (min: number) => p2(Math.floor(min / 60) % 24) + ':' + p2(min % 60);

/** A list attribute: a list, or a JSON string of one (the HA stream keeps non-scalar attributes as JSON text). */
function listOf(v: unknown): unknown[] | null {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v : null;
}

/** ISO 8601 → epoch ms; no offset = local wall time (UTC + tz minutes). NaN on error. */
export function isoMs(s: unknown, tz: number): number {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(.*)$/.exec(s);
  if (!m) return NaN;
  const civil = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) + Math.trunc(+(m[6] ?? 0)) * 1000;
  const z = m[7];
  if (!z) return civil - tz * 60000;
  if (z[0] === 'Z' || z[0] === 'z') return civil;
  const o = /^[+-](\d{2}):?(\d{2})?/.exec(z);
  if (!o) return NaN;
  const off = (+o[1] * 60 + +(o[2] ?? 0)) * (z[0] === '+' ? 1 : -1);
  return civil - off * 60000;
}

/** Local minute of day of an epoch (ms) at UTC offset tz minutes. */
const minuteOf = (ms: number, tz: number) => ((Math.floor(ms / 60000) + tz) % 1440 + 1440) % 1440;

/** A number attribute: a number, or the text of one (the HA stream keeps scalars as text). NaN otherwise. */
function numOf(v: unknown): number {
  if (typeof v === 'number') return v;
  return typeof v === 'string' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) ? Number(v) : NaN;
}
const textOf = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** One departure from a single-departure entity (ha-paper#22, the OVapi integration): a timestamp state with
 *  `scheduled_time` (its "departure time" sensors), or `expected_arrival` / `target_arrival` (its "vehicle" sensors, local ISO).
 *  time = local HH:MM of the state (else expected_arrival, else the scheduled time); delay = `delay_minutes` (an early
 *  bus is negative: 0), else
 *  expected − scheduled (≥ 0); info = "‹line_number› · ‹destination›". Neither time → null. */
export function departureOf(state: string, attrs: Record<string, unknown>, tz: number): RouteDeparture | null {
  const atState = isoMs(state, tz), atAttr = isoMs(attrs.expected_arrival, tz);
  const actual = Number.isNaN(atState) ? atAttr : atState;
  const sched = isoMs(attrs.scheduled_time, tz), target = isoMs(attrs.target_arrival, tz);
  const planned = Number.isNaN(sched) ? target : sched;
  const t = Number.isNaN(actual) ? planned : actual;
  if (Number.isNaN(t)) return null;
  const dm = numOf(attrs.delay_minutes);
  const delay = !Number.isNaN(dm) ? Math.max(0, dm) : Number.isNaN(actual) || Number.isNaN(planned) ? 0 : Math.max(0, Math.round((actual - planned) / 60000));
  const info = [textOf(attrs.line_number), textOf(attrs.destination)].filter(Boolean).join(' · ');
  return { time: hm(minuteOf(t, tz)), delay, cancelled: false, info };
}

/** A route tile's departures: `entity`'s, then `entity2`'s (ha-paper#22) unless that one has no state (empty,
 *  unavailable, unknown). The caller shows the gap state when `entity` itself has none. */
export function routeDeparturesOf(ents: { state: string; attrs: Record<string, unknown> }[], tz: number, lang: Lang): RouteDeparture[] {
  return ents.filter((e, i) => i === 0 || (e.state !== '' && e.state !== 'unknown' && e.state !== 'unavailable'))
    .flatMap((e) => routeDepartures(e.attrs, tz, lang, e.state));
}

/** Train/bus departures, upcoming first. `departures: [{time "HH:MM", delay, cancelled, info}]` wins; else the NS
 *  departures integration's `upcoming: [{planned, actual, delay, track, direction, status, …}]` (ISO timestamps):
 *  time = local HH:MM of actual (else planned), delay = `delay` minutes (else actual − planned, ≥ 0),
 *  cancelled = status "cancelled", info = "Track ‹n› · ‹direction›". Neither list: the entity as one departure
 *  (departureOf, `state` = the entity's state). tz = local UTC offset in minutes. */
export function routeDepartures(attrs: Record<string, unknown>, tz: number, lang: Lang, state = ''): RouteDeparture[] {
  const out: RouteDeparture[] = [];
  const deps = listOf(attrs.departures);
  if (deps) {
    for (const x of deps) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      if (typeof o.time !== 'string') continue;
      const c = o.time.indexOf(':');
      if (c < 0) continue;
      const min = (parseInt(o.time.slice(0, c), 10) || 0) * 60 + (parseInt(o.time.slice(c + 1), 10) || 0);
      out.push({ time: hm(min), delay: typeof o.delay === 'number' ? o.delay : 0, cancelled: o.cancelled === true, info: typeof o.info === 'string' ? o.info : '' });
    }
    return out;
  }
  const up = listOf(attrs.upcoming);
  if (!up) {
    const one = departureOf(state, attrs, tz);
    return one ? [one] : [];
  }
  for (const x of up) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const planned = isoMs(o.planned, tz), actual = isoMs(o.actual, tz);
    const t = Number.isNaN(actual) ? planned : actual;
    if (Number.isNaN(t)) continue;
    const delay = typeof o.delay === 'number' ? o.delay
      : Number.isNaN(actual) || Number.isNaN(planned) ? 0 : Math.max(0, Math.round((actual - planned) / 60000));
    const track = typeof o.track === 'string' ? o.track : '';
    const dir = typeof o.direction === 'string' ? o.direction : '';
    const info = [track ? tr(lang, 'routeTrack', track) : '', dir].filter(Boolean).join(' · ');
    out.push({ time: hm(minuteOf(t, tz)), delay, cancelled: o.status === 'cancelled', info });
  }
  return out;
}
