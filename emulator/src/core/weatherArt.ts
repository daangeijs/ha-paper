// The 12 weather drawings (eink-ha-os#318), one source for the emulator (SVG) and the firmware bitmaps: `npm run vectors` writes
// firmware/assets/weather-icons.json, tools/icongen.py rasterises it at 44 px (strip) and 120 px (hero).
// 48-unit square; layers in order: fill (ink), stroke (ink, round caps / joins), erase (paper: the shape filled, and
// stroked `w` wide, so a cloud in front of the sun keeps a gap). Stroke widths are for the 44 px size; the hero draws
// them × WX_HERO_STROKE so the large drawing stays light.
import type { WxIcon } from './weather.ts';

export type WxLayer = { mode: 'fill' | 'stroke' | 'erase'; d: string; w?: number };
export const WX_GRID = 48;
export const WX_HERO_STROKE = 0.6;

// a cloud (flat bottom, two bumps), and the same raised for something falling below it
const CLOUD = 'M13 36h22a8.5 8.5 0 0 0 0-17a11.5 11.5 0 0 0-22 3.5a6.8 6.8 0 0 0 0 13.5z';
const CLOUD_UP = 'M13 30h22a8.5 8.5 0 0 0 0-17a11.5 11.5 0 0 0-22 3.5a6.8 6.8 0 0 0 0 13.5z';
const CLOUD_FRONT = 'M17 40h20a8 8 0 0 0 0-16a10.5 10.5 0 0 0-20 3a6.5 6.5 0 0 0 0 13z';
const RAYS = 'M24 4.5v4M24 39.5v4M4.5 24h4M39.5 24h4M10.2 10.2l2.8 2.8M35 35l2.8 2.8M10.2 37.8l2.8-2.8M35 13l2.8-2.8';
const SW = 3.4;   // line weight at 44 px

export const WX_ART: Record<WxIcon, WxLayer[]> = {
  sun: [{ mode: 'fill', d: 'M24 15a9 9 0 1 0 0 18a9 9 0 1 0 0-18z' }, { mode: 'stroke', d: RAYS, w: SW }],
  moon: [{ mode: 'fill', d: 'M22 7a12 12 0 0 0 19 15a17.5 17.5 0 1 1-19-15z' }],
  partly: [{ mode: 'fill', d: 'M18 10a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15z' }, { mode: 'stroke', d: 'M18 2.5v3.5M5.5 17.5H2M8.5 8l2.4 2.4M27.5 8l-2.4 2.4M8.5 27l2.4-2.4', w: SW },
    { mode: 'erase', d: CLOUD_FRONT, w: SW + 5 }, { mode: 'stroke', d: CLOUD_FRONT, w: SW }],
  cloud: [{ mode: 'stroke', d: CLOUD, w: SW }],
  fog: [{ mode: 'stroke', d: 'M10 15h28M5 23h38M9 31h30M15 39h18', w: SW }],
  rain: [{ mode: 'stroke', d: CLOUD_UP, w: SW }, { mode: 'stroke', d: 'M19 36l-2.5 7M29 36l-2.5 7', w: SW }],
  pour: [{ mode: 'fill', d: CLOUD_UP }, { mode: 'stroke', d: CLOUD_UP, w: SW }, { mode: 'stroke', d: 'M15 36l-2.5 7M24 36l-2.5 7M33 36l-2.5 7', w: SW }],
  snow: [{ mode: 'stroke', d: CLOUD_UP, w: SW }, { mode: 'stroke', d: 'M17 37.5h0M24 42.5h0M31 37.5h0', w: SW + 1.6 }],
  sleet: [{ mode: 'stroke', d: CLOUD_UP, w: SW }, { mode: 'stroke', d: 'M19 36l-2.5 7', w: SW }, { mode: 'stroke', d: 'M28 38h0M33 43h0', w: SW + 1.6 }],
  thunder: [{ mode: 'stroke', d: CLOUD_UP, w: SW }, { mode: 'fill', d: 'M25 32l-7 9h5.5l-2.5 6l8.5-10h-5.5l3-5z' }],
  wind: [{ mode: 'stroke', d: 'M4 16h18a4.5 4.5 0 1 0-4.5-4.5M4 24h31a5.5 5.5 0 1 1-5.5 5.5M4 32h14', w: SW }],
  alert: [{ mode: 'stroke', d: 'M24 7L43 40H5z', w: SW }, { mode: 'stroke', d: 'M24 19v9', w: SW }, { mode: 'stroke', d: 'M24 34.5h0', w: SW + 1.2 }],
};
