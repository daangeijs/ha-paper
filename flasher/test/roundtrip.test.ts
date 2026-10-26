// Issue #65: backup -> install -> restore on a patterned 16 MB image. The backup is byte-identical, the install
// changes only the sectors of the five planned writes, and writing the backup back gives the original image.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Session } from "../src/flow.ts";
import { FLASH_SIZE } from "../src/layout.ts";
import { eraseRange } from "../src/writePlan.ts";
import { fakeChip, makeRelease, patternedFlash, REGIONS } from "./fakeChip.ts";

/** Names of the regions with a byte outside `allowed` that differs between a and b. */
function changedOutside(a: Uint8Array, b: Uint8Array, allowed: [number, number][]): string[] {
  const keep: [number, number][] = [];
  let at = 0;
  for (const [s, e] of [...allowed].sort((x, y) => x[0] - y[0])) {
    if (s > at) keep.push([at, s]);
    at = Math.max(at, e);
  }
  if (at < FLASH_SIZE) keep.push([at, FLASH_SIZE]);
  const bad = new Set<string>();
  for (const [s, e] of keep) {
    if (Buffer.compare(a.subarray(s, e), b.subarray(s, e)) === 0) continue;
    for (const r of REGIONS) {
      const lo = Math.max(s, r.start);
      const hi = Math.min(e, r.end);
      if (lo < hi && Buffer.compare(a.subarray(lo, hi), b.subarray(lo, hi)) !== 0) bad.add(r.name);
    }
  }
  return [...bad];
}

describe("backup -> install -> restore on a patterned 16 MB image", () => {
  it("backs up byte-identically, writes only the planned sectors, restores byte-identically", async () => {
    const original = patternedFlash();
    const chip = fakeChip({}, original.slice());
    const s = new Session(chip.loader, () => new Date(2026, 9, 16));
    await s.chipCheck();

    const backup = await s.makeBackup();
    expect(Buffer.compare(backup.data, original)).toBe(0); // not toEqual: element-wise diff of 16 MB runs out of heap
    expect(backup.sha256).toBe(createHash("sha256").update(original).digest("hex"));

    const plan = await s.install(await makeRelease());
    const allowed = plan.writes.map((w) => eraseRange(w.address, w.data.length));
    expect(allowed).toEqual([
      [0x0, 0x6000], // bootloader, 0x5123 bytes
      [0x8000, 0x9000], // partitions
      [0xe000, 0x10000], // otadata
      [0x10000, 0x31000], // app0, 0x20345 bytes
      [0xc90000, 0xc98000], // www
    ]);
    // every sector the chip erased was planned, and nothing outside the plan changed (NVS, app1, userdata, coredump)
    for (const [start, end] of chip.erased) {
      expect(allowed.some(([s0, e0]) => start >= s0 && end <= e0), `erase 0x${start.toString(16)}`).toBe(true);
    }
    expect(changedOutside(original, chip.flash, allowed)).toEqual([]);
    // inside the plan: the part, then 0xFF to the end of its last sector
    for (const w of plan.writes) {
      const [, end] = eraseRange(w.address, w.data.length);
      expect(Buffer.compare(chip.flash.subarray(w.address, w.address + w.data.length), w.data), w.name).toBe(0);
      expect(chip.flash.subarray(w.address + w.data.length, end).every((x) => x === 0xff), w.name).toBe(true);
    }
    // the check above is not vacuous: the pattern was overwritten in exactly these regions
    expect(changedOutside(original, chip.flash, [])).toEqual(["bootloader", "partition table", "otadata", "app0", "www"]);

    await s.restore(backup.name, backup.data, backup.sha256);
    expect(chip.events.filter((e) => e.startsWith("begin")).at(-1)).toBe("begin 0x0");
    expect(Buffer.compare(chip.flash, original)).toBe(0);
  });
});
