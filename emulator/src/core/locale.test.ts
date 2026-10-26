import { describe, it, expect } from 'vitest';
import { TZ_TABLE, currencySymbol, ianaToPosix, money, tzFor, validPosixTz, validTzSetting } from './locale.ts';
import { settingsPages, settingsPutError } from './settings.ts';

describe('time zone from Home Assistant (#147)', () => {
  it('every table entry is a valid newlib POSIX TZ, names unique', () => {
    for (const [n, p] of TZ_TABLE) expect(validPosixTz(p), n + ' ' + p).toBe(true);
    expect(new Set(TZ_TABLE.map(([n]) => n)).size).toBe(TZ_TABLE.length);
  });
  it('override wins, else HA, unknown = keep (null)', () => {
    expect(tzFor('', 'Europe/Berlin')).toBe('CET-1CEST,M3.5.0,M10.5.0/3');
    expect(tzFor('Europe/London', 'Europe/Berlin')).toBe('GMT0BST,M3.5.0/1,M10.5.0');
    expect(tzFor('UTC0', 'Europe/Berlin')).toBe('UTC0');
    expect(tzFor('', 'Mars/Olympus')).toBeNull();
    expect(ianaToPosix('US/Pacific')).toBe('PST8PDT,M3.2.0,M11.1.0');
  });
  it('PUT tz takes "", a known zone or POSIX', () => {
    expect(['', 'Europe/Amsterdam', 'CET-1CEST,M3.5.0,M10.5.0/3'].every(validTzSetting)).toBe(true);
    expect(settingsPutError({ tz: 'Mars/Olympus' })).toMatch(/^tz must be/);
  });
  it('the console offers tz under Home Assistant', () => {
    expect(settingsPages().find((p) => p.id === 'ha')?.fields.map((f) => f.key)).toContain('tz');
  });
});

describe('currency from Home Assistant (#147)', () => {
  it('symbols and prices', () => {
    expect([currencySymbol('EUR'), currencySymbol('USD'), currencySymbol('GBP'), currencySymbol('SEK'), currencySymbol(null)]).toEqual(['€', '$', '£', 'SEK', '€']);
    expect(money(0.234, '€')).toBe('€0.23');
    expect(money(0.31, 'SEK')).toBe('SEK 0.31');
  });
});
