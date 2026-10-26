import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

// #42: the installer page loads nothing from other hosts (no font CDN, no script CDN). Same rule as the device console
// (emulator/src/webconsole/offline.test.ts): XML namespace URIs are text, plain <a href> links to github.com are fine.
const TEXT_ONLY = new Set(["www.w3.org"]);
function externalRefs(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)[^\s"'`)<>\\]*/gi)) {
    const host = m[1].toLowerCase();
    const at = m.index ?? 0;
    if (TEXT_ONLY.has(host)) continue;
    const before = text.slice(Math.max(0, at - 400), at);
    const link = /href[=:]\s*["'`]?$/.test(before) && !/<(?!a[\s>])[a-z][^<>]*$/i.test(before);
    if (host === "github.com" && link) continue;
    bad.push(m[0]);
  }
  return bad;
}

const root = new URL("../", import.meta.url);

describe("no external requests (#42)", () => {
  it("externalRefs flags resources on other hosts, not plain GitHub links", () => {
    expect(externalRefs('<link rel="stylesheet" href="https://fonts.googleapis.com/css2">')).toHaveLength(1);
    expect(externalRefs('<script src="https://github.com/x.js"></script>')).toHaveLength(1);
    expect(externalRefs('import("https://cdn.jsdelivr.net/npm/esptool-js")')).toHaveLength(1);
    expect(externalRefs('<a href="https://github.com/daangeijs/eink-ha-os">source</a>')).toEqual([]);
    expect(externalRefs("on an https:// page")).toEqual([]);
  });

  it("built installer page loads nothing from other hosts", async () => {
    const out = mkdtempSync(join(tmpdir(), "x4-flasher-"));
    try {
      await build({ configFile: fileURLToPath(new URL("vite.config.ts", root)), logLevel: "silent", build: { outDir: out } });
      const files = readdirSync(out, { recursive: true, encoding: "utf8" }).filter((f) => /\.(html|js|css|svg|json|webmanifest)$/.test(f));
      expect(files).toContain("index.html");
      expect(files.flatMap((f) => externalRefs(readFileSync(join(out, f), "utf8")).map((u) => `${f}: ${u}`))).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
