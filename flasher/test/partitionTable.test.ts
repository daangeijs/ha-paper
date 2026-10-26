import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDeviceTable, checkOurTable, parsePartitionTable } from "../src/partitionTable.ts";
import { encodeTable, X4_ROWS } from "./tables.ts";

const DIST_TABLE = new URL("../../dist/partitions.bin", import.meta.url);

describe("parsePartitionTable", () => {
  it("reads entries up to the MD5 entry", () => {
    const t = parsePartitionTable(encodeTable(X4_ROWS));
    expect(t.kind).toBe("table");
    if (t.kind !== "table") return;
    expect(t.entries.map((e) => [e.label, e.offset, e.size])).toEqual(X4_ROWS.map((r) => [r[0], r[3], r[4]]));
  });
  it("erased flash is 'empty', garbage is 'invalid'", () => {
    expect(parsePartitionTable(new Uint8Array(0xc00).fill(0xff)).kind).toBe("empty");
    expect(parsePartitionTable(new Uint8Array(0xc00).fill(0x12)).kind).toBe("invalid");
  });
});

describe("checkOurTable", () => {
  it("accepts the HA Paper layout", () => {
    expect(() => checkOurTable(encodeTable(X4_ROWS))).not.toThrow();
  });
  it("rejects a table that moves NVS, otadata or app0", () => {
    const moved = X4_ROWS.map((r) => (r[0] === "nvs" ? (["nvs", 1, 2, 0x9000, 0x6000] as typeof r) : r));
    expect(() => checkOurTable(encodeTable(moved))).toThrow(/NVS/);
    const ota = X4_ROWS.map((r) => (r[0] === "otadata" ? (["otadata", 1, 0, 0xd000, 0x2000] as typeof r) : r));
    expect(() => checkOurTable(encodeTable(ota))).toThrow(/otadata/);
    const app = X4_ROWS.map((r) => (r[0] === "app0" ? (["app0", 0, 0x10, 0x20000, 0x640000] as typeof r) : r));
    expect(() => checkOurTable(encodeTable(app))).toThrow(/app0/);
  });
  it("rejects a table without userdata at 0xfd0000/0x20000, incl. the old single littlefs layout", () => {
    const noUd = X4_ROWS.filter((r) => r[0] !== "userdata");
    expect(() => checkOurTable(encodeTable(noUd))).toThrow(/userdata/);
    const small = X4_ROWS.map((r) => (r[0] === "userdata" ? (["userdata", 1, 0x82, 0xfd0000, 0x10000] as typeof r) : r));
    expect(() => checkOurTable(encodeTable(small))).toThrow(/userdata/);
    const old = X4_ROWS.filter((r) => r[0] !== "www" && r[0] !== "userdata");
    old.splice(4, 0, ["littlefs", 1, 0x82, 0xc90000, 0x360000]);
    expect(() => checkOurTable(encodeTable(old))).toThrow(/www/);
  });
  it.skipIf(!existsSync(DIST_TABLE))("accepts the partitions.bin from `make dist`", () => {
    expect(() => checkOurTable(new Uint8Array(readFileSync(DIST_TABLE)))).not.toThrow();
  });
});

describe("checkDeviceTable", () => {
  it("accepts a device that keeps NVS at 0x9000/0x5000 (HA Paper, or a stock table with the same NVS)", () => {
    expect(checkDeviceTable(encodeTable(X4_ROWS))).toMatch(/NVS at 0x9000/);
    const stockLike = encodeTable([
      ["nvs", 1, 2, 0x9000, 0x5000],
      ["otadata", 1, 0, 0xe000, 0x2000],
      ["app0", 0, 0x10, 0x10000, 0x7e0000],
      ["app1", 0, 0x11, 0x7f0000, 0x7e0000],
    ]);
    expect(() => checkDeviceTable(stockLike)).not.toThrow();
  });
  it("accepts erased flash with a note", () => {
    expect(checkDeviceTable(new Uint8Array(0xc00).fill(0xff))).toMatch(/erased/);
  });
  it("refuses NVS elsewhere, a different NVS size, no NVS, or an unreadable table", () => {
    expect(() => checkDeviceTable(encodeTable([["nvs", 1, 2, 0x9000, 0x6000]]))).toThrow(/0x6000/);
    expect(() => checkDeviceTable(encodeTable([["nvs", 1, 2, 0x10000, 0x5000]]))).toThrow(/0x10000/);
    expect(() => checkDeviceTable(encodeTable([["app0", 0, 0x10, 0x10000, 0x100000]]))).toThrow(/no NVS/);
    expect(() => checkDeviceTable(new Uint8Array(0xc00).fill(0x00))).toThrow(/can't be read/);
  });
});
