import { describe, expect, it } from "vitest";
import { loadVersion, loadVersions, parseVersions, versionLabel } from "../src/versions.ts";
import { makeRelease } from "./fakeChip.ts";

const LIST = JSON.stringify([
  { version: "0.2.0-beta.1", prerelease: true, date: "2026-10-26T10:00:00Z", path: "firmware/0.2.0-beta.1/" },
  { version: "0.3.0", prerelease: false, date: "2026-11-20T10:00:00Z", path: "firmware/0.3.0/" },
]);

// Serves a release's files under one folder, like the Pages site.
async function site(base: string, version: string, extra: Record<string, string> = {}) {
  const r = await makeRelease();
  const files: Record<string, Uint8Array | string> = { ...extra };
  for (const [n, d] of r.files) files[base + n] = d;
  files[`${base}manifest.json`] = JSON.stringify({ ...r.manifest, version });
  files[`${base}SHA256SUMS`] = [...r.sums].map(([n, h]) => `${h}  ${n}`).join("\n");
  const asked: string[] = [];
  const fetchFn = async (url: string) => {
    asked.push(url);
    const f = files[url];
    const bytes = typeof f === "string" ? new TextEncoder().encode(f) : f;
    return {
      ok: f !== undefined,
      status: f === undefined ? 404 : 200,
      text: async () => (typeof f === "string" ? f : ""),
      arrayBuffer: async () => (bytes ?? new Uint8Array()).slice().buffer as ArrayBuffer,
    };
  };
  return { fetchFn, asked };
}

describe("selectable versions (eink-ha-os#239)", () => {
  it("parses versions.json newest first and labels each by its release name", () => {
    const v = parseVersions(LIST);
    expect(v.map((e) => e.version)).toEqual(["0.3.0", "0.2.0-beta.1"]);
    expect(versionLabel(v[0], true)).toBe("v0.3.0");
    expect(versionLabel(v[1], false)).toBe("v0.2.0-beta.1");
  });

  it("rejects paths outside firmware/<version>/ and bad entries", () => {
    expect(() => parseVersions('[{"version":"1.0.0","path":"../evil/"}]')).toThrow(/bad path/);
    expect(() => parseVersions('[{"version":"1.0.0","path":"https://x/firmware/1.0.0/"}]')).toThrow(/bad path/);
    expect(() => parseVersions('[{"version":"../x"}]')).toThrow(/bad version/);
    expect(() => parseVersions("[]")).toThrow(/empty/);
    expect(parseVersions('[{"version":"1.0.0"}]')[0].path).toBe("firmware/1.0.0/");
  });

  it("falls back to the single firmware/ layout without versions.json", async () => {
    const { fetchFn, asked } = await site("firmware/", "0.2.0-beta.1");
    expect(await loadVersions(fetchFn)).toBeNull();
    const r = await loadVersion(fetchFn, null);
    expect(r.manifest.version).toBe("0.2.0-beta.1");
    expect(asked).toContain("firmware/firmware.bin");
  });

  it("loads the chosen version from its own folder and checks the manifest names it", async () => {
    const { fetchFn, asked } = await site("firmware/0.2.0-beta.1/", "0.2.0-beta.1", { "firmware/versions.json": LIST });
    const list = (await loadVersions(fetchFn))!;
    const beta = list.find((e) => e.version === "0.2.0-beta.1")!;
    expect((await loadVersion(fetchFn, beta)).manifest.version).toBe("0.2.0-beta.1");
    expect(asked).toContain("firmware/0.2.0-beta.1/firmware.bin");

    const wrong = await site("firmware/0.3.0/", "0.2.0-beta.1");
    await expect(loadVersion(wrong.fetchFn, list[0])).rejects.toThrow(/is 0.2.0-beta.1, not 0.3.0/);
  });
});
