import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sevOf, routeLevel, carEta, carLevel, badge } from './severity.ts';
import { severityVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'severity.json');

describe('travel severity (SPEC §6)', () => {
  it('per-departure thresholds', () => {
    expect([0, 1.9, 2, 4.9, 5, 15, 15.1].map((d) => sevOf(d, false))).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect(sevOf(0, true)).toBe(4);
  });
  it('route = worst of the next two departures only', () => {
    expect(routeLevel([{ delay: 0, cancelled: false }, { delay: 0, cancelled: false }, { delay: 60, cancelled: false }])).toBe(1);
    expect(routeLevel([{ delay: 0, cancelled: true }, { delay: 0, cancelled: false }])).toBe(4);
    expect(routeLevel([])).toBe(1);
  });
  it('car ETA from level and back', () => {
    expect([1, 2, 3, 4].map((l) => carEta(21, l))).toEqual([21, 24, 29, 37]);
    expect(carLevel(37, 21)).toBe(4);
  });
  it('red (4) badge is inverted', () => {
    expect(badge(4, false).bg).toBe('#D32F2F'); expect(badge(4, false).fg).toBe('#fff'); expect(badge(2, true).word).toBe('Busy');
  });
  it('severity.json is in sync', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(severityVectors());
  });
});
