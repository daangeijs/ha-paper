// Power decision (docs/ROBUSTNESS_PLAN.md Phase 3): may the display deep-sleep now, when must it wake, and how hard
// should CPU and Wi-Fi work while awake. Pure; the emulator, the device simulator and the firmware
// (firmware/src/core/power.cpp, a 1:1 port) all run it. Vectors: spec/test-vectors/power/*.json.
import { inQuietHours, quietEndHour } from './quiet.ts';
import { emptyWaitS } from './emptyHouse.ts';

// glance (eink-ha-os#10, decided in eink-ha-os#18: the default on battery; eink-ha-os#356): the panel shows the sleep face and the display deep-sleeps
// until a key, the charger, or the next transition: midnight (the face's date) or the start of quiet hours, whichever
// comes first (at most MAX_SLEEP_S). No periodic data wakes. A transition wake fetches a snapshot and redraws only when
// what the panel shows changed (core/glance.ts). A key press wakes into live mode for `standbyAfter` minutes ("Live for"),
// then the standby step (ha-paper#32, reworked in ha-paper#37) for `deepAfter` minutes ("Then standby for", 0 = never, -1 = none): the
// dashboard stays on the panel unchanged, no HA updates (WebSocket closed), Wi-Fi stays associated (API and console
// reachable), any key or touch goes live at once; then deep sleep as above (glancePhase).
// Quiet hours (eink-ha-os#295, core/quiet.ts) win over standby and glance: no timer wakes in the window. "Sleep at night" is gone
// (settings schema 2 moves it to glance). Empty house (eink-ha-os#331, core/emptyHouse.ts): glance waits EMPTY_WAIT_S (cut at
// the start of quiet hours) while nobody is home; quiet hours and live mode win.
// off = "Always live", glance = "Save battery". The Standby mode (timer wakes every `wakeEvery` minutes with the standby face
// on) is gone since ha-paper#37: settings schema 4 moves it to glance.
export type PowerSave = 'off' | 'glance';
export const POWER_SAVES: PowerSave[] = ['glance', 'off'];
// Legacy `wakeEvery` (the old Standby mode's timer wake, minutes): stored and served for a rollback, no effect since ha-paper#37.
export const WAKE_EVERY = [15, 30, 60];
export type OtaAuto = 'off' | 'notify' | 'night';

export const MAX_SLEEP_S = 8 * 3600;      // a missed wake source must never leave the device off for longer
export const API_QUIET_MS = 120_000;      // no deep sleep within 2 min of an API request
export const LOW_BATTERY_PCT = 5;         // below: sleep until a button or the charger wakes it
export const RECENT_CHARGE_MIN = 30;      // "charged within 30 min and ≥ 4.15 V" counts as external power
export const FULL_VOLTAGE = 4.15;
export const OTA_HOUR = 3;                // auto install / daily check window 03:00–04:00 (net/ota.cpp)

export type PowerInputs = {
  nowEpoch: number;            // seconds (UTC)
  localSec: number;            // seconds since local midnight
  powerSave: PowerSave;
  quiet: string;               // quiet hours "23-07" | "off"
  peeking: boolean;            // dashboard shown for 60 s after a press in quiet hours
  charging: boolean;
  usb: boolean;                // USB host connected (USB-JTAG)
  chargedAgoMin: number | null; // minutes since charging stopped; null = not since boot
  voltage: number | null;      // battery volts; null = unknown
  battery: number | null;      // %; null = gauge not read yet
  otaPendingVerify: boolean;   // running image not confirmed yet: a deep-sleep wake is a reset, a reset rolls back
  otaBusy: boolean;            // download / install running
  otaAuto: OtaAuto;
  otaDue: boolean;             // an install (auto night) or the daily check is due
  setup: boolean;              // AP / setup wizard
  msSinceApi: number | null;   // null = no API request since boot
  live?: boolean;              // glance: a key press / touch within the last `standbyAfter` minutes (absent = false)
  standbyLeftS?: number;       // glance (ha-paper#32, #37): seconds left in the standby step after live mode (absent / 0 = not in it)
  glanceFails?: number;        // glance: wakes in a row that could not reach HA (diagnostics; no backoff since eink-ha-os#356)
  armBootsLeft?: number;       // first-boot safety (eink-ha-os#10): confirmed boots this image still needs before any deep sleep (absent = 0)
  emptyHouse?: boolean;        // glance (eink-ha-os#331): the presence source says nobody is home (absent = false)
};

export type CpuProfile = 'full' | 'auto';
export type WifiPs = 'none' | 'min';
/** The clock a CPU profile runs at (eink-ha-os#177). The Arduino libs ship without CONFIG_PM_ENABLE, so no esp_pm DFS: auto is a
 *  fixed 80 MHz, the lowest clock that keeps APB at 80 MHz (UART, SPI to the panel, I2C and Wi-Fi unchanged). */
export const CPU_MHZ: Record<CpuProfile, number> = { full: 240, auto: 80 };
export type PowerReason = 'unconfirmed image' | 'ota running' | 'external power' | 'battery unknown' | 'low battery' | 'setup mode'
  | 'recent api' | 'ota window' | 'power save off' | 'quiet' | 'standby' | 'live' | 'glance' | 'empty house' | 'not armed';

export type PowerDecision = {
  deepSleepNow: boolean;
  wakeAtEpoch: number | null;  // timer wake; null when awake, or low battery (button/charger only)
  standby: boolean;            // ha-paper#37 standby step: awake, Wi-Fi on, no HA updates, the panel unchanged
  buttonWakeOnly: boolean;     // low battery: no timer, wake on Power/Right key or charger only
  cpuProfile: CpuProfile;      // full = 240 MHz; auto = 80 MHz (CPU_MHZ, Phase 3.2)
  wifiPs: WifiPs;              // none = no modem sleep; min = modem sleep (DTIM)
  external: boolean;
  reason: PowerReason;
};

/** Glance after a key press (ha-paper#32, #37): live for `standbyAfter` minutes, then the standby step for `deepAfter` minutes
 *  (0 = never: MAX_SLEEP_S at a time), then deep sleep. msSinceInput null = no key since the wake (a timer wake): neither.
 *  standbyLeftS = whole seconds left in the step (rounded up). Vectors: spec/test-vectors/standby-step.json. */
export function glancePhase(msSinceInput: number | null, standbyAfter: number, deepAfter: number): { live: boolean; standbyLeftS: number } {
  if (msSinceInput === null) return { live: false, standbyLeftS: 0 };
  const liveMs = standbyAfter * 60_000;
  if (msSinceInput < liveMs) return { live: true, standbyLeftS: 0 };
  if (deepAfter === 0) return { live: false, standbyLeftS: MAX_SLEEP_S };
  if (deepAfter < 0) return { live: false, standbyLeftS: 0 };   // none: straight to deep sleep
  return { live: false, standbyLeftS: Math.max(0, Math.ceil((liveMs + deepAfter * 60_000 - msSinceInput) / 1000)) };
}

/** Glance sleep (eink-ha-os#356), seconds from local `localSec` to the next transition: midnight (the sleep face's date) or the
 *  start of quiet hours, whichever comes first. */
export function glanceWaitS(localSec: number, quiet: string): number {
  const midnight = secsUntil(localSec, 0);
  return quietEndHour(quiet) < 0 ? midnight : Math.min(midnight, secsUntil(localSec, Number(quiet.split('-')[0]) * 3600));
}

/** Seconds from local time `localSec` to the next `targetSec` of the day (a full day when they are equal). */
export function secsUntil(localSec: number, targetSec: number): number {
  const d = (((targetSec - localSec) % 86400) + 86400) % 86400;
  return d === 0 ? 86400 : d;
}

export function isExternalPower(i: Pick<PowerInputs, 'charging' | 'usb' | 'chargedAgoMin' | 'voltage'>): boolean {
  return i.charging || i.usb || (i.chargedAgoMin !== null && i.chargedAgoMin < RECENT_CHARGE_MIN && i.voltage !== null && i.voltage >= FULL_VOLTAGE);
}

/** Charging honesty (issue eink-ha-os#11, spec/test-vectors/battery-label.json): `charging` = charger STAT pin, `usb` = a USB host
 * is seen. A full battery on USB drops STAT, so it says "on USB", never "charging". GET /status `power.source`. */
export function powerSource(charging: boolean, usb: boolean): 'usb' | 'battery' { return charging || usb ? 'usb' : 'battery'; }
/** About screen Battery row. */
export function batteryLabel(pct: number, charging: boolean, usb: boolean): string {
  return pct + '%' + (charging ? ' · charging' : usb ? ' · on USB' : '');
}

export function powerDecision(i: PowerInputs): PowerDecision {
  const external = isExternalPower(i);
  const cpuProfile: CpuProfile = external || i.otaBusy || i.battery === null ? 'full' : 'auto';
  const wifiPs: WifiPs = external || i.otaBusy || i.setup ? 'none' : 'min';
  const out = (reason: PowerReason, wakeAtEpoch: number | null = null): PowerDecision =>
    ({ deepSleepNow: wakeAtEpoch !== null, wakeAtEpoch, standby: false, buttonWakeOnly: false, cpuProfile, wifiPs, external, reason });

  if (i.otaPendingVerify) return out('unconfirmed image');
  if (i.otaBusy) return out('ota running');
  if (external) return out('external power');
  if ((i.armBootsLeft ?? 0) > 0) return out('not armed');
  if (i.battery === null) return out('battery unknown');
  if (i.battery < LOW_BATTERY_PCT) return { deepSleepNow: true, wakeAtEpoch: null, standby: false, buttonWakeOnly: true, cpuProfile, wifiPs, external, reason: 'low battery' };
  if (i.setup) return out('setup mode');
  const hour = Math.floor(i.localSec / 3600) % 24;
  const otaWanted = i.otaDue && i.otaAuto !== 'off';
  const otaNow = otaWanted && hour === OTA_HOUR;
  const quiet = inQuietHours(hour, i.quiet) && !i.peeking;
  // ha-paper#37 standby step: wins over a recent API request (the console stays reachable without waking HA); quiet hours
  // (deep sleep) and the install window win over it
  if (i.powerSave === 'glance' && !i.live && (i.standbyLeftS ?? 0) > 0 && !quiet && !otaNow) return { ...out('standby'), standby: true };
  if (i.msSinceApi !== null && i.msSinceApi < API_QUIET_MS) return out('recent api');
  if (otaNow) return out('ota window');
  if (i.powerSave === 'off') return out('power save off');
  if (i.live) return out('live');

  let wait = MAX_SLEEP_S;
  let reason: PowerReason;
  if (quiet) { reason = 'quiet'; wait = Math.min(wait, secsUntil(i.localSec, quietEndHour(i.quiet) * 3600)); }
  else if (i.emptyHouse) { reason = 'empty house'; wait = Math.min(wait, emptyWaitS(i.localSec, i.quiet)); }   // eink-ha-os#331
  else { reason = 'glance'; wait = Math.min(wait, glanceWaitS(i.localSec, i.quiet)); }   // eink-ha-os#356
  if (otaWanted) wait = Math.min(wait, secsUntil(i.localSec, OTA_HOUR * 3600));
  return out(reason, i.nowEpoch + wait);
}

/** POST /api/v1/device/sleep {"seconds": N} (eink-ha-os#178, power measurements): deep sleep now, skipping live mode, the standby step and the
 *  2-min API quiet; wake by timer after N s or by button/charger as usual. Refused (409, the powerDecision words) on an
 *  unconfirmed image, during OTA, on external power (it would never sleep there) and in setup. Not refused: battery
 *  unknown or low, first-boot safety not armed yet (an explicit request). Vectors: spec/test-vectors/sleep-now.json. */
export const SLEEP_NOW_MIN_S = 60;
export const SLEEP_NOW_MAX_S = 86400;
export type SleepNowCheck = { status: 202 | 409 | 422; error: string };
export function sleepNowCheck(seconds: unknown, i: PowerInputs): SleepNowCheck {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < SLEEP_NOW_MIN_S || seconds > SLEEP_NOW_MAX_S)
    return { status: 422, error: 'seconds must be an integer from ' + SLEEP_NOW_MIN_S + ' to ' + SLEEP_NOW_MAX_S };
  const no = (why: PowerReason): SleepNowCheck => ({ status: 409, error: 'stays awake: ' + why });
  if (i.otaPendingVerify) return no('unconfirmed image');
  if (i.otaBusy) return no('ota running');
  if (isExternalPower(i)) return no('external power');
  if (i.setup) return no('setup mode');
  return { status: 202, error: '' };
}
