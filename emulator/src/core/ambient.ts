// Ambient idle mode and the night face as a poster (issue #27). Vectors: spec/test-vectors/ambient.json.
//
// After AMBIENT_MS without input the dashboard drops its chrome: pager, battery icon, app label (and sub-page "1 of 2");
// a page with a clock tile also drops the top-bar clock. The page title and the status icons (offline, not linked,
// update, away, …) stay: they are information, not chrome. A low battery (< BATT_LOW %, the same threshold that adds
// the "NN%" text) keeps the battery visible. Not while a menu or setup is open, nor on the night/standby faces.
// The first touch or key (except Power) brings the chrome back as one partial refresh of the top bar and does nothing
// else. Firmware: core/logic.h ambientDue / chromeFor / nightStale.

export const AMBIENT_MS = 60_000;
export const BATT_LOW = 20;
/** Night face: "as of HH:MM" only when the last Home Assistant data is older than this. */
export const STALE_MS = 30 * 60_000;

export type AmbientInput = { idleMs: number; menu: boolean; setup: boolean };
export const ambientDue = ({ idleMs, menu, setup }: AmbientInput): boolean => !menu && !setup && idleMs >= AMBIENT_MS;

export type Chrome = { app: boolean; pager: boolean; battery: boolean; clock: boolean };
export function chromeFor(ambient: boolean, battery: number, clockTile: boolean): Chrome {
  if (!ambient) return { app: true, pager: true, battery: true, clock: true };
  return { app: false, pager: false, battery: battery < BATT_LOW, clock: !clockTile };
}

/** Data older than STALE_MS at `nowMs`? No data yet (null) or no clock (0) → not stale (the values show "—"). */
export const nightStale = (nowMs: number, lastDataMs: number | null): boolean =>
  !!lastDataMs && nowMs > 0 && nowMs - lastDataMs > STALE_MS;
