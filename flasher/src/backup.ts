import { FLASH_SIZE } from "./layout.ts";
import { md5Hex } from "./md5.ts";

/** x4pro_stock_YYYYMMDD.bin in local time, the same name `make backup` and x4flash.py use. */
export function backupFileName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `x4pro_stock_${y}${m}${d}.bin`;
}

/** Sidecar in sha256sum format, like x4flash.py writes next to the backup. */
export function sha256Sidecar(name: string, sha256: string): string {
  return `${sha256}  ${name}\n`;
}

export interface FlashReader {
  readFlash(
    addr: number,
    size: number,
    onPacketReceived?: ((p: Uint8Array, got: number, total: number) => void) | null,
  ): Promise<Uint8Array>;
  /** The chip hashes the region itself (SPI_FLASH_MD5): checks that what came over USB is what is in flash. */
  flashMd5sum(addr: number, size: number): Promise<string>;
}

// esptool-js 0.7.0 readFlash() grows its result by copying the whole buffer for every 4 KB packet: 16 MB in one call
// is ~34 GB of copying. 256 KB per call into one preallocated buffer keeps that small, and a bad chunk is cheap to
// read again. (crosspoint-tools reads 1 MB chunks with the same MD5 check.)
export const READ_CHUNK = 256 * 1024;
export const READ_ATTEMPTS = 3;

export async function readFullFlash(
  loader: FlashReader,
  onProgress?: (done: number, total: number) => void,
  log?: (line: string) => void,
): Promise<Uint8Array> {
  const out = new Uint8Array(FLASH_SIZE);
  for (let addr = 0; addr < FLASH_SIZE; addr += READ_CHUNK) {
    const size = Math.min(READ_CHUNK, FLASH_SIZE - addr);
    const where = `0x${addr.toString(16)}`;
    let lastError = "";
    let ok = false;
    for (let attempt = 1; attempt <= READ_ATTEMPTS && !ok; attempt++) {
      try {
        const chunk = await loader.readFlash(addr, size, (_p, got) => onProgress?.(addr + got, FLASH_SIZE));
        if (chunk.length !== size) throw new Error(`read ${chunk.length} bytes, expected ${size}`);
        const onChip = (await loader.flashMd5sum(addr, size)).toLowerCase();
        if (md5Hex(chunk) !== onChip) throw new Error("MD5 differs from the chip's");
        out.set(chunk, addr);
        ok = true;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        log?.(`Backup chunk at ${where}, attempt ${attempt}: ${lastError}`);
      }
    }
    if (!ok) throw new Error(`Backup failed at ${where} after ${READ_ATTEMPTS} attempts: ${lastError}.`);
    onProgress?.(addr + size, FLASH_SIZE);
  }
  return out;
}

/** A stock image starts with an ESP image header (magic 0xE9) at 0x0. Anything else suggests a bad read. */
export function looksLikeFlashImage(data: Uint8Array): boolean {
  return data.length === FLASH_SIZE && data[0] === 0xe9;
}
