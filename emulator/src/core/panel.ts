// Panel preview: what the X4 panel actually shows after partial refreshes (issue eink-ha-os#25).
//
// firmware/src/hw/x4_display.cpp: a full refresh draws B/W and then the 4-gray overlay. A partial refresh sends the
// B/W plane only (2-bit level ≥ 2 → white, else black: gray2 #A8A8A8 → white, gray1 #555 → black) for ONE window:
// the bounding box of every redrawn region (core/logic.cpp unionRect), x widened to 8 px. If that box covers half the
// screen or more, the driver does a whole-frame FAST refresh instead, so the whole screen goes B/W.
// The B/W area only grows until the next full refresh restores 4 gray. A navigation's fast refresh (eink-ha-os#197, whole frame)
// is B/W only since eink-ha-os#212 (no gray pass): it leaves the whole screen B/W until the next clean ({ kind: 'fast' }).
import type { Rect } from './paging.ts';

export const SCREEN_W = 800;
export const SCREEN_H = 480;
const WHOLE: Rect = { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H };

/** 2-bit level (0 ink … 3 paper) after a partial refresh. */
export const bwLevel = (v: number): 0 | 3 => (v >= 2 ? 3 : 0);
/** Same threshold on an 8-bit luma: halfway between gray1 (0x55) and gray2 (0xA8). */
export const BW_LUMA_THRESHOLD = (0x55 + 0xa8) / 2;

/** The window one partial refresh redraws for these region rects (screen px). No rects → whole screen. */
export function partialWindow(rects: readonly Rect[]): Rect {
  let x0 = SCREEN_W, y0 = SCREEN_H, x1 = 0, y1 = 0;
  for (const r of rects) {
    x0 = Math.min(x0, Math.max(0, r.x)); y0 = Math.min(y0, Math.max(0, r.y));
    x1 = Math.max(x1, Math.min(SCREEN_W, r.x + r.w)); y1 = Math.max(y1, Math.min(SCREEN_H, r.y + r.h));
  }
  if (x1 <= x0 || y1 <= y0) return WHOLE;
  x0 = Math.floor(x0 / 8) * 8; x1 = Math.min(SCREEN_W, Math.ceil(x1 / 8) * 8);
  if ((x1 - x0) * (y1 - y0) * 2 >= SCREEN_W * SCREEN_H) return WHOLE;   // driver: whole-frame FAST refresh
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------- B/W-only rule (issue eink-ha-os#38) ----------
// A partial refresh thresholds its window to black/white, and every region on this screen can be redrawn by one (data
// tick, tap, sub-page turn, the minute tick, the night/standby clock). So the screen is drawn in INK and PAPER only:
// values, text, live bars, separators, the clock. Gray (G1 #555, G2 #A8A8A8) stays only on the boot face (full refresh
// only) and the Sleek card surface (SURF; dither vs dots is an open owner decision). Lighter and darker fills use 1-bit
// patterns that survive the threshold; firmware gfx/style.h Tone::Track / Tone::Hatch draw the same pixels.
const svgTile = (n: number, on: (x: number, y: number) => boolean) => {
  let px = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (on(x, y)) px += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
  return `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='${n}' height='${n}' fill='%23111'>${px}</svg>")`;
};
/** Track = "light gray": 25 % ink dots on paper (x, y even). CSS background. */
export const TRACK = `${svgTile(2, (x, y) => x === 0 && y === 0)} 0 0 / 2px 2px #ECEBE5`;
/** Hatch = "dark gray": 2 px ink / 2 px paper diagonal stripes ((x + y) mod 4 < 2). CSS background. */
export const HATCH = `${svgTile(4, (x, y) => (x + y) % 4 < 2)} 0 0 / 4px 4px #ECEBE5`;
/** The same patterns as SVG paint (`<pattern>` defs in components/Device.tsx). */
export const TRACK_PAINT = 'url(#x4-track)';
/** Grays that must not appear on a screen a partial refresh can redraw (hex as written in the markup). */
export const GRAYS = ['#555', '#A8A8A8', '#BDBBB4', '#C4C2BB'];
/** Grays used in rendered markup (lint in emulator/render.test.ts). */
export const graysIn = (html: string): string[] => GRAYS.filter((g) => new RegExp(g + '(?![0-9a-f])', 'i').test(html));

export type PanelEvent = { kind: 'full' } | { kind: 'fast' } | { kind: 'partial'; rects: readonly Rect[] };

/** Screen areas currently B/W (thresholded) on the panel, after `ev`. Full (clean) refresh → none; fast → all. */
export function bwAfter(prev: readonly Rect[], ev: PanelEvent): Rect[] {
  if (ev.kind === 'full') return [];
  if (ev.kind === 'fast') return [WHOLE];
  const win = partialWindow(ev.rects);
  if (win.w === SCREEN_W && win.h === SCREEN_H) return [WHOLE];
  if (prev.some((r) => r.x <= win.x && r.y <= win.y && r.x + r.w >= win.x + win.w && r.y + r.h >= win.y + win.h)) return [...prev];
  return [...prev, win];
}
