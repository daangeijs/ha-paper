// List from attributes tile (eink-ha-os#332): rows from a sensor attribute that holds a list of objects (e.g. the rare birds
// recipe, docs/recipes/rare-birds.md). Pure; firmware core/attr_list.cpp must match spec/test-vectors/attr-list.json.
// Times are epoch ms, `tz` the local UTC offset in minutes.
import { fmtNum } from './format.ts';
import { parseTime } from './history.ts';
import { tr, type Lang } from './strings.ts';

export const LIST_DOMAINS = ['sensor'];
/** Defaults: the display-ready fields of the ha-waarneming integration (eink-ha-os#375). subtitle = space-separated field names. */
export const LIST_DEFAULTS = { attribute: 'sightings', title: 'title', subtitle: 'subtitle', time: 'ts' } as const;
/** A default field the item lacks falls back to the YAML recipe's shape (docs/recipes/rare-birds.md). */
export const LIST_FALLBACK = { title: 'species', subtitle: 'place distance_km', time: 'observed_at' } as const;
export const MAX_SUBTITLE_FIELDS = 3;
/** Ingest cap (firmware core/ha_stream): at most this many items, and items only while the JSON stays within the bytes. */
export const LIST_MAX_ITEMS = 10;
export const LIST_MAX_BYTES = 3072;
const FIELD = /^[A-Za-z0-9_]+$/;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const localDay = (ms: number, tz: number): number => Math.floor((ms + tz * MIN) / DAY);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** fb: the fallback of each field left at its default (absent when the tile sets the field). */
export type ListSpec = { attribute: string; title: string; subtitle: string[]; time: string; fb: { title?: string; subtitle?: string[]; time?: string } };
export function listSpec(w: Record<string, unknown>): ListSpec {
  const unset = (k: keyof typeof LIST_DEFAULTS) => w[k] === undefined || w[k] === '';
  const s = (k: keyof typeof LIST_DEFAULTS) => (unset(k) ? LIST_DEFAULTS[k] : String(w[k]));
  const words = (v: string) => v.split(' ').filter(Boolean);
  const fb: ListSpec['fb'] = {};
  if (unset('title')) fb.title = LIST_FALLBACK.title;
  if (unset('subtitle')) fb.subtitle = words(LIST_FALLBACK.subtitle);
  if (unset('time')) fb.time = LIST_FALLBACK.time;
  return { attribute: s('attribute'), title: s('title'), subtitle: words(s('subtitle')), time: s('time'), fb };
}
const has = (item: Record<string, unknown>, k: string): boolean => item[k] !== undefined && item[k] !== null;

/** Config check of an attrList tile, in order; '' = fine (entity is checked by parseYaml). */
export function listError(w: Record<string, unknown>): string {
  for (const k of ['attribute', 'title', 'time'] as const)
    if (w[k] !== undefined && !FIELD.test(String(w[k]))) return 'attrList: ' + k + ' must be a field name (letters, digits, _)';
  if (w.subtitle !== undefined) {
    const f = String(w.subtitle).split(' ').filter(Boolean);
    if (!f.length || f.some((x) => !FIELD.test(x))) return 'attrList: subtitle must be field names (letters, digits, _) split by spaces';
    if (f.length > MAX_SUBTITLE_FIELDS) return 'attrList: at most ' + MAX_SUBTITLE_FIELDS + ' subtitle fields';
  }
  return '';
}

/** Rows a tile shows: 2-line rows (title, then subtitle) below 3 columns, one-line rows from 3 columns. */
export function listRows(cs: number, rs: number): { rows: number; oneLine: boolean } {
  const oneLine = cs >= 3;
  return { oneLine, rows: rs > 1 ? (oneLine ? 10 : 6) : oneLine ? 4 : 2 };
}

/** A field value as text: strings trimmed; numbers to at most 1 decimal, `…_km` / `…_m` names get the unit; the rest ''. */
export function fieldText(item: Record<string, unknown>, key: string): string {
  const v = item[key];
  if (typeof v === 'string') return v.trim();
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const s = fmtNum(Math.round(v * 10) / 10, '', null);
  return key.endsWith('_km') ? s + ' km' : key.endsWith('_m') ? s + ' m' : s;
}

/** How long ago: "just now", "N min ago", "N h ago", then by local day "yesterday" / "N days ago". A date without a
 *  time: "today" / "yesterday" / "N days ago". Unreadable or more than 5 min ahead: ''. */
export function listAgo(v: unknown, now: number, tz: number, lang: Lang): string {
  const t = parseTime(v, tz);
  if (t == null) return '';
  const days = localDay(now, tz) - localDay(t, tz);
  if (typeof v === 'string' && DATE_ONLY.test(v.trim())) return days < 0 ? '' : days === 0 ? tr(lang, 'listToday') : days === 1 ? tr(lang, 'listYesterday') : tr(lang, 'listDaysAgo', days);
  const d = now - t;
  if (d < -5 * MIN) return '';
  if (d < MIN) return tr(lang, 'listNow');
  if (d < HOUR) return tr(lang, 'listMinAgo', Math.floor(d / MIN));
  if (d < DAY) return tr(lang, 'listHoursAgo', Math.floor(d / HOUR));
  return days <= 1 ? tr(lang, 'listYesterday') : tr(lang, 'listDaysAgo', days);
}

export type ListRow = { title: string; sub: string; ago: string };
/** The tile's rows from the attribute value (a list, or JSON text of one): a default field the item lacks (absent or
 *  null) reads its fallback (title → species, subtitle → place distance_km, time → observed_at); items without a title are left out; in
 *  list order, at most `max`; more = the other items with a title. Not a list → no rows. */
export function listView(value: unknown, spec: ListSpec, now: number, tz: number, lang: Lang, max: number): { rows: ListRow[]; more: number } {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  const rows: ListRow[] = [];
  let more = 0;
  if (!Array.isArray(v)) return { rows, more };
  for (const e of v) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const item = e as Record<string, unknown>;
    const title = fieldText(item, spec.fb.title && !has(item, spec.title) ? spec.fb.title : spec.title);
    if (!title) continue;
    if (rows.length >= max) { more++; continue; }
    const subKeys = spec.fb.subtitle && !spec.subtitle.some((k) => has(item, k)) ? spec.fb.subtitle : spec.subtitle;
    const time = spec.fb.time && !has(item, spec.time) ? spec.fb.time : spec.time;
    rows.push({ title, sub: subKeys.map((k) => fieldText(item, k)).filter(Boolean).join(' · '), ago: listAgo(item[time], now, tz, lang) });
  }
  return { rows, more };
}

/** What the display keeps of a list attribute at ingest: the first items while there are at most LIST_MAX_ITEMS and the
 *  JSON stays within LIST_MAX_BYTES (an item that does not fit ends the list). Not a list: kept as is. */
export function capList(value: unknown, maxItems = LIST_MAX_ITEMS, maxBytes = LIST_MAX_BYTES): unknown {
  if (!Array.isArray(value)) return value;
  const out: unknown[] = [];
  let bytes = 2;
  for (const e of value) {
    if (out.length >= maxItems) break;
    const n = new TextEncoder().encode(JSON.stringify(e)).length + (out.length ? 1 : 0);
    if (bytes + n > maxBytes) break;
    out.push(e); bytes += n;
  }
  return out;
}
