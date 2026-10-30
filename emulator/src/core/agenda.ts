// Agenda and Next tiles (eink-ha-os#316): events from HA calendars (calendar.get_events with return_response, HA 2023.12+) for
// today, tomorrow and the rest of the week, and a countdown to the next timed event. Pure; firmware core/agenda.cpp
// must match spec/test-vectors/agenda.json. Times are epoch ms, `tz` is the local UTC offset in minutes at `now` (a DST
// change inside the week is ignored, like the history tile).
import { parseTime } from './history.ts';
import { pad } from './format.ts';
import { tr, type Lang, type StrKey } from './strings.ts';

export const AGENDA_TYPES = ['agenda', 'next'];
export const MAX_CALENDARS = 4;      // per tile
export const MAX_AGENDA_TILES = 4;   // agenda + next tiles in one config
export const MAX_EVENTS = 12;        // kept per calendar set (PSRAM on the device)
export const TITLE_BYTES = 48;       // UTF-8 bytes of a title, cut on a character boundary
export const AGENDA_DAYS = 7;
const MIN = 60_000, DAY = 24 * 60 * MIN;
export const REFRESH_MS = 30 * MIN;   // asked again this often, and when the local day changes

type W = { type?: unknown; [k: string]: unknown };
/** A tile's calendars (`entities`, space-separated, pick order). */
export const calendarsOf = (w: W): string[] => (w.entities === undefined ? [] : String(w.entities).split(' ').filter(Boolean));
/** The tile's own rule broken, else null (calendar ids are checked as list picks in config.ts). */
export function agendaError(w: W): string | null {
  const n = calendarsOf(w).length;
  if (!n) return String(w.type) + ': pick at least one calendar';
  if (n > MAX_CALENDARS) return String(w.type) + ': at most ' + MAX_CALENDARS + ' calendars';
  return null;
}
/** Tiles with the same calendars share one fetch: sorted, without repeats. */
export const agendaKey = (w: W): string => [...new Set(calendarsOf(w))].sort().join(' ');

/** Local day number (days since 1970-01-01 local) and its midnight. */
export const dayOf = (ms: number, tz: number): number => Math.floor((ms + tz * MIN) / DAY);
const dayStart = (day: number, tz: number): number => day * DAY - tz * MIN;
const hm = (ms: number, tz: number): string => { const m = (((Math.floor((ms + tz * MIN) / MIN)) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
const isoUtc = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The week asked: local midnight today to midnight 7 days later. */
export const agendaWindow = (now: number, tz: number): { start: number; end: number } => {
  const s = dayStart(dayOf(now, tz), tz); return { start: s, end: s + AGENDA_DAYS * DAY };
};
/** The WebSocket message (exact text; the firmware sends the same bytes). `key` = agendaKey. */
export function eventsRequest(key: string, now: number, tz: number, id: number): string {
  const w = agendaWindow(now, tz);
  return JSON.stringify({ id, type: 'call_service', domain: 'calendar', service: 'get_events',
    service_data: { start_date_time: isoUtc(w.start), end_date_time: isoUtc(w.end) }, target: { entity_id: key.split(' ') }, return_response: true });
}

export type CalEvent = { start: number; end: number; allDay: boolean; cal: number; title: string };
/** Kept events (sorted, at most MAX_EVENTS) and how many more the answer had. */
export type AgendaFetch = { events: CalEvent[]; more: number };

/** A title as the device keeps it: control characters → spaces, spaces trimmed, at most TITLE_BYTES of UTF-8 (cut on
 *  a character boundary, then trailing spaces trimmed again). */
export function cutTitle(s: string): string {
  const t = [...s].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').replace(/^ +| +$/g, '');
  const b = new TextEncoder().encode(t);
  if (b.length <= TITLE_BYTES) return t;
  let n = TITLE_BYTES;
  while (n > 0 && (b[n] & 0xc0) === 0x80) n--;
  return new TextDecoder().decode(b.subarray(0, n)).replace(/ +$/, '');
}
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** One HA event ({start, end, summary}) of calendar `cal`, or null when its start is not a time. An all-day event has
 *  a date-only start (local midnight); an end that is missing or not after the start → start + 1 day (all-day) or the
 *  start. */
export function eventOf(raw: unknown, cal: number, tz: number): CalEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.start !== 'string') return null;
  const start = parseTime(r.start, tz); if (start === null) return null;
  const allDay = DATE_ONLY.test(r.start.trim());
  let end = typeof r.end === 'string' ? parseTime(r.end, tz) : null;
  if (end === null || end <= start) end = allDay ? start + DAY : start;
  return { start, end, allDay, cal, title: cutTitle(typeof r.summary === 'string' ? r.summary : '') };
}
const byteCmp = (a: string, b: string): number => { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
/** Event order: start, all-day first, end, calendar (index in the key), title bytes. Total, so the answer's key order
 *  does not matter. */
export const eventCmp = (a: CalEvent, b: CalEvent): number =>
  a.start - b.start || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || a.end - b.end || a.cal - b.cal || byteCmp(a.title, b.title);

/** A get_events answer (the whole WebSocket result frame) for the calendars of `key`: events not ended at `now` and
 *  starting before the window's end, the first MAX_EVENTS in eventCmp order. null = not a successful result. */
export function parseAnswer(frame: string, key: string, now: number, tz: number): AgendaFetch | null {
  let m: unknown; try { m = JSON.parse(frame); } catch { return null; }
  const o = m as { success?: unknown; result?: { response?: unknown } };
  if (!o || typeof o !== 'object' || o.success !== true) return null;
  const cals = key.split(' '), wEnd = agendaWindow(now, tz).end, out: CalEvent[] = [];
  let more = 0;
  const resp = o.result && typeof o.result === 'object' ? o.result.response : undefined;
  if (resp && typeof resp === 'object' && !Array.isArray(resp))
    for (const [id, v] of Object.entries(resp as Record<string, unknown>)) {
      const cal = cals.indexOf(id), evs = v && typeof v === 'object' ? (v as { events?: unknown }).events : undefined;
      if (cal < 0 || !Array.isArray(evs)) continue;
      for (const raw of evs) {
        const e = eventOf(raw, cal, tz);
        if (!e || e.end <= now || e.start >= wEnd) continue;
        let i = out.length; while (i > 0 && eventCmp(out[i - 1], e) > 0) i--;
        out.splice(i, 0, e);
        if (out.length > MAX_EVENTS) { out.pop(); more++; }
      }
    }
  return { events: out, more };
}

/** Weekday of a local day number (0 = Sunday; day 0 = Thursday 1 Jan 1970). */
const wdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7;
const shortDay = (lang: Lang, day: number): string => tr(lang, ('agDay' + wdayOf(day)) as StrKey);
const mdayOf = (day: number): number => new Date(day * DAY).getUTCDate();

/** Lines of an agenda tile: a day header, then its events. */
export type AgendaLine = { day: string } | { time: string; title: string; allDay: boolean };
/** How many lines (headers + events) an agenda tile fits: 4 on one row, 11 on two. */
export const agendaMaxLines = (rs: number): number => (rs > 1 ? 11 : 4);
/**
 * An agenda tile at `now`: events not ended, each under the day it is on (an event that began on an earlier day is
 * under today), for today and the next 6 days, at most `maxLines` lines; a day header only with at least one event under
 * it. Headers: "Today · Wed 28", "Tomorrow · Thu 29", "Fri 30". Times: "08:30", "all day", or "–10:00" for an event
 * that began on an earlier day and ends that day. more = events not shown (also those past MAX_EVENTS).
 */
export function agendaLines(f: AgendaFetch, now: number, tz: number, lang: Lang, maxLines: number): { lines: AgendaLine[]; more: number } {
  const today = dayOf(now, tz), lines: AgendaLine[] = [];
  const live = f.events.map((e) => ({ e, d: Math.max(dayOf(e.start, tz), today) })).filter(({ e, d }) => e.end > now && d < today + AGENDA_DAYS);
  live.sort((a, b) => a.d - b.d);   // stable: start order inside a day
  let shown = 0, prev = -1;
  for (const { e, d } of live) {
    const need = d !== prev ? 2 : 1;
    if (lines.length + need > maxLines) break;
    if (d !== prev) {
      const label = shortDay(lang, d) + ' ' + mdayOf(d);
      lines.push({ day: d === today ? tr(lang, 'agToday') + ' · ' + label : d === today + 1 ? tr(lang, 'agTomorrow') + ' · ' + label : label });
      prev = d;
    }
    const ds = dayStart(d, tz);
    const time = e.allDay ? tr(lang, 'agAllDay') : e.start >= ds ? hm(e.start, tz) : e.end <= ds + DAY ? '–' + hm(e.end, tz) : tr(lang, 'agAllDay');
    lines.push({ time, title: e.title || tr(lang, 'agBusy'), allDay: time === tr(lang, 'agAllDay') });
    shown++;
  }
  return { lines, more: live.length - shown + f.more };
}

/** A Next tile: the first timed event not ended. pill: "Now" while it runs, "in 48 min" under an hour, "in 3 h" later
 *  today, "Tomorrow", else the short day name. mins = whole minutes to the start (rounded up; ≤ 0 = running). */
export type NextView = { title: string; when: string; pill: string; mins: number };
export function nextView(f: AgendaFetch, now: number, tz: number, lang: Lang): NextView | null {
  const e = f.events.find((x) => !x.allDay && x.end > now);
  if (!e) return null;
  const mins = Math.ceil((e.start - now) / MIN), d = dayOf(e.start, tz), today = dayOf(now, tz), ed = dayOf(e.end - 1, tz);
  const pill = e.start <= now ? tr(lang, 'now') : mins < 60 ? tr(lang, 'agInMin', mins) : d === today ? tr(lang, 'agInH', Math.round(mins / 60))
    : d === today + 1 ? tr(lang, 'agTomorrow') : shortDay(lang, d);
  const when = e.end === e.start ? hm(e.start, tz) : hm(e.start, tz) + ' – ' + (ed > d ? shortDay(lang, ed) + ' ' : '') + hm(e.end, tz);
  return { title: e.title || tr(lang, 'agBusy'), when, pill, mins };
}

// ---- demo calendars (emulator tiles, fake HA calendar.get_events) ----
export const DEMO_CALENDARS: { id: string; name: string }[] = [{ id: 'calendar.family', name: 'Family' }, { id: 'calendar.work', name: 'Work' }];
type DemoEv = [number, string, string, string];   // day offset, start "HH:MM" or "" (all day), end "HH:MM" or days, title
const DEMO: Record<string, DemoEv[]> = {
  'calendar.family': [[0, '', '1', 'Paper bin out'], [0, '08:30', '09:15', 'Dentist'], [0, '15:00', '16:00', 'Swimming lessons'], [0, '19:30', '21:00', 'Book club at Zoë’s'],
    [1, '09:00', '11:00', 'Plumber, 2 h window'], [2, '', '1', 'School holiday'], [3, '17:00', '19:00', 'Glühwein market'], [4, '', '1', 'Zoë’s birthday'],
    [5, '10:00', '11:30', 'Brunch at the café'], [6, '14:00', '15:00', 'Piano lesson']],
  'calendar.work': [[0, '12:00', '13:00', 'Lunch with the team'], [1, '10:00', '11:00', 'Quarterly planning with the whole team and all the external partners'],
    [3, '', '2', 'Conference'], [4, '09:00', '09:30', 'Stand-up']],
};
const isoLocal = (ms: number, tz: number): string => {
  const d = new Date(ms + tz * MIN).toISOString().slice(0, 19), a = Math.abs(tz);
  return d + (tz < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
};
/** A demo calendar's events as calendar.get_events returns them (local ISO times with offset, dates for all-day
 *  events), the ones overlapping [from, to); a week from local today at `now`. */
export function demoEvents(id: string, now: number, tz: number, from = -Infinity, to = Infinity): { start: string; end: string; summary: string; description: string }[] {
  const today = dayOf(now, tz);
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return (DEMO[id] || []).map(([off, s, e, title]) => {
    const d = today + off;
    if (!s) { const ymd = (x: number) => new Date(x * DAY).toISOString().slice(0, 10); const st = dayStart(d, tz);
      return { st, en: st + Number(e) * DAY, start: ymd(d), end: ymd(d + Number(e)), title }; }
    const st = dayStart(d, tz) + mins(s) * MIN, en = dayStart(d, tz) + mins(e) * MIN;
    return { st, en, start: isoLocal(st, tz), end: isoLocal(en, tz), title };
  }).filter((x) => x.en > from && x.st < to)
    .map((x) => ({ start: x.start, end: x.end, summary: x.title, description: 'Added by the demo calendar. ' + 'Notes '.repeat(20).trim() }));
}
/** The demo answer to eventsRequest(key) as a WebSocket result frame. */
export function demoAnswer(key: string, now: number, tz: number, id = 1): string {
  const w = agendaWindow(now, tz);
  const response = Object.fromEntries(key.split(' ').map((c) => [c, { events: demoEvents(c, now, tz, w.start, w.end) }]));
  return JSON.stringify({ id, type: 'result', success: true, result: { context: { id: 'demo', parent_id: null, user_id: null }, response } });
}
