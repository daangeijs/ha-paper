import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agendaVectors } from '../../scripts/gen-vectors.ts';
import { agendaKey, agendaLines, cutTitle, demoAnswer, nextView, parseAnswer, MAX_EVENTS } from './agenda.ts';
import { validateYaml } from './config.ts';

const NOW = Date.UTC(2026, 9, 28, 6, 42);   // Wed 28 Oct 2026 07:42 CET
const KEY = 'calendar.family calendar.work';

describe('agenda tile (eink-ha-os#316)', () => {
  it('spec/test-vectors/agenda.json is in sync with the generator', () => {
    const disk = JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/agenda.json'), 'utf8'));
    expect(disk).toEqual(JSON.parse(JSON.stringify(agendaVectors())));
  });
  it('config: calendars required, 1–4, calendar.* only, at most 4 tiles', () => {
    const y = (w: string) => validateYaml('version: 1\nscreens:\n  - id: a\n    widgets:\n      - {' + w + '}\n');
    expect(y('type: agenda, entities: calendar.family, cs: 2, rs: 2').ok).toBe(true);
    expect(y('type: next, cs: 2')).toMatchObject({ ok: false, message: 'next: pick at least one calendar' });
    expect(y('type: agenda, entities: light.x')).toMatchObject({ ok: false, message: 'agenda: “light.x” is not a calendar entity' });
  });
  it('one fetch per calendar set', () => expect(agendaKey({ type: 'next', entities: 'calendar.work calendar.family' })).toBe(KEY));
  it('titles: at most 48 bytes, cut on a character boundary', () => {
    expect(cutTitle('é'.repeat(30))).toBe('é'.repeat(24));
    expect(new TextEncoder().encode(cutTitle('a'.repeat(47) + 'é')).length).toBe(47);
  });
  it('the demo week: today first, ended events gone, Next counts down', () => {
    const f = parseAnswer(demoAnswer(KEY, NOW, 60), KEY, NOW, 60)!;
    expect(f.events.length).toBe(MAX_EVENTS);
    const a = agendaLines(f, NOW, 60, 'en', 11);
    expect(a.lines[0]).toEqual({ day: 'Today · Wed 28' });
    expect(a.lines[1]).toMatchObject({ time: 'all day', title: 'Paper bin out' });
    expect(a.lines[2]).toMatchObject({ time: '08:30', title: 'Dentist' });
    expect(a.more).toBeGreaterThan(0);
    expect(nextView(f, NOW, 60, 'en')).toMatchObject({ title: 'Dentist', when: '08:30 – 09:15', pill: 'in 48 min', mins: 48 });
    expect(nextView(f, NOW + 60 * 60_000, 60, 'nl')).toMatchObject({ title: 'Dentist', pill: 'Nu' });
    expect(agendaLines(f, NOW, 60, 'nl', 4).lines[0]).toEqual({ day: 'Vandaag · wo 28' });
  });
});
