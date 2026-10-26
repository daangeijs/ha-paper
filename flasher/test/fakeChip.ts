// Shared test fixtures: a fake ESP32-S3 (real esptool-js ESPLoader, fake wire protocol) and a fake release.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { ESPLoader } from "esptool-js";
import { sha256Hex } from "../src/checksums.ts";
import { EFUSE_SECURE_BOOT_EN_REG, EFUSE_SPI_BOOT_CRYPT_CNT_REG } from "../src/efuse.ts";
import type { Loader } from "../src/flow.ts";
import { FLASH_SIZE, NVS_END, NVS_START, PART_NAMES, SECTOR, USERDATA_END, USERDATA_START } from "../src/layout.ts";
import type { Release } from "../src/release.ts";
import { encodeTable, X4_ROWS } from "./tables.ts";

// Stock-like table on the device: NVS at 0x9000 like HA Paper, apps elsewhere.
export const STOCK_TABLE = encodeTable([
  ["nvs", 1, 2, 0x9000, 0x5000],
  ["otadata", 1, 0, 0xe000, 0x2000],
  ["app0", 0, 0x10, 0x10000, 0x7e0000],
  ["app1", 0, 0x11, 0x7f0000, 0x7e0000],
]);

// A fake ESP32-S3 with 16 MB of flash. NVS and userdata are filled with markers that must survive every install.
export const NVS_MARK = 0xab;
export const USERDATA_MARK = 0xcd;
export function freshFlash(): Uint8Array {
  const f = new Uint8Array(FLASH_SIZE).fill(0x5a);
  f[0] = 0xe9;
  f.set(STOCK_TABLE, 0x8000);
  f.fill(NVS_MARK, NVS_START, NVS_END);
  f.fill(USERDATA_MARK, USERDATA_START, USERDATA_END);
  return f;
}

export async function makeRelease(): Promise<Release> {
  const sizes = [0x5123, 0xc00, 0x2000, 0x20345, 0x8000];
  const files = new Map<string, Uint8Array>();
  const sums = new Map<string, string>();
  for (const [i, name] of PART_NAMES.entries()) {
    const d =
      name === "partitions.bin" ? encodeTable(X4_ROWS) : new Uint8Array(sizes[i]).map((_, j) => (j * 7 + i) & 0xff);
    files.set(name, d);
    sums.set(name, await sha256Hex(d));
  }
  const fw = files.get("firmware.bin")!;
  return { files, sums, manifest: { version: "0.4.0", sha256: sums.get("firmware.bin")!, size: fw.length } };
}

export const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * A real esptool-js ESPLoader whose wire protocol is answered by a fake chip: FLASH_DEFL_BEGIN erases the sectors it
 * covers, FLASH_DEFL_DATA inflates into the fake flash, SPI_FLASH_MD5 hashes the fake flash. So the test sees the
 * addresses esptool-js actually sends, not just what we asked for.
 */
export function fakeChip(efuse: { crypt?: number; secure?: number; throws?: boolean } = {}, image?: Uint8Array) {
  const flash = image ?? freshFlash();
  const events: string[] = [];
  const erased: [number, number][] = [];
  const loader = new ESPLoader({ transport: { getInfo: () => "fake" } as any, baudrate: 921600, terminal: { clean() {}, write() {}, writeLine() {} } });
  loader.chip = { CHIP_NAME: "ESP32-S3", BOOTLOADER_FLASH_OFFSET: 0 } as any;
  loader.IS_STUB = true;
  let cur: { offset: number; parts: Uint8Array[] } | null = null;

  loader.readReg = async (addr: number) => {
    events.push(`readReg 0x${addr.toString(16)}`);
    if (efuse.throws) throw new Error("Timed out waiting for packet header");
    if (addr === EFUSE_SPI_BOOT_CRYPT_CNT_REG) return efuse.crypt ?? 0;
    if (addr === EFUSE_SECURE_BOOT_EN_REG) return efuse.secure ?? 0;
    return 0;
  };
  loader.detectFlashSize = async () => "16MB";
  let corruptNextRead = 0;
  loader.readFlash = async (addr: number, size: number) => {
    if (addr === 0x8000 && size === 0xc00) events.push("readFlash table");
    else if (!events.includes("readFlash")) events.push("readFlash");
    if (corruptNextRead > 0) {
      corruptNextRead--;
      const bad = flash.slice(addr, addr + size);
      bad[5] ^= 0xff;
      return bad;
    }
    return flash.slice(addr, addr + size);
  };
  loader.after = async () => {
    events.push("after");
  };
  loader.eraseFlash = async () => {
    events.push("ERASE_FLASH");
    flash.fill(0xff);
    return 0;
  };
  loader.checkCommand = async (_desc?: string, op?: number | null, data?: Uint8Array) => {
    const d = data ?? new Uint8Array(0);
    if (op === loader.ESP_FLASH_DEFL_BEGIN) {
      const size = u32(d, 0);
      const offset = u32(d, 12);
      const end = Math.ceil((offset + size) / SECTOR) * SECTOR;
      erased.push([offset, end]);
      flash.fill(0xff, offset, end);
      events.push(`begin 0x${offset.toString(16)}`);
      cur = { offset, parts: [] };
      return 0;
    }
    if (op === loader.ESP_FLASH_DEFL_DATA) {
      cur!.parts.push(d.slice(16));
      return 0;
    }
    if (op === loader.ESP_FLASH_DEFL_END) {
      const out = inflateSync(Buffer.concat(cur!.parts));
      flash.set(out, cur!.offset);
      cur = null;
      return 0;
    }
    if (op === loader.ESP_SPI_FLASH_MD5) {
      const addr = u32(d, 0);
      const size = u32(d, 4);
      return new Uint8Array(createHash("md5").update(flash.subarray(addr, addr + size)).digest());
    }
    events.push(`unexpected op 0x${(op ?? 0).toString(16)}`);
    throw new Error("unexpected command");
  };
  return {
    loader: loader as unknown as Loader,
    flash,
    events,
    erased,
    corruptReads: (n: number) => {
      corruptNextRead = n;
    },
  };
}

// A 16 MB stock-like image with a different, position-dependent pattern per region (no sector is all 0xFF), so any
// erase or misplaced write shows up as a diff and the diff names the region. Device partition table: STOCK_TABLE.
export const REGIONS: readonly { name: string; start: number; end: number }[] = [
  { name: "bootloader", start: 0x0, end: 0x8000 },
  { name: "partition table", start: 0x8000, end: NVS_START },
  { name: "nvs", start: NVS_START, end: NVS_END },
  { name: "otadata", start: NVS_END, end: 0x10000 },
  { name: "app0", start: 0x10000, end: 0x650000 },
  { name: "app1", start: 0x650000, end: 0xc90000 },
  { name: "www", start: 0xc90000, end: USERDATA_START },
  { name: "userdata", start: USERDATA_START, end: USERDATA_END },
  { name: "coredump", start: USERDATA_END, end: FLASH_SIZE },
];

export function patternedFlash(): Uint8Array {
  const f = new Uint8Array(FLASH_SIZE);
  REGIONS.forEach(({ start, end }, tag) => {
    for (let i = start; i < end; i++) f[i] = ((tag + 1) * 0x11 + (i >>> 12) * 7 + (i & 0xff)) & 0x7f;
  });
  f[0] = 0xe9;
  f.set(STOCK_TABLE, 0x8000);
  return f;
}
