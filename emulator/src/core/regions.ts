// "Redraw only what changed" (SPEC §7, ARCHITECTURE §1 Region diff).
// Each region (tile `t<i>`, list header `h<i>`, list row `z:<zone>` / `l:<light>` / `r:<room>[:c]`, top bar `bar`)
// is serialised to text before and after new data; only regions whose text differs are redrawn.
// If nothing differs there is NO refresh at all.

export type RegionMap = Record<string, string>;

/** JSON replacer: drops callbacks and redraw-highlight flags so they never count as visible content. */
export const stripRegion = (k: string, v: unknown): unknown => (typeof v === 'function' || k === 'dirty' || k === 'hdrDirty' || k === 'clockDirty' ? undefined : v);

/** Text of one region (what the firmware would hash). */
export const serializeRegion = (view: unknown): string => JSON.stringify(view, stripRegion);

/** Keys of regions in `next` whose content differs from `prev` (new regions count as changed). */
export const changedRegions = (prev: RegionMap, next: RegionMap): string[] => Object.keys(next).filter((k) => prev[k] !== next[k]);

/** 32-bit FNV-1a over UTF-8 — a cheap per-region hash the firmware can keep instead of the full text. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export const hashRegions = (m: RegionMap): Record<string, number> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fnv1a(v)]));
