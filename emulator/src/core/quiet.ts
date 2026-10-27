// Quiet hours (#295, decision on #294): one window that replaces night mode and the "Sleep at night" power mode.
// Vectors: spec/test-vectors/quiet.json (+ power/*, refresh.json, frontlight.json). Firmware: core/logic.h.
//
// Inside the window (clock known, not peeking) the display shows the quiet face: "Back at 07:00", the date and the
// first values of the Home page, frozen when the window starts. No minute clock (a deep-sleeping panel would show a
// wrong time all night). On battery it deep-sleeps to the window end (no timer wakes; the 03:00 OTA wake excepted);
// on USB it stays connected but draws no data. The front light follows its own timeout. Standby inside the window
// shows the same face. Any key, tap or swipe shows the dashboard for PEEK_MS (a "peek"), also as the first screen
// after a button wake, a power-on or any other boot inside the window; a timer wake does not peek.
import { isNightHour } from './format.ts';

export const QUIET_STEPS = ['off', '22-06', '23-07', '00-06'];
export const DEFAULT_QUIET = '23-07';
export const PEEK_MS = 60_000;
/** Values on the quiet face: the first QUIET_TILES tiles of the Home page with one of these types. */
export const QUIET_TILES = 3;
export const QUIET_TYPES = ['stat', 'gauge', 'price', 'thermo'];

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

/** Widget indices of the Home page that the quiet face shows, in order. */
export function quietTiles(types: readonly string[]): number[] {
  const out: number[] = [];
  types.forEach((t, i) => { if (out.length < QUIET_TILES && QUIET_TYPES.includes(t)) out.push(i); });
  return out;
}

/** A boot inside the window starts with a peek, except a timer wake (glance, OTA): nobody pressed anything. */
export type WakeKind = 'cold' | 'timer' | 'button' | 'charger' | 'other';
export const peekOnBoot = (wake: WakeKind): boolean => wake !== 'timer';

/** Settings schema 1 → 2: `quiet` from the old `display.night` (a window is kept; off or missing → the default, on). */
export function quietFromNight(night: unknown): string {
  return typeof night === 'string' && /^([01]\d|2[0-3])-([01]\d|2[0-3])$/.test(night) ? night : DEFAULT_QUIET;
}
