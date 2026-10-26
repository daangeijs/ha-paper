// GET /screens/{id}/preview.png for the simulator: an 800 × 480 8-bit grayscale PNG with the paper colour,
// the top bar rule and the widget frames at the firmware's fixed grid rectangles (src/core/paging.ts rects()).
// It shows the layout, not the rendered content (the emulator draws that).
import { crc32, deflateSync } from 'node:zlib';
import { rects } from '../src/core/paging.ts';
import type { Screen } from '../src/core/config.ts';

const W = 800, H = 480, PAPER = 0xec, INK = 0x11, GRAY = 0xa8;

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function previewPng(screen: Screen): Buffer {
  const px = Buffer.alloc(W * H, PAPER);
  const hline = (x: number, y: number, w: number, c: number) => { if (y >= 0 && y < H) px.fill(c, y * W + Math.max(0, x), y * W + Math.min(W, x + w)); };
  const vline = (x: number, y: number, h: number, c: number) => { if (x >= 0 && x < W) for (let i = Math.max(0, y); i < Math.min(H, y + h); i++) px[i * W + x] = c; };
  for (let t = 0; t < 2; t++) hline(14, 58 + t, W - 28, GRAY);
  rects(screen.widgets).forEach((r) => {
    if (!r) return;
    for (let t = 0; t < 2; t++) { hline(r.x, r.y + t, r.w, INK); hline(r.x, r.y + r.h - 1 - t, r.w, INK); vline(r.x + t, r.y, r.h, INK); vline(r.x + r.w - 1 - t, r.y, r.h, INK); }
  });
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; px.copy(raw, y * (W + 1) + 1, y * W, (y + 1) * W); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
