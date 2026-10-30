import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binDays, binLabels, binsView } from './bins.ts';
import { validateYaml } from './config.ts';
import { binsVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'bins.json');
const at = (d: number, h: number, m: number, tz = 60) => Date.UTC(2026, 9, d, h, m) - tz * 60_000;

describe('bins (eink-ha-os#317)', () => {
  it('reads both state shapes and the attributes', () => {
    const now = at(28, 19, 5);
    expect(binDays('2026-10-29', {}, now, 60)).toBe(1);
    expect(binDays('29-10-2026', {}, now, 60)).toBe(1);
    expect(binDays('4', {}, now, 60)).toBe(4);
    expect(binDays('Paper in 2 days', { daysTo: 2 }, now, 60)).toBe(2);
    expect(binDays('x', { upcoming: ['2026-10-01', { date: '2026-11-01' }] }, now, 60)).toBe(4);
    expect(binDays('2026-10-01', {}, now, 60)).toBeNull();
    expect(binDays('unavailable', { daysTo: 1 }, now, 60)).toBeNull();
  });
  it('says "put out tonight" from the set hour the day before', () => {
    const bins = [{ label: 'Paper', state: '2026-10-29', attrs: {} }, { label: 'Plastic', state: '6', attrs: {} }];
    const before = binsView(bins, at(28, 16, 59), 60, 17, 'en');
    expect([before.big, before.line, before.pill]).toEqual(['Tomorrow', 'Tomorrow · Thursday 29', '']);
    const after = binsView(bins, at(28, 17, 0), 60, 17, 'en');
    expect([after.head, after.line, after.foot, after.pill, after.tonight]).toEqual(['Paper', 'Thursday 29 · put out tonight', 'Put out tonight', 'Tonight', true]);
    expect(after.rest.map((r) => r.label + ' ' + r.short)).toEqual(['Plastic Tue 3']);
    const nl = binsView(bins, at(28, 17, 0), 60, 17, 'nl');
    expect([nl.line, nl.rest[0].short]).toEqual(['Donderdag 29 · vanavond buiten zetten', 'di 3']);
    const day = binsView(bins, at(29, 7, 0), 60, 17, 'en');
    expect([day.big, day.pill]).toEqual(['Today', 'Today']);
  });
  it('labels: the tile’s own name, else HA’s, else the id', () => {
    expect(binLabels(['sensor.a', 'sensor.b', 'sensor.c'], [['sensor.a', 'Paper']], (id) => (id === 'sensor.b' ? 'Afval PMD' : undefined))).toEqual(['Paper', 'Afval PMD', 'sensor.c']);
  });
  it('config rules', () => {
    const y = (w: string) => validateYaml('version: 1\nscreens:\n  - id: a\n    widgets:\n      - {' + w + '}\n');
    expect(y('type: bins, entities: sensor.a sensor.b, labels: sensor.a=Paper; sensor.b=Plastic, tonight: 18, cs: 2').ok).toBe(true);
    expect(y('type: bins, tonight: 17:00')).toMatchObject({ ok: false, message: 'bins: tonight must be an hour 0–23' });
    expect(y('type: bins, entities: binary_sensor.x')).toMatchObject({ ok: false, message: 'bins: “binary_sensor.x” is not a sensor entity' });
    expect(y('type: bins, labels: sensor.a')).toMatchObject({ ok: false, message: 'bins: “sensor.a” in labels is not sensor.<id>=Name' });
  });
  it('spec/test-vectors/bins.json is current', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(binsVectors())));
  });
});
