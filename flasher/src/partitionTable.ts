// ESP-IDF partition table (binary, at 0x8000): 32-byte entries, magic 0xAA 0x50, type, subtype, offset u32 LE,
// size u32 LE, 16-byte label, flags u32. An entry starting 0xEB 0xEB is the MD5 of the entries before it; 0xFF ends
// the table. Used for two checks before an install:
//  - our partitions.bin must describe the layout in layout.ts (nvs 0x9000/0x5000, otadata 0xE000, app0, www,
//    userdata 0xFD0000/0x20000);
//  - the table already on the device must keep NVS at 0x9000/0x5000. If the stock firmware kept NVS somewhere
//    else, our table would point the firmware at the wrong place and our parts could land on the real NVS.

import { NVS_END, NVS_START, PARTS, USERDATA_END, USERDATA_START } from "./layout.ts";

export const PARTITION_TABLE_OFFSET = 0x8000;
export const PARTITION_TABLE_SIZE = 0xc00;

export interface PartitionEntry {
  type: number;
  subtype: number;
  offset: number;
  size: number;
  label: string;
}

export type ParsedTable = { kind: "empty" } | { kind: "table"; entries: PartitionEntry[] } | { kind: "invalid"; reason: string };

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function parsePartitionTable(data: Uint8Array): ParsedTable {
  if (data.length < 32) return { kind: "invalid", reason: "too short" };
  if (data.subarray(0, 32).every((b) => b === 0xff)) return { kind: "empty" };
  const entries: PartitionEntry[] = [];
  for (let o = 0; o + 32 <= data.length; o += 32) {
    const m0 = data[o];
    const m1 = data[o + 1];
    if (m0 === 0xaa && m1 === 0x50) {
      let label = "";
      for (let i = 0; i < 16 && data[o + 12 + i] !== 0; i++) label += String.fromCharCode(data[o + 12 + i]);
      entries.push({ type: data[o + 2], subtype: data[o + 3], offset: u32(data, o + 4), size: u32(data, o + 8), label });
      continue;
    }
    if ((m0 === 0xeb && m1 === 0xeb) || (m0 === 0xff && m1 === 0xff)) break;
    return { kind: "invalid", reason: `unexpected bytes at 0x${(PARTITION_TABLE_OFFSET + o).toString(16)}` };
  }
  if (entries.length === 0) return { kind: "invalid", reason: "no entries" };
  return { kind: "table", entries };
}

const TYPE_DATA = 0x01;
const SUBTYPE_NVS = 0x02;
const SUBTYPE_OTA = 0x00;

const nvsOf = (entries: PartitionEntry[]) => entries.filter((e) => e.type === TYPE_DATA && e.subtype === SUBTYPE_NVS);

/** Our own partitions.bin must match layout.ts. Throws with a message otherwise. */
export function checkOurTable(data: Uint8Array): void {
  const t = parsePartitionTable(data);
  if (t.kind !== "table") throw new Error(`partitions.bin is not a partition table (${t.kind === "invalid" ? t.reason : "empty"}).`);
  const nvs = nvsOf(t.entries);
  if (nvs.length !== 1 || nvs[0].offset !== NVS_START || nvs[0].size !== NVS_END - NVS_START) {
    throw new Error("partitions.bin does not put NVS at 0x9000 (0x5000 bytes).");
  }
  const otadata = t.entries.find((e) => e.type === TYPE_DATA && e.subtype === SUBTYPE_OTA);
  if (otadata?.offset !== PARTS.find((p) => p.name === "boot_app0.bin")!.offset) {
    throw new Error("partitions.bin does not put otadata at 0xE000.");
  }
  for (const name of ["app0", "www"]) {
    const e = t.entries.find((x) => x.label === name);
    const slot = PARTS.find((p) => p.name === (name === "app0" ? "firmware.bin" : "www.bin"))!;
    if (e?.offset !== slot.offset) throw new Error(`partitions.bin does not put ${name} at 0x${slot.offset.toString(16)}.`);
  }
  const ud = t.entries.find((x) => x.label === "userdata");
  if (ud?.offset !== USERDATA_START || ud.size !== USERDATA_END - USERDATA_START) {
    throw new Error("partitions.bin does not put userdata at 0xfd0000 (0x20000 bytes).");
  }
}

/**
 * The table currently on the device. Returns a note for the log, throws if installing would be unsafe.
 * Erased (all 0xFF) is accepted: there is no mapping to keep, and NVS bytes are not written either way.
 */
export function checkDeviceTable(data: Uint8Array): string {
  const t = parsePartitionTable(data);
  if (t.kind === "empty") return "No partition table on the device (erased). NVS is still left alone.";
  if (t.kind === "invalid") {
    throw new Error(`The partition table on the device can't be read (${t.reason}). Not writing; restore your backup or use x4flash.py.`);
  }
  const nvs = nvsOf(t.entries);
  if (nvs.length === 0) throw new Error("The device's partition table has no NVS partition. Not writing.");
  const bad = nvs.find((e) => e.offset !== NVS_START || e.size !== NVS_END - NVS_START);
  if (bad || nvs.length !== 1) {
    const where = nvs.map((e) => `0x${e.offset.toString(16)} (0x${e.size.toString(16)} bytes)`).join(", ");
    throw new Error(
      `The device keeps NVS at ${where}, not 0x9000 (0x5000 bytes) as HA Paper does. Not writing: the panel id could ` +
        "be overwritten or end up outside HA Paper's NVS. Please report this unit.",
    );
  }
  return `Device partition table: ${t.entries.map((e) => e.label).join(", ")}; NVS at 0x9000.`;
}
