// Clock time zone and price currency from Home Assistant (#147; spec/test-vectors/locale.json = firmware core/locale).
// HA's get_config gives an IANA `time_zone` and an ISO 4217 `currency`. The device has no zone database, so a table
// maps the zones HA users pick most to newlib POSIX TZ strings; an unknown zone keeps the current one.
import { fmtNum } from './format.ts';

/** POSIX TZ as newlib tzset() reads it (firmware setenv("TZ")): std offset [dst [offset] ,rule,rule], at most 64 chars.
 * Names: 3–10 letters, or <3–10 of A-Za-z0-9+->. Offsets [+-]hh[:mm[:ss]], hh ≤ 24. Rule dates Jn (1–365), n (0–365)
 * or Mm.w.d; rule times hh[:mm[:ss]], hh ≤ 167. IANA names ("Europe/Amsterdam") fail: newlib would fall back to UTC (tzFor maps known ones). */
export function validPosixTz(tz: string): boolean {
  if (tz.length > 64) return false;
  let i = 0;
  const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  const num = (lo: number, hi: number, maxDigits: number): boolean => {
    let j = i, v = 0;
    while (j < tz.length && j - i < maxDigits && digit(tz[j])) v = v * 10 + Number(tz[j++]);
    if (j === i || v < lo || v > hi) return false;
    i = j;
    return true;
  };
  const name = (): boolean => {
    const m = (tz[i] === '<' ? /^<[A-Za-z0-9+-]{3,10}>/ : /^[A-Za-z]{3,10}(?![A-Za-z])/).exec(tz.slice(i));
    if (!m) return false;
    i += m[0].length;
    return true;
  };
  const hms = (maxH: number): boolean => {
    if (!num(0, maxH, 3)) return false;
    for (let k = 0; k < 2 && tz[i] === ':'; k++) { i++; if (!num(0, 59, 2)) return false; }
    return true;
  };
  const offset = (): boolean => { if (tz[i] === '+' || tz[i] === '-') i++; return hms(24); };
  const rule = (): boolean => {
    if (tz[i++] !== ',') return false;
    if (tz[i] === 'J') { i++; if (!num(1, 365, 3)) return false; }
    else if (tz[i] === 'M') {
      i++;
      if (!num(1, 12, 2) || tz[i++] !== '.' || !num(1, 5, 1) || tz[i++] !== '.' || !num(0, 6, 1)) return false;
    } else if (!num(0, 365, 3)) return false;
    if (tz[i] === '/') { i++; if (!hms(167)) return false; }
    return true;
  };
  if (!name() || !offset()) return false;
  if (i === tz.length) return true;
  if (!name()) return false;
  if (tz[i] !== ',' && !offset()) return false;
  return rule() && rule() && i === tz.length;
}

const CET = 'CET-1CEST,M3.5.0,M10.5.0/3', EET = 'EET-2EEST,M3.5.0/3,M10.5.0/4', WET = 'WET0WEST,M3.5.0/1,M10.5.0';
const US = ',M3.2.0,M11.1.0', AU = ',M10.1.0,M4.1.0/3';
const zones = (posix: string, ...names: string[]): [string, string][] => names.map((n) => [n, posix]);

/** IANA zone → POSIX TZ, in console order (UTC, Europe, the Americas, Asia/Africa, Australia/NZ). */
export const TZ_TABLE: [string, string][] = [
  ...zones('UTC0', 'UTC', 'Etc/UTC'), ...zones('GMT0', 'GMT', 'Etc/GMT', 'Atlantic/Reykjavik'),
  ...zones('GMT0BST,M3.5.0/1,M10.5.0', 'Europe/London', 'Europe/Guernsey', 'Europe/Isle_of_Man', 'Europe/Jersey'),
  ['Europe/Dublin', 'GMT0IST,M3.5.0/1,M10.5.0'], ...zones(WET, 'Europe/Lisbon', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Faroe'),
  ...zones(CET, 'Europe/Amsterdam', 'Europe/Andorra', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Bratislava', 'Europe/Brussels',
    'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Gibraltar', 'Europe/Ljubljana', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta',
    'Europe/Monaco', 'Europe/Oslo', 'Europe/Paris', 'Europe/Podgorica', 'Europe/Prague', 'Europe/Rome', 'Europe/San_Marino',
    'Europe/Sarajevo', 'Europe/Skopje', 'Europe/Stockholm', 'Europe/Tirane', 'Europe/Vaduz', 'Europe/Vatican', 'Europe/Vienna',
    'Europe/Warsaw', 'Europe/Zagreb', 'Europe/Zurich', 'Arctic/Longyearbyen'),
  ...zones(EET, 'Europe/Athens', 'Europe/Bucharest', 'Europe/Helsinki', 'Europe/Kiev', 'Europe/Kyiv', 'Europe/Mariehamn', 'Europe/Riga',
    'Europe/Sofia', 'Europe/Tallinn', 'Europe/Vilnius', 'Asia/Nicosia'),
  ['Europe/Chisinau', 'EET-2EEST,M3.5.0,M10.5.0/3'], ['Europe/Kaliningrad', 'EET-2'],
  ...zones('<+03>-3', 'Europe/Istanbul', 'Europe/Minsk'), ['Europe/Moscow', 'MSK-3'],
  ...zones('EST5EDT' + US, 'America/New_York', 'America/Detroit', 'America/Toronto', 'America/Indiana/Indianapolis', 'US/Eastern'),
  ...zones('CST6CDT' + US, 'America/Chicago', 'America/Winnipeg', 'US/Central'),
  ...zones('MST7MDT' + US, 'America/Denver', 'America/Edmonton', 'America/Boise', 'US/Mountain'),
  ...zones('MST7', 'America/Phoenix', 'US/Arizona'), ...zones('PST8PDT' + US, 'America/Los_Angeles', 'America/Vancouver', 'US/Pacific'),
  ...zones('AKST9AKDT' + US, 'America/Anchorage', 'US/Alaska'), ...zones('HST10', 'Pacific/Honolulu', 'US/Hawaii'),
  ['America/Halifax', 'AST4ADT' + US], ['America/St_Johns', 'NST3:30NDT' + US], ['America/Mexico_City', 'CST6'],
  ['America/Sao_Paulo', '<-03>3'], ['America/Argentina/Buenos_Aires', '<-03>3'],
  ['Asia/Dubai', '<+04>-4'], ['Asia/Kolkata', 'IST-5:30'], ['Asia/Bangkok', '<+07>-7'], ['Asia/Singapore', '<+08>-8'],
  ['Asia/Hong_Kong', 'HKT-8'], ['Asia/Shanghai', 'CST-8'], ['Asia/Tokyo', 'JST-9'], ['Asia/Seoul', 'KST-9'],
  ['Asia/Jerusalem', 'IST-2IDT,M3.4.4/26,M10.5.0'], ['Africa/Cairo', 'EET-2EEST,M4.5.5/0,M10.5.4/24'], ['Africa/Johannesburg', 'SAST-2'],
  ['Africa/Lagos', 'WAT-1'], ['Africa/Nairobi', 'EAT-3'],
  ...zones('AEST-10AEDT' + AU, 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Canberra', 'Australia/Hobart'),
  ['Australia/Brisbane', 'AEST-10'], ['Australia/Adelaide', 'ACST-9:30ACDT' + AU], ['Australia/Darwin', 'ACST-9:30'],
  ['Australia/Perth', 'AWST-8'], ['Pacific/Auckland', 'NZST-12NZDT,M9.5.0,M4.1.0/3'],
];
const TZ = new Map(TZ_TABLE);
/** The zone names the console offers. */
export const TZ_ZONES: string[] = TZ_TABLE.map(([n]) => n);

/** A known IANA zone → its POSIX TZ, else null. */
export const ianaToPosix = (zone: string): string | null => TZ.get(zone) ?? null;

/** PUT /settings `tz`: "" (follow Home Assistant), a zone from the table, or a POSIX TZ string. */
export const validTzSetting = (tz: string): boolean => tz === '' || TZ.has(tz) || validPosixTz(tz);

/** The POSIX TZ the clock uses: the override (`tz`, a POSIX string or a known zone) wins, else HA's `time_zone`;
 *  null = neither known, keep the current one (at boot: Europe/Amsterdam). */
export function tzFor(override: string, haZone: string): string | null {
  if (override) return validPosixTz(override) ? override : ianaToPosix(override);
  return haZone ? ianaToPosix(haZone) : null;
}
export const DEFAULT_TZ = CET;

const SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
/** HA `currency` (ISO 4217) → what a price shows: €, $, £, else the code itself ("SEK"); "" / unknown HA → €. */
export const currencySymbol = (code: string | null | undefined): string => (!code ? '€' : SYMBOL[code] ?? code.toUpperCase());

let CUR = '€';
/** The display's currency symbol (= firmware setCurrency); price tiles read it. */
export const setCurrency = (symbol: string): void => { CUR = symbol || '€'; };
export const currency = (): string => CUR;
/** A price with the currency: €0.23, $0.23, SEK 0.23 (a letter code gets a space). */
export const money = (v: number, sym = CUR): string => sym + (/^[A-Za-z]/.test(sym) ? ' ' : '') + fmtNum(v, '', 2);
