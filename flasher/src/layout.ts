// Flash layout of the X4 Pro under HA Paper. Source of truth: firmware/partitions.csv and the PARTS list in
// firmware/tools/x4flash.py. Keep all three in step.

export const FLASH_SIZE = 16 * 1024 * 1024; // 16 MB, 0x1000000
export const SECTOR = 0x1000; // SPI flash erase granularity: a write erases every 4 KB sector it touches

// NVS holds Wi-Fi, the Home Assistant link and the OEM `hw_calib/screenType` panel id. That last value exists
// nowhere else, so nothing here may write or erase this range. End is exclusive.
export const NVS_START = 0x9000;
export const NVS_END = 0xe000;

// userdata (LittleFS) holds screens.yaml, settings.json and diag.json. The firmware formats it on first boot; an
// install never writes or erases it, so a re-flash keeps the user's screens and settings. End is exclusive.
export const USERDATA_START = 0xfd0000;
export const USERDATA_END = 0xff0000;

export type PartName = "bootloader.bin" | "partitions.bin" | "boot_app0.bin" | "firmware.bin" | "www.bin";

export interface PartSlot {
  name: PartName;
  offset: number;
  /** Exclusive end of the region this part may occupy (next region or partition end). */
  limit: number;
}

// The five parts, at their own offsets. Same as x4flash.py. No merged 0x0 image: merge-bin pads the NVS gap with
// 0xFF, and writing that would wipe the panel id.
export const PARTS: readonly PartSlot[] = [
  { name: "bootloader.bin", offset: 0x0, limit: 0x8000 },
  { name: "partitions.bin", offset: 0x8000, limit: NVS_START },
  { name: "boot_app0.bin", offset: 0xe000, limit: 0x10000 }, // otadata
  { name: "firmware.bin", offset: 0x10000, limit: 0x650000 }, // app0
  { name: "www.bin", offset: 0xc90000, limit: USERDATA_START }, // www (web console); userdata follows
];

export const PART_NAMES: readonly PartName[] = PARTS.map((p) => p.name);
