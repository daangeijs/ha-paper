// Travel severity (SPEC §6). Works without colour: 1–4 bars + word; red is inverted (solid).
// Test vectors: spec/test-vectors/severity.json.

export const SEV = [
  { level: 1, word: 'On time', car: 'Clear', color: '#1E8E3E' },
  { level: 2, word: 'Minor', car: 'Busy', color: '#F2B705' },
  { level: 3, word: 'Delayed', car: 'Slow', color: '#EF6C00' },
  { level: 4, word: 'Disrupted', car: 'Jammed', color: '#D32F2F' },
];

/** One departure: delay < 2 → 1, 2–<5 → 2, 5–15 → 3, > 15 or cancelled → 4. (Main.dc.html `sevOf`) */
export function sevOf(delay: number, cancelled: boolean): number {
  if (cancelled || delay > 15) return 4;
  if (delay >= 5) return 3;
  if (delay >= 2) return 2;
  return 1;
}

export type Departure = { delay: number; cancelled: boolean };
/** Route status = the worst of the NEXT TWO departures (the ones you would actually take). */
export function routeLevel(deps: Departure[]): number {
  return Math.max(1, ...deps.slice(0, 2).map((x) => sevOf(x.delay, x.cancelled)));
}

/** Car: ETA / typical ratio per level (SPEC §6). The emulator derives the ETA from the level. */
export const CAR_FACTOR = [1, 1.15, 1.4, 1.75];
export const carEta = (typical: number, level: number): number => Math.round(typical * CAR_FACTOR[level - 1]);
/**
 * Inverse, for firmware fed by a real travel-time sensor: ratio ≥ 1.75 → 4, ≥ 1.4 → 3, ≥ 1.15 → 2, else 1.
 * (Derived from the SPEC table; the emulator never needs it because its mock data starts from a level.)
 */
export function carLevel(eta: number, typical: number): number {
  const r = eta / typical;
  return r >= CAR_FACTOR[3] ? 4 : r >= CAR_FACTOR[2] ? 3 : r >= CAR_FACTOR[1] ? 2 : 1;
}

/** Badge view: word, solid red for level 4, segments of increasing height. */
export function badge(lvl: number, isCar: boolean, paper = '#ECEBE5', ink = '#111') {
  const S = SEV[lvl - 1]; const red = lvl === 4;
  return { word: isCar ? S.car : S.word, bg: red ? S.color : paper, fg: red ? '#fff' : ink,
    segs: [0, 1, 2, 3].map((k) => ({ h: 6 + k * 2, c: k < lvl ? (red ? '#fff' : S.color) : paper, bd: red ? '#fff' : ink })) };
}
