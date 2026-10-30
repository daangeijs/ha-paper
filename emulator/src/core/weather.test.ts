import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { weatherVectors } from '../../scripts/gen-vectors.ts';
import { validateYaml } from './config.ts';
import { DEMO_WEATHER_ATTRS, demoWeatherForecast, weatherView, wxEntries, wxIcon, wxMm, wxRain, wxWind, WX_ICONS } from './weather.ts';

const HOUR = 3_600_000;
describe('weather tile (eink-ha-os#318)', () => {
  it('vectors match the reference', () => {
    expect(JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/weather.json'), 'utf8'))).toEqual(weatherVectors());
  });
  it('maps every HA condition to one of 12 drawings', () => {
    expect(WX_ICONS).toHaveLength(12);
    expect(wxIcon('lightning-rainy')).toBe('thunder');
    expect(wxIcon('hail')).toBe('sleet');
    expect(wxIcon(42)).toBe('cloud');
  });
  it('wind in Beaufort or the HA unit, bearing on 8 points', () => {
    expect(wxWind({ wind_speed: 4.4, wind_speed_unit: 'Beaufort', wind_bearing: 200 }, 'en')).toBe('4 Bft S');
    expect(wxWind({ wind_speed: 14.6, wind_speed_unit: 'km/h', wind_bearing: 100 }, 'nl')).toBe('15 km/h O');
    expect(wxWind({}, 'en')).toBe('—');
  });
  it('rain from the first wet hour within 12 h', () => {
    const now = Date.UTC(2026, 9, 28, 10, 20);
    const h = (k: number, mm: number) => ({ t: Date.UTC(2026, 9, 28, 10 + k), icon: 'cloud' as const, temp: 10, low: null, mm });
    expect(wxRain([h(0, 0), h(3, 0.2)], now, 60, 'en')).toBe('from 14:00');
    expect(wxRain([h(0, 0.1)], now, 0, 'en')).toBe('now');
    expect(wxRain([h(13, 3)], now, 0, 'en')).toBe('none soon');
    expect(wxRain(null, now, 0, 'en')).toBe('—');
  });
  it('precipitation text', () => {
    expect(wxMm(0.04, 'mm', 'en')).toBe('dry');
    expect(wxMm(0.45, 'mm', 'en')).toBe('0.5 mm');
    expect(wxMm(7.6, 'mm', 'en')).toBe('8 mm');
    expect(wxMm(null, 'mm', 'en')).toBe('');
  });
  it('the demo forecast fills the tile', () => {
    const now = Date.UTC(2026, 9, 28, 10, 20);
    const v = weatherView({ state: 'partlycloudy', attrs: DEMO_WEATHER_ATTRS, daily: wxEntries(demoWeatherForecast('daily', now), 'daily', now, 60),
      hourly: wxEntries(demoWeatherForecast('hourly', now), 'hourly', now, 60), now, tz: 60, lang: 'en' });
    expect(v.days).toHaveLength(5);
    expect(v.rain).toBe('from 14:00');
    expect(v.wind).toBe('4 Bft SW');
    expect(wxEntries(demoWeatherForecast('hourly', now), 'hourly', now + 3 * HOUR, 60)[0].t).toBe(Date.UTC(2026, 9, 28, 13));
  });
  it('config: full width, at most 2', () => {
    const y = (ws: string[]) => '# HA Paper display config\nversion: 1\nscreens:\n  - id: a\n    widgets:\n' + ws.map((w) => '      - {' + w + '}\n').join('');
    expect(validateYaml(y(['type: weather, entity: weather.home, cs: 4, rs: 1'])).ok).toBe(true);
    expect(validateYaml(y(['type: weather, entity: weather.home, cs: 3']))).toMatchObject({ ok: false, message: 'weather: needs the full width (cs: 4)' });
  });
});
