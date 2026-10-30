// Selectable releases (eink-ha-os#239). The Pages build puts every published beta/stable release next to the page in
// firmware/<version>/ and lists them in firmware/versions.json; browsers can't fetch GitHub release assets (no CORS).
// Without versions.json (dev server, zip download, older deploys) the single firmware/ folder is the one version.

import { loadRelease, type Release } from "./release.ts";

export interface VersionEntry {
  version: string;
  prerelease: boolean;
  date: string;
  /** Folder next to the page, "firmware/<version>/". */
  path: string;
}

type Fetch = Parameters<typeof loadRelease>[0];

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** Parse versions.json, newest first. Rejects paths that leave firmware/. */
export function parseVersions(text: string): VersionEntry[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("versions.json: not a list");
  const out = raw.map((e, i): VersionEntry => {
    const r = e as Record<string, unknown>;
    if (typeof r.version !== "string" || !VERSION_RE.test(r.version)) throw new Error(`versions.json: bad version at ${i}`);
    const path = typeof r.path === "string" ? r.path : `firmware/${r.version}/`;
    if (path !== `firmware/${r.version}/`) throw new Error(`versions.json: bad path for ${r.version}`);
    return { version: r.version, prerelease: r.prerelease === true, date: typeof r.date === "string" ? r.date : "", path };
  });
  if (!out.length) throw new Error("versions.json: empty");
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** The list to offer: versions.json, or null when it isn't there (single firmware/ layout). */
export async function loadVersions(fetchFn: Fetch): Promise<VersionEntry[] | null> {
  const res = await fetchFn("firmware/versions.json");
  if (!res.ok) return null;
  return parseVersions(await res.text());
}

export function versionLabel(e: VersionEntry, _latest: boolean): string {
  return `v${e.version}`;
}

/** Load one entry's files; null entry = the single firmware/ layout. The manifest must name the same version. */
export async function loadVersion(fetchFn: Fetch, entry: VersionEntry | null): Promise<Release> {
  if (!entry) return loadRelease(fetchFn);
  const r = await loadRelease(fetchFn, entry.path);
  if (r.manifest.version !== entry.version) {
    throw new Error(`${entry.path}manifest.json is ${r.manifest.version}, not ${entry.version}.`);
  }
  return r;
}
