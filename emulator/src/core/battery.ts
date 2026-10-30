// Battery history (eink-ha-os#231): what the gauge said every 5 min over the last 24 h, so a drain can be measured on the device
// itself. GET /api/v1/diagnostics `battery`; firmware core/battery_history.cpp (PSRAM ring, lost on reset and deep
// sleep). Vectors: spec/test-vectors/battery-history.json.

export const BATT_SAMPLE_S = 300;
export const BATT_HISTORY_N = 288;   // 24 h
export const BATT_FIELDS = ['t', 'pct', 'mv', 'chg', 'usb', 'power', 'rssi'] as const;
const SANE_EPOCH = 1_700_000_000;

/** t = epoch seconds, or uptime seconds while the clock is unknown (always < 1e9); mv / rssi null = not read;
 *  power = the powerDecision reason ("not armed", "external power", …) or "glance" during a glance wake. */
export type BattRow = [t: number, pct: number, mv: number | null, chg: 0 | 1, usb: 0 | 1, power: string, rssi: number | null];
export type BattIn = { ms: number; epoch: number; pct: number; mv: number | null; chg: boolean; usb: boolean; power: string; rssi: number | null };
/** lastMs = uptime of the last sample (null = none yet); chg / usb = last seen (null = none yet). */
export type BattState = { rows: BattRow[]; lastMs: number | null; chg: boolean | null; usb: boolean | null };
export const BATT_ZERO: BattState = { rows: [], lastMs: null, chg: null, usb: null };

/** Log line `[I][BATT] …`: every sample and every charging / USB change. */
export const battLine = (i: BattIn): string =>
  i.pct + '% ' + (i.mv === null ? '-' : i.mv) + ' mV · chg ' + (i.chg ? 1 : 0) + ' · usb ' + (i.usb ? 1 : 0) + ' · rssi ' + (i.rssi === null ? '-' : i.rssi);

/** One power-loop pass. pct < 0 = gauge not read yet: nothing. A row every BATT_SAMPLE_S (the first right away),
 *  newest BATT_HISTORY_N kept; log = the line to write (a sample or a charging / USB change), else null. */
export function battStep(s: BattState, i: BattIn): { s: BattState; log: string | null } {
  if (i.pct < 0) return { s, log: null };
  const due = s.lastMs === null || i.ms - s.lastMs >= BATT_SAMPLE_S * 1000;
  const changed = s.chg !== null && (s.chg !== i.chg || s.usb !== i.usb);
  let rows = s.rows;
  if (due) {
    const row: BattRow = [i.epoch > SANE_EPOCH ? i.epoch : Math.floor(i.ms / 1000), i.pct, i.mv, i.chg ? 1 : 0, i.usb ? 1 : 0, i.power, i.rssi];
    rows = [...rows, row].slice(-BATT_HISTORY_N);
  }
  return { s: { rows, lastMs: due ? i.ms : s.lastMs, chg: i.chg, usb: i.usb }, log: due || changed ? battLine(i) : null };
}

/** GET /diagnostics `battery`: rows oldest first, columns named in `fields`. */
export type BattHistory = { interval_s: number; fields: string[]; history: BattRow[] };
export const battHistory = (s: BattState): BattHistory => ({ interval_s: BATT_SAMPLE_S, fields: [...BATT_FIELDS], history: s.rows });

// Gauge filter (eink-ha-os#327): the CW2017 % reads low under load and high after rest (92 → 94 % after a night asleep, no
// charger). The shown % never rises without a charger; a rise of GAUGE_RISE_PTS or more confirmed by GAUGE_RISE_READS
// reads in a row is taken (a charge the board did not see). Falls pass at once. The state survives deep sleep (RTC
// memory); power-on starts at none. Firmware core/gauge_filter.cpp; vectors spec/test-vectors/gauge-filter.json.
export const GAUGE_RISE_PTS = 5;
export const GAUGE_RISE_READS = 3;
/** shown -1 = nothing shown yet; rise = reads in a row at least GAUGE_RISE_PTS above shown. */
export type GaugeState = { shown: number; rise: number };
export const GAUGE_ZERO: GaugeState = { shown: -1, rise: 0 };

/** One gauge read: raw < 0 = not read (state kept); charging = STAT or USB host seen. */
export function gaugeStep(s: GaugeState, raw: number, charging: boolean): GaugeState {
  if (raw < 0) return s;
  if (s.shown < 0 || charging || raw <= s.shown) return { shown: raw, rise: 0 };
  if (raw - s.shown < GAUGE_RISE_PTS) return { shown: s.shown, rise: 0 };
  const rise = s.rise + 1;
  return rise >= GAUGE_RISE_READS ? { shown: raw, rise: 0 } : { shown: s.shown, rise };
}
