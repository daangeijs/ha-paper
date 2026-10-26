import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// index.html is plain markup that main.ts wires up by id: check the ids exist and the steps come in order.
const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const main = readFileSync(new URL("src/main.ts", root), "utf8");
const at = (needle: string) => {
  const i = html.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

describe("landing page", () => {
  it("has every element main.ts looks up", () => {
    const ids = [...main.matchAll(/\$(?:<[^>]+>)?\("([\w-]+)"\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) at(`id="${id}"`);
  });

  it("orders intro, needs, download mode, connect, backup, install, after, details", () => {
    const order = [
      'id="screens-h"',
      'id="need-h"',
      "hold Left",
      'id="connect"',
      'id="backup"',
      'id="install"',
      'id="after-h"',
      'class="tech"',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps hex offsets inside the technical details", () => {
    const tech = at('class="tech"');
    for (const m of html.matchAll(/0x[0-9A-F]{4,}/gi)) expect(m.index).toBeGreaterThan(tech);
  });

  it("has alt text on every screen image and the files exist", () => {
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBe(4);
    for (const img of imgs) {
      expect(img).toMatch(/alt="[^"]{20,}"/);
      const src = img.match(/src="\.\/([^"]+)"/)![1];
      expect(existsSync(new URL(src, root)), src).toBe(true);
    }
  });

  it("loads nothing from another host (plain <a> links to github.com are fine)", () => {
    expect(html).not.toMatch(/src="(https?:)?\/\//);
    expect(html).not.toMatch(/<link[^>]+href="(https?:)?\/\//);
    for (const m of html.matchAll(/href="((https?:)?\/\/[^"]*)"/g)) expect(m[1]).toMatch(/^https:\/\/github\.com\/daangeijs\/eink-ha-os\//);
  });

  it("links the release, x4flash.py, the flashing guide and the issue form (#44)", () => {
    for (const p of ["/releases/latest", "/firmware/tools/x4flash.py", "/docs/FLASHING.md", "/issues/new?template=bug_report.yml"])
      at(`href="https://github.com/daangeijs/eink-ha-os${p.startsWith("/releases") || p.startsWith("/issues") ? "" : "/blob/main"}${p}"`);
  });
});
