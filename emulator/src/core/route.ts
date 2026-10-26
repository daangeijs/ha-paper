// Route tile departures from an HA entity's attributes (spec/SCHEMA.md "Route sensors", #145, #275).
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

/** Train/bus departures, upcoming first. `departures: [{time "HH:MM", delay, cancelled, info}]` wins; else the NS
 *  departures integration's `upcoming: [{planned, actual, delay, track, direction, status, …}]` (ISO timestamps):
 *  time = local HH:MM of actual (else planned), delay = `delay` minutes (else actual − planned, ≥ 0),
 *  cancelled = status "cancelled", info = "Track ‹n› · ‹direction›". tz = local UTC offset in minutes. */
export function routeDepartures(attrs: Record<string, unknown>, tz: number, lang: Lang): RouteDeparture[] {
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
  for (const x of listOf(attrs.upcoming) ?? []) {
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
