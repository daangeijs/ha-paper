// Loads the release files bundled next to the page (firmware/, filled by `make flasher`). GitHub release assets
// can't be fetched from a browser (no CORS headers), so the files travel with the page.

import { type Manifest, parseManifest, parseSha256Sums, verifyRelease } from "./checksums.ts";
import { PART_NAMES } from "./layout.ts";

export interface Release {
  manifest: Manifest;
  sums: Map<string, string>;
  files: Map<string, Uint8Array>;
}

type Fetch = (url: string) => Promise<Pick<Response, "ok" | "status" | "text" | "arrayBuffer">>;

export async function loadRelease(fetchFn: Fetch, base = "firmware/"): Promise<Release> {
  const get = async (name: string) => {
    const res = await fetchFn(base + name);
    if (!res.ok) throw new Error(`Could not load ${base}${name} (HTTP ${res.status}).`);
    return res;
  };
  const manifest = parseManifest(await (await get("manifest.json")).text());
  const sums = parseSha256Sums(await (await get("SHA256SUMS")).text());
  const files = new Map<string, Uint8Array>();
  for (const name of PART_NAMES) files.set(name, new Uint8Array(await (await get(name)).arrayBuffer()));
  await verifyRelease(files, sums, manifest);
  return { manifest, sums, files };
}
