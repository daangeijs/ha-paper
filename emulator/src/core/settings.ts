// Display settings (SPEC §8) as GET/PUT /api/v1/settings carries them (`display`), the values the device's own
// Settings screen steps through, and the mapping onto the emulator's internal cfg.
import { SETTINGS } from './data.ts';
import { tr, type Lang, type StrKey } from './strings.ts';
import { CLEAN_EVERY, DEFAULT_CLEAN_EVERY } from './refresh.ts';
import { POWER_SAVES, WAKE_EVERY, type PowerSave } from './power.ts';
import { DEFAULT_LIVE_MIN, LIVE_MIN } from './glance.ts';
import { settingsScreens } from './config.ts';
import { TZ_ZONES, validTzSetting } from './locale.ts';
export { validPosixTz } from './locale.ts';

export type DisplayStyle = 'classic' | 'sleek';
export type Typeface = 'archivo' | 'bricolage' | 'fraunces' | 'geist';
/** Card-gray rendering on the panel (OWNER decision 1: both, chosen on the real panel). The emulator does not draw it. */
export type Surface = 'dither' | 'dots';
export const STYLES: DisplayStyle[] = ['classic', 'sleek'];
export const TYPEFACES: Typeface[] = ['archivo', 'bricolage', 'fraunces', 'geist'];
export const SURFACES: Surface[] = ['dither', 'dots'];
/** Settings that change the look: a change is one full refresh, never a region diff. */
export const LOOK_KEYS = ['style', 'typeface', 'surface'] as const;

export type DisplaySettings = { brightness: number; warmth: number; night: string; returnHome: string; standby: string; clock: string; intervalSec: number; fullEvery: number; cleanEvery: number;
  style: DisplayStyle; typeface: Typeface; surface: Surface;
  /** Push device health to Home Assistant as entities (#32, core/haReport.ts). Default on. */
  haReport: boolean;
  /** Power saving (#10): `glance` by default (#18) — on battery it deep-sleeps between wakes; on USB it is always live.
   *  New keys with defaults (migrate.ts rules): a firmware without them ignores them. */
  powerSave: PowerSave; wakeEvery: number; liveMin: number;
  /** Settings › Updates › Automatic (firmware key; the device keeps it with the OTA state). */
  otaAuto?: OtaAutoMode;
  /** POST /api/v1/debug/input allowed (#214, measuring on hardware). API only, no tile; missing = false. */
  debugInput?: boolean };
export type OtaAutoMode = 'off' | 'notify' | 'night';
/** `entities`: logical id → HA entity overrides ("-" = negate); `entity_sources`: resolved mapping (core/entityMap.ts). */
/** `tz`: clock override ("" = follow Home Assistant, #147); `tz_ha`: HA's time_zone; `tz_active`: the POSIX TZ in use. */
export type DeviceSettings = { display: DisplaySettings; name: string; ota_channel?: OtaChannel; tz?: string; tz_ha?: string; tz_active?: string;
  entities?: Record<string, string>; entity_sources?: Record<string, string> };
export type SettingsPatch = { display?: Partial<DisplaySettings>; name?: string; ota_channel?: OtaChannel; tz?: string; entities?: Record<string, string | null> };
export type OtaChannel = 'stable' | 'beta';

/** Emulator-internal cfg (Settings tiles): minutes as numbers, 0 = never. */
export type DisplayCfg = { brightness: number; warmth: number; night: string; fullEvery: number; cleanEvery: number; interval: number; returnHome: number; standby: number; clock: string;
  style: DisplayStyle; typeface: Typeface; surface: Surface; haReport: boolean } & PowerCfg;
/** Power saving (Settings › Power, #10). On the wire in `display`. */
export type PowerCfg = { powerSave: PowerSave; wakeEvery: number; liveMin: number };
export const DEFAULT_POWER: PowerCfg = { powerSave: 'glance', wakeEvery: 15, liveMin: DEFAULT_LIVE_MIN };
export type Cfg = DisplayCfg;

export const cfgToDisplay = (c: DisplayCfg): DisplaySettings => ({
  brightness: c.brightness, warmth: c.warmth, night: c.night, returnHome: c.returnHome ? String(c.returnHome) : 'never',
  standby: c.standby ? String(c.standby) : 'never', clock: c.clock, intervalSec: c.interval, fullEvery: c.fullEvery, cleanEvery: c.cleanEvery,
  style: c.style, typeface: c.typeface, surface: c.surface, haReport: c.haReport,
  powerSave: c.powerSave, wakeEvery: c.wakeEvery, liveMin: c.liveMin,
});
export const displayToCfg = (d: DisplaySettings): DisplayCfg => ({
  brightness: d.brightness, warmth: d.warmth, night: d.night, returnHome: d.returnHome === 'never' ? 0 : Number(d.returnHome),
  standby: d.standby === 'never' ? 0 : Number(d.standby), clock: d.clock, interval: d.intervalSec, fullEvery: d.fullEvery, cleanEvery: d.cleanEvery ?? DEFAULT_CLEAN_EVERY,
  style: d.style, typeface: d.typeface, surface: d.surface, haReport: d.haReport ?? true,
  powerSave: d.powerSave ?? DEFAULT_POWER.powerSave, wakeEvery: d.wakeEvery ?? DEFAULT_POWER.wakeEvery, liveMin: d.liveMin ?? DEFAULT_POWER.liveMin,
});

const range = (min: number, max: number, step: number): number[] => Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);

/** Every display setting the device's Settings › Display screen offers, with its choices (wire values) and labels. */
export const DISPLAY_FIELDS: { key: keyof DisplaySettings; label: StrKey; info?: StrKey; values: (string | number | boolean)[]; fmt: (v: string | number | boolean, lang: Lang) => string }[] = [
  { key: 'brightness', label: SETTINGS.brightness.lk, values: range(0, 100, 10), fmt: (v, lg) => SETTINGS.brightness.fmt(v, lg) },
  { key: 'warmth', label: SETTINGS.warmth.lk, values: range(0, 100, 10), fmt: (v, lg) => SETTINGS.warmth.fmt(v, lg) },
  { key: 'night', label: SETTINGS.night.lk, values: ['off', '22-06', '23-07', '00-06'], fmt: (v, lg) => SETTINGS.night.fmt(v, lg) },
  { key: 'returnHome', label: SETTINGS.returnHome.lk, values: ['never', '1', '5', '15'], fmt: (v, lg) => SETTINGS.returnHome.fmt(v === 'never' ? 0 : Number(v), lg) },
  { key: 'standby', label: SETTINGS.standby.lk, info: SETTINGS.standby.info, values: ['never', '10', '30', '60'], fmt: (v, lg) => SETTINGS.standby.fmt(v === 'never' ? 0 : Number(v), lg) },
  { key: 'clock', label: SETTINGS.clock.lk, values: ['24', '12'], fmt: (v, lg) => SETTINGS.clock.fmt(v, lg) },
  { key: 'intervalSec', label: SETTINGS.interval.lk, info: SETTINGS.interval.info, values: [5, 10, 30, 60], fmt: (v, lg) => SETTINGS.interval.fmt(v, lg) },
  { key: 'cleanEvery', label: SETTINGS.cleanEvery.lk, info: SETTINGS.cleanEvery.info, values: [...CLEAN_EVERY], fmt: (v, lg) => SETTINGS.cleanEvery.fmt(v, lg) },
  { key: 'style', label: SETTINGS.style.lk, values: STYLES, fmt: (v, lg) => SETTINGS.style.fmt(v, lg) },
  { key: 'typeface', label: SETTINGS.typeface.lk, values: TYPEFACES, fmt: (v, lg) => SETTINGS.typeface.fmt(v, lg) },
  { key: 'surface', label: SETTINGS.surface.lk, values: SURFACES, fmt: (v, lg) => SETTINGS.surface.fmt(v, lg) },
  { key: 'haReport', label: 'setHaReport', info: 'infoHaReport', values: [true, false], fmt: (v, lg) => tr(lg, v ? 'on' : 'off') },
  { key: 'powerSave', label: SETTINGS.powerSave.lk, info: SETTINGS.powerSave.info, values: POWER_SAVES, fmt: (v, lg) => SETTINGS.powerSave.fmt(v, lg) },
  { key: 'wakeEvery', label: SETTINGS.wakeEvery.lk, info: SETTINGS.wakeEvery.info, values: WAKE_EVERY, fmt: (v, lg) => SETTINGS.wakeEvery.fmt(v, lg) },
  { key: 'liveMin', label: SETTINGS.liveMin.lk, info: SETTINGS.liveMin.info, values: LIVE_MIN, fmt: (v, lg) => SETTINGS.liveMin.fmt(v, lg) },
];

/** A setting the browser's Settings page edits (#159): `display.<key>`, or a top-level key when `top`. */
export type SettingField = { key: string; top?: boolean; label: StrKey; info?: StrKey; values: (string | number | boolean)[]; fmt: (v: string | number | boolean, lang: Lang) => string };
/** Settings › Updates on the device: channel (top-level `ota_channel`) and automatic updates (`display.otaAuto`). */
export const OTA_FIELDS: SettingField[] = [
  { key: 'ota_channel', top: true, label: 'otaChannel', values: ['stable', 'beta'], fmt: (v, lg) => tr(lg, v === 'beta' ? 'chanBeta' : 'chanStable') },
  { key: 'otaAuto', label: 'otaAutomatic', values: ['off', 'notify', 'night'], fmt: (v, lg) => tr(lg, v === 'night' ? 'autoNight' : v === 'notify' ? 'autoNotify' : 'off') },
];
/** Clock time zone (#147): "" follows Home Assistant's, else a zone from the table (a POSIX string set over the API
 *  shows as itself in the console). */
export const TZ_FIELD: SettingField = { key: 'tz', top: true, label: 'timeZone', values: ['', ...TZ_ZONES], fmt: (v, lg) => (v === '' ? tr(lg, 'tzFromHa') : String(v)) };
const PAGE_TITLE: Record<string, StrKey> = { display: 'display', style: 'menuStyle', power: 'menuPower', updates: 'menuUpdates', ha: 'menuHa' };
const WIRE_KEY: Record<string, string> = { interval: 'intervalSec' };
/** Fields behind a fixed system tile; haReport and tz have no tile on the device, they sit with Home Assistant. */
const TILE_FIELDS: Record<string, string[]> = { ota: ['ota_channel', 'otaAuto'], ha: ['haReport', 'tz'] };
/**
 * The browser's Settings page (#159): the device's fixed Settings pages that hold settings, in menu order, each with
 * the fields of its tiles. Derived from settingsScreens(), so a setting added to the device menu shows up here.
 */
export function settingsPages(): { id: string; title: StrKey; fields: SettingField[] }[] {
  const all: SettingField[] = [...DISPLAY_FIELDS.map((f) => ({ ...f, key: f.key as string })), ...OTA_FIELDS, TZ_FIELD];
  const byKey = (k: string) => all.find((f) => f.key === k);
  return settingsScreens().filter((sc) => PAGE_TITLE[sc.id]).map((sc) => ({
    id: sc.id, title: PAGE_TITLE[sc.id],
    fields: sc.widgets.flatMap((w) => (w.type === 'setting' ? [WIRE_KEY[w.key as string] || String(w.key)] : TILE_FIELDS[w.type] || [])).map(byKey).filter((f): f is SettingField => !!f),
  })).filter((p) => p.fields.length);
}

/** PUT /settings rules for `display` (422 message, or null). Shared by the device simulator and the emulator. */
export function displayError(d: DisplaySettings): string | null {
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!int(d.brightness, 0, 100)) return 'display.brightness must be 0–100';
  if (!int(d.warmth, 0, 100)) return 'display.warmth must be 0–100';
  if (!/^(off|([01]\d|2[0-3])-([01]\d|2[0-3]))$/.test(String(d.night))) return 'display.night must be "off" or "HH-HH"';
  if (!['never', '1', '5', '15'].includes(String(d.returnHome))) return 'display.returnHome must be never, 1, 5 or 15';
  if (!['never', '10', '30', '60'].includes(String(d.standby))) return 'display.standby must be never, 10, 30 or 60';
  if (!['24', '12'].includes(String(d.clock))) return 'display.clock must be "24" or "12"';
  if (![5, 10, 30, 60].includes(d.intervalSec)) return 'display.intervalSec must be 5, 10, 30 or 60';
  if (!int(d.fullEvery, 1, 30)) return 'display.fullEvery must be 1–30';   // legacy (#26): stored, unused
  if (!(CLEAN_EVERY as readonly unknown[]).includes(d.cleanEvery)) return 'display.cleanEvery must be 30, 60 or 120';
  // Shared contract with the firmware (firmware/src/net/storage.cpp): these three messages are exact.
  if (!(STYLES as unknown[]).includes(d.style)) return 'style must be classic or sleek';
  if (!(TYPEFACES as unknown[]).includes(d.typeface)) return 'typeface must be archivo, bricolage, fraunces or geist';
  if (!(SURFACES as unknown[]).includes(d.surface)) return 'surface must be dither or dots';
  if (typeof d.haReport !== 'boolean') return 'display.haReport must be true or false';
  if (!(POWER_SAVES as unknown[]).includes(d.powerSave)) return 'display.powerSave must be off, night, standby or glance';
  if (!WAKE_EVERY.includes(d.wakeEvery)) return 'display.wakeEvery must be 15, 30 or 60';
  if (!LIVE_MIN.includes(d.liveMin)) return 'display.liveMin must be 1, 3, 5 or 10';
  // Firmware-only key (Settings › Updates); the simulators accept it so a firmware GET round-trips.
  const otaAuto = (d as { otaAuto?: unknown }).otaAuto;
  if (otaAuto !== undefined && !['off', 'notify', 'night'].includes(otaAuto as string)) return 'display.otaAuto must be off, notify or night';
  if (d.debugInput !== undefined && typeof d.debugInput !== 'boolean') return 'display.debugInput must be true or false';
  return null;
}
export const nameError = (name: unknown): string | null => (typeof name !== 'string' || !name.trim() || name.length > 40 ? 'name must be 1–40 characters' : null);

/** PUT /settings key tables (#43). A new setting = one row here and one in firmware core/settings_api.cpp. */
export const SETTINGS_KEYS = ['display', 'ota_channel', 'tz', 'name', 'entities'] as const;
export const DISPLAY_KEYS = ['brightness', 'warmth', 'night', 'returnHome', 'standby', 'clock', 'intervalSec', 'fullEvery', 'cleanEvery', 'otaAuto',
  'style', 'typeface', 'surface', 'haReport', 'powerSave', 'wakeEvery', 'liveMin', 'debugInput'] as const;
export const TZ_ERROR = 'tz must be "", a known zone like Europe/Amsterdam or a POSIX TZ string like CET-1CEST,M3.5.0,M10.5.0/3';


/** PUT /settings key + tz check, before any value rule (422 message, or null); = firmware settings_api::putError().
 * Input only: stored files keep keys this build does not know (#12 rollback rule, core/migrate.ts). */
export function settingsPutError(body: Record<string, unknown>): string | null {
  for (const k of Object.keys(body)) if (!(SETTINGS_KEYS as readonly string[]).includes(k)) return 'unknown key: ' + k;
  const d = body.display;
  if (d != null) {
    if (typeof d !== 'object' || Array.isArray(d)) return 'display must be an object';
    for (const k of Object.keys(d)) if (!(DISPLAY_KEYS as readonly string[]).includes(k)) return 'unknown key: display.' + k;
  }
  if (body.tz != null && (typeof body.tz !== 'string' || !validTzSetting(body.tz))) return TZ_ERROR;
  return null;
}
