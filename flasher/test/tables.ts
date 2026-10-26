// Test helper: encode an ESP-IDF partition table like gen_esp32part.py (entries, MD5 entry, 0xFF fill).
import { createHash } from "node:crypto";

export type Row = [label: string, type: number, subtype: number, offset: number, size: number];

// firmware/partitions.csv
export const X4_ROWS: Row[] = [
  ["nvs", 0x01, 0x02, 0x9000, 0x5000],
  ["otadata", 0x01, 0x00, 0xe000, 0x2000],
  ["app0", 0x00, 0x10, 0x10000, 0x640000],
  ["app1", 0x00, 0x11, 0x650000, 0x640000],
  ["www", 0x01, 0x82, 0xc90000, 0x340000],
  ["userdata", 0x01, 0x82, 0xfd0000, 0x20000],
  ["coredump", 0x01, 0x03, 0xff0000, 0x10000],
];

export function encodeTable(rows: Row[]): Uint8Array {
  const out = new Uint8Array(0xc00).fill(0xff);
  const v = new DataView(out.buffer);
  rows.forEach(([label, type, subtype, offset, size], i) => {
    const o = i * 32;
    out.set([0xaa, 0x50, type, subtype], o);
    v.setUint32(o + 4, offset, true);
    v.setUint32(o + 8, size, true);
    out.fill(0, o + 12, o + 28);
    out.set(new TextEncoder().encode(label), o + 12);
    v.setUint32(o + 28, 0, true);
  });
  const end = rows.length * 32;
  out.set([0xeb, 0xeb], end);
  out.fill(0xff, end + 2, end + 16);
  out.set(createHash("md5").update(out.subarray(0, end)).digest(), end + 16);
  return out;
}
