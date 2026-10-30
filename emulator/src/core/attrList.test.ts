import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capList, listAgo, listError, listSpec, listView, LIST_MAX_BYTES } from './attrList.ts';
import { validateYaml } from './config.ts';
import { demoBirds } from './data.ts';
import { attrListVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'attr-list.json');
const tz = 60, now = Date.UTC(2026, 9, 28, 14, 30) - tz * 60_000;

describe('attrList (eink-ha-os#332)', () => {
  it('reads the bird shape by default', () => {
    const v = listView([{ species: 'Klapekster', place: 'Heideveld Oost', distance_km: 3.24, observed_at: '2026-10-28T12:25:00+01:00' }], listSpec({}), now, tz, 'en', 2);
    expect(v).toEqual({ rows: [{ title: 'Klapekster', sub: 'Heideveld Oost · 3.2 km', ago: '2 h ago' }], more: 0 });
  });
  it('reads the integration\'s display-ready fields first (eink-ha-os#375)', () => {
    const item = { title: '3× Kraanvogel ?', subtitle: 'Heidebos · 3,2 km', ts: Math.floor(now / 1000) - 7200, species: 'Kraanvogel ?', place: 'Heidebos', distance_km: 3.2, observed_at: '2020-01-01' };
    expect(listView([item], listSpec({}), now, tz, 'en', 2).rows).toEqual([{ title: '3× Kraanvogel ?', sub: 'Heidebos · 3,2 km', ago: '2 h ago' }]);
    expect(listView([item], listSpec({ title: 'species' }), now, tz, 'en', 2).rows[0].title).toBe('Kraanvogel ?');
    expect(listView([{ title: 'X' }], listSpec({ subtitle: 'subtitle', time: 'ts' }), now, tz, 'en', 2).rows).toEqual([{ title: 'X', sub: '', ago: '' }]);
  });
  it('the demo sensor has the integration\'s fields and fits the ingest cap', () => {
    const s = demoBirds(new Date(now)).attrs.sightings as Record<string, unknown>[];
    expect(s.every((b) => typeof b.title === 'string' && typeof b.subtitle === 'string' && Number.isInteger(b.ts))).toBe(true);
    expect((capList(s) as unknown[]).length).toBe(s.length);
  });
  it('says how long ago in both languages', () => {
    expect(listAgo('2026-10-28T14:05:00+01:00', now, tz, 'nl')).toBe('25 min geleden');
    expect(listAgo('2026-10-27', now, tz, 'nl')).toBe('gisteren');
    expect(listAgo('2026-10-29T10:00:00+01:00', now, tz, 'en')).toBe('');
  });
  it('checks the field names', () => {
    expect(listError({ attribute: 'sightings', subtitle: 'place distance_km' })).toBe('');
    expect(listError({ time: 'observed at' })).toMatch(/time must be a field name/);
    expect(validateYaml('version: 1\nscreens:\n  - id: a\n    widgets:\n      - {type: attrList, entity: sensor.rare_birds_nearby, cs: 2, rs: 2}\n').ok).toBe(true);
  });
  it('caps a long list at ingest', () => {
    const big = Array.from({ length: 30 }, (_, k) => ({ species: 'Soort ' + k, notes: 'x'.repeat(200) }));
    const kept = capList(big) as unknown[];
    expect(kept.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(LIST_MAX_BYTES);
  });
  it('the demo sensor fills a 2 × 2 tile', () => {
    const d = demoBirds(new Date(now));
    const v = listView(d.attrs.sightings, listSpec({}), now, -new Date(now).getTimezoneOffset(), 'nl', 6);
    expect(v.rows.length).toBe(6);
    expect(v.more).toBe(1);
    expect(d.attrs.attribution).toBe('Data: waarneming.nl / observation.org');
  });
  it('spec/test-vectors/attr-list.json is current (npm run vectors)', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(attrListVectors())));
  });
});
