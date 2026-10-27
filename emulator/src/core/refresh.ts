// E-ink refresh policy (SPEC §7, issues #26, #197, #212). Pure decisions used by the emulator's refreshes and minute tick.
//
// Three panel-wide kinds (#197, SSD1677 sequences in firmware/src/hw/x4_display.cpp):
//  * fast: whole-frame differential update, no flash (~0.6 s). Every navigation: screen/app change, home, overlays
//    open/close, open page, keyboard / Wi-Fi views. Every NAV_CLEAN-th navigation is a clean instead. B/W only since
//    #212: grays thresholded like a partial (the gray pass cost ~0.5 s per page on the X4 Pro); the next clean restores them.
//  * clean: one short flash (~1 s). Boot, wake, glance render, quiet face / quiet end, standby, setup steps, new config,
//    style switch, OTA screen, and a scheduled "clean screen" at the first :00/:30 at least `cleanEvery` minutes
//    (Settings › Clean screen: 30, 60 or 120) after the last clean, only when a partial or fast refresh was drawn
//    since, and not during quiet hours (quiet end is a clean anyway).
//  * full: the multi-flash waveform, only for a manual POST /display/refresh.
// Partial refresh (windowed, B/W only since #38) otherwise, never on the quiet face (#295: no clock either), nor in
// standby (except its clock). Clock unset (no SNTP yet): no schedule, so CLEAN_CAP partials or fast refreshes force a clean
// ("ghosting limit").

export const CLEAN_SLOT_MIN = 30;
export const CLEAN_EVERY = [30, 60, 120] as const;
export const DEFAULT_CLEAN_EVERY = 30;
/** Partials before a forced full while the clock is unset (safety only; the legacy `fullEvery` setting is unused). */
export const CLEAN_CAP = 30;
/** Navigations per clean: the NAV_CLEAN-th navigation since the last clean is a clean, the others are fast (#197). */
export const NAV_CLEAN = 10;

export type RefreshInput = { reason: string; sleeping: boolean; quiet: boolean; sinceFull: number; clockKnown: boolean };
export type RefreshDecision =
  | { kind: 'skip'; why: 'standby' | 'quiet' }
  | { kind: 'clean'; reason: 'ghosting limit' }
  | { kind: 'partial'; sinceFull: number };

/** `quiet`: the quiet face is up (core/quiet.ts); it has no clock, so nothing is drawn, the minute tick included. */
export function decidePartial({ reason, sleeping, quiet, sinceFull, clockKnown }: RefreshInput): RefreshDecision {
  if (quiet) return { kind: 'skip', why: 'quiet' };
  if (sleeping && reason !== 'clock') return { kind: 'skip', why: 'standby' };
  const since = sinceFull + 1;
  if (!clockKnown && since >= CLEAN_CAP) return { kind: 'clean', reason: 'ghosting limit' };
  return { kind: 'partial', sinceFull: since };
}

export type NavInput = { navSinceClean: number; sinceFull: number; clockKnown: boolean };
export type NavDecision =
  | { kind: 'clean'; reason: 'nav clean' | 'ghosting limit' }
  | { kind: 'fast'; navSinceClean: number; sinceFull: number };

/** A navigation (#197): fast, or a clean every NAV_CLEAN-th time (or at the clock-unset cap). A fast counts toward the
 *  scheduled clean like a partial; a clean resets both counters (the caller's clean does). */
export function decideNav({ navSinceClean, sinceFull, clockKnown }: NavInput): NavDecision {
  const nav = navSinceClean + 1, since = sinceFull + 1;
  if (nav >= NAV_CLEAN) return { kind: 'clean', reason: 'nav clean' };
  if (!clockKnown && since >= CLEAN_CAP) return { kind: 'clean', reason: 'ghosting limit' };
  return { kind: 'fast', navSinceClean: nav, sinceFull: since };
}

/** Input coalescing (#212): the device drains its input queue once per loop pass, so a pass after a refresh holds every
 *  tap / key made while the panel was busy. Only the last one is handled (last intent wins, at most one navigation
 *  follows a refresh). Returns the index handled, -1 for none. */
export function coalesceInput(n: number): number {
  return n > 0 ? n - 1 : -1;
}

/** First :00/:30 (epoch minutes, UTC-aligned) at least `everyMin` after the last clean: everyMin … everyMin + 30 later. */
export function nextCleanMin(lastFullMin: number, everyMin: number = DEFAULT_CLEAN_EVERY): number {
  return Math.ceil((lastFullMin + everyMin) / CLEAN_SLOT_MIN) * CLEAN_SLOT_MIN;
}

export type CleanInput = { sinceFull: number; lastFullMin: number; nowMin: number; everyMin: number; quiet: boolean };
/** Scheduled clean due at `nowMin` (epoch minutes)? Only with partial / fast refreshes since the last clean and not on the
 * quiet face (standby keeps it); catches up after a gap. */
export function cleanDue({ sinceFull, lastFullMin, nowMin, everyMin, quiet }: CleanInput): boolean {
  return !quiet && sinceFull > 0 && nowMin >= nextCleanMin(lastFullMin, everyMin);
}

/**
 * Regions the minute tick redraws (issue #38): the clock text of the top bar / standby face (`time`) and
 * the digit window of each clock tile (`k<i>`; Sleek: digits + day progress). The whole tile `t<i>` only when the date
 * line changes. Top bar + clock tile was 800 × 263 px = 55 % of the panel, which the driver turns into a whole-frame
 * B/W refresh; the two windows' bounding box stays well under half.
 */
export function minuteKeys(clockTiles: readonly string[], dateChanged: boolean): string[] {
  return ['time', ...clockTiles.map((t) => 'k' + t.slice(1)), ...(dateChanged ? clockTiles : [])];
}

/** Power deadband (#85, spec/test-vectors/deadband.json): a power tile takes a new value only when it moved ≥ 50 W and
 *  ≥ 5 % of the shown value, or crosses the W ↔ kW boundary; otherwise it keeps the last shown value (no redraw). */
export function powerMoved(shown: number, now: number): boolean {
  if ((Math.abs(shown) >= 1000) !== (Math.abs(now) >= 1000)) return true;
  const d = Math.abs(now - shown);
  return d >= 50 && d * 20 >= Math.abs(shown);
}

export class PowerHold {
  private shown = new Map<string, number>();
  /** Value to show for `key`; remembers it. */
  hold(key: string, w: number): number {
    const s = this.shown.get(key);
    if (s === undefined || powerMoved(s, w)) { this.shown.set(key, w); return w; }
    return s;
  }
  forget(key: string): void { this.shown.delete(key); }
}
