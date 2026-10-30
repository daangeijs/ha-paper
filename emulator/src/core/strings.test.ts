import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringsVectors, stringsHeader, STRINGS_HEADER } from '../../scripts/gen-vectors.ts';
import { STRINGS, consoleLang, dateLine, langOf, tr, trMsg, trParts, type StrKey } from './strings.ts';
import { ENT, SETTINGS, type Derived } from './data.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'strings.json');

describe('UI strings (spec/test-vectors/strings.json, eink-ha-os#98)', () => {
  it('generator output matches the vectors and the firmware header on disk (run `npm run vectors` after changing strings.ts)', () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(stringsVectors())));
    expect(readFileSync(STRINGS_HEADER, 'utf8')).toBe(stringsHeader());
  });
  it('every key has both languages and the same placeholders', () => {
    for (const [k, [en, nl]] of Object.entries(STRINGS)) {
      expect(en.length, k).toBeGreaterThan(0);
      expect(nl.length, k).toBeGreaterThan(0);
      expect(nl.split('{}').length, k).toBe(en.split('{}').length);
    }
  });
  it('display texts stay inside the firmware font charset (ASCII, Latin-1, a few marks)', () => {
    const extra = '‹›–—·°€•→←↑↓✓…’‘“”×▾−';
    for (const [k, pair] of Object.entries(STRINGS)) for (const s of pair) for (const c of s) {
      const n = c.charCodeAt(0);
      expect((n >= 0x20 && n < 0x7f) || (n >= 0xa0 && n < 0x100) || extra.includes(c), k + ': ' + c).toBe(true);
    }
  });
  it('Dutch for nl variants, English for everything else', () => {
    expect(['nl', 'nl-NL', 'nl_BE', 'NL'].map(langOf)).toEqual(['nl', 'nl', 'nl', 'nl']);
    expect(['en', 'de', 'fr', '', null, undefined, 'nld'].map(langOf)).toEqual(['en', 'en', 'en', 'en', 'en', 'en', 'en']);
  });
  it('fills placeholders in order and builds the clock line', () => {
    expect(tr('nl', 'standbyFoot', '07:45')).toBe('Stand-by · bijgewerkt 07:45 · druk op aan/uit');
    expect(tr('en', 'cheapestAt')).toBe('Cheapest {}');
    expect(tr('nl', 'haOffline')).toBe('Geen verbinding met Home Assistant');
    expect(dateLine('en', 2, 13, 9)).toBe('Tuesday 13 October');
    expect(dateLine('nl', 2, 13, 9)).toBe('Dinsdag 13 oktober');
    expect(Object.keys(STRINGS).filter((k) => /^(day|month)\d+$/.test(k)).length).toBe(19);
    expect(tr('en', 'updated' as StrKey)).toBe('Updated');
  });
  it('English messages from the device API and the editor read in Dutch (eink-ha-os#111)', () => {
    expect(trMsg('nl', 'Pick a network')).toBe('Kies een netwerk');
    expect(trMsg('nl', 'Already up to date (0.4.0)')).toBe('Al up-to-date (0.4.0)');
    expect(trMsg('nl', 'Connect the display to your Wi-Fi first, then continue at http://ha-paper.local')).toBe('Verbind het scherm eerst met je wifi en ga dan verder op http://ha-paper.local');
    expect(trMsg('nl', 'Solar power')).toBe('Zonnevermogen');
    expect(trMsg('nl', 'something new from a newer firmware')).toBe('something new from a newer firmware');
    expect(trMsg('en', 'Pick a network')).toBe('Pick a network');
  });
  it('settings values and our stat tiles follow the language (eink-ha-os#111)', () => {
    expect(SETTINGS.returnHome.fmt(5, 'nl')).toBe('na 5 min');
    expect(SETTINGS.returnHome.fmt(0)).toBe('Never');
    expect(SETTINGS.powerSave.fmt('glance', 'nl')).toBe('Oogopslag');
    expect(tr('nl', SETTINGS.brightness.lk)).toBe('Verlichting');
    expect(SETTINGS.brightness.label).toBe('Front light');
    expect(ENT['sensor.solar_power'].get({ solar: 0 } as Derived, 'nl').sub).toBe('Geen zon');
    expect(ENT['sensor.home_power'].label).toBe('Home use');
  });
  it('console: HA language while linked, else the browser language', () => {
    expect(consoleLang({ ha: { linked: true }, language: 'nl' }, 'en-US')).toBe('nl');
    expect(consoleLang({ ha: { linked: false }, language: null }, 'nl-NL')).toBe('nl');
    expect(consoleLang({ ha: { linked: true }, language: null }, 'de-DE')).toBe('en');
    expect(consoleLang(null, 'nl')).toBe('nl');
    expect(trParts('nl', 'haFound')).toEqual(['', ' gevonden op je netwerk']);
  });
});
