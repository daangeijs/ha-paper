// Web console: the bin day tile's sensors and names (eink-ha-os#317). Pure; writes `entities` (space-separated, in pick order)
// and `labels` ("sensor.a=Paper; sensor.b=Plastic") on the tile.
import { BIN_DOMAINS, MAX_BINS } from '../core/bins.ts';
import { labelPairs, listOf, type Widget } from '../core/config.ts';
import type { HaEntity } from '../core/data.ts';
import { cleanLabel, matches } from './configEdit.ts';

const BINNY = /afval|waste|bin\b|bins|container|gft|pmd|papier|paper|plastic|glas|rest|kliko|trash|garbage|recycl/i;
const DATE = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})/;
export type BinRowIn = { id: string; name: string; on: boolean; label: string; state: string };

/** Sensors for the picker: picked first (in pick order), then ones that look like a bin (name / id, or a date state),
 *  then the other sensors; the search narrows the unpicked ones. */
export function binRows(list: HaEntity[], w: Widget, q: string): BinRowIn[] {
  const picked = listOf(w, 'entities'); const labels = labelPairs(w.labels);
  const row = (id: string, e?: HaEntity): BinRowIn => ({ id, name: e?.name || id, on: picked.includes(id), label: labels.find(([k]) => k === id)?.[1] ?? '', state: e?.state ?? '' });
  const sensors = list.filter((e) => BIN_DOMAINS.includes(e.id.split('.')[0]) && !picked.includes(e.id) && matches(q, e.name, e.id));
  const binny = (e: HaEntity) => BINNY.test(e.id + ' ' + e.name) || DATE.test(e.state ?? '');
  return [...picked.map((id) => row(id, list.find((e) => e.id === id))), ...sensors.filter(binny).map((e) => row(e.id, e)), ...sensors.filter((e) => !binny(e)).map((e) => row(e.id, e))];
}

const clone = (ws: Widget[]): Widget[] => ws.map((x) => ({ ...x }));
const writeLabels = (w: Widget, pairs: [string, string][]) => { if (pairs.length) w.labels = pairs.map(([e, l]) => e + '=' + l).join('; '); else delete w.labels; };

/** Tick / untick a sensor (at most MAX_BINS); unticking drops its name. */
export function toggleBin(ws: Widget[], i: number, id: string): Widget[] {
  const out = clone(ws); const cur = listOf(out[i], 'entities');
  const on = cur.includes(id);
  if (!on && cur.length >= MAX_BINS) return out;
  const next = on ? cur.filter((x) => x !== id) : [...cur, id];
  if (next.length) out[i].entities = next.join(' '); else delete out[i].entities;
  if (on) writeLabels(out[i], labelPairs(out[i].labels).filter(([e]) => e !== id));
  return out;
}

/** A bin's own name on the tile; empty = HA's name. No "," ":" ";" "=" (the flow map and the labels list use them). */
export function setBinLabel(ws: Widget[], i: number, id: string, name: string, typing = false): Widget[] {
  const out = clone(ws); const v = cleanLabel(name.replace(/[;=]/g, ' '), typing);
  const pairs = labelPairs(out[i].labels).filter(([e]) => e !== id);
  if (v.trim()) {
    const order = listOf(out[i], 'entities');
    pairs.push([id, v]);
    pairs.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }
  writeLabels(out[i], pairs);
  return out;
}
