import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/checksums.ts";
import { RefusedError, Session } from "../src/flow.ts";
import { FLASH_SIZE, NVS_END, NVS_START, PARTS, USERDATA_END, USERDATA_START } from "../src/layout.ts";
import type { Release } from "../src/release.ts";
import { overlapsNvs } from "../src/writePlan.ts";
import { fakeChip, makeRelease, NVS_MARK, USERDATA_MARK } from "./fakeChip.ts";
import { encodeTable, X4_ROWS } from "./tables.ts";

describe("full flow against esptool-js with a fake chip", () => {
  let release: Release;
  beforeEach(async () => {
    release = await makeRelease();
  });

  it("chip check -> chosen backup -> verify -> write the five parts; NVS untouched", async () => {
    const chip = fakeChip();
    const before = chip.flash.slice();
    const s = new Session(chip.loader, () => new Date(2026, 9, 15));

    await expect(s.install(release)).rejects.toThrow(/chip check first/);
    expect(s.readyToInstall).toBe(false);
    await s.chipCheck();
    expect(s.readyToInstall).toBe(true);

    const b = await s.makeBackup();
    expect(b.name).toBe("x4pro_stock_20261015.bin");
    expect(Buffer.compare(b.data, before)).toBe(0); // not toEqual: element-wise diff of 16 MB runs out of heap
    expect(b.sha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect(b.looksValid).toBe(true);

    const plan = await s.install(release);
    expect(plan.writes.map((w) => w.address)).toEqual(PARTS.map((p) => p.offset));

    const firstWrite = chip.events.findIndex((e) => e.startsWith("begin"));
    expect(chip.events.slice(0, firstWrite)).toEqual([
      "readReg 0x60007034",
      "readReg 0x60007038",
      "readFlash",
      "readFlash table",
    ]);
    expect(chip.events.filter((e) => e.startsWith("begin"))).toEqual([
      "begin 0x0",
      "begin 0x8000",
      "begin 0xe000",
      "begin 0x10000",
      "begin 0xc90000",
    ]);
    expect(chip.events.at(-1)).toBe("after");
    expect(chip.events).not.toContain("ERASE_FLASH");
    expect(chip.events.some((e) => e.startsWith("unexpected"))).toBe(false);

    for (const [start, end] of chip.erased) expect(overlapsNvs(start, end - start)).toBe(false);
    expect(chip.flash.subarray(NVS_START, NVS_END).every((x) => x === NVS_MARK)).toBe(true);
    for (const [start, end] of chip.erased) expect(start < USERDATA_END && end > USERDATA_START).toBe(false);
    expect(chip.flash.subarray(USERDATA_START, USERDATA_END).every((x) => x === USERDATA_MARK)).toBe(true);
    for (const p of PARTS) {
      const data = release.files.get(p.name)!;
      expect(chip.flash.subarray(p.offset, p.offset + data.length)).toEqual(data);
    }
  });

  it("installs without a backup (optional since eink-ha-os#239) and reads no flash beyond the partition table", async () => {
    const chip = fakeChip();
    const s = new Session(chip.loader);
    await s.chipCheck();
    await s.install(release);
    expect(chip.events).not.toContain("readFlash");
    expect(chip.flash.subarray(NVS_START, NVS_END).every((x) => x === NVS_MARK)).toBe(true);
  });

  it("re-verifies the files before writing and writes nothing if one changed", async () => {
    const chip = fakeChip();
    const s = new Session(chip.loader);
    await s.chipCheck();
    release.files.get("firmware.bin")![10] ^= 0xff;
    await expect(s.install(release)).rejects.toThrow(/does not match SHA256SUMS/);
    expect(chip.events.some((e) => e.startsWith("begin"))).toBe(false);
  });

  it.each([
    ["secure boot", { secure: 1 << 20 }, /Secure boot is enabled/],
    ["flash encryption", { crypt: 1 << 18 }, /Flash encryption is enabled/],
    ["both", { secure: 1 << 20, crypt: 7 << 18 }, /Secure boot and flash encryption/],
    ["unreadable eFuses", { throws: true }, /Could not read/],
  ])("refuses on %s and writes nothing", async (_n, efuse, msg) => {
    const chip = fakeChip(efuse);
    const s = new Session(chip.loader);
    await expect(s.chipCheck()).rejects.toThrow(msg);
    await expect(s.chipCheck()).rejects.toBeInstanceOf(RefusedError);
    await expect(s.install(release)).rejects.toThrow(/chip check first/);
    await expect(s.restore("b.bin", new Uint8Array(FLASH_SIZE))).rejects.toThrow(/chip check first/);
    expect(chip.events.some((e) => e.startsWith("begin") || e === "readFlash")).toBe(false);
  });

  it("refuses other chips and secure download mode", async () => {
    const chip = fakeChip();
    (chip.loader as any).chip = { CHIP_NAME: "ESP32-C3" };
    await expect(new Session(chip.loader).chipCheck()).rejects.toThrow(/not the ESP32-S3/);
    const chip2 = fakeChip();
    chip2.loader.secureDownloadMode = true;
    await expect(new Session(chip2.loader).chipCheck()).rejects.toThrow(/secure download mode/);
    const chip3 = fakeChip();
    chip3.loader.detectFlashSize = async () => "8MB";
    await expect(new Session(chip3.loader).chipCheck()).rejects.toThrow(/8MB/);
  });

  it("backup re-reads a chunk whose MD5 differs from the chip's, and gives up after 3 tries", async () => {
    const chip = fakeChip();
    const s = new Session(chip.loader);
    await s.chipCheck();
    chip.corruptReads(2);
    const b = await s.makeBackup();
    expect(Buffer.compare(b.data, chip.flash)).toBe(0);

    const s2 = new Session(chip.loader);
    await s2.chipCheck();
    chip.corruptReads(3);
    await expect(s2.makeBackup()).rejects.toThrow(/after 3 attempts/);
    expect(s2.backup).toBeNull();
  });

  it("refuses to install when the device keeps NVS somewhere else", async () => {
    const chip = fakeChip();
    chip.flash.set(
      encodeTable([
        ["nvs", 1, 2, 0x9000, 0x6000],
        ["app0", 0, 0x10, 0x10000, 0x100000],
      ]),
      0x8000,
    );
    const s = new Session(chip.loader);
    await s.chipCheck();
    await expect(s.install(release)).rejects.toThrow(/not 0x9000 \(0x5000 bytes\)/);
    expect(chip.events.some((e) => e.startsWith("begin"))).toBe(false);
  });

  it("refuses a release whose partitions.bin moves NVS", async () => {
    const chip = fakeChip();
    const s = new Session(chip.loader);
    await s.chipCheck();
    const table = encodeTable(X4_ROWS.map((r) => (r[0] === "nvs" ? (["nvs", 1, 2, 0xa000, 0x4000] as typeof r) : r)));
    release.files.set("partitions.bin", table);
    release.sums.set("partitions.bin", await sha256Hex(table));
    await expect(s.install(release)).rejects.toThrow(/partitions.bin does not put NVS/);
    expect(chip.events.some((e) => e.startsWith("begin"))).toBe(false);
  });

  it("restore writes a 16 MB backup at 0x0 (NVS included), checks size and .sha256", async () => {
    const chip = fakeChip();
    const s = new Session(chip.loader);
    await s.chipCheck();
    await expect(s.restore("short.bin", new Uint8Array(FLASH_SIZE - 1))).rejects.toThrow(/not a full 16 MB/);
    const backup = new Uint8Array(FLASH_SIZE).fill(0x11);
    await expect(s.restore("b.bin", backup, "0".repeat(64))).rejects.toThrow(/damaged/);
    expect(chip.events.some((e) => e.startsWith("begin"))).toBe(false);

    await s.restore("b.bin", backup, createHash("sha256").update(backup).digest("hex"));
    expect(chip.events.filter((e) => e.startsWith("begin"))).toEqual(["begin 0x0"]);
    expect(Buffer.compare(chip.flash, backup)).toBe(0);
  });
});
