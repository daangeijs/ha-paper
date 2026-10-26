// OTA for the simulator: a mock GitHub Releases feed + manifest.json {version, sha256, size, notes[]} (ARCHITECTURE §6),
// SHA-256 verification of a downloaded/uploaded image, and a small multipart/form-data parser for POST /ota/upload.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { INITIAL_RELEASES } from '../src/core/data.ts';
import { newer } from '../src/core/format.ts';

export type Manifest = { version: string; sha256: string; size: number; notes: string[] };
export type SimRelease = { tag: string; prerelease: boolean; manifest: Manifest; image: () => Buffer };

/** A version from an upload (manifest.json or ?version=): printable, ≤ 64 chars, no leading "v"; else '' (#237). */
export const uploadVersion = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim().replace(/^[vV](?=\d)/, '') : '';
  return /^[\x21-\x7e]{1,64}$/.test(s) ? s : '';
};

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Deterministic stand-in for firmware.bin of a version (what `--releases-file`-less releases "download"). */
export const syntheticImage = (version: string): Buffer => Buffer.from('HA Paper firmware v' + version + '\n' + 'x'.repeat(4096) + '\n');

const manifestFor = (version: string, notes: string[], img: Buffer): Manifest => ({ version, sha256: sha256(img), size: img.length, notes });

export function defaultReleases(): SimRelease[] {
  return (['stable', 'beta'] as const).map((ch) => {
    const r = INITIAL_RELEASES[ch]; const img = syntheticImage(r.version);
    return { tag: 'v' + r.version, prerelease: ch === 'beta', manifest: manifestFor(r.version, r.notes, img), image: () => img };
  });
}

/**
 * --releases-file: a GitHub "list releases" response (newest first), each with an optional inline `manifest`
 * and optionally a local `path` on the firmware.bin asset:
 *   [{ "tag_name": "v0.4.0", "prerelease": false, "body": "- note\n- note",
 *      "assets": [{ "name": "firmware.bin", "path": "./fw-0.4.0.bin" }],
 *      "manifest": { "version": "0.4.0", "sha256": "…", "size": 1234, "notes": ["…"] } }]
 * Without a manifest it is computed from the image (local path, or the synthetic image).
 * Set a wrong manifest sha256 to simulate a corrupted download.
 */
export function loadReleases(file: string): SimRelease[] {
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error(file + ': expected an array of GitHub releases');
  return list.map((r: any) => {
    const version = String(r.tag_name || r.manifest?.version || '').replace(/^v/, '');
    const asset = (r.assets || []).find((a: any) => a.name === 'firmware.bin');
    const img = asset?.path ? readFileSync(resolve(dirname(file), asset.path)) : syntheticImage(version);
    const notes: string[] = r.manifest?.notes || String(r.body || '').split('\n').map((l: string) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);
    const manifest: Manifest = { ...manifestFor(version, notes, img), ...(r.manifest || {}) };
    return { tag: 'v' + version, prerelease: !!r.prerelease, manifest, image: () => img };
  });
}

/** stable = GET /releases/latest (newest non-prerelease); beta = newest of GET /releases?per_page=5. */
export function latestFor(releases: SimRelease[], channel: 'stable' | 'beta'): SimRelease | null {
  const pool = releases.filter((r) => channel === 'beta' || !r.prerelease);
  return pool.reduce<SimRelease | null>((best, r) => (!best || newer(r.manifest.version, best.manifest.version) ? r : best), null);
}

export type MultipartPart = { name: string; filename: string | null; type: string | null; data: Buffer };

export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('multipart boundary missing');
  const delim = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts: MultipartPart[] = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    let start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body.subarray(start, start + 2).toString() === '\r\n') start += 2;
    const next = body.indexOf(delim, start); if (next < 0) break;
    const chunk = body.subarray(start, next - 2); // strip CRLF before the delimiter
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep >= 0) {
      const head = chunk.subarray(0, sep).toString('utf8');
      const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] || '';
      const name = /\bname="([^"]*)"/i.exec(disp)?.[1] || '';
      const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1] ?? null;
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null;
      parts.push({ name, filename, type, data: chunk.subarray(sep + 4) });
    }
    pos = next;
  }
  return parts;
}
