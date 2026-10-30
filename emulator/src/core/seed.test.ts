import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedConfig, seedPlan, labelText, SEED_TEMPLATE } from './seed.ts';
import { toYaml, validateYaml, cellsUsed, MAX_CELLS } from './config.ts';
import { seedVectors, SEED_CASES } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'seed.json');

describe('first-run screens from HA (eink-ha-os#23, spec/test-vectors/seed.json)', () => {
  it('seed.json is in sync with the generator (npm run vectors)', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(seedVectors());
  });
  for (const [name, , snap] of SEED_CASES) it(name + ': valid screens.yaml, ≤ 8 cells, apps only with screens', () => {
    const cfg = seedConfig(snap);
    const r = validateYaml(toYaml(cfg));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(toYaml(r.config)).toBe(toYaml(cfg));
    for (const s of cfg.screens) expect(cellsUsed(s.widgets)).toBeLessThanOrEqual(MAX_CELLS);
    for (const a of cfg.apps) expect(cfg.screens.some((s) => s.app === a.id)).toBe(true);
    expect(cfg.screens.some((s) => s.app === 'settings'), 'Settings is built in (eink-ha-os#159)').toBe(false);
  });
  for (const [name, , snap] of SEED_CASES) it(name + ': every stat / gauge entity is a sensor from HA\'s answer (eink-ha-os#82)', () => {
    // route tiles may also sit on a mapped sensor.x4_route_* (live, eink-ha-os#145); Outside on a weather entity of the answer (eink-ha-os#152)
    const have = new Set([...(snap.sensors || []).map((s) => s[0]), ...(snap.live || []).filter((id) => id.startsWith('sensor.x4_route_')), ...(snap.weather || [])]);
    for (const s of seedConfig(snap, []).screens) for (const w of s.widgets) if (w.entity) expect(have.has(String(w.entity)), String(w.entity)).toBe(true);
  });
  for (const [name, , snap] of SEED_CASES) it(name + ': the seed report matches the screens it made (eink-ha-os#89)', () => {
    const { config, report } = seedPlan(snap, []);
    const ids = new Set(config.screens.flatMap((s) => s.widgets.map((w) => String(w.entity || ''))));
    const screens = new Set(config.screens.map((s) => s.id));
    expect(report.total).toBe(report.tiles.length);
    expect(report.filled).toBe(report.tiles.filter((t) => !t.why).length);
    for (const t of report.tiles) {
      expect(!!t.rule !== !!t.why, JSON.stringify(t)).toBe(true);
      if (t.entity && t.tile !== 'price' && t.entity !== 'sensor.home_battery_soc') expect(ids.has(t.entity), t.entity).toBe(true);   // the catalog gauge has no entity
      if (t.rule) expect(screens.has(t.screen), t.tile).toBe(true);
    }
  });
  it('labels lose the characters a flow map cannot hold', () => {
    expect(labelText(' Kids {1}: "east", #2 ')).toBe('Kids 1 east 2');
  });
  it('firmware sends the same seed template (core/seed.cpp seedTemplate())', () => {
    const cpp = readFileSync(join(import.meta.dirname, '..', '..', '..', 'firmware', 'src', 'core', 'seed.cpp'), 'utf8');
    const decl = /const char\* seedTemplate\(\) \{\n {2}return([\s\S]*?);\n/.exec(cpp);
    expect(decl).toBeTruthy();
    const text = [...decl![1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
    expect(text).toBe(SEED_TEMPLATE);
  });
  it('a stranger never gets the owner\'s routes, sensors or tado', () => {
    const y = seedVectors().cases.find((c) => c.name === 'stranger-house')!.yaml;
    expect(y).not.toMatch(/type: route|living_temperature|price_min|tado/);
  });
});
