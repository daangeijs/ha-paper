// Glance mode (#10; "glance by default" on battery, decided in #18). Between timer wakes the display deep-sleeps; each
// wake connects Wi-Fi, fetches the visible entities once, compares what it would draw with what the panel shows (a
// snapshot kept in RTC memory) and redraws only when that differs, then sleeps again. A key press wakes into live mode
// (WebSocket + touch) for `liveMin` minutes. When to sleep and for how long: core/power.ts powerDecision().
// Pure; the firmware port is firmware/src/core/glance.cpp. Vectors: spec/test-vectors/glance.json.
import { fnv1a } from './regions.ts';

/** A glance wake that is not done after 20 s gives up (HA unreachable counts as a failed wake) and sleeps. */
export const GLANCE_AWAKE_CAP_MS = 20_000;
/** Live mode after a key press, minutes (setting `liveMin`). */
export const LIVE_MIN = [1, 3, 5, 10];
export const DEFAULT_LIVE_MIN = 3;
/** Failed wakes in a row before the panel says so (one redraw with the offline mark). */
export const GLANCE_OFFLINE_AFTER = 3;
/** Values unchanged for this long: redraw anyway, so a clock on the page is never more than an hour behind. */
export const GLANCE_STALE_MIN = 60;
/** Wi-Fi fast connect: reuse the cached IP (no DHCP) while the lease we saw is younger than this. */
export const WIFI_IP_MAX_AGE_S = 3600;
/** A cached BSSID/channel that failed this often in a row is dropped (full scan + DHCP). */
export const WIFI_CACHE_MAX_FAILS = 2;

/** What the panel shows: region key → FNV-1a of the region text (core/regions.ts). Lives in RTC memory. */
export type Snapshot = Record<string, number>;
export const snapshotOf = (regions: Record<string, string>): Snapshot => Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, fnv1a(v)]));

/** Regions whose hash differs, plus keys only one side has (another face, another page layout). `ignore` = clock
 *  regions: the time alone never wakes the panel. No previous snapshot (cold boot, bad RTC) = everything changed. */
export function snapshotDiff(prev: Snapshot | null, next: Snapshot, ignore: readonly string[] = []): string[] {
  const skip = new Set(ignore);
  const keys = prev ? [...new Set([...Object.keys(prev), ...Object.keys(next)])] : Object.keys(next);
  return keys.filter((k) => !skip.has(k) && (!prev || prev[k] !== next[k])).sort();
}

export type GlanceIn = {
  ok: boolean;              // HA answered within the 20 s cap
  changed: string[];        // snapshotDiff() of this wake (unreachable: what the face shows without new data, #356)
  hadSnapshot: boolean;     // a valid snapshot was in RTC memory
  fails: number;            // failed wakes in a row before this one
  drawnOffline: boolean;    // the panel shows the offline mark
  minSinceDraw: number;     // minutes since the panel was last drawn
};
export type GlanceReason = 'first' | 'changed' | 'back online' | 'stale' | 'unchanged' | 'offline' | 'unreachable';
export type GlanceOut = { redraw: boolean; reason: GlanceReason; fails: number; drawnOffline: boolean };

/** What a glance wake does with its result. Redraws are full refreshes (the controller lost its RAM in deep sleep). */
export function glanceStep(i: GlanceIn): GlanceOut {
  if (!i.ok) {
    const fails = i.fails + 1;
    if (fails >= GLANCE_OFFLINE_AFTER && !i.drawnOffline) return { redraw: true, reason: 'offline', fails, drawnOffline: true };
    // #356: a transition wake moves the face itself (its date at midnight, the quiet face): drawn without new data
    if (i.hadSnapshot && i.changed.length) return { redraw: true, reason: 'changed', fails, drawnOffline: i.drawnOffline };
    return { redraw: false, reason: 'unreachable', fails, drawnOffline: i.drawnOffline };
  }
  const done = (redraw: boolean, reason: GlanceReason): GlanceOut => ({ redraw, reason, fails: 0, drawnOffline: false });
  if (!i.hadSnapshot) return done(true, 'first');
  if (i.changed.length) return done(true, 'changed');
  if (i.drawnOffline) return done(true, 'back online');
  if (i.minSinceDraw >= GLANCE_STALE_MIN) return done(true, 'stale');
  return done(false, 'unchanged');
}

/** Wi-Fi details kept in RTC memory after a successful connect. */
export type WifiCache = { valid: boolean; ssidHash: number; channel: number; fails: number; ipAtEpoch: number };
export type WifiFast = 'none' | 'radio' | 'ip';
/** How to reconnect after a wake: 'ip' = cached BSSID/channel + static IP (no scan, no DHCP), 'radio' = cached
 *  BSSID/channel + DHCP, 'none' = normal connect. Clock unknown (0) = no IP reuse. */
export function wifiFast(c: WifiCache, savedSsidHash: number, nowEpoch: number): WifiFast {
  if (!c.valid || c.ssidHash !== savedSsidHash || c.channel < 1 || c.channel > 14 || c.fails >= WIFI_CACHE_MAX_FAILS) return 'none';
  return nowEpoch > 0 && c.ipAtEpoch > 0 && nowEpoch >= c.ipAtEpoch && nowEpoch - c.ipAtEpoch < WIFI_IP_MAX_AGE_S ? 'ip' : 'radio';
}

/** First-boot safety (#10, council): a wrong power latch or wake pin would make a sleeping display look dead and
 *  invisible on USB. So an image deep-sleeps only once it is armed on this device: ARM_BOOTS boots that confirmed with
 *  the network up (the OTA confirm rule: 60 s up, Wi-Fi connected), or (#231) ARM_UPTIME_MIN minutes of one boot with
 *  the network up and the OTA image confirmed valid, whichever comes first. A new firmware version starts over. */
export const ARM_BOOTS = 3;
export const ARM_UPTIME_MIN = 30;
/** uptime: armed by ARM_UPTIME_MIN minutes online (stored, so a restart stays armed). */
export type ArmRecord = { version: string; boots: number; uptime: boolean };
/** The stored record for this firmware (another version or none → counting starts at 0). */
export const armFor = (stored: Partial<ArmRecord> | null, version: string): ArmRecord => (stored && stored.version === version && Number.isInteger(stored.boots) && (stored.boots as number) >= 0 ? { version, boots: stored.boots as number, uptime: stored.uptime === true } : { version, boots: 0, uptime: false });
/** This boot confirmed with the network up: count it (once per boot; stops counting at ARM_BOOTS). */
export const armCount = (r: ArmRecord): ArmRecord => (r.boots >= ARM_BOOTS ? r : { ...r, boots: r.boots + 1 });
/** #231: this boot has been online `netUpMin` minutes; arms once that reaches ARM_UPTIME_MIN with the image confirmed. */
export const armUptime = (r: ArmRecord, netUpMin: number, pendingVerify: boolean): ArmRecord =>
  (armBootsLeft(r) === 0 || pendingVerify || netUpMin < ARM_UPTIME_MIN ? r : { ...r, uptime: true });
/** powerDecision `armBootsLeft` (0 = armed); /diagnostics "glance armed after N more boots". */
export const armBootsLeft = (r: ArmRecord): number => (r.uptime ? 0 : Math.max(0, ARM_BOOTS - r.boots));
/** Why it is armed (log "sleep armed · …", /diagnostics deep_sleep.armed_by); null = not armed. */
export const armedBy = (r: ArmRecord): 'uptime' | 'boots' | null => (r.uptime ? 'uptime' : r.boots >= ARM_BOOTS ? 'boots' : null);
export const armReason = (r: ArmRecord): string => (r.uptime ? ARM_UPTIME_MIN + ' min online' : r.boots >= ARM_BOOTS ? ARM_BOOTS + ' boots online' : '');
/** Diagnostics card line. */
export const armLine = (left: number): string => (left > 0 ? 'Glance armed after ' + left + ' more boot' + (left === 1 ? '' : 's') + ' or ' + ARM_UPTIME_MIN + ' min online' : 'Glance armed');
/** A key held through the boot / wake screen keeps the display live this long (way out of a bad sleep loop). */
export const BOOT_HOLD_LIVE_MIN = 10;

/** Live mode is on while the last key press / touch is younger than `liveMin` minutes (null = none since the wake). */
export const liveNow = (msSinceInput: number | null, liveMin: number): boolean => msSinceInput !== null && msSinceInput < liveMin * 60_000;

/** Wake counters since power-on (#178, power measurements), RTC memory next to the snapshot. GET /status `power`
 *  (wakes, redraws, failedWakes, awakeS, asleepS, lastWake) and `refreshes`. A restart that is no deep-sleep wake keeps
 *  them but loses that boot's awake time and refreshes; power-on (or a bad RTC record) zeroes them. */
export type WakeTally = {
  wakes: number;            // deep-sleep wakes (timer, button, charger)
  redraws: number;          // glance wakes that redrew the panel
  failedWakes: number;      // glance wakes that did not get HA data within the 20 s cap
  asleepS: number;          // total deep sleep, seconds
  awakeMs: number;          // total awake time of boots that ended in deep sleep, ms
  fullRefreshes: number;    // refreshes of boots that ended in deep sleep (the running boot adds its own)
  partialRefreshes: number;
  last: null | { wifiMs: number | null; haMs: number | null; totalMs: number };   // last glance wake; null = not reached
};
export const TALLY_ZERO: WakeTally = { wakes: 0, redraws: 0, failedWakes: 0, asleepS: 0, awakeMs: 0, fullRefreshes: 0, partialRefreshes: 0, last: null };

/** Seconds a deep sleep lasted: the wall clock when it was known at sleep and still runs (ESP32 RTC timer), else the
 *  planned timer, else 0 (button-only sleep, clock unknown). Epochs: 0 = unknown. */
export function sleptSeconds(sleptAtEpoch: number, wakeAtEpoch: number, nowEpoch: number): number {
  if (sleptAtEpoch > 0 && nowEpoch >= sleptAtEpoch) return nowEpoch - sleptAtEpoch;
  return wakeAtEpoch > sleptAtEpoch ? wakeAtEpoch - sleptAtEpoch : 0;
}
/** A deep-sleep wake began. */
export const tallyWake = (t: WakeTally, sleptS: number): WakeTally => ({ ...t, wakes: t.wakes + 1, asleepS: t.asleepS + Math.max(0, sleptS) });
/** A glance wake decided. wifiMs / haMs: since the reset, Wi-Fi up / HA connected after Wi-Fi (null = never). */
export const tallyGlance = (t: WakeTally, ok: boolean, redraw: boolean, wifiMs: number | null, haMs: number | null, totalMs: number): WakeTally =>
  ({ ...t, redraws: t.redraws + (redraw ? 1 : 0), failedWakes: t.failedWakes + (ok ? 0 : 1), last: { wifiMs, haMs, totalMs } });
/** Going to deep sleep: this boot's awake time and refresh counts. */
export const tallySleep = (t: WakeTally, awakeMs: number, full: number, partial: number): WakeTally =>
  ({ ...t, awakeMs: t.awakeMs + awakeMs, fullRefreshes: t.fullRefreshes + full, partialRefreshes: t.partialRefreshes + partial });
