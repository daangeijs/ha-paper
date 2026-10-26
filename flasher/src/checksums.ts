// Release file checks: SHA256SUMS (sha256sum / shasum -a 256 output) and manifest.json ({version, sha256, size}).
// Same rules as check_release() in firmware/tools/x4flash.py, plus the manifest cross-check.

import { PART_NAMES } from "./layout.ts";

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse `<hex>  <name>` / `<hex> *<name>` lines. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS: cannot read line "${line}"`);
    sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

export interface Manifest {
  version: string;
  sha256: string;
  size: number;
  notes?: string[];
}

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Partial<Manifest>;
  if (typeof m.version !== "string" || typeof m.sha256 !== "string" || typeof m.size !== "number") {
    throw new Error("manifest.json: missing version, sha256 or size");
  }
  return { version: m.version, sha256: m.sha256.toLowerCase(), size: m.size, notes: m.notes };
}

/** Throws with a plain message on the first problem. Returns nothing on success. */
export async function verifyRelease(
  files: ReadonlyMap<string, Uint8Array>,
  sums: ReadonlyMap<string, string>,
  manifest: Manifest,
): Promise<void> {
  for (const name of PART_NAMES) {
    const data = files.get(name);
    if (!data) throw new Error(`Missing ${name}.`);
    const expected = sums.get(name);
    if (!expected) throw new Error(`${name} is not listed in SHA256SUMS.`);
    if ((await sha256Hex(data)) !== expected) throw new Error(`${name} does not match SHA256SUMS.`);
  }
  const fw = files.get("firmware.bin")!;
  if (fw.length !== manifest.size) throw new Error("firmware.bin size does not match manifest.json.");
  if (sums.get("firmware.bin") !== manifest.sha256) throw new Error("firmware.bin does not match manifest.json.");
}
