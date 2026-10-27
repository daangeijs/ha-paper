// Today's energy from the recorder (#308): recorder/statistics_during_period (period hour, types [change], from local
// midnight) → the *_today totals and the 24-hour series of sensor.solar_hourly / sensor.energy_usage_hourly, plus the
// local day change that restarts them. Pure; firmware EntityAdapter::setHourlyStatistics / rollDay in
// core/entity_map.cpp must match spec/test-vectors/energy-hourly.json. Times are epoch ms, `tz` the local UTC offset in
// minutes (the firmware uses localtime()).
import type { Meters } from './energyPrefs.ts';

const MIN = 60000, DAY = 86400000;

export const SOLAR_TODAY = 'sensor.solar_today', IMPORT_TODAY = 'sensor.grid_import_today', EXPORT_TODAY = 'sensor.grid_export_today';
export const ENERGY_TODAY = 'sensor.energy_today', USAGE_HOURLY = 'sensor.energy_usage_hourly', SOLAR_HOURLY = 'sensor.solar_hourly';
const SERIES = [USAGE_HOURLY, SOLAR_HOURLY];

/** Local day number of an epoch (ms). */
export const localDay = (t: number, tz: number): number => Math.floor((t + tz * MIN) / DAY);
const localHour = (t: number, tz: number): number => Math.floor((((t + tz * MIN) % DAY) + DAY) % DAY / 3600000);

/** Recorder `start`: ms (HA 2023.3+), seconds, or ISO text with an offset. null when unusable. */
function startMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? Math.trunc(v) : v * 1000;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

/** logical id → value: state in kWh, `today` = 24 × kWh for the two hourly series. */
export type StatOut = Record<string, { state: number; today?: number[] }>;

const round = (v: number, d: number): number => { const p = 10 ** d, r = Math.round(v * p) / p; return r === 0 ? 0 : r; };
const total = (h: number[]): number => h.reduce((a, b) => a + b, 0);

/** Only rows of the local day of `now` count: an answer to a request sent before midnight that lands after it
 * carries yesterday's hours, and those must not fill today's bars. A role without any meter in the answer emits
 * nothing (HA omits ids without rows). */
export function hourlyStatistics(stats: unknown, m: Meters, now: number, tz: number): StatOut {
  const out: StatOut = {};
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return out;
  const day = localDay(now, tz), hours = new Map<string, number[]>();
  for (const [id, rows] of Object.entries(stats as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const h = Array(24).fill(0);
    for (const r of rows) {
      const t = startMs(r?.start), c = r?.change;
      if (t === null || typeof c !== 'number') continue;
      if (localDay(t, tz) !== day) continue;
      h[localHour(t, tz)] += c;
    }
    hours.set(id, h);
  }
  const sumOf = (meters: string[]) => {
    const h = Array(24).fill(0);
    let any = false;
    for (const id of meters) { const x = hours.get(id); if (!x) continue; any = true; for (let i = 0; i < 24; i++) h[i] += x[i]; }
    return { h, any };
  };
  const s = sumOf(m.solar), i = sumOf(m.imp), e = sumOf(m.exp), bo = sumOf(m.out), bi = sumOf(m.in);
  const series = (id: string, h: number[]) => { out[id] = { state: round(total(h), 2), today: h.map((x) => round(x, 3)) }; };
  if (s.any) { out[SOLAR_TODAY] = { state: round(total(s.h), 2) }; series(SOLAR_HOURLY, s.h); }
  if (i.any) out[IMPORT_TODAY] = { state: round(total(i.h), 2) };
  if (e.any) out[EXPORT_TODAY] = { state: round(total(e.h), 2) };
  if (s.any || i.any) {
    const use = s.h.map((x, k) => Math.max(0, x + i.h[k] - e.h[k] + bo.h[k] - bi.h[k]));
    out[ENERGY_TODAY] = { state: round(total(use), 2) };
    series(USAGE_HOURLY, use);
  }
  return out;
}

/** Day change (#308): `lastDay` = local day of the last statistics answer (null = none yet). Another local day now →
 * every id the statistics fed restarts at 0 (series: 24 zeros) and the device asks the recorder again right away,
 * instead of drawing yesterday's 24 bars against today's hours until the next 10-minute refresh. Also after a deep
 * sleep across midnight. now 0 = clock unknown: no roll. */
export function statsDayRoll(lastDay: number | null, owned: string[], now: number, tz: number): { roll: boolean; out: StatOut } {
  const out: StatOut = {};
  if (lastDay === null || now <= 0 || localDay(now, tz) === lastDay) return { roll: false, out };
  for (const id of owned) out[id] = SERIES.includes(id) ? { state: 0, today: Array(24).fill(0) } : { state: 0 };
  return { roll: true, out };
}
