// Front light timeout (issue #220). Vectors: spec/test-vectors/frontlight.json. Firmware: core/logic.h.
//
// After `lightTimeout` seconds without a key or touch the front light goes off; the brightness setting stays. The
// first key or tap after that (not Power) only turns the light back on and does nothing else, like ambient's
// "chrome back". Home Assistant updates and redraws never turn it on. Night mode and standby keep the light off.

/** Settings › Display › Light off: seconds, 0 = never. */
export const LIGHT_TIMEOUTS = [30, 60, 120, 300, 0];
export const DEFAULT_LIGHT_TIMEOUT = 60;

/** The light is out after `timeoutSec` s without input (0 = never). */
export const lightTimedOut = (idleMs: number, timeoutSec: number): boolean => timeoutSec > 0 && idleMs >= timeoutSec * 1000;

export type LightIn = { brightness: number; standby: boolean; night: boolean; lightOut: boolean };
/** Front light level (0–100) the board gets. */
export const frontlightPct = ({ brightness, standby, night, lightOut }: LightIn): number => (standby || night || lightOut ? 0 : brightness);

/** First input after the timeout: consumed when it is what turns the light back on (not Power, not on night/standby). */
export const lightWakeConsumes = (l: LightIn & { power: boolean }): boolean =>
  l.lightOut && l.brightness > 0 && !l.standby && !l.night && !l.power;
