import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// #42: the device console must work on a LAN without internet and must not call any other host (no font CDN).
// Allowed: XML namespace URIs and React's error-text URL (never fetched), and plain <a href> links to github.com.
const TEXT_ONLY = new Set(['www.w3.org', 'react.dev']);
function externalRefs(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)[^\s"'`)<>\\]*/gi)) {
    const host = m[1].toLowerCase(), at = m.index ?? 0;
    if (TEXT_ONLY.has(host)) continue;
    const before = text.slice(Math.max(0, at - 400), at);
    const link = /href[=:]\s*["'`]?$/.test(before) && !/<(?!a[\s>])[a-z][^<>]*$/i.test(before);
    if (host === 'github.com' && link) continue;
    bad.push(m[0]);
  }
  return bad;
}

const root = new URL('../../', import.meta.url);
const scan = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(html|js|css|svg|json|webmanifest)$/.test(f))
    .flatMap((f) => externalRefs(readFileSync(join(dir, f), 'utf8')).map((u) => f + ': ' + u));

describe('no external requests (#42)', () => {
  it('externalRefs flags resources on other hosts, not plain GitHub links', () => {
    expect(externalRefs('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">')).toHaveLength(1);
    expect(externalRefs('@font-face{src:url(https://fonts.gstatic.com/s/x.woff2)}')).toHaveLength(1);
    expect(externalRefs('<script src="https://github.com/x.js"></script>')).toHaveLength(1);
    expect(externalRefs('<link href="https://github.com/x.css">')).toHaveLength(1);
    expect(externalRefs('fetch("https://cdn.example.com/a")')).toHaveLength(1);
    expect(externalRefs('<a class="m" href="https://github.com/daangeijs/eink-ha-os">repo</a>')).toEqual([]);
    expect(externalRefs('n("a",{href:"https://github.com/daangeijs/eink-ha-os"})')).toEqual([]);
    expect(externalRefs('"http://"+host+"/" "http://www.w3.org/2000/svg"')).toEqual([]);
  });

  it('source pages load nothing from other hosts', () => {
    for (const f of ['index.html', 'device-ui/index.html']) expect(externalRefs(readFileSync(new URL(f, root), 'utf8')), f).toEqual([]);
  });

  it('built device console (www) loads nothing from other hosts', async () => {
    const out = mkdtempSync(join(tmpdir(), 'x4-device-ui-'));
    try {
      await build({ configFile: fileURLToPath(new URL('vite.device-ui.config.ts', root)), logLevel: 'silent', build: { outDir: out } });
      const files = readdirSync(out);
      expect(files.filter((f) => f.endsWith('.woff2'))).toHaveLength(5);
      expect(scan(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
