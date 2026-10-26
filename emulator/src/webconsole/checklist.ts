// First-run checklist (#91): linked → seeded → preview checked → done, one "fix it" link per open step. Shown with
// the seed report (GET /api/v1/seed, #89) until it is dismissed; finishing all steps dismisses it on the display
// (DELETE /api/v1/seed), so a second browser does not show it again. "Preview checked" is per browser (localStorage).
// #184: the count is of tiles the house can fill; tiles it has nothing for (solar, battery, prices, …) are one calm
// "left out" line, and the "done" step only shows once it is done.
import type { StrKey } from '../core/strings.ts';
import type { SeedTile } from '../core/seed.ts';

export type CheckFix = 'device' | 'missing' | 'values';
export type CheckStep = { id: 'linked' | 'seeded' | 'preview' | 'done'; ok: boolean; text: string; fix: { label: string; to: CheckFix } | null };
/** The console only shows it while linked (else the link page); `offline`: linked, but HA unreachable.
 *  `filled` of `total` fillable tiles (seedSplit). */
export type CheckInput = { offline: boolean; filled: number; total: number; previewSeen: boolean };
type T = (k: StrKey, ...a: (string | number)[]) => string;

// What a left-out tile needs that the house does not have. A missing core sensor (inside, home use, …) is not here:
// the user can pick one.
const OPTIONAL: Record<string, StrKey> = {
  solar_power: 'optSolar', solar_today: 'optSolar', solar_chart: 'optSolar', grid_export_today: 'optSolar',
  battery_soc: 'optBattery', battery_power: 'optBattery', price: 'optPrice', usage_chart: 'optHistory',
  lights: 'optLights', heating: 'optHeating', rooms: 'optRooms',
};

/** Seed report → fillable count, the tiles the user can still pick, and what the house lacks (StrKeys, no repeats). */
export function seedSplit(tiles: SeedTile[]): { filled: number; total: number; pickable: SeedTile[]; leftOut: StrKey[] } {
  const pickable: SeedTile[] = [], leftOut: StrKey[] = [];
  for (const x of tiles) {
    if (!x.why) continue;
    const opt = x.why !== 'overview_full' && OPTIONAL[x.tile];
    if (!opt) pickable.push(x);
    else if (!leftOut.includes(opt)) leftOut.push(opt);
  }
  const filled = tiles.filter((x) => !x.why).length;
  return { filled, total: filled + pickable.length, pickable, leftOut };
}

export function checklist(i: CheckInput, t: T): CheckStep[] {
  const seeded = i.filled > 0;
  const steps: CheckStep[] = [
    { id: 'linked', ok: !i.offline, text: t(i.offline ? 'clHaOffline' : 'clLinked'), fix: !i.offline ? null : { label: t('clFixLink'), to: 'device' } },
    { id: 'seeded', ok: seeded, text: i.filled < i.total ? t('clFilled', i.filled, i.total) : i.filled === 1 ? t('clFilled1') : t('clFilledAll', i.filled), fix: i.filled < i.total ? { label: t('clFixMissing'), to: 'missing' } : null },
    { id: 'preview', ok: i.previewSeen, text: t(i.previewSeen ? 'clPreviewed' : 'clPreview'), fix: i.previewSeen ? null : { label: t('clFixPreview'), to: 'values' } },
  ];
  const done = steps.every((s) => s.ok);
  return [...steps, { id: 'done', ok: done, text: t('allSet'), fix: null }];
}

const SEEN_KEY = 'x4.previewSeen';
export function loadPreviewSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
export function savePreviewSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode, storage off */ }
}
