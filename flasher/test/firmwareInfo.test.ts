import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activeOtaSlot, crc32, parseAppDesc, readInstalled } from "../src/firmwareInfo.ts";
import { encodeTable, X4_ROWS } from "./tables.ts";
import { STOCK_TABLE } from "./fakeChip.ts";

// An app image head as esptool elf2image writes it: image header, first segment header, esp_app_desc_t.
function appImage(d: { version: string; project: string; sha?: number }): Uint8Array {
  const b = new Uint8Array(0x200).fill(0);
  b[0] = 0xe9;
  const v = new DataView(b.buffer);
  v.setUint32(0x20, 0xabcd5432, true);
  const put = (o: number, s: string) => b.set(new TextEncoder().encode(s), 0x20 + o);
  put(16, d.version);
  put(48, d.project);
  put(80, "14:51:03");
  put(96, "Sep 15 2026");
  put(112, "v6.0.1");
  b.fill(d.sha ?? 0x11, 0x20 + 144, 0x20 + 176);
  return b;
}

function otadata(seq: number): Uint8Array {
  const b = new Uint8Array(0x2000).fill(0xff);
  const v = new DataView(b.buffer);
  v.setUint32(0, seq, true);
  v.setUint32(24, 2, true); // ESP_OTA_IMG_VALID
  v.setUint32(28, crc32(b.subarray(0, 4), 0xffffffff), true);
  return b;
}

function flashOf(parts: [number, Uint8Array][]) {
  const f = new Uint8Array(0x1000000).fill(0xff);
  for (const [o, d] of parts) f.set(d, o);
  return { readFlash: async (addr: number, size: number) => f.slice(addr, addr + size) };
}

describe("installed firmware (#239)", () => {
  it("parses esp_app_desc_t", () => {
    const d = parseAppDesc(appImage({ version: "7.5.11", project: "xteink_app" }))!;
    expect(d).toMatchObject({ version: "7.5.11", project: "xteink_app", date: "Sep 15 2026", idf: "v6.0.1" });
    expect(d.elfSha256).toBe("11".repeat(32));
    expect(parseAppDesc(new Uint8Array(0x200).fill(0xff))).toBeNull();
  });

  it("matches ESP-IDF's otadata crc (value from a stock X4 Pro: seq 1 -> 0x4743989a)", () => {
    expect(crc32(new Uint8Array([1, 0, 0, 0]), 0xffffffff)).toBe(0x4743989a);
    expect(activeOtaSlot(otadata(1), 2)).toBe(0);
    expect(activeOtaSlot(otadata(2), 2)).toBe(1);
    expect(activeOtaSlot(new Uint8Array(0x2000).fill(0xff), 2)).toBeNull();
    const bad = otadata(2);
    bad[28] ^= 1;
    expect(activeOtaSlot(bad, 2)).toBeNull();
  });

  it("names stock, this HA Paper build, another HA Paper build, and empty flash", async () => {
    const stock = flashOf([[0x8000, STOCK_TABLE], [0xe000, otadata(1)], [0x10000, appImage({ version: "7.5.11", project: "xteink_app" })]]);
    expect(await readInstalled(stock)).toMatchObject({ label: "Stock firmware 7.5.11", slot: "app0" });

    const ours = appImage({ version: "ee57070", project: "arduino-lib-builder", sha: 0x22 });
    const ha = flashOf([[0x8000, encodeTable(X4_ROWS)], [0xe000, otadata(2)], [0x650000, ours]]);
    const bundled = { desc: parseAppDesc(ours), version: "0.2.0-beta.1" };
    expect(await readInstalled(ha, bundled)).toMatchObject({ label: "HA Paper 0.2.0-beta.1", slot: "app1" });
    const older = { desc: parseAppDesc(appImage({ version: "x", project: "arduino-lib-builder", sha: 0x33 })), version: "0.3.0" };
    expect((await readInstalled(ha, older)).label).toBe("HA Paper (other version)");

    expect((await readInstalled(flashOf([]))).label).toBe("No firmware");
  });

  it("names any HA Paper build by its own descriptor (#242), bundled or not", async () => {
    const img = appImage({ version: "0.2.0-beta.2", project: "ha-paper", sha: 0x44 });
    const ha = flashOf([[0x8000, encodeTable(X4_ROWS)], [0xe000, otadata(1)], [0x10000, img]]);
    expect((await readInstalled(ha)).label).toBe("HA Paper 0.2.0-beta.2");
    const other = { desc: parseAppDesc(appImage({ version: "0.3.0", project: "ha-paper", sha: 0x55 })), version: "0.3.0" };
    expect((await readInstalled(ha, other)).label).toBe("HA Paper 0.2.0-beta.2");
  });

  // The real image from `pio run -e x4pro` (firmware/src/hw/app_desc.cpp replaces the Arduino core's descriptor).
  const built = new URL("../../firmware/.pio/build/x4pro/firmware.bin", import.meta.url);
  it.skipIf(!existsSync(built))("reads project ha-paper and X4_FW_VERSION from the built firmware.bin (#242)", () => {
    const d = parseAppDesc(new Uint8Array(readFileSync(built)))!;
    expect(d.project).toBe("ha-paper");
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.idf).toMatch(/^v5\./);
    expect(d.elfSha256).not.toBe("00".repeat(32));
  });
});
