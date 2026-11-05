// Battery days left (ha-paper#30): the glance sleep face's line "Battery 64% · about 23 days left". From the first sleep
// it shows a model (1100 mAh, deep-sleep floor + awake time); as the gauge falls while unplugged, the measured drain
// takes over. Computed when the face is drawn: no extra wakes. Firmware core/battery_days.cpp (anchor in RTC memory,
// net/power.cpp); vectors spec/test-vectors/battery-days.json. Numbers: docs/POWER_BUDGET.md, docs/HARDWARE_ASSUMPTIONS.md.
import { tr, type Lang } from './strings.ts';

export const BATT_MAH = 1100;          // A27: cell capacity (unverified)
export const SLEEP_MA = 0.2;           // A32: deep-sleep floor target < 200 µA (TRMNL measured ~100 µA)
export const AWAKE_MA = 40;            // awake average: live 27–38 mA at 80 MHz, a glance wake ~64 mA (0.67 C / 10.5 s)
export const DEFAULT_AWAKE_MIN = 11;   // awake minutes a day until counted: 3 transition wakes × 15 s + 10 min live
export const TALLY_MIN_H = 6;          // counted sleep + awake hours before the counts replace the default
export const MEASURE_MIN_H = 1;        // the anchor must be this old before the drop counts
export const BLEND_PTS = 10;           // full trust in the measurement after this many points dropped …
export const BLEND_DAYS = 7;           // … or this many days measured
export const DAYS_CAP = 99;            // more shows "99+"
const SANE_EPOCH = 1_700_000_000;

/** Model drain, % a day: counted awake time (WakeTally awakeMs / asleepS) once it covers TALLY_MIN_H, else the default. */
export function modelPctPerDay(awakeMs: number, asleepS: number): number {
  const awakeS = Math.max(0, awakeMs) / 1000, total = awakeS + Math.max(0, asleepS);
  const frac = total >= TALLY_MIN_H * 3600 ? awakeS / total : DEFAULT_AWAKE_MIN / 1440;
  return (24 * (frac * AWAKE_MA + (1 - frac) * SLEEP_MA) * 100) / BATT_MAH;
}

/** Where the measurement starts: the first gauge % seen unplugged with a known clock. Lives in RTC memory on the device. */
export type BattAnchor = { epoch: number; pct: number } | null;

/** One gauge read (pct < 0 = not read; pct is the filtered %, core/battery.ts gaugeStep). Charging drops the anchor;
 *  a rise (a charge the board did not see) or a clock that went back starts it again. */
export function anchorStep(a: BattAnchor, pct: number, charging: boolean, epoch: number): BattAnchor {
  if (pct < 0) return a;
  if (charging) return null;
  if (epoch <= SANE_EPOCH) return a;
  if (!a || pct > a.pct || epoch < a.epoch) return { epoch, pct };
  return a;
}

/** days: null = no days (charging or gauge unknown); DAYS_CAP + 1 = "99+". measured: % a day since the anchor (null =
 *  none yet); weight: its share in the rate (0 = model only). */
export type BattEstimate = { pct: number; charging: boolean; days: number | null; model: number; measured: number | null; weight: number };

export function battEstimate(pct: number, charging: boolean, a: BattAnchor, epoch: number, model: number): BattEstimate {
  const base = { pct, charging, model, measured: null, weight: 0 };
  if (pct < 0 || charging) return { ...base, days: null };
  let measured: number | null = null, weight = 0;
  if (a && epoch > SANE_EPOCH && epoch - a.epoch >= MEASURE_MIN_H * 3600) {
    const d = (epoch - a.epoch) / 86400, drop = Math.max(0, a.pct - pct);
    measured = Math.max(drop, 0.5) / d;   // whole points: no drop yet = under one point
    weight = Math.min(1, Math.max(drop / BLEND_PTS, d / BLEND_DAYS));
  }
  const rate = weight * (measured ?? 0) + (1 - weight) * model;
  const days = Math.min(DAYS_CAP + 1, Math.max(1, Math.floor(pct / rate + 0.5)));
  return { ...base, measured, weight, days };
}

/** The face line; '' = gauge unknown. */
export function battDaysLine(lang: Lang, e: BattEstimate): string {
  if (e.pct < 0) return '';
  if (e.charging) return tr(lang, 'battCharging', e.pct);
  if (e.days === null) return '';
  if (e.days === 1) return tr(lang, 'battDay1', e.pct);
  return tr(lang, 'battDays', e.pct, e.days > DAYS_CAP ? DAYS_CAP + '+' : e.days);
}

/** GET /diagnostics battery.estimate. */
export const battEstimateJson = (e: BattEstimate) => ({
  pct: e.pct < 0 ? null : e.pct, charging: e.charging, days_left: e.days,
  model_pct_per_day: Math.round(e.model * 1000) / 1000, measured_pct_per_day: e.measured === null ? null : Math.round(e.measured * 1000) / 1000,
  measured_weight: Math.round(e.weight * 1000) / 1000,
});
