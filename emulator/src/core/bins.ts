// Bin day tile (eink-ha-os#317): the next waste collection per bin sensor, in words. Pure; firmware core/bins.cpp must match
// spec/test-vectors/bins.json. Times are epoch ms, `tz` the local UTC offset in minutes.
import { parseTime } from './history.ts';
import { tr, type Lang, type StrKey } from './strings.ts';

export const BIN_DOMAINS = ['sensor'];
export const MAX_BINS = 6;
/** From this local hour the day before a collection, the tile says "put out tonight". */
export const TONIGHT_DEFAULT = 17;
const DAY = 86_400_000;

/** Local day number (days since 1970-01-01) of epoch ms at UTC offset tz minutes. */
const localDay = (ms: number, tz: number): number => Math.floor((ms + tz * 60_000) / DAY);
const NL_DATE = /^(\d{2})-(\d{2})-(\d{4})$/;

/** A date in a state or list: ISO ("2026-10-29", "…T00:00:00+01:00") or the Dutch "29-10-2026" (afvalwijzer's
 *  older date format) → local day number, else null. */
function dayOfText(v: unknown, tz: number): number | null {
  if (typeof v !== 'string') return null;
  const m = NL_DATE.exec(v.trim());
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    return mo < 1 || mo > 12 || d < 1 || d > 31 ? null : Math.floor(Date.UTC(Number(m[3]), mo - 1, d) / DAY);
  }
  const t = parseTime(v, tz);
  return t == null ? null : localDay(t, tz);
}
const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : null);

/**
 * Days from today (local) to a bin's next collection, or null (unknown, or only dates in the past). Sources, the first
 * that gives a day ≥ today wins: a date state (afvalwijzer), a whole-number state (days to, waste_collection_schedule
 * with value_template "{{ value.daysTo }}"), attribute `daysTo`, attribute `upcoming` (a list, or JSON text of one, of
 * dates or {date} objects). `unavailable` / `unknown` → null.
 */
export function binDays(state: string | null | undefined, attrs: Record<string, unknown>, now: number, tz: number): number | null {
  if (state === 'unavailable' || state === 'unknown') return null;   // the gap state wins over old attributes
  const today = localDay(now, tz);
  const cands: (number | null)[] = [];
  cands.push(dayOfText(state, tz));
  const n = intOf(state); cands.push(n == null ? null : today + n);
  const dt = intOf(attrs.daysTo); cands.push(dt == null ? null : today + dt);
  let up = attrs.upcoming;
  if (typeof up === 'string') { try { up = JSON.parse(up); } catch { up = null; } }
  if (Array.isArray(up))
    for (const e of up) cands.push(dayOfText(e && typeof e === 'object' ? (e as Record<string, unknown>).date : e, tz));
  for (const c of cands) if (c != null && c >= today) return c - today;
  return null;
}

export type BinIn = { label: string; state: string | null | undefined; attrs: Record<string, unknown> };
/** One bin with a known day. when: Today / Tomorrow / in N days; date: "Thursday 29"; short: "Thu 29". */
export type BinRow = { label: string; days: number; when: string; date: string; short: string };
/**
 * The tile: rows soonest first (config order on a tie, unknown bins left out). head: the labels of the soonest day
 * joined with " + "; big: the 1-cell value (when); line: the 2-wide sub line; foot: the 1-cell sub line; pill:
 * "Tonight" from `tonight`:00 the day before, "Today" on the day, else ""; rest: the later bins.
 */
export type BinsView = { rows: BinRow[]; head: string; big: string; line: string; foot: string; pill: string; tonight: boolean; rest: BinRow[] };

export function binsView(bins: BinIn[], now: number, tz: number, tonight: number, lang: Lang): BinsView {
  const today = localDay(now, tz), minute = Math.floor(((now + tz * 60_000) % DAY + DAY) % DAY / 60_000);
  const rows: BinRow[] = [];
  for (const b of bins) {
    const days = binDays(b.state, b.attrs, now, tz);
    if (days == null) continue;
    const t = new Date((today + days) * DAY), wd = t.getUTCDay(), md = t.getUTCDate();
    rows.push({ label: b.label, days, when: days === 0 ? tr(lang, 'binToday') : days === 1 ? tr(lang, 'binTomorrow') : tr(lang, 'binInDays', days),
      date: tr(lang, ('day' + wd) as StrKey) + ' ' + md, short: tr(lang, ('dayShort' + wd) as StrKey) + ' ' + md });
  }
  rows.sort((a, b) => a.days - b.days);   // stable: config order on a tie
  if (!rows.length) return { rows, head: '', big: '—', line: '', foot: '', pill: '', tonight: false, rest: [] };
  const first = rows[0], same = rows.filter((r) => r.days === first.days);
  const isTonight = first.days === 1 && minute >= tonight * 60;
  return {
    rows, head: same.map((r) => r.label).join(' + '), big: first.when,
    line: isTonight ? tr(lang, 'binLineTonight', first.date) : tr(lang, 'binLine', first.when, first.date),
    foot: isTonight ? tr(lang, 'binPutOut') : first.date,
    pill: isTonight ? tr(lang, 'binTonight') : first.days === 0 ? tr(lang, 'binToday') : '', tonight: isTonight,
    rest: rows.slice(same.length),
  };
}

/** The tile's bins from its config: `entities` (space-separated sensor ids, in order), `labels`
 *  ("sensor.a=Paper; sensor.b=Plastic"), else HA's friendly name, else the id. */
export function binLabels(entities: string[], labels: [string, string][], names: (id: string) => string | undefined): string[] {
  return entities.map((e) => labels.find(([k, l]) => k === e && l)?.[1] || names(e) || e);
}

/** Config check of a bins tile (eink-ha-os#317), in order; '' = fine. `entities` items and `labels` items are checked by
 *  parseYaml like a list pick; this covers the rest. */
export function binsError(w: Record<string, unknown>, entities: string[]): string {
  if (entities.length > MAX_BINS) return 'bins: at most ' + MAX_BINS + ' sensors';
  const t = w.tonight;
  if (t !== undefined && !(typeof t === 'number' && t >= 0 && t <= 23)) return 'bins: tonight must be an hour 0–23';
  return '';
}
