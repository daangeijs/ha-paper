// The only place that decides what gets written where. Every write goes through planInstall() or planRestore(),
// and flow.ts checks the plan again with assertSafePlan() right before handing it to esptool-js.

import { FLASH_SIZE, NVS_END, NVS_START, PARTS, type PartName, SECTOR, USERDATA_START } from "./layout.ts";

export interface PlannedWrite {
  name: string;
  address: number;
  data: Uint8Array;
}

export type WritePlan =
  | { kind: "install"; writes: PlannedWrite[] }
  | { kind: "restore"; writes: PlannedWrite[] };

export class UnsafeWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeWriteError";
  }
}

const hex = (n: number) => "0x" + n.toString(16).toUpperCase();

/** Byte range [start, end) that a write erases: esptool pads data to 4 bytes, the flash erases whole 4 KB sectors. */
export function eraseRange(address: number, length: number): [number, number] {
  const padded = Math.ceil(length / 4) * 4;
  return [address, Math.ceil((address + padded) / SECTOR) * SECTOR];
}

export function overlapsNvs(address: number, length: number): boolean {
  const [start, end] = eraseRange(address, length);
  return start < NVS_END && end > NVS_START;
}

export function overlapsProtectedTop(address: number, length: number): boolean { // userdata + coredump
  const [start, end] = eraseRange(address, length);
  return start < FLASH_SIZE && end > USERDATA_START;
}

/** Install: exactly the five parts, each at its own offset, each inside its own region, none touching NVS or userdata. */
export function planInstall(files: ReadonlyMap<string, Uint8Array>): WritePlan {
  const extra = [...files.keys()].filter((n) => !PARTS.some((p) => p.name === n));
  if (extra.length > 0) throw new UnsafeWriteError(`Unexpected file(s) in the install plan: ${extra.join(", ")}`);
  const writes: PlannedWrite[] = PARTS.map((slot) => {
    const data = files.get(slot.name);
    if (!data) throw new UnsafeWriteError(`Missing ${slot.name}`);
    return { name: slot.name, address: slot.offset, data };
  });
  const plan: WritePlan = { kind: "install", writes };
  assertSafePlan(plan);
  return plan;
}

/** Restore: one full 16 MB backup made by the user, written at 0x0. The only plan allowed to cover NVS. */
export function planRestore(name: string, data: Uint8Array): WritePlan {
  const plan: WritePlan = { kind: "restore", writes: [{ name, address: 0, data }] };
  assertSafePlan(plan);
  return plan;
}

export function assertSafePlan(plan: WritePlan): void {
  if (plan.kind === "restore") {
    if (plan.writes.length !== 1) throw new UnsafeWriteError("A restore writes exactly one file.");
    const w = plan.writes[0];
    if (w.address !== 0) throw new UnsafeWriteError(`A restore is written at 0x0, not ${hex(w.address)}.`);
    if (w.data.length !== FLASH_SIZE) {
      throw new UnsafeWriteError(
        `${w.name} is ${w.data.length} bytes; a full backup is exactly ${FLASH_SIZE} bytes (16 MB).`,
      );
    }
    return;
  }

  if (plan.writes.length !== PARTS.length) {
    throw new UnsafeWriteError(`An install writes exactly ${PARTS.length} parts, got ${plan.writes.length}.`);
  }
  const seen = new Set<string>();
  for (const w of plan.writes) {
    const slot = PARTS.find((p) => p.name === (w.name as PartName));
    if (!slot) throw new UnsafeWriteError(`Unknown part ${w.name}.`);
    if (seen.has(w.name)) throw new UnsafeWriteError(`${w.name} appears twice.`);
    seen.add(w.name);
    if (w.address !== slot.offset) {
      throw new UnsafeWriteError(`${w.name} belongs at ${hex(slot.offset)}, not ${hex(w.address)}.`);
    }
    if (w.address % SECTOR !== 0) throw new UnsafeWriteError(`${w.name}: ${hex(w.address)} is not sector aligned.`);
    if (w.data.length === 0) throw new UnsafeWriteError(`${w.name} is empty.`);
    if (overlapsNvs(w.address, w.data.length)) {
      const [, end] = eraseRange(w.address, w.data.length);
      throw new UnsafeWriteError(
        `${w.name} would erase ${hex(w.address)}-${hex(end - 1)}, which overlaps NVS ` +
          `(${hex(NVS_START)}-${hex(NVS_END - 1)}). Refusing: NVS holds the OEM panel id.`,
      );
    }
    if (overlapsProtectedTop(w.address, w.data.length)) {
      throw new UnsafeWriteError(
        `${w.name} would overwrite userdata + coredump (${hex(USERDATA_START)}-${hex(FLASH_SIZE - 1)}): ` +
          "screens and settings must survive a re-flash. Refusing.",
      );
    }
    const [, end] = eraseRange(w.address, w.data.length);
    if (end > slot.limit) {
      throw new UnsafeWriteError(`${w.name} (${w.data.length} bytes) does not fit before ${hex(slot.limit)}.`);
    }
    if (end > FLASH_SIZE) throw new UnsafeWriteError(`${w.name} runs past the end of the 16 MB flash.`);
  }
}
