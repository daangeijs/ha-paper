// Quiet hours (#295, decision on #294): one window that replaces night mode and the "Sleep at night" power mode.
// Vectors: spec/test-vectors/quiet.json (+ power/*, refresh.json, frontlight.json). Firmware: core/logic.h.
//
// Inside the window (clock known, not peeking) the display shows the quiet face: "Back at 07:00", the date and a
// "Tomorrow" row (#328, quiet-tomorrow.json, firmware core/tomorrow.h), built when the window starts. No minute clock
// (a deep-sleeping panel would show a wrong time all night). On battery it deep-sleeps to the window end (no timer wakes;
// the 03:00 OTA wake excepted); on USB it stays connected but draws no data. The front light follows its own timeout.
// Standby inside the window shows the same face. Any key, tap or swipe shows the dashboard for PEEK_MS (a "peek"), also
// as the first screen after a button wake, a power-on or any other boot inside the window; a timer wake does not peek.
import { isNightHour, pad } from './format.ts';
import { wxDeg, wxWet, type WxEntry, type WxIcon } from './weather.ts';
import { AGENDA_TYPES, calendarsOf, type CalEvent } from './agenda.ts';
import { tr, type Lang } from './strings.ts';

export const QUIET_STEPS = ['off', '22-06', '23-07', '00-06'];
export const DEFAULT_QUIET = '23-07';
export const PEEK_MS = 60_000;

/** Hour `h` inside the window ("23-07" wraps midnight; "off" never). */
export const inQuietHours = (h: number, window: string): boolean => isNightHour(h, window);
/** End hour of the window, -1 when off. */
export const quietEndHour = (window: string): number => (window === 'off' ? -1 : Number(window.split('-')[1]));

/** "Back at {}" time: "07:00" (24 h) or "7:00" (12 h, like the clock: no AM/PM). '' when off. */
export function quietBackAt(window: string, clock: string): string {
  const h = quietEndHour(window);
  if (h < 0) return '';
  return (clock === '12' ? String(h % 12 || 12) : String(h).padStart(2, '0')) + ':00';
}

/** A boot inside the window starts with a peek, except a timer wake (glance, OTA): nobody pressed anything. */
export type WakeKind = 'cold' | 'timer' | 'button' | 'charger' | 'other';
export const peekOnBoot = (wake: WakeKind): boolean => wake !== 'timer';

/** Settings schema 1 → 2: `quiet` from the old `display.night` (a window is kept; off or missing → the default, on). */
export function quietFromNight(night: unknown): string {
  return typeof night === 'string' && /^([01]\d|2[0-3])-([01]\d|2[0-3])$/.test(night) ? night : DEFAULT_QUIET;
}

// ---------- the "Tomorrow" row (#328) ----------
// Values that stay true overnight and matter for the morning, from data the device already keeps (no fetch for the face):
// the weather forecast (#318, RTC), the first event (#316 agenda cache), the bins (#317, the entity mirror). An item
// without a source is left out; no item = no row ("Back at 07:00" and the date only).

/** A tile on screen `screen` (config order), widget `widget`. */
export type TileRef = [number, number];
/** The tiles the row reads: the first weather tile with an entity, the first agenda or next tile with a calendar, the
 *  first bins tile with a sensor, each in screen then widget order; null = none in the config. */
export type QuietSources = { weather: TileRef | null; agenda: TileRef | null; bins: TileRef | null };
type W = { type?: unknown; entity?: unknown; entities?: unknown };
const listLen = (v: unknown): number => (v === undefined ? 0 : String(v).split(' ').filter(Boolean).length);
export function quietSources(screens: readonly { widgets: readonly W[] }[]): QuietSources {
  const out: QuietSources = { weather: null, agenda: null, bins: null };
  screens.forEach((sc, i) => sc.widgets.forEach((w, k) => {
    if (w.type === 'weather' && !out.weather && w.entity !== undefined && String(w.entity) !== '') out.weather = [i, k];
    if (AGENDA_TYPES.includes(String(w.type)) && !out.agenda && calendarsOf(w).length) out.agenda = [i, k];
    if (w.type === 'bins' && !out.bins && listLen(w.entities)) out.bins = [i, k];
  }));
  return out;
}

/** The morning the face points at: the local day of the window's end. Before the end hour that is today (a boot at
 *  03:00), else tomorrow. TODAY_END (24): always today, the glance sleep face's "Today" row (#356). */
export const TODAY_END = 24;
export const quietDay = (now: number, tz: number, endHour: number): number => {
  const m = Math.floor((now + tz * 60_000) / 60_000), day = Math.floor(m / 1440), h = Math.floor((((m % 1440) + 1440) % 1440) / 60);
  return h < endHour ? day : day + 1;
};

export type QuietItem = { kind: 'weather' | 'event' | 'bins'; icon: WxIcon | ''; bold: string; text: string };
export type QuietRow = { head: string; items: QuietItem[] };
export type QuietIn = {
  now: number; tz: number; lang: Lang; endHour: number;
  /** The weather tile's forecasts (null = no weather tile or none kept yet). */
  daily: WxEntry[] | null; hourly: WxEntry[] | null;
  /** The agenda / next tile's kept events (null = no tile, or no answer yet). */
  events: CalEvent[] | null;
  /** The bins tile's sensors with days to their next collection (null = unknown), and its "tonight" hour. */
  bins: { label: string; days: number | null }[] | null; tonight: number;
};

const MIN = 60_000, DAY = 1440 * MIN;
const dayOfMs = (t: number, tz: number): number => Math.floor((t + tz * MIN) / DAY);
const hmOf = (t: number, tz: number): string => { const m = ((Math.floor((t + tz * MIN) / MIN) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };

/**
 * The row, in this order:
 * - weather: the daily entry on that day: its drawing, "12° / 6°" (high only when no low; no high = left out), and
 *   "rain from 08:00" for the first wet hour of the hourly forecast on that day that is not over ('' when none).
 * - event: the first event starting on that day and not over: a timed one ("08:30", title), else an all-day one
 *   ("all day", title); an empty title is "Busy".
 * - bins: the bins collected on that day, labels joined with " + ", and "put out tonight" (tomorrow, from the tonight
 *   hour on), "collected tomorrow" (tomorrow, before it) or "collected today".
 * head: "Tomorrow", or "Today" when the day is today; '' without items.
 */
export function quietTomorrow(i: QuietIn): QuietRow {
  const { now, tz, lang } = i, today = dayOfMs(now, tz), day = quietDay(now, tz, i.endHour), items: QuietItem[] = [];
  const d = i.daily?.find((e) => dayOfMs(e.t, tz) === day);
  if (d && d.temp !== null) {
    const wet = (i.hourly ?? []).find((e) => e.t + 60 * MIN > now && dayOfMs(e.t, tz) === day && wxWet(e));
    items.push({ kind: 'weather', icon: d.icon, bold: wxDeg(d.temp) + (d.low !== null ? ' / ' + wxDeg(d.low) : ''), text: wet ? tr(lang, 'qtRain', hmOf(wet.t, tz)) : '' });
  }
  const on = (i.events ?? []).filter((e) => dayOfMs(e.start, tz) === day && e.end > now);
  const ev = on.find((e) => !e.allDay) ?? on.find((e) => e.allDay);
  if (ev) items.push({ kind: 'event', icon: '', bold: ev.allDay ? tr(lang, 'agAllDay') : hmOf(ev.start, tz), text: ev.title || tr(lang, 'agBusy') });
  const due = (i.bins ?? []).filter((b) => b.days !== null && today + b.days === day);
  if (due.length) {
    const minute = (((Math.floor((now + tz * MIN) / MIN)) % 1440) + 1440) % 1440;
    const text = day === today ? 'qtBinToday' : minute >= i.tonight * 60 ? 'qtBinTonight' : 'qtBinTomorrow';
    items.push({ kind: 'bins', icon: '', bold: due.map((b) => b.label).join(' + '), text: tr(lang, text) });
  }
  return { head: items.length ? tr(lang, day === today ? 'qtToday' : 'qtTomorrow') : '', items };
}
