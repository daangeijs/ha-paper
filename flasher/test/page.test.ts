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

  it("orders screens, device, connect, install, Wi-Fi, advanced (restore), details", () => {
    const order = [
      'id="carousel"',
      'id="device-pick"',
      'id="device-controls"',
      'id="connect"',
      'id="install"',
      'id="want-backup"',
      'id="wifi-step"',
      'class="advanced"',
      'id="restore"',
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
    expect(imgs.length).toBe(5);
    for (const img of imgs) {
      expect(img).toMatch(/alt="[^"]{20,}"/);
      const src = img.match(/src="\.\/([^"]+)"/)![1];
      expect(existsSync(new URL(src, root)), src).toBe(true);
    }
  });

  it("loads nothing from another host (plain <a> links to github.com are fine)", () => {
    expect(html).not.toMatch(/src="(https?:)?\/\//);
    expect(html).not.toMatch(/<link[^>]+href="(https?:)?\/\//);
    const css = readFileSync(new URL("src/style.css", root), "utf8");
    expect(css).not.toMatch(/@import|url\(/);
    for (const m of html.matchAll(/href="((https?:)?\/\/[^"]*)"/g)) expect(m[1]).toMatch(/^https:\/\/github\.com\/daangeijs\/ha-paper\//);
  });

  it("links the release, x4flash.py, the flashing guide and the issue form (eink-ha-os#44)", () => {
    for (const p of ["/releases/latest", "/firmware/tools/x4flash.py", "/docs/FLASHING.md", "/issues/new?template=bug_report.yml"])
      at(`href="https://github.com/daangeijs/ha-paper${p.startsWith("/releases") || p.startsWith("/issues") ? "" : "/blob/main"}${p}"`);
  });

  it("keeps restore under Advanced; backup privacy in the details (eink-ha-os#233, eink-ha-os#239)", () => {
    const adv = html.slice(at('<details class="advanced">'), at('class="tech"'));
    expect(adv).toContain('id="restore-h">Restore backup<');
    expect(html).toMatch(/Wi-Fi password/);
    expect(html).toMatch(/nothing is uploaded/);
    expect(html).toMatch(/Chrome or Edge/);
  });

  it("makes the backup an unchecked option and draws no button layout (eink-ha-os#239)", () => {
    expect(html).toMatch(/<input type="checkbox" id="want-backup">/);
    expect(html).not.toMatch(/<svg/);
    expect(html).not.toMatch(/press Reset|hold Left/i);
    expect(main).toContain('"Done. Replug USB."');
  });

  it("shows progress and errors inline, in the step that runs (eink-ha-os#239)", () => {
    expect(html).not.toContain('id="progress"');
    for (const step of ["backup", "install", "restore"]) {
      const ids = [`id="${step}-progress"`, `id="${step}-bar"`, `id="${step}-label"`, `id="${step}-error"`];
      const pos = ids.map(at);
      expect(pos, step).toEqual([...pos].sort((a, b) => a - b));
    }
    expect(at('id="install"')).toBeLessThan(at('id="backup-progress"'));
    expect(at('id="restore"')).toBeLessThan(at('id="restore-progress"'));
    at('id="connect-error"');
    at('id="wifi-error"');
  });

  it("keeps the landing state short: under 60 visible words (eink-ha-os#239)", () => {
    let b = html.slice(html.indexOf("<body>"));
    b = b.replace(/<details[\s\S]*?<\/details>\s*<\/details>|<details class="tech">[\s\S]*?<\/details>/g, "");
    b = b.replace(/<(p|div|li)\b[^>]*\bhidden\b[^>]*>[\s\S]*?<\/\1>/g, "");
    b = b.replace(/<(dialog|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ");
    expect(b.split(/\s+/).filter(Boolean).length).toBeLessThan(60);
  });

  it("offers the X4 Pro and Other as radio tiles; Other hides the controls and says why (eink-ha-os#239)", () => {
    const pick = html.slice(at('<fieldset id="device-pick"'), at("</fieldset>"));
    expect([...pick.matchAll(/<input type="radio" name="device" value="(\w+)"/g)].map((m) => m[1])).toEqual(["x4pro", "other"]);
    expect(pick).toMatch(/value="x4pro" checked/);
    expect(pick).toMatch(/id="x4pro-verified"/);
    expect(pick).not.toMatch(/Tested on/); // rendered from src/devices.ts
        expect(html).toMatch(/<p id="other-device"[^>]*hidden>Only Xteink X4 Pro is supported\./);
    expect(main).toContain("ui.deviceControls.hidden = !supported");
  });


  it("always shows a Version select before Install, even with one release (eink-ha-os#239)", () => {
    expect(html).toMatch(/<select id="version-select"><\/select>/);
    expect(at('id="version-select"')).toBeLessThan(at('id="install"'));
  });
});
