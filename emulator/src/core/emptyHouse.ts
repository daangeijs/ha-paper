// Empty-house sleep (eink-ha-os#331): when nobody is home, glance wakes every EMPTY_WAIT_S instead of `wakeEvery` and the
// sleeping panel shows the "Nobody home" face. Setting `display.emptyHouse`: '' = off, else the presence entity.
// Vectors: spec/test-vectors/empty-house.json (+ power/10-empty-house.json). Firmware: core/empty_house.cpp.
//
// Precedence: quiet hours win (asleep at night stays the quiet face, no timer wakes); a key press always wakes into
// live mode with the normal dashboard; the face is only on the sleeping panel (glance), never in live mode.
import { quietEndHour } from './quiet.ts';

/** Glance wait while nobody is home, seconds. */
export const EMPTY_WAIT_S = 2 * 3600;
/** Presence source domains: zone = number of persons in it (0 = empty); the others: off = empty. */
export const EMPTY_DOMAINS = ['zone', 'binary_sensor', 'input_boolean', 'group'];
/** The console preselects this source when HA has it. */
export const DEFAULT_EMPTY_SOURCE = 'zone.home';
/** binary_sensor device classes that count as "a door or window" on the face. */
export const OPEN_CLASSES = ['door', 'window', 'opening', 'garage_door'];

const domainOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf('.')));

/** A valid `display.emptyHouse`: '' (off) or an entity id of an EMPTY_DOMAINS domain. */
export function validEmptySource(v: unknown): boolean {
  if (v === '') return true;
  return typeof v === 'string' && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(v) && EMPTY_DOMAINS.includes(domainOf(v));
}

/** Nobody home by `entity`'s state. Unknown / unavailable / missing = not empty (the normal interval is the safe side). */
export function houseEmpty(entity: string, state: string | undefined | null): boolean {
  if (!entity || state == null) return false;
  if (domainOf(entity) === 'zone') return /^\d+$/.test(state) && Number(state) === 0;
  return EMPTY_DOMAINS.includes(domainOf(entity)) && state === 'off';
}

/** Seconds of an empty-house sleep from local time `localSec`: EMPTY_WAIT_S, cut at the start of quiet hours so the
 *  quiet face goes up on time. */
export function emptyWaitS(localSec: number, quiet: string): number {
  if (quietEndHour(quiet) < 0) return EMPTY_WAIT_S;
  const toStart = (((Number(quiet.split('-')[0]) * 3600 - localSec) % 86400) + 86400) % 86400;   // power.ts secsUntil
  return Math.min(EMPTY_WAIT_S, toStart || 86400);
}

/** "Next update ~{}" time: local `localSec` + emptyWaitS, "16:05" (24 h) or "4:05" (12 h, like the clock). */
export function emptyNextAt(localSec: number, quiet: string, clock: string): string {
  const t = (localSec + emptyWaitS(localSec, quiet)) % 86400;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return (clock === '12' ? String(h % 12 || 12) : String(h).padStart(2, '0')) + ':' + String(m).padStart(2, '0');
}

/** An entity the display holds: the facts read binary_sensor (door / window) and alarm_control_panel states. */
export type FactEntity = { id: string; name: string; state: string; deviceClass: string };
export type Alarm = 'armed' | 'disarmed' | 'triggered';
/** The face's facts, language-free; null = no source, the row is dropped. open.n = doors / windows open now,
 *  open.first = the name of the first open one (by entity id). */
export type HouseFacts = { inside: number | null; open: { n: number; first: string } | null; alarm: Alarm | null };

export function alarmOf(state: string): Alarm | null {
  if (state === 'disarmed') return 'disarmed';
  if (state === 'triggered') return 'triggered';
  return state.startsWith('armed_') || state === 'arming' || state === 'pending' ? 'armed' : null;
}

/** Up to three facts: inside temperature, doors / windows, alarm (the first alarm_control_panel by id). */
export function houseFacts(inside: number | null, ents: readonly FactEntity[]): HouseFacts {
  const sorted = [...ents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const doors = sorted.filter((e) => domainOf(e.id) === 'binary_sensor' && OPEN_CLASSES.includes(e.deviceClass) && (e.state === 'on' || e.state === 'off'));
  const open = doors.filter((e) => e.state === 'on');
  const panel = sorted.find((e) => domainOf(e.id) === 'alarm_control_panel');
  return {
    inside: inside != null && Number.isFinite(inside) ? inside : null,
    open: doors.length ? { n: open.length, first: open.length ? open[0].name : '' } : null,
    alarm: panel ? alarmOf(panel.state) : null,
  };
}
