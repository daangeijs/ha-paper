// Front light timeout (issue eink-ha-os#220). Vectors: spec/test-vectors/frontlight.json. Firmware: core/logic.h.
//
// After `lightTimeout` seconds without a key or touch the front light goes off; the brightness setting stays. The
// first key or tap after that (not Power) only turns the light back on and does nothing else, like ambient's
// "chrome back". Home Assistant updates and redraws never turn it on. Standby keeps the light off; quiet hours leave it
// to the timeout (eink-ha-os#295), and a press on the quiet face shows the dashboard instead of being consumed. A timer wake
// (glance, quiet-hours end, OTA) boots with the light off (eink-ha-os#357): nobody pressed anything.
import type { WakeKind } from './quiet.ts';

/** Settings › Display › Light off: seconds, 0 = never. */
export const LIGHT_TIMEOUTS = [30, 60, 120, 300, 0];
export const DEFAULT_LIGHT_TIMEOUT = 60;

/** The light is out after `timeoutSec` s without input (0 = never). */
export const lightTimedOut = (idleMs: number, timeoutSec: number): boolean => timeoutSec > 0 && idleMs >= timeoutSec * 1000;

export type LightIn = { brightness: number; standby: boolean; lightOut: boolean };
/** Front light level (0–100) the board gets. */
export const frontlightPct = ({ brightness, standby, lightOut }: LightIn): number => (standby || lightOut ? 0 : brightness);

/** First input after the timeout: consumed when it is what turns the light back on (not Power, not on the quiet face or
 *  in standby). */
export const lightWakeConsumes = (l: LightIn & { quiet: boolean; power: boolean }): boolean =>
  l.lightOut && l.brightness > 0 && !l.standby && !l.quiet && !l.power;

/** The light comes on at boot, except after a timer wake (eink-ha-os#357); then the first key or tap turns it on, not consumed. */
export const lightOnBoot = (wake: WakeKind): boolean => wake !== 'timer';
