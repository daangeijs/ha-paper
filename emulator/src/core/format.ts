// Small pure helpers, ported 1:1 from Main.dc.html.

export const pad = (n: number | string): string => String(n).padStart(2, '0');

/** Decimals per unit when HA gives no display_precision (eink-ha-os#85, spec/test-vectors/format.json). */
const UNIT_DP = new Map<string, number>([['W', 0], ['kW', 2], ['kWh', 1], ['%', 0], ['°C', 1], ['°F', 1], ['V', 1], ['A', 1]]);
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Decimal mark and grouping (eink-ha-os#110): 'point' 2.1, 'comma' 2,1 (no grouping, from the language), or one of HA's
 *  profile `number_format` values with grouping: comma_decimal 1,250.5 · decimal_comma 1.250,5 · space_comma 1 250,5. */
export type NumFormat = 'point' | 'comma' | 'comma_decimal' | 'decimal_comma' | 'space_comma';

/** HA profile `number_format` (frontend/get_user_data "language") → NumFormat; "language", "system", unset → from
 *  the language: Dutch a comma, else a point, never grouped. "none" → point. */
export function numFormatOf(ha: string | null | undefined, lang: 'en' | 'nl'): NumFormat {
  if (ha === 'comma_decimal' || ha === 'decimal_comma' || ha === 'space_comma') return ha;
  if (ha === 'none') return 'point';
  return lang === 'nl' ? 'comma' : 'point';
}

let NF: NumFormat = 'point';
/** The display's number format; fmtNum/fmtValue/kw use it (= firmware setNumFormat). */
export const setNumFormat = (nf: NumFormat): void => { NF = nf; };
export const numFormat = (): NumFormat => NF;

/** A "-1234.5" toFixed string in a number format. */
export function localNum(s: string, nf: NumFormat): string {
  if (nf === 'point') return s;
  const dot = s.indexOf('.');
  let int = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  const dec = nf === 'comma_decimal' ? '.' : ',';
  if (nf !== 'comma') {
    const grp = nf === 'comma_decimal' ? ',' : nf === 'decimal_comma' ? '.' : ' ';
    const sign = int[0] === '-' || int[0] === '+' ? int[0] : '';
    let digits = int.slice(sign.length), out = '';
    while (digits.length > 3 && /^\d+$/.test(digits)) { out = grp + digits.slice(-3) + out; digits = digits.slice(0, -3); }
    int = sign + digits + out;
  }
  return dot < 0 ? int : int + dec + frac;
}

/** The one number formatter: minutes whole (ha-paper#22: HA suggests 2 decimals for a duration sensor), else HA
 *  display_precision, else the unit's decimals, else up to 2 with zeros trimmed; then the number format (eink-ha-os#110). */
export function fmtNum(n: number, unit: string, dp?: number | null): string {
  let s: string;
  const ud = UNIT_DP.get(unit);
  if (unit === 'min') s = n.toFixed(0);
  else if (dp != null && Number.isInteger(dp) && dp >= 0) s = n.toFixed(Math.min(dp, 10));
  else if (ud !== undefined) s = n.toFixed(ud);
  else { s = n.toFixed(2); if (s.includes('.')) s = s.replace(/\.?0+$/, ''); }
  return localNum(/^-0(\.0*)?$/.test(s) ? s.slice(1) : s, NF);
}

/** A shown number (fmtNum output in the current number format) with one decimal less, rounded like toFixed:
 *  "28.30" → "28.3" → "28". No decimals or not a number → unchanged. A tile whose value + unit does not fit drops
 *  decimals before the unit is cut (eink-ha-os#151, spec/test-vectors/format.json fewerDecimals). */
export function fewerDecimals(shown: string): string {
  const dec = NF === 'point' || NF === 'comma_decimal' ? '.' : ',';
  const grp = NF === 'comma_decimal' ? ',' : NF === 'decimal_comma' ? '.' : NF === 'space_comma' ? ' ' : '';
  let plain = '', frac = -1;
  for (let i = 0; i < shown.length; i++) {
    const ch = shown[i];
    if (grp && ch === grp) continue;
    if (ch === dec && frac < 0) { frac = plain.length; plain += '.'; continue; }
    if (!/[0-9]/.test(ch) && !(i === 0 && ch === '-')) return shown;
    plain += ch;
  }
  if (frac < 0 || frac + 1 >= plain.length || frac === 0 || (frac === 1 && plain[0] === '-')) return shown;
  const s = Number(plain).toFixed(plain.length - frac - 2);
  return localNum(/^-0(\.0*)?$/.test(s) ? s.slice(1) : s, NF);
}

/** Significant digits of a shown number: digits from the first non-zero one ("0.25" → 2, "28.3" → 3, "0.0" → 0). */
const sigDigits = (s: string): number => (s.replace(/[^0-9]/g, '').replace(/^0+/, '')).length;

/** A value that fits maxW with its unit (eink-ha-os#162): decimals drop while the number keeps 3 significant digits, over every
 *  size step (sizes descending), then the same with 2 ("28.30" → "28.3" at the big size; "1.23" stays and steps
 *  down; "0.2534" → "0.253", never "0.3"); the first fit wins. Nothing fits → the smallest size with decimals dropped
 *  until it fits. Never an ellipsis. width(value, size) includes the unit (spec/test-vectors/format.json fitValue). */
export function fitValue(value: string, sizes: number[], maxW: number, width: (v: string, size: number) => number): { value: string; size: number } {
  for (const floor of [3, 2])
    for (const size of sizes) {
      let v = value;
      for (let f = fewerDecimals(v); width(v, size) > maxW && f !== v && sigDigits(f) >= floor; f = fewerDecimals(v)) v = f;
      if (width(v, size) <= maxW) return { value: v, size };
    }
  const size = sizes.length ? sizes[sizes.length - 1] : 0;
  let v = value;
  for (let f = fewerDecimals(v); width(v, size) > maxW && f !== v; f = fewerDecimals(v)) v = f;
  return { value: v, size };
}

/** A label that fits maxW (eink-ha-os#215, format.json fitMiddle): the first size (descending) where it fits whole; else the
 *  smallest size with the middle cut to "…", keeping ceil(k/2) codepoints of the start and floor(k/2) of the end
 *  for the largest k that fits ("0.1.0-alpha.6-18-gbf929d4" → "0.1.0-al…gbf929d4"). */
export function fitMiddle(text: string, sizes: number[], maxW: number, width: (v: string, size: number) => number): { value: string; size: number } {
  for (const size of sizes) if (width(text, size) <= maxW) return { value: text, size };
  const size = sizes.length ? sizes[sizes.length - 1] : 0;
  const cp = [...text];
  for (let k = cp.length - 1; k > 0; --k) {
    const v = cp.slice(0, Math.ceil(k / 2)).join('') + '…' + cp.slice(cp.length - Math.floor(k / 2)).join('');
    if (width(v, size) <= maxW) return { value: v, size };
  }
  return { value: '…', size };
}

/** An HA state: numbers through fmtNum, anything else unchanged. */
/** HA state without a value (eink-ha-os#86): the tile shows a ring and this reason. Anything else (a value, or nothing received
 *  yet = "—") → null. */
export type EntityGap = 'unavailable' | 'unknown';
export const entityGap = (state: string | null | undefined): EntityGap | null => (state === 'unavailable' || state === 'unknown' ? state : null);
export const fmtValue = (state: string, unit: string, dp?: number | null): string => (NUM.test(state) ? fmtNum(Number(state), unit, dp) : state);

/** What a stat tile shows for a raw HA entity (eink-ha-os#161): climate → current_temperature in °C, weather → temperature in
 *  its temperature_unit (absent = °C), anything else → state + unit_of_measurement. No `state` = no temperature ("—").
 *  The console's entity list (GET /ha/entities) sends the same pair. spec/test-vectors/stat-raw.json. */
export function statSource(id: string, state: string, attrs: Record<string, unknown>): { state?: string; unit: string } {
  const d = id.split('.')[0];
  if (d === 'climate' || d === 'weather') {
    const t = attrs[d === 'climate' ? 'current_temperature' : 'temperature'];
    if (t == null || t === '') return { unit: '' };
    return { state: String(t), unit: d === 'weather' && attrs.temperature_unit ? String(attrs.temperature_unit) : '°C' };
  }
  return { state, unit: attrs.unit_of_measurement == null ? '' : String(attrs.unit_of_measurement) };
}

/** Does a climate entity's `preset_modes` attribute (a list, or its JSON text on the display) offer `away`? (eink-ha-os#148: the
 *  zoneList's away button shows only when one zone does, and is sent only to those zones.) */
export function presetHasAway(modes: unknown): boolean {
  let v = modes;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return false; } }
  return Array.isArray(v) && v.includes('away');
}

/** Power, unsigned: |w| ≥ 1000 → kW (2 decimals), else W (display_precision, else 0 decimals). */
export function kw(w: number, dp?: number | null): { v: string; u: string } {
  const a = Math.abs(w);
  return a >= 1000 ? { v: fmtNum(a / 1000, 'kW'), u: 'kW' } : { v: fmtNum(a, 'W', dp), u: 'W' };
}

/** Minutes since midnight (may be > 1440 or negative) → "HH:MM". */
export const hhmm = (t: number): string => pad(Math.floor((((t % 1440) + 1440) % 1440) / 60)) + ':' + pad(((t % 60) + 60) % 60);

/** Night window like "23-07" (wraps midnight) or "off". */
export function isNightHour(h: number, v: string): boolean {
  if (v === 'off') return false;
  const [a, b] = v.split('-').map(Number);
  return a > b ? h >= a || h < b : h >= a && h < b;
}

export function semver(v: string): { n: number[]; pre: string | null } {
  const [core, pre] = v.split('-');
  return { n: core.split('.').map(Number), pre: pre || null };
}

/** is a > b (semver, pre-release sorts before release). */
export function newer(a: string, b: string): boolean {
  const A = semver(a), B = semver(b);
  for (let i = 0; i < 3; i++) if (A.n[i] !== B.n[i]) return A.n[i] > B.n[i];
  if (A.pre && !B.pre) return false;
  if (!A.pre && B.pre) return true;
  return (A.pre || '') > (B.pre || '');
}

/** Wi-Fi RSSI → 1–4 bars. */
export const barsFor = (rssi: number): number => (rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1);

export const hm = (dt: Date): string => pad(dt.getHours()) + ':' + pad(dt.getMinutes());
