// The flashing sequence, independent of the DOM and of Web Serial so it can be tested with a fake loader.
// Order is enforced here, not in the UI: chip check -> backup (or explicit skip) -> verify files -> check partition
// tables -> write.

import { backupFileName, type FlashReader, looksLikeFlashImage, readFullFlash } from "./backup.ts";
import { sha256Hex, verifyRelease } from "./checksums.ts";
import { readSecurity, type SecurityState } from "./efuse.ts";
import { FLASH_SIZE } from "./layout.ts";
import { md5Hex } from "./md5.ts";
import { checkDeviceTable, checkOurTable, PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE } from "./partitionTable.ts";
import type { Release } from "./release.ts";
import { assertSafePlan, planInstall, planRestore, type WritePlan } from "./writePlan.ts";

/** The part of esptool-js's ESPLoader this flow uses. */
export interface Loader extends FlashReader {
  chip: { CHIP_NAME: string };
  secureDownloadMode: boolean;
  readReg(addr: number): Promise<number>;
  detectFlashSize(): Promise<string | undefined>;
  writeFlash(options: {
    fileArray: { data: Uint8Array; address: number }[];
    flashMode: "keep";
    flashFreq: "keep";
    flashSize: "keep";
    eraseAll: false;
    compress: boolean;
    reportProgress?: (fileIndex: number, written: number, total: number) => void;
    calculateMD5Hash?: (image: Uint8Array) => string;
  }): Promise<void>;
  after(mode?: "hard_reset"): Promise<void>;
}

export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

export interface Backup {
  name: string;
  data: Uint8Array;
  sha256: string;
  looksValid: boolean;
}

export type Progress = (label: string, done: number, total: number) => void;

export class Session {
  security: SecurityState | null = null;
  backup: Backup | null = null;
  backupSkipped = false;

  private readonly loader: Loader;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(loader: Loader, now: () => Date = () => new Date(), log: (line: string) => void = () => {}) {
    this.loader = loader;
    this.now = now;
    this.log = log;
  }

  async chipCheck(): Promise<SecurityState> {
    this.security = null;
    const l = this.loader;
    if (l.chip.CHIP_NAME !== "ESP32-S3") {
      throw new RefusedError(`This is an ${l.chip.CHIP_NAME}, not the ESP32-S3 of an X4 Pro. Nothing was written.`);
    }
    if (l.secureDownloadMode) {
      throw new RefusedError("The chip is in secure download mode: its eFuses can't be read. Nothing was written.");
    }
    let s: SecurityState;
    try {
      s = await readSecurity(l);
    } catch (e) {
      throw new RefusedError(`Could not read the secure boot / flash encryption eFuses (${errText(e)}). Nothing was written.`);
    }
    if (s.secureBoot || s.flashEncryption) {
      const what = [s.secureBoot && "secure boot", s.flashEncryption && "flash encryption"].filter(Boolean).join(" and ");
      throw new RefusedError(`${cap(what)} is enabled on this unit: it cannot run HA Paper. Nothing was written.`);
    }
    const size = await l.detectFlashSize().catch(() => undefined);
    if (size !== undefined && size !== "16MB") {
      throw new RefusedError(`This unit reports ${size} of flash; the X4 Pro has 16MB. Nothing was written.`);
    }
    this.security = s;
    return s;
  }

  async makeBackup(progress?: Progress): Promise<Backup> {
    this.requireChipCheck();
    const data = await readFullFlash(this.loader, (d, t) => progress?.("Reading backup", d, t), this.log);
    if (data.length !== FLASH_SIZE) throw new Error(`Backup is ${data.length} bytes, expected ${FLASH_SIZE}.`);
    const backup: Backup = {
      name: backupFileName(this.now()),
      data,
      sha256: await sha256Hex(data),
      looksValid: looksLikeFlashImage(data),
    };
    this.backup = backup;
    return backup;
  }

  skipBackup(): void {
    this.backupSkipped = true;
  }

  get readyToInstall(): boolean {
    return this.security !== null && (this.backup !== null || this.backupSkipped);
  }

  /** Verify the bundled files again (right before writing), build the plan, write. */
  async install(release: Release, progress?: Progress): Promise<WritePlan> {
    this.requireChipCheck();
    if (!this.backup && !this.backupSkipped) throw new RefusedError("Make a backup first (or tick that you have one).");
    await verifyRelease(release.files, release.sums, release.manifest);
    checkOurTable(release.files.get("partitions.bin")!);
    const onDevice = await this.loader.readFlash(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE);
    try {
      this.log(checkDeviceTable(onDevice));
    } catch (e) {
      throw new RefusedError(errText(e));
    }
    const plan = planInstall(release.files);
    await this.write(plan, progress);
    return plan;
  }

  async restore(name: string, data: Uint8Array, expectedSha256?: string, progress?: Progress): Promise<WritePlan> {
    this.requireChipCheck();
    if (data.length !== FLASH_SIZE) {
      throw new RefusedError(`${name} is ${data.length} bytes, not a full 16 MB backup (${FLASH_SIZE} bytes).`);
    }
    if (expectedSha256 && (await sha256Hex(data)) !== expectedSha256.toLowerCase()) {
      throw new RefusedError(`${name} does not match its .sha256 file: the backup is damaged.`);
    }
    const plan = planRestore(name, data);
    await this.write(plan, progress);
    return plan;
  }

  private async write(plan: WritePlan, progress?: Progress): Promise<void> {
    assertSafePlan(plan); // again, on the exact object handed to esptool-js
    const writes = plan.writes;
    await this.loader.writeFlash({
      fileArray: writes.map((w) => ({ data: w.data, address: w.address })),
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, total) => progress?.(`Writing ${writes[i]?.name ?? ""}`, written, total),
      calculateMD5Hash: md5Hex,
    });
    await this.loader.after("hard_reset");
  }

  private requireChipCheck(): void {
    if (!this.security) throw new RefusedError("Run the chip check first.");
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
