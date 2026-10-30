// Good morning page (eink-ha-os#330): the first wake after Quiet hours end shows today's weather, events and bins on one page for
// MORNING_MS; one press (key, tap, swipe) or the timeout hands over to the start page. Built from the data the tiles
// already keep (weather forecast, agenda events, bin sensors): no fetch of its own. A row without a source is left out.
// Pure; firmware core/morning.cpp must match spec/test-vectors/morning.json.
import { dayOf, type AgendaFetch, agendaLines } from './agenda.ts';
import { pad } from './format.ts';
import { inQuietHours, quietSources } from './quiet.ts';
import { dateLine, tr, type Lang } from './strings.ts';
import { wxDeg, wxWet, type WxEntry, type WxIcon } from './weather.ts';

export const MORNING_MS = 20 * 60_000;
/** Today's events on the page; later ones are "+N more today". */
export const MORNING_EVENTS = 4;
const MIN = 60_000, HOUR = 60 * MIN;

// ---------- when ----------
/** Survives deep sleep (firmware: RTC memory). armed: quiet hours were seen since the page last went up; until: epoch
 *  ms the page ends, 0 = not up. Power-on starts unarmed: no page after a cold boot. */
export type MorningState = { armed: boolean; until: number };
export const MORNING_IDLE: MorningState = { armed: false, until: 0 };
export type MorningTick = { now: number; hour: number; clockKnown: boolean; quiet: string; enabled: boolean };
export type MorningStep = MorningState & { start: boolean; end: boolean };

/**
 * One step (every loop / tick). Clock unknown: nothing changes. Inside the window: armed, the page down. Outside, armed:
 * disarmed, and the page goes up for MORNING_MS when the setting is on and quiet hours are not off (turning them off at
 * night shows nothing). Up and `until` reached: down (end).
 */
export function morningStep(s: MorningState, i: MorningTick): MorningStep {
  if (!i.clockKnown) return { ...s, start: false, end: false };
  if (inQuietHours(i.hour, i.quiet)) return { armed: true, until: 0, start: false, end: s.until !== 0 };
  if (s.armed) {
    const on = i.enabled && i.quiet !== 'off';
    return { armed: false, until: on ? i.now + MORNING_MS : s.until, start: on, end: false };
  }
  if (s.until && i.now >= s.until) return { armed: false, until: 0, start: false, end: true };
  return { ...s, start: false, end: false };
}
/** The page is up. */
export const morningUp = (s: MorningState, now: number): boolean => s.until !== 0 && now < s.until;

// ---------- what ----------
/** The tiles the page reads: the quiet face's Tomorrow row sources (eink-ha-os#328, quiet.ts quietSources). */
export const morningSources = quietSources;

export type MorningIn = {
  now: number; tz: number; lang: Lang;
  /** The weather tile's forecasts (null = no tile, or none kept yet). */
  daily: WxEntry[] | null; hourly: WxEntry[] | null;
  /** The agenda / next tile's events (null = no tile, or no answer yet). */
  events: AgendaFetch | null;
  /** The bins tile's bins with days to their next collection (bins.ts binDays; null = unknown). */
  bins: { label: string; days: number | null }[] | null;
};
export type MorningView = {
  head: string; date: string;
  /** today's drawing ('' without a daily entry), "13° / 6°" ('' without a high), "Rain from 08:00" / "Rain now" / ''. */
  weather: { icon: WxIcon | ''; temps: string; rain: string } | null;
  /** Today's events: "08:30" / "all day" / "–10:00", title; more: "+2 more today" or ''. */
  events: { time: string; title: string }[]; more: string;
  /** Bins collected today, then bins to put out tonight (collected tomorrow): labels joined with " + ". */
  bins: { labels: string; when: string }[];
};

const hmOf = (t: number, tz: number): string => { const m = ((Math.floor((t + tz * MIN) / MIN) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };

/**
 * The page at `now`:
 * - date: "Thursday 29 October" (local).
 * - weather: the daily entry on today's date: drawing and "13° / 6°" (the high alone without a low); rain: the first
 *   wet hour of the hourly forecast that is not over and starts today: "Rain now" when it holds now, else "Rain from
 *   08:00". Left out (null) when it has neither temperatures nor rain.
 * - events: events not ended that are on today (one that began earlier counts as today), as the agenda tile writes them,
 *   at most MORNING_EVENTS; more = today's events not shown.
 * - bins: bins with days 0 ("collected today"), then days 1 ("put out tonight"); one row each, empty rows left out.
 */
export function morningView(i: MorningIn): MorningView {
  const { now, tz, lang } = i, today = dayOf(now, tz), d = new Date(today * 24 * HOUR);
  const date = dateLine(lang, d.getUTCDay(), d.getUTCDate(), d.getUTCMonth());
  let weather: MorningView['weather'] = null;
  const day = i.daily?.find((e) => dayOf(e.t, tz) === today) ?? null;
  const temps = day && day.temp !== null ? wxDeg(day.temp) + (day.low !== null ? ' / ' + wxDeg(day.low) : '') : '';
  const w = (i.hourly ?? []).find((e) => e.t + HOUR > now && dayOf(Math.max(e.t, now), tz) === today && wxWet(e));
  const rain = !w ? '' : w.t <= now ? tr(lang, 'gmRainNow') : tr(lang, 'gmRainFrom', hmOf(w.t, tz));
  if (temps || rain) weather = { icon: day ? day.icon : '', temps, rain };
  let events: MorningView['events'] = [], more = '';
  if (i.events) {
    const on = i.events.events.filter((e) => e.end > now && Math.max(dayOf(e.start, tz), today) === today);
    const a = agendaLines({ events: on, more: 0 }, now, tz, lang, MORNING_EVENTS + 1);
    events = a.lines.flatMap((l) => ('time' in l ? [{ time: l.time, title: l.title }] : []));
    more = a.more ? tr(lang, 'gmMore', a.more) : '';
  }
  const bins: MorningView['bins'] = [];
  for (const [n, k] of [[0, 'gmBinToday'], [1, 'gmBinTonight']] as const) {
    const due = (i.bins ?? []).filter((b) => b.days === n);
    if (due.length) bins.push({ labels: due.map((b) => b.label).join(' + '), when: tr(lang, k) });
  }
  return { head: tr(lang, 'gmHead'), date, weather, events, more, bins };
}
