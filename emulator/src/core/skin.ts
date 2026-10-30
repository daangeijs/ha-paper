// Display styles (docs/DISPLAY_STYLES_PLAN.md): a render-time skin over the widget view model.
// Ported from reference/display-styles.js (`skin()`, `SK_ICON`, `SK_FONTS`).
//
// The rule that matters: skin() runs AFTER vm() and only for rendering. Emulator.regions() / commit() diff vm()
// output, never skinned output, so the display style never changes which regions count as dirty.
// Switching style or typeface is one full refresh (Emulator.setLook / setCfg / putSettings).
import { tr, type Lang } from './strings.ts';
import { PAPER, INK, PRICES, SOLAR, USAGE } from './data.ts';
import type { DisplayStyle, Typeface } from './settings.ts';
import { TRACK, HATCH } from './panel.ts';

/** Sleek card surface. Not a native panel level (EINK_NOTES §1); the firmware maps it to dither or dots. */
export const SURF = '#DEDCD5';

/** The emulator's single "look": classic, or Sleek in one of the four typefaces. */
export type Look = 'classic' | Typeface;
export const lookOf = (style: DisplayStyle, typeface: Typeface): Look => (style === 'sleek' ? typeface : 'classic');
/** Simulation › Display style: [look, label]. Every option except Classic is Sleek in that typeface. */
export const LOOKS: [Look, string][] = [['classic', 'Classic'], ['archivo', 'Archivo'], ['bricolage', 'Bricolage'], ['fraunces', 'Fraunces'], ['geist', 'Geist']];

/** Stroke icons (24 px grid) per stat label; `_` is the fallback (bolt). */
export const SK_ICON: Record<string, string> = {
  Solar: 'M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z',
  'Home use': 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6', Grid: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
  'Battery flow': 'M3 8h15a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H3zM22 11v2', Inside: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z',
  Lowest: 'M18 7a6 6 0 1 0 0 10M4 10h9M4 14h9', Highest: 'M18 7a6 6 0 1 0 0 10M4 10h9M4 14h9',
  'Cheapest 3h': 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2', _: 'M13 2L4 14h7l-1 8 9-12h-7z',
};
SK_ICON['Solar today'] = SK_ICON.Solar; SK_ICON['Used today'] = SK_ICON['Home use']; SK_ICON.Imported = SK_ICON.Grid; SK_ICON.Exported = SK_ICON.Grid;

/** Typefaces: t = text face, d = display face (numbers, titles), s = font-stretch of the display face, k = display size factor. */
export const SK_FONTS: Record<Look, { t: string; d: string; s: string; k: number }> = {
  classic: { t: "'X4 Plain Zero', 'Atkinson Hyperlegible', system-ui, sans-serif", d: "'X4 Plain Zero', 'Atkinson Hyperlegible', system-ui, sans-serif", s: '100%', k: 1 },
  archivo: { t: "'Archivo', system-ui, sans-serif", d: "'Archivo', system-ui, sans-serif", s: '75%', k: 1.12 },
  bricolage: { t: "'Bricolage Grotesque', system-ui, sans-serif", d: "'Bricolage Grotesque', system-ui, sans-serif", s: '100%', k: 0.92 },
  fraunces: { t: "'Geist', system-ui, sans-serif", d: "'Fraunces', Georgia, serif", s: '100%', k: 0.95 },
  geist: { t: "'Geist', system-ui, sans-serif", d: "'Geist', system-ui, sans-serif", s: '100%', k: 0.92 },
};

/** `isX` (Classic template) → `sX` (Sleek template). Widgets not listed keep the Classic layout + fallback styling. */
const SWAP: [string, string][] = [['isStat', 'sStat'], ['isClock', 'sClock'], ['isPrice', 'sPrice'], ['isGauge', 'sGauge'], ['isBars', 'sBars'], ['isThermo', 'sThermo'],
  ['isZoneList', 'sZones'], ['isLightList', 'sLights'], ['isLight', 'sLight'], ['isScene', 'sScene'], ['isSetting', 'sSetting'], ['isHistory', 'sHistory'], ['isBins', 'sBins'],
  ['isAgenda', 'sAgenda'], ['isNext', 'sNext']];   // #316

/**
 * Map one widget view model to style-specific render data. Pure: same input, same output; never mutates `v`.
 * Classic adds only `bg`, `fg`, `radius`. Sleek swaps `isX` for `sX` and adds the card data (spark, ring, dial, …).
 * `h` = current hour (0–23), `mins` = minutes past the hour (clock card day progress).
 */
export function skin(v: any, look: Look, h: number, mins: number, lang: Lang = 'en'): any {
  if (look === 'classic') return { ...v, bg: PAPER, fg: INK, radius: 10 };
  const o: any = { ...v, radius: 20, bg: SURF, fg: INK, subc: INK, border: v.isGhost ? '2px dotted #111' : '0px solid transparent' };
  if (v.isGhost) o.bg = 'transparent';
  for (const [k, n] of SWAP) if (o[k]) { o[k] = false; o[n] = true; }
  if (o.sStat) {
    const L = o.ikey ?? o.label, n = String(o.value).length;   // ikey: the English label of our own stat (the shown label follows the language)
    o.icon = SK_ICON[L] || SK_ICON._; o.vs = n <= 3 ? 62 : n === 4 ? 56 : n === 5 ? 48 : 40;
    const ser = L === 'Solar' || L === 'Solar today' ? SOLAR : L === 'Home use' || L === 'Used today' ? USAGE : null;
    o.hasSpark = !!ser;
    o.spark = ser ? ser.map((x, j) => ({ h: Math.max(8, Math.round((x / Math.max(...ser)) * 100)), c: j === h ? INK : j < h ? HATCH : TRACK })) : [];
  }
  if (o.sClock) { o.bg = INK; o.fg = PAPER; o.dayPct = Math.round(((h * 60 + mins) / 1440) * 100); o.big = o.rs > 1 ? 150 : 104; }
  if (o.sPrice) {
    const so = [...PRICES].sort((a, b) => a - b);
    o.cells = PRICES.map((p, j) => ({ c: j === h ? INK : p <= so[7] ? PAPER : p >= so[16] ? HATCH : TRACK, hh: j === h ? 26 : 16 }));
    o.chip = tr(lang, o.tag === 'HIGH' ? 'high' : o.tag === 'CHEAP' ? 'cheap' : 'normal');
    o.chipBg = o.tag === 'HIGH' ? INK : PAPER; o.chipFg = o.tag === 'HIGH' ? PAPER : INK;
  }
  if (o.sGauge) o.dash = ((o.pct / 100) * 289).toFixed(1);
  if (o.sBars) o.nowPct = (((h + 0.5) / 24) * 100).toFixed(2);
  if (o.sThermo) {
    const fr = (t: number) => Math.max(0, Math.min(1, (t - 14) / 12));
    const a = ((135 + 270 * fr(o.setN)) * Math.PI) / 180;   // numbers, not the text: "20,6" in Dutch (#110)
    o.arc = (fr(o.curN) * 207.3).toFixed(1); o.mx = (60 + 44 * Math.cos(a)).toFixed(1); o.my = (60 + 44 * Math.sin(a)).toFixed(1);
  }
  if (o.sZones) {
    o.bg = PAPER; o.radius = 0;
    o.rows = o.rows.map((r: any) => ({ ...r, cbg: r.heating ? INK : SURF, cfg: r.heating ? PAPER : INK, csub: r.heating ? PAPER : INK, bbg: PAPER }));
  }
  if (o.sLights) {
    o.bg = PAPER; o.radius = 0;
    o.rows = o.rows.map((r: any) => {
      if (!r.isLight) return r;
      const on = r.value !== tr(lang, 'off'); const b = on ? parseInt(r.value, 10) || 100 : 0;
      return { ...r, chipBg: on ? INK : SURF, chipFg: on ? PAPER : INK, dotBg: PAPER, dotFg: INK, trackC: on ? HATCH : 'transparent', fillC: on ? PAPER : 'transparent', bw: b };
    });
  }
  if (o.sLight) { const on = o.value !== tr(lang, 'off'); o.bg = on ? INK : SURF; o.fg = on ? PAPER : INK; o.subc = on ? PAPER : INK; o.dotBg = on ? PAPER : INK; o.dotFg = on ? INK : PAPER; o.btnBg = PAPER; }
  if (o.sScene) { o.bg = INK; o.fg = PAPER; }
  if (o.isWeather) { o.wxSleek = true; if (o.tall) o.bg = 'transparent'; }   // #318: two cards (hero, strip) when full screen
  return o;
}
