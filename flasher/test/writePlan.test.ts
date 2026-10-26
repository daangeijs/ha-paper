import { describe, expect, it } from "vitest";
import { FLASH_SIZE, NVS_END, NVS_START, PARTS, USERDATA_END, USERDATA_START } from "../src/layout.ts";
import {
  assertSafePlan,
  eraseRange,
  overlapsNvs,
  overlapsProtectedTop,
  planInstall,
  planRestore,
  UnsafeWriteError,
} from "../src/writePlan.ts";

const sizes: Record<string, number> = {
  "bootloader.bin": 0x5000,
  "partitions.bin": 0xc00,
  "boot_app0.bin": 0x2000,
  "firmware.bin": 0x1a0000,
  "www.bin": 0x340000,
};
function files(over: Record<string, number> = {}): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const [n, s] of Object.entries({ ...sizes, ...over })) m.set(n, new Uint8Array(s));
  return m;
}

describe("layout", () => {
  it("matches firmware/partitions.csv and x4flash.py", () => {
    expect(PARTS.map((p) => [p.name, p.offset])).toEqual([
      ["bootloader.bin", 0x0],
      ["partitions.bin", 0x8000],
      ["boot_app0.bin", 0xe000],
      ["firmware.bin", 0x10000],
      ["www.bin", 0xc90000],
    ]);
    expect([NVS_START, NVS_END]).toEqual([0x9000, 0xe000]);
    expect([USERDATA_START, USERDATA_END]).toEqual([0xfd0000, 0xff0000]);
    expect(PARTS.find((p) => p.name === "www.bin")!.limit).toBe(USERDATA_START);
  });
});

describe("userdata (screens.yaml, settings.json) survives an install", () => {
  it("no part of the plan erases a byte of userdata, even at full partition size", () => {
    const plan = planInstall(files());
    for (const w of plan.writes) expect(overlapsProtectedTop(w.address, w.data.length)).toBe(false);
    expect(plan.writes.some((w) => w.name.includes("userdata"))).toBe(false);
  });
  it("refuses a www.bin that would spill into userdata", () => {
    expect(() => planInstall(files({ "www.bin": 0x340001 }))).toThrow(/userdata/);
  });
  it("refuses the old 3.5 MB littlefs.bin (pre-split layout) by name", () => {
    const old = files();
    old.delete("www.bin");
    old.set("littlefs.bin", new Uint8Array(0x360000));
    expect(() => planInstall(old)).toThrow(/Unexpected file\(s\) in the install plan: littlefs.bin/);
  });
  it("assertSafePlan catches a tampered plan that targets userdata", () => {
    const plan = planInstall(files());
    plan.writes[4] = { ...plan.writes[4], data: new Uint8Array(0x350000) };
    expect(() => assertSafePlan(plan)).toThrow(/userdata/);
  });
  it("overlapsProtectedTop rounds to sectors", () => {
    expect(overlapsProtectedTop(0xc90000, 0x340000)).toBe(false);
    expect(overlapsProtectedTop(0xc90000, 0x340001)).toBe(true);
    expect(overlapsProtectedTop(0xff0000, 0x10000)).toBe(true);
    expect(overlapsProtectedTop(0xfef000, 1)).toBe(true);
  });
});

describe("eraseRange / overlapsNvs", () => {
  it("rounds up to whole 4 KB sectors", () => {
    expect(eraseRange(0x8000, 0xc00)).toEqual([0x8000, 0x9000]);
    expect(eraseRange(0x8000, 0x1001)).toEqual([0x8000, 0xa000]);
    expect(eraseRange(0x0, 1)).toEqual([0x0, 0x1000]);
  });
  it("flags anything touching 0x9000-0xDFFF", () => {
    expect(overlapsNvs(0x8000, 0x1000)).toBe(false);
    expect(overlapsNvs(0x8000, 0x1001)).toBe(true); // erases the 0x9000 sector
    expect(overlapsNvs(0xd000, 1)).toBe(true);
    expect(overlapsNvs(0xe000, 0x2000)).toBe(false);
    expect(overlapsNvs(0x0, 0x9001)).toBe(true);
    expect(overlapsNvs(0x0, FLASH_SIZE)).toBe(true);
  });
});

describe("planInstall", () => {
  it("writes the five parts at their own offsets", () => {
    const plan = planInstall(files());
    expect(plan.kind).toBe("install");
    expect(plan.writes.map((w) => [w.name, w.address])).toEqual(PARTS.map((p) => [p.name, p.offset]));
    for (const w of plan.writes) expect(overlapsNvs(w.address, w.data.length)).toBe(false);
  });
  it("refuses a partition table that would spill into NVS", () => {
    expect(() => planInstall(files({ "partitions.bin": 0x1001 }))).toThrow(/overlaps NVS/);
  });
  it("refuses a bootloader that runs into the partition table / NVS", () => {
    expect(() => planInstall(files({ "bootloader.bin": 0x9000 }))).toThrow(UnsafeWriteError);
    expect(() => planInstall(files({ "bootloader.bin": 0x8001 }))).toThrow(/does not fit/);
  });
  it("refuses a merged full image, extra or missing files", () => {
    const merged = files();
    merged.set("merged.bin", new Uint8Array(0x400000));
    expect(() => planInstall(merged)).toThrow(/Unexpected/);
    const missing = files();
    missing.delete("boot_app0.bin");
    expect(() => planInstall(missing)).toThrow(/Missing boot_app0.bin/);
  });
  it("refuses an app larger than its slot and empty parts", () => {
    expect(() => planInstall(files({ "firmware.bin": 0x640001 }))).toThrow(/does not fit/);
    expect(() => planInstall(files({ "boot_app0.bin": 0 }))).toThrow(/empty/);
  });
  it("assertSafePlan catches a tampered plan", () => {
    const plan = planInstall(files());
    plan.writes[1] = { ...plan.writes[1], address: 0x9000 };
    expect(() => assertSafePlan(plan)).toThrow(/belongs at 0x8000/);
    const plan2 = planInstall(files());
    plan2.writes.push({ name: "nvs.bin", address: 0x9000, data: new Uint8Array(0x5000) });
    expect(() => assertSafePlan(plan2)).toThrow(UnsafeWriteError);
    const plan3 = planInstall(files());
    plan3.writes[2] = { ...plan3.writes[2], name: "firmware.bin", address: 0x10000 };
    expect(() => assertSafePlan(plan3)).toThrow(/twice/);
  });
});

describe("planRestore", () => {
  it("allows exactly 16 MB at 0x0", () => {
    const plan = planRestore("x4pro_stock_20261015.bin", new Uint8Array(FLASH_SIZE));
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].address).toBe(0);
  });
  it("refuses any other size", () => {
    expect(() => planRestore("b.bin", new Uint8Array(FLASH_SIZE - 1))).toThrow(/16 MB/);
    expect(() => planRestore("b.bin", new Uint8Array(FLASH_SIZE + 4096))).toThrow(/16 MB/);
    expect(() => planRestore("b.bin", new Uint8Array(0x10000))).toThrow(UnsafeWriteError);
  });
  it("refuses a restore at another offset", () => {
    expect(() =>
      assertSafePlan({ kind: "restore", writes: [{ name: "b", address: 0x1000, data: new Uint8Array(FLASH_SIZE) }] }),
    ).toThrow(/0x0/);
  });
});
