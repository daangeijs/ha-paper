// Weather tile (#318): a weather.* entity's condition and temperature, today's high / low / wind / "rain from", and a
// 5-day strip, from the entity's attributes and weather.get_forecasts (daily + hourly, asked once an hour). Pure; the
// firmware port is core/weather.cpp, vectors spec/test-vectors/weather.json.
import { entityGap, fmtNum, pad, type EntityGap } from './format.ts';
import { numOf, parseTime } from './history.ts';
import { tr, type Lang, type StrKey } from './strings.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const MAX_WEATHER_TILES = 2;
/** Entries kept per forecast: the daily list from today, the hourly list from the hour holding now. */
export const WX_DAILY = 7, WX_HOURLY = 16;
/** "Rain from" looks this far ahead in the hourly forecast. */
export const WX_RAIN_AHEAD = 12 * HOUR;
export const WX_DAYS = 5;
/** Forecasts are asked again after this (providers update about hourly; a glance wake reuses them). */
export const WX_REFRESH_MS = HOUR;

/** The drawings: about one per HA condition (`hail` shares sleet, `lightning-rainy` thunder, `windy-variant` wind). */
export const WX_ICONS = ['sun', 'moon', 'partly', 'cloud', 'fog', 'rain', 'pour', 'snow', 'sleet', 'thunder', 'wind', 'alert'] as const;
export type WxIcon = (typeof WX_ICONS)[number];
const COND: Record<string, [WxIcon, StrKey]> = {
  sunny: ['sun', 'wxSunny'], 'clear-night': ['moon', 'wxClearNight'], partlycloudy: ['partly', 'wxPartlyCloudy'], cloudy: ['cloud', 'wxCloudy'],
  fog: ['fog', 'wxFog'], rainy: ['rain', 'wxRainy'], pouring: ['pour', 'wxPouring'], snowy: ['snow', 'wxSnowy'], 'snowy-rainy': ['sleet', 'wxSnowyRainy'],
  hail: ['sleet', 'wxHail'], lightning: ['thunder', 'wxLightning'], 'lightning-rainy': ['thunder', 'wxLightningRainy'], windy: ['wind', 'wxWindy'],
  'windy-variant': ['wind', 'wxWindyVariant'], exceptional: ['alert', 'wxExceptional'],
};
const has = (k: string): boolean => Object.hasOwn(COND, k);
/** HA condition → drawing; an unknown condition draws the cloud. */
export const wxIcon = (cond: unknown): WxIcon => (typeof cond === 'string' && has(cond) ? COND[cond][0] : 'cloud');
/** HA condition → its name in `lang`; unknown → the text as HA sent it. */
export const wxCondText = (cond: string, lang: Lang): string => (has(cond) ? tr(lang, COND[cond][1]) : cond);
const WET: WxIcon[] = ['rain', 'pour', 'snow', 'sleet', 'thunder'];

/** Config rule beyond the entity's domain (config.ts): full width only. */
export function weatherError(w: Record<string, unknown>): string | null {
  return Number(w.cs ?? 1) !== 4 ? 'weather: needs the full width (cs: 4)' : null;
}

/** One forecast entry as kept (the firmware's 12-byte record): whole seconds, numbers to 2 decimals, null = absent. */
export type WxEntry = { t: number; icon: WxIcon; temp: number | null; low: number | null; mm: number | null };
const r2 = (v: number | null, lo: number, hi: number): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100);
const localDay = (t: number, tz: number): number => Math.floor((t + tz * MIN) / DAY);

/** A weather.get_forecasts `forecast` list (or JSON text of one) → entries: daily from today's local date, hourly from
 *  the hour holding now (an entry whose hour is over is skipped), at most WX_DAILY / WX_HOURLY, in HA's order. An entry
 *  without a valid `datetime` is skipped. */
export function wxEntries(raw: unknown, kind: 'daily' | 'hourly', now: number, tz: number): WxEntry[] {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const out: WxEntry[] = [], max = kind === 'daily' ? WX_DAILY : WX_HOURLY;
  for (const e of list) {
    if (out.length >= max) break;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>, t = parseTime(o.datetime, tz);
    if (t === null || (kind === 'daily' ? localDay(t, tz) < localDay(now, tz) : t + HOUR <= now)) continue;
    out.push({ t: Math.floor(t / 1000) * 1000, icon: wxIcon(o.condition), temp: r2(numOf(o.temperature), -327, 327), low: r2(numOf(o.templow), -327, 327), mm: r2(numOf(o.precipitation), 0, 655) });
  }
  return out;
}

export type WxDay = { name: string; icon: WxIcon; hi: string; lo: string; mm: string; bar: number };
export type WxView = { gap: EntityGap | null; icon: WxIcon; temp: string; cond: string; feels: string; high: string; low: string; wind: string; rain: string; days: WxDay[]; forecast: boolean };
export type WxInput = { state?: string | null; attrs: Record<string, unknown>; daily: WxEntry[] | null; hourly: WxEntry[] | null; now: number; tz: number; lang: Lang };

/** A temperature as the tile shows it: "12°", "—" when absent (also the quiet face, #328). */
export const wxDeg = (v: number | null): string => (v === null ? '—' : fmtNum(Math.round(v), '', 0) + '°');
/** Wet hour: precipitation > 0, or without precipitation a rain / snow / thunder drawing. */
export const wxWet = (e: WxEntry): boolean => (e.mm !== null ? e.mm > 0 : WET.includes(e.icon));

/** Wind: speed in HA's wind_speed_unit ("Beaufort" → "4 Bft", else "14 km/h"), then the bearing on 8 points
 *  (degrees, or a short text such as "SW" as is). No speed → "—". */
export function wxWind(attrs: Record<string, unknown>, lang: Lang): string {
  const v = numOf(attrs.wind_speed);
  if (v === null || !Number.isFinite(v)) return '—';
  const unit = typeof attrs.wind_speed_unit === 'string' ? attrs.wind_speed_unit : '';
  let s = unit === 'Beaufort' ? tr(lang, 'wxBft', fmtNum(Math.round(v), '', 0)) : fmtNum(Math.round(v), '', 0) + (unit ? ' ' + unit : '');
  const b = numOf(attrs.wind_bearing);
  if (b !== null && Number.isFinite(b)) s += ' ' + tr(lang, 'wxCompass').split(' ')[Math.round((((b % 360) + 360) % 360) / 45) % 8];
  else if (typeof attrs.wind_bearing === 'string' && /^[A-Za-z]{1,3}$/.test(attrs.wind_bearing)) s += ' ' + attrs.wind_bearing;
  return s;
}

/** Hourly forecast → "from 15:00" (local), "now" (the hour holding now is wet), "none soon" (dry for WX_RAIN_AHEAD),
 *  "—" without a forecast. Wet = precipitation > 0, or without precipitation a rain / snow / thunder condition. */
export function wxRain(hourly: WxEntry[] | null, now: number, tz: number, lang: Lang): string {
  if (!hourly) return '—';
  for (const e of hourly) {
    if (e.t + HOUR <= now || e.t >= now + WX_RAIN_AHEAD || !wxWet(e)) continue;
    if (e.t <= now) return tr(lang, 'wxRainNow');
    const m = Math.floor((e.t + tz * MIN) / MIN) % 1440;
    return tr(lang, 'wxRainFrom', pad(Math.floor(m / 60)) + ':' + pad(m % 60));
  }
  return tr(lang, 'wxRainNone');
}

/** Precipitation of a day: "" without, "dry" under 0.05, one decimal under 1, else whole. */
export function wxMm(mm: number | null, unit: string, lang: Lang): string {
  if (mm === null) return '';
  if (mm < 0.05) return tr(lang, 'wxDry');
  return fmtNum(mm < 1 ? mm : Math.round(mm), '', mm < 1 ? 1 : 0) + ' ' + unit;
}

/** What the tile shows. today = the daily entry on today's local date (high / low); the strip = the next WX_DAYS
 *  dated after today, rain bars scaled to the wettest of them, at least 10 mm (0.4 in). */
export function weatherView(i: WxInput): WxView {
  const st = i.state ?? null, a = i.attrs, lang = i.lang, gap = entityGap(st);
  const tv = numOf(a.temperature), fv = numOf(a.apparent_temperature);
  const day0 = localDay(i.now, i.tz), today = i.daily?.find((e) => localDay(e.t, i.tz) === day0) ?? null;
  const unit = typeof a.precipitation_unit === 'string' && a.precipitation_unit ? a.precipitation_unit : 'mm';
  const next = (i.daily ?? []).filter((e) => localDay(e.t, i.tz) > day0).slice(0, WX_DAYS);
  const scale = Math.max(unit === 'in' ? 0.4 : 10, ...next.map((e) => e.mm ?? 0));
  return {
    gap, icon: wxIcon(st), temp: gap || st === null ? '—' : wxDeg(tv), cond: gap || st === null ? '' : wxCondText(st, lang),
    feels: gap || fv === null ? '' : tr(lang, 'wxFeels', wxDeg(fv)),
    high: wxDeg(today?.temp ?? null), low: wxDeg(today?.low ?? null), wind: gap ? '—' : wxWind(a, lang), rain: wxRain(i.hourly, i.now, i.tz, lang),
    days: next.map((e) => ({ name: tr(lang, ('wd' + new Date(e.t + i.tz * MIN).getUTCDay()) as StrKey), icon: e.icon, hi: wxDeg(e.temp), lo: wxDeg(e.low),
      mm: wxMm(e.mm, unit, lang), bar: Math.round(((e.mm ?? 0) / scale) * 1000) / 1000 })),
    forecast: i.daily !== null,
  };
}

// ---------- demo (emulator, fake HA) ----------

/** weather.home's attributes in the demo and the fake HA. */
export const DEMO_WEATHER_ATTRS = { temperature: 11.4, apparent_temperature: 9.2, temperature_unit: '°C', humidity: 78, wind_speed: 4, wind_speed_unit: 'Beaufort', wind_bearing: 225, precipitation_unit: 'mm', supported_features: 3 };
const DEMO_DAY: [string, number, number, number][] = [   // condition, high, low, mm per day from today (repeats)
  ['partlycloudy', 13, 6, 0], ['cloudy', 12, 7, 0.4], ['rainy', 10, 6, 8], ['rainy', 11, 5, 2], ['sunny', 14, 4, 0], ['partlycloudy', 13, 6, 0], ['fog', 9, 3, 0.2]];
const iso = (t: number): string => new Date(t).toISOString().slice(0, 19) + '+00:00';
/** weather.get_forecasts lists like met.no's: daily = 7 days from today (UTC dates, 11:00), hourly = 48 h from the
 *  current hour, a shower from 3 h ahead. */
export function demoWeatherForecast(type: string, now: number): Record<string, string | number>[] | null {
  if (type === 'daily') {
    const d0 = Math.floor(now / DAY) * DAY;
    return Array.from({ length: 7 }, (_, k) => { const [c, hi, lo, mm] = DEMO_DAY[k];
      return { datetime: iso(d0 + k * DAY + 11 * HOUR), condition: c, temperature: hi, templow: lo, precipitation: mm, wind_speed: 14 + k, wind_bearing: 225 }; });
  }
  if (type !== 'hourly') return null;
  const h0 = Math.floor(now / HOUR) * HOUR;
  return Array.from({ length: 48 }, (_, k) => {
    const day = ((h0 + k * HOUR) % DAY) / DAY, mm = k >= 3 && k <= 6 ? [0.3, 1.2, 0.8, 0.1][k - 3] : 0;
    return { datetime: iso(h0 + k * HOUR), condition: mm > 0.5 ? 'rainy' : mm > 0 ? 'cloudy' : day > 0.3 && day < 0.75 ? 'partlycloudy' : 'cloudy',
      temperature: Math.round((10 + 4 * Math.sin(2 * Math.PI * (day - 0.375))) * 10) / 10, precipitation: mm };
  });
}
