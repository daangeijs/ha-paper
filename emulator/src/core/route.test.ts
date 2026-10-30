import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoMs, routeDepartures } from './route.ts';
import { routeVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'route-departures.json');

describe('route departures (eink-ha-os#275)', () => {
  it('the NS upcoming list as HA sends it (a real list)', () => {
    const upcoming = [
      { planned: '2026-09-29T07:55:00+02:00', actual: '2026-09-29T08:01:00+02:00', delay: 6, track: '5', direction: 'Harbour', train: 'IC 1234', status: 'delayed', message: null },
      { planned: '2026-09-29T08:25:00+02:00', actual: '2026-09-29T08:25:00+02:00', delay: 0, track: '7', direction: 'Central', train: 'SPR 42', status: 'cancelled', message: 'No trains' },
    ];
    expect(routeDepartures({ upcoming }, 120, 'en')).toEqual([
      { time: '08:01', delay: 6, cancelled: false, info: 'Track 5 · Harbour' },
      { time: '08:25', delay: 0, cancelled: true, info: 'Track 7 · Central' },
    ]);
  });
  it('ISO offsets: +HH:MM, +HHMM, Z, none = local; garbage = NaN', () => {
    expect(isoMs('2026-09-29T07:55:00+02:00', 0)).toBe(Date.UTC(2026, 8, 29, 5, 55));
    expect(isoMs('2026-09-29T07:55:00+0200', 0)).toBe(Date.UTC(2026, 8, 29, 5, 55));
    expect(isoMs('2026-09-29T05:55:00Z', 60)).toBe(Date.UTC(2026, 8, 29, 5, 55));
    expect(isoMs('2026-09-29 07:55', 120)).toBe(Date.UTC(2026, 8, 29, 5, 55));
    expect(isoMs('soon', 0)).toBeNaN();
    expect(isoMs('2026-09-29T07:55:00 later', 0)).toBeNaN();
  });
  it('spec/test-vectors/route-departures.json is current', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(routeVectors())));
  });
});
