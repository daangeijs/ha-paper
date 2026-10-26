import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backupFileName, looksLikeFlashImage, READ_CHUNK, readFullFlash, sha256Sidecar } from "../src/backup.ts";
import { parseManifest, parseSha256Sums, sha256Hex, verifyRelease } from "../src/checksums.ts";
import {
  decodeSecurity,
  EFUSE_SECURE_BOOT_EN_REG,
  EFUSE_SPI_BOOT_CRYPT_CNT_REG,
  popcount,
  readSecurity,
} from "../src/efuse.ts";
import { FLASH_SIZE, PART_NAMES } from "../src/layout.ts";
import { md5Hex } from "../src/md5.ts";
import { romBaudFor } from "../src/serial.ts";

describe("eFuse decoding (esptool esp32s3.py)", () => {
  it("uses the esptool register addresses", () => {
    expect(EFUSE_SPI_BOOT_CRYPT_CNT_REG).toBe(0x60007034);
    expect(EFUSE_SECURE_BOOT_EN_REG).toBe(0x60007038);
  });
  it("all zero: nothing enabled", () => {
    expect(decodeSecurity(0, 0)).toEqual({ secureBoot: false, flashCryptCnt: 0, flashEncryption: false });
  });
  it("SECURE_BOOT_EN is bit 20 of 0x60007038", () => {
    expect(decodeSecurity(0, 1 << 20).secureBoot).toBe(true);
    expect(decodeSecurity(0, (1 << 19) | (1 << 21)).secureBoot).toBe(false);
    expect(decodeSecurity(0, 0xffffffff).secureBoot).toBe(true);
  });
  it("SPI_BOOT_CRYPT_CNT is bits 18-20 of 0x60007034; odd popcount = enabled", () => {
    const at = (cnt: number) => decodeSecurity(cnt << 18, 0);
    expect(at(0b000).flashEncryption).toBe(false);
    expect(at(0b001).flashEncryption).toBe(true);
    expect(at(0b011).flashEncryption).toBe(false); // enabled then disabled
    expect(at(0b111).flashEncryption).toBe(true); // permanently enabled
    expect(at(0b111).flashCryptCnt).toBe(7);
    // neighbouring bits don't count
    expect(decodeSecurity((1 << 17) | (1 << 21), 0).flashEncryption).toBe(false);
  });
  it("popcount", () => {
    expect(popcount(0)).toBe(0);
    expect(popcount(0xffffffff)).toBe(32);
    expect(popcount(-1)).toBe(32);
  });
  it("readSecurity reads both registers and propagates read errors", async () => {
    const reads: number[] = [];
    const s = await readSecurity({
      readReg: async (a) => {
        reads.push(a);
        return a === EFUSE_SECURE_BOOT_EN_REG ? 1 << 20 : 0;
      },
    });
    expect(reads).toEqual([0x60007034, 0x60007038]);
    expect(s.secureBoot).toBe(true);
    await expect(readSecurity({ readReg: async () => Promise.reject(new Error("timeout")) })).rejects.toThrow("timeout");
  });
});

describe("checksums", () => {
  it("sha256Hex matches node", async () => {
    const d = new TextEncoder().encode("x4 home");
    expect(await sha256Hex(d)).toBe(createHash("sha256").update(d).digest("hex"));
  });
  it("parses sha256sum and shasum output, binary-mode star too", () => {
    const h = "a".repeat(64);
    const m = parseSha256Sums(`${h}  firmware.bin\n${"B".repeat(64)} *www.bin\n\n`);
    expect(m.get("firmware.bin")).toBe(h);
    expect(m.get("www.bin")).toBe("b".repeat(64));
    expect(() => parseSha256Sums("nonsense line")).toThrow(/cannot read/);
  });
  it("parseManifest requires version, sha256, size", () => {
    expect(parseManifest('{"version":"0.4.0","sha256":"AB","size":3,"notes":[]}').sha256).toBe("ab");
    expect(() => parseManifest('{"version":"0.4.0"}')).toThrow(/manifest/);
  });

  async function fixture() {
    const files = new Map<string, Uint8Array>();
    const sums = new Map<string, string>();
    for (const [i, n] of PART_NAMES.entries()) {
      const d = new Uint8Array(100 + i).fill(i);
      files.set(n, d);
      sums.set(n, await sha256Hex(d));
    }
    const fw = files.get("firmware.bin")!;
    const manifest = { version: "0.4.0", sha256: sums.get("firmware.bin")!, size: fw.length };
    return { files, sums, manifest };
  }
  it("accepts matching files", async () => {
    const { files, sums, manifest } = await fixture();
    await expect(verifyRelease(files, sums, manifest)).resolves.toBeUndefined();
  });
  it("rejects a changed byte, a missing file, an unlisted file, a manifest mismatch", async () => {
    let f = await fixture();
    f.files.get("www.bin")![0] ^= 1;
    await expect(verifyRelease(f.files, f.sums, f.manifest)).rejects.toThrow(/www.bin does not match/);
    f = await fixture();
    f.files.delete("bootloader.bin");
    await expect(verifyRelease(f.files, f.sums, f.manifest)).rejects.toThrow(/Missing bootloader.bin/);
    f = await fixture();
    f.sums.delete("boot_app0.bin");
    await expect(verifyRelease(f.files, f.sums, f.manifest)).rejects.toThrow(/not listed/);
    f = await fixture();
    await expect(verifyRelease(f.files, f.sums, { ...f.manifest, size: 1 })).rejects.toThrow(/manifest/);
    await expect(verifyRelease(f.files, f.sums, { ...f.manifest, sha256: "0".repeat(64) })).rejects.toThrow(/manifest/);
  });
});

describe("backup", () => {
  it("names the file x4pro_stock_YYYYMMDD.bin in local time", () => {
    expect(backupFileName(new Date(2026, 9, 15, 23, 59))).toBe("x4pro_stock_20261015.bin");
    expect(backupFileName(new Date(2027, 0, 3))).toBe("x4pro_stock_20270103.bin");
  });
  it("writes a sha256sum-format sidecar", () => {
    expect(sha256Sidecar("x.bin", "ab")).toBe("ab  x.bin\n");
  });
  it("reads 16 MB in chunks into one buffer", async () => {
    const calls: [number, number][] = [];
    const chunkAt = (addr: number, size: number) => new Uint8Array(size).fill((addr / READ_CHUNK) & 0xff);
    const data = await readFullFlash({
      readFlash: async (addr, size) => {
        calls.push([addr, size]);
        return chunkAt(addr, size);
      },
      flashMd5sum: async (addr, size) => md5Hex(chunkAt(addr, size)),
    });
    expect(data.length).toBe(FLASH_SIZE);
    expect(calls.length).toBe(FLASH_SIZE / READ_CHUNK);
    expect(calls[1]).toEqual([READ_CHUNK, READ_CHUNK]);
    expect(data[READ_CHUNK * 3]).toBe(3);
  });
  it("fails on a short read", async () => {
    const reader = { readFlash: async (_a: number, s: number) => new Uint8Array(s - 1), flashMd5sum: async () => "" };
    await expect(readFullFlash(reader)).rejects.toThrow(/expected/);
  });
  it("checks the ESP image magic", () => {
    const d = new Uint8Array(FLASH_SIZE);
    expect(looksLikeFlashImage(d)).toBe(false);
    d[0] = 0xe9;
    expect(looksLikeFlashImage(d)).toBe(true);
  });
});

describe("md5", () => {
  it("matches node for several lengths", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
      const d = new Uint8Array(n).map((_, i) => (i * 31) & 0xff);
      expect(md5Hex(d)).toBe(createHash("md5").update(d).digest("hex"));
    }
  });
});

describe("serial", () => {
  it("skips the ROM baud switch on USB-Serial/JTAG only", () => {
    expect(romBaudFor(0x1001)).toBe(921600);
    expect(romBaudFor(0x7523)).toBe(115200);
    expect(romBaudFor(undefined)).toBe(115200);
  });
});
