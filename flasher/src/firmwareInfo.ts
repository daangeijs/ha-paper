// What is installed on the connected display, read-only (eink-ha-os#239): partition table, otadata, and the app descriptor of
// the app the bootloader would start. A few KB of reads, no writes.

import type { FlashReader } from "./backup.ts";
import { PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE, type PartitionEntry, parsePartitionTable } from "./partitionTable.ts";

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const IMAGE_MAGIC = 0xe9;
export const APP_DESC_MAGIC = 0xabcd5432;
// esp_image_header_t (24 bytes) + first segment header (8 bytes), then esp_app_desc_t (256 bytes).
export const APP_DESC_OFFSET = 0x20;
export const APP_DESC_READ = APP_DESC_OFFSET + 256;
const OTADATA_ENTRY = 32; // esp_ota_select_entry_t: ota_seq, seq_label[20], ota_state, crc

export interface AppDesc {
  version: string;
  project: string;
  time: string;
  date: string;
  idf: string;
  /** app_elf_sha256, hex: unique per build. */
  elfSha256: string;
}

function cstr(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && b[o + i] !== 0; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

/** The esp_app_desc_t at the start of an app image, or null when there is no valid image there. */
export function parseAppDesc(image: Uint8Array): AppDesc | null {
  if (image.length < APP_DESC_READ || image[0] !== IMAGE_MAGIC) return null;
  const d = APP_DESC_OFFSET;
  if (u32(image, d) !== APP_DESC_MAGIC) return null;
  const sha = [...image.subarray(d + 144, d + 176)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return {
    version: cstr(image, d + 16, 32),
    project: cstr(image, d + 48, 32),
    time: cstr(image, d + 80, 16),
    date: cstr(image, d + 96, 16),
    idf: cstr(image, d + 112, 32),
    elfSha256: sha,
  };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib-style crc32 continuing from `prev`; ESP-IDF's otadata crc is crc32(ota_seq bytes, 0xFFFFFFFF). */
export function crc32(data: Uint8Array, prev = 0): number {
  let c = ~prev >>> 0;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Which ota_N slot the bootloader picks from the two otadata entries, like bootloader_utility: the valid entry with
 * the highest sequence number, slot (seq - 1) % slots. Null when neither entry is valid (it then boots ota_0 or
 * factory).
 */
export function activeOtaSlot(otadata: Uint8Array, slots: number): number | null {
  let best: number | null = null;
  for (const o of [0, 0x1000]) {
    if (o + OTADATA_ENTRY > otadata.length) continue;
    const seq = u32(otadata, o);
    const state = u32(otadata, o + 24);
    if (seq === 0xffffffff || seq === 0) continue;
    if (crc32(otadata.subarray(o, o + 4), 0xffffffff) !== u32(otadata, o + 28)) continue;
    if (state === 3 /* ESP_OTA_IMG_INVALID */ || state === 4 /* ABORTED */) continue;
    if (best === null || seq > best) best = seq;
  }
  return best === null || slots === 0 ? null : (best - 1) % slots;
}

/** esp_app_desc_t.project_name of HA Paper builds (firmware/src/hw/app_desc.cpp). */
export const HA_PAPER_PROJECT = "ha-paper";

export interface Installed {
  /** Short line for the device row. */
  label: string;
  desc: AppDesc | null;
  slot: string;
}

/**
 * Read what is installed. HA Paper builds since eink-ha-os#242 carry project "ha-paper" and their version in the descriptor.
 * Older builds carry the Arduino core's ("arduino-lib-builder"): `ours` (the bundled firmware.bin's descriptor) names
 * that exact build by its hash, other ones are recognised by the "www" partition HA Paper's table has.
 */
export async function readInstalled(flash: Pick<FlashReader, "readFlash">, ours?: { desc: AppDesc | null; version: string }): Promise<Installed> {
  const table = parsePartitionTable(await flash.readFlash(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE));
  if (table.kind !== "table") return { label: "No firmware", desc: null, slot: "" };
  const entries = table.entries;
  const ota = entries.filter((e) => e.type === 0 && e.subtype >= 0x10 && e.subtype < 0x20).sort((a, b) => a.subtype - b.subtype);
  const factory = entries.find((e) => e.type === 0 && e.subtype === 0x00);
  let app: PartitionEntry | undefined;
  const otadata = entries.find((e) => e.type === 1 && e.subtype === 0x00);
  if (otadata && ota.length) {
    const od = await flash.readFlash(otadata.offset, Math.min(otadata.size, 0x1000 + OTADATA_ENTRY));
    const slot = activeOtaSlot(od, ota.length);
    if (slot !== null) app = ota[slot];
  }
  app ??= factory ?? ota[0];
  if (!app) return { label: "Unknown firmware", desc: null, slot: "" };
  const desc = parseAppDesc(await flash.readFlash(app.offset, APP_DESC_READ));
  return { label: describe(desc, entries, ours), desc, slot: app.label };
}

export function describe(desc: AppDesc | null, entries: PartitionEntry[], ours?: { desc: AppDesc | null; version: string }): string {
  if (!desc) return "No firmware";
  if (desc.project === HA_PAPER_PROJECT) return `HA Paper ${desc.version}`;
  if (ours?.desc && ours.desc.elfSha256 === desc.elfSha256) return `HA Paper ${ours.version}`;
  if (entries.some((e) => e.label === "www" && e.type === 1)) return "HA Paper (other version)";
  if (desc.project === "xteink_app") return `Stock firmware ${desc.version}`;
  return desc.project ? `Unknown firmware (${desc.project} ${desc.version})` : "Unknown firmware";
}
