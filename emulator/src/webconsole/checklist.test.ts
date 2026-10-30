import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { tr, type StrKey } from '../core/strings.ts';
import { Emulator } from '../emulator/Emulator.tsx';
import { checklist, seedSplit, type CheckInput } from './checklist.ts';
import { useConsole } from './useConsole.ts';
import { FirstRunCard } from './pages/SeedReport.tsx';
import type { SeedReportView } from './DeviceApi.ts';

const en = (k: StrKey, ...a: (string | number)[]) => tr('en', k, ...a);
const nl = (k: StrKey, ...a: (string | number)[]) => tr('nl', k, ...a);
const base: CheckInput = { offline: false, filled: 9, total: 17, previewSeen: false };

// Module level: biome's noComponentHookFactories (2.6) rejects a component defined inside the test.
function FirstRunPage({ e, rep }: { e: Emulator; rep: SeedReportView }) {
  return createElement(FirstRunCard, { rep, v: { web: useConsole(e.api, e.snapshot() as any), osName: 'HA Paper' }, open: false, setOpen: () => {}, hide: () => {}, fix: () => {} });
}

describe('first-run checklist (eink-ha-os#91)', () => {
  it('four steps; done only when linked, seeded and the preview was opened', () => {
    const s = checklist(base, en);
    expect(s.map((x) => x.id)).toEqual(['linked', 'seeded', 'preview', 'done']);
    expect(s.map((x) => x.ok)).toEqual([true, true, false, false]);
    expect(s[1].text).toBe('9 of 17 tiles filled');
    expect(s.map((x) => x.fix?.to ?? null)).toEqual([null, 'missing', 'values', null]);
    expect(s[3]).toMatchObject({ ok: false, text: 'All set' });   // the card hides it until it is done (eink-ha-os#184)
    const done = checklist({ ...base, previewSeen: true }, en);
    expect(done[3]).toMatchObject({ ok: true, text: 'All set' });
  });
  it('HA unreachable → step 1 open with a fix into the Device tab; nothing filled → step 2 open', () => {
    const s = checklist({ ...base, offline: true, filled: 0, previewSeen: true }, en);
    expect(s[0]).toMatchObject({ ok: false, text: 'Linked, but Home Assistant can’t be reached', fix: { to: 'device', label: 'Check the link' } });
    expect(s[1].ok).toBe(false);
    expect(s[3].ok).toBe(false);
  });
  it('all tiles filled → no "see what is missing" link', () => {
    expect(checklist({ ...base, filled: 17 }, en)[1].fix).toBeNull();
  });
  it('Dutch', () => {
    const s = checklist(base, nl);
    expect(s[1].text).toBe('9 van 17 tegels gevuld');
    expect(s[2].fix?.label).toBe('Toon waarden');
  });
  it('card renders the steps above the seed report', () => {
    const e = new Emulator({});
    (e as any).state = { ...e.state, mode: 'main', setup: null, offline: false, ha: { ...e.state.ha, linked: true }, session: { signedIn: true, user: 'u', admin: true } };
    const rep: SeedReportView = { filled: 1, total: 2, dismissed: false, tiles: [{ tile: 'price', screen: 'energy', rule: 'energy' }, { tile: 'lights', screen: 'lights', why: 'none' }] };
    const h = renderToString(createElement(FirstRunPage, { e, rep }));
    for (const t of ['Getting started', 'Linked to Home Assistant', '1 tile filled', 'Show values', 'Not found in your Home Assistant, so left out: lights.']) expect(h).toContain(t);
    for (const t of ['See what’s missing', 'All set', '<summary']) expect(h).not.toContain(t);   // nothing to pick; done not yet
  });
  it('eink-ha-os#184: counts only tiles the house can fill; what it lacks is one "left out" line', () => {
    const tiles = [
      { tile: 'home_power', screen: 'overview', entity: 'sensor.p1', rule: 'grid' as const },
      { tile: 'inside', screen: 'overview', why: 'no_sensor' as const },
      { tile: 'outside', screen: 'overview', why: 'overview_full' as const },
      { tile: 'solar_power', screen: 'energy', why: 'no_sensor' as const },
      { tile: 'solar_chart', screen: 'energy', why: 'no_meter' as const },
      { tile: 'battery_soc', screen: 'energy', why: 'no_sensor' as const },
      { tile: 'price', screen: 'energy', why: 'no_meter' as const },
    ];
    const s = seedSplit(tiles);
    expect(s).toMatchObject({ filled: 1, total: 3, leftOut: ['optSolar', 'optBattery', 'optPrice'] });
    expect(s.pickable.map((x) => x.tile)).toEqual(['inside', 'outside']);
    expect(checklist({ ...base, filled: 1, total: 3 }, en)[1].text).toBe('1 of 3 tiles filled');
    expect(checklist({ ...base, filled: 7, total: 7 }, en)[1]).toMatchObject({ ok: true, text: '7 tiles filled', fix: null });
    expect(nl('clLeftOut', ['optSolar', 'optBattery', 'optPrice'].map((k) => nl(k as StrKey)).join(', '))).toBe('Niet gevonden in je Home Assistant, dus weggelaten: zonnepanelen, thuisbatterij, energieprijzen.');
  });
});
