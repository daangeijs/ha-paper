import { describe, it, expect } from 'vitest';
import { bwLevel, BW_LUMA_THRESHOLD, partialWindow, bwAfter } from './panel.ts';

const WHOLE = { x: 0, y: 0, w: 800, h: 480 };

describe('panel preview (B/W after partial refresh)', () => {
  it('thresholds like x4_display.cpp bwNibble(grayBase=false): gray1 → ink, gray2 → paper', () => {
    expect([0, 1, 2, 3].map(bwLevel)).toEqual([0, 0, 3, 3]);
    expect(0x55 < BW_LUMA_THRESHOLD && 0xa8 > BW_LUMA_THRESHOLD).toBe(true);
  });
  it('one window = bounding box of the redrawn regions, x widened to 8 px', () => {
    expect(partialWindow([{ x: 14, y: 72, w: 186, h: 191 }])).toEqual({ x: 8, y: 72, w: 192, h: 191 });
    // two tiles in a row: the box also covers the gap and anything between them
    expect(partialWindow([{ x: 14, y: 72, w: 186, h: 191 }, { x: 406, y: 72, w: 186, h: 191 }])).toEqual({ x: 8, y: 72, w: 584, h: 191 });
  });
  it('half the screen or more → whole-frame FAST refresh → whole screen', () => {
    expect(partialWindow([{ x: 14, y: 72, w: 380, h: 191 }, { x: 406, y: 275, w: 380, h: 191 }])).toEqual(WHOLE);
    // the minute tick on Home (top bar + clock tile): 800 × 263 = 55 % of the panel
    expect(partialWindow([{ x: 0, y: 0, w: 800, h: 60 }, { x: 14, y: 72, w: 186, h: 191 }])).toEqual(WHOLE);
  });
  it('minute tick since #38: top-bar time + clock digits only (firmware rects, Classic Home) → 29 % window', () => {
    const win = partialWindow([{ x: 530, y: 8, w: 76, h: 40 }, { x: 30, y: 110, w: 268, h: 87 }]);
    expect(win).toEqual({ x: 24, y: 8, w: 584, h: 189 });
    expect(win.w * win.h / (800 * 480)).toBeLessThan(0.3);
  });
  it('no measurable region → whole screen; clipped to the panel', () => {
    expect(partialWindow([])).toEqual(WHOLE);
    expect(partialWindow([{ x: 790, y: 470, w: 50, h: 50 }])).toEqual({ x: 784, y: 470, w: 16, h: 10 });
  });
  it('B/W areas accumulate until a full refresh restores 4 gray', () => {
    const a = bwAfter([], { kind: 'partial', rects: [{ x: 16, y: 72, w: 184, h: 191 }] });
    expect(a).toEqual([{ x: 16, y: 72, w: 184, h: 191 }]);
    const b = bwAfter(a, { kind: 'partial', rects: [{ x: 600, y: 275, w: 184, h: 191 }] });
    expect(b).toHaveLength(2);
    expect(bwAfter(b, { kind: 'partial', rects: [{ x: 16, y: 80, w: 100, h: 50 }] })).toEqual(b);   // already B/W
    expect(bwAfter(b, { kind: 'partial', rects: [] })).toEqual([WHOLE]);
    expect(bwAfter(b, { kind: 'full' })).toEqual([]);
    expect(bwAfter([], { kind: 'fast' })).toEqual([WHOLE]);   // #212: a navigation is B/W only until the next clean
  });
});
