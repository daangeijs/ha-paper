// Hardware-key factory reset and crash-loop recovery (issue #21). Pure; the emulator and the firmware
// (firmware/src/core/recovery.cpp, a 1:1 port) run it. Vectors: spec/test-vectors/recovery.json.
//
// Hold Power + Right (and nothing else) for 5 s → confirmation screen. Release every key, then Right alone resets;
// any other key, the Home key or a touch cancels; 10 s without an answer cancels. Left is never part of the combo:
// held at reset it is the GPIO0 strap for download mode. After the screen goes away (reset, cancel, timeout) all keys
// must be released before a new hold counts, so a key stuck down in a bag shows the screen once, not every 15 s.
// Hold Power + Left (and nothing else) for 5 s → restart (issue #226): the app shows "Restarting…" and restarts. A
// software restart does not sample the GPIO0 strap, so Left held then does not enter download mode.
// Power alone (issue #258): released before 2 s = a short press ('press': standby / wake); held 2 s = 'off' (the
// "Turned off" face, then the board switches off), while still held. Power + Right / Left within the 2 s turns into
// those holds. A Power hold only counts after Power was seen released once since boot: the hold that switched the
// board on is still down when the firmware starts.

export const RESET_HOLD_MS = 5000;
export const RESET_CONFIRM_MS = 10_000;
export const RESTART_HOLD_MS = 5000;
export const POWER_OFF_HOLD_MS = 2000;
export const CRASH_LOOP_BOOTS = 3;   // this many crash resets in a row, newest first → offer the reset screen at boot

// Sample bits: keys held now, or pressed since the last sample (a press shorter than the sample interval still counts).
export const KEY_POWER = 1, KEY_RIGHT = 2, KEY_LEFT = 4, KEY_OTHER = 8;   // OTHER = Home key or a touch
const COMBO = KEY_POWER | KEY_RIGHT;
const RESTART_COMBO = KEY_POWER | KEY_LEFT;

export type RecoveryPhase = 'idle' | 'hold' | 'rhold' | 'phold' | 'confirm';   // rhold = Power + Left (restart), phold = Power alone
export type RecoveryAction = 'none' | 'show' | 'reset' | 'cancel' | 'timeout' | 'restart' | 'press' | 'off';
export type RecoveryState = {
  phase: RecoveryPhase;
  since: number;     // ms: hold start / screen shown
  armed: boolean;    // idle: all keys were released since the last screen; confirm: released since it was shown
  crash: boolean;    // confirm: offered at boot after a crash loop (wording only)
  powerArmed: boolean;   // Power was released since boot: a Power-alone hold counts
};

export const recoveryInit = (): RecoveryState => ({ phase: 'idle', since: 0, armed: true, crash: false, powerArmed: false });
/** Boot after a crash loop: the confirmation screen straight away. */
export const recoveryOffer = (nowMs: number): RecoveryState => ({ phase: 'confirm', since: nowMs, armed: false, crash: true, powerArmed: false });

export function recoveryStep(s0: RecoveryState, nowMs: number, keys: number): { state: RecoveryState; action: RecoveryAction } {
  const powerArmed = s0.powerArmed || !(keys & KEY_POWER);
  const s = { ...s0, powerArmed };
  const at = (phase: RecoveryPhase, armed = true): RecoveryState => ({ phase, since: nowMs, armed, crash: false, powerArmed });
  const idle = (action: RecoveryAction) => ({ state: { ...at('idle', keys === 0), since: 0 }, action });
  const reset = () => ({ state: { ...recoveryInit(), powerArmed }, action: 'none' as const });
  const elapsed = (nowMs - s.since) >>> 0;   // millis() wraps: unsigned elapsed, like the firmware
  if (s.phase === 'idle') {
    if (!s.armed) return { state: { ...s, armed: keys === 0 }, action: 'none' };
    if (keys === COMBO) return { state: at('hold'), action: 'none' };
    if (keys === RESTART_COMBO) return { state: at('rhold'), action: 'none' };
    if (keys === KEY_POWER && s0.powerArmed) return { state: at('phold'), action: 'none' };
    return { state: s, action: 'none' };
  }
  if (s.phase === 'phold') {
    if (keys === 0) return idle('press');   // released before 2 s: a short press
    if (keys === COMBO) return { state: at('hold'), action: 'none' };
    if (keys === RESTART_COMBO) return { state: at('rhold'), action: 'none' };
    if (keys !== KEY_POWER) return reset();
    if (elapsed >= POWER_OFF_HOLD_MS) return idle('off');   // still held: unarmed, the key-up does nothing
    return { state: s, action: 'none' };
  }
  if (s.phase === 'rhold') {
    if (keys !== RESTART_COMBO) return reset();
    if (elapsed >= RESTART_HOLD_MS) return idle('restart');   // keys still held: not armed until released
    return { state: s, action: 'none' };
  }
  if (s.phase === 'hold') {
    if (keys !== COMBO) return reset();
    if (elapsed >= RESET_HOLD_MS) return { state: at('confirm', false), action: 'show' };
    return { state: s, action: 'none' };
  }
  if (elapsed >= RESET_CONFIRM_MS) return idle('timeout');
  if (!s.armed) return { state: { ...s, armed: keys === 0 }, action: 'none' };
  if (keys === KEY_RIGHT) return idle('reset');
  if (keys !== 0) return idle('cancel');
  return { state: s, action: 'none' };
}

/** Crash resets in a row at the top of the boot ring (newest first). BROWNOUT does not count: a reset cannot fix a
 *  flat battery, and it breaks the streak. */
export function crashStreak(reasons: string[]): number {
  let n = 0;
  for (const r of reasons) { if (!LOOP_REASONS.has(r)) break; n++; }
  return n;
}
const LOOP_REASONS = new Set(['PANIC', 'INT_WDT', 'TASK_WDT', 'WDT', 'CPU_LOCKUP']);
export const isCrashLoop = (reasons: string[]): boolean => crashStreak(reasons) >= CRASH_LOOP_BOOTS;
