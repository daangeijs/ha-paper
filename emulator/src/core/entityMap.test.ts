import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOGICAL, ROUTE_PREFIX, formatSource, isLogicalId, mergeEntities, parseSource, sourceKind, validEntityRef } from './entityMap.ts';

describe('logical ids (firmware core/entity_map.cpp)', () => {
  it('fixed ids = fixedLogical(); no route catalog (eink-ha-os#145)', () => {
    const cpp = readFileSync(new URL('../../../firmware/src/core/entity_map.cpp', import.meta.url), 'utf8');
    const consts = Object.fromEntries([...cpp.matchAll(/const char\* const (k\w+) = "([^"]+)";/g)].map((m) => [m[1], m[2]]));
    const body = /fixedLogical\(\) \{[^{]*\{([^}]*)\}/.exec(cpp)![1];
    const fixed = body.split(',').map((s) => consts[s.trim()]);
    expect(LOGICAL.map((l) => l.id)).toEqual(fixed);
    expect(LOGICAL.some((l) => l.id.startsWith(ROUTE_PREFIX))).toBe(false);
    expect(isLogicalId('sensor.x4_route_anything')).toBe(true);
    expect(isLogicalId('sensor.price_min')).toBe(false);
  });
  it('validEntityRef = validEntityId() in net/web_server.cpp', () => {
    for (const ok of ['sensor.a', '-sensor.inverter_battery_power', 'input_number.x1']) expect(validEntityRef(ok), ok).toBe(true);
    for (const bad of ['sensor', 'sensor.', '.x', '-.x', 'Sensor.x', 'sensor.a.b', 'sensor.a-b', '--sensor.a', 'not an id']) expect(validEntityRef(bad), bad).toBe(false);
  });
  it('mergeEntities: merges, removes on null / "", firmware 422 messages', () => {
    expect(mergeEntities({ 'sensor.solar_power': 'sensor.a' }, { 'sensor.grid_power': '-sensor.b' })).toEqual({ 'sensor.solar_power': 'sensor.a', 'sensor.grid_power': '-sensor.b' });
    expect(mergeEntities({ 'sensor.solar_power': 'sensor.a', 'sensor.grid_power': 'sensor.b' }, { 'sensor.solar_power': null, 'sensor.grid_power': '' })).toEqual({});
    expect(mergeEntities({}, [])).toBe('entities must be an object {logical id: HA entity id}');
    expect(mergeEntities({}, { 'sensor.nope': 'sensor.a' })).toBe('entities: unknown logical id sensor.nope');
    expect(mergeEntities({}, { 'sensor.solar_power': 5 })).toBe('entities: sensor.solar_power must name an HA entity like sensor.my_power');
  });
  it('entity_sources text round trip (HaClient::publishSources)', () => {
    for (const t of ['-sensor.batt (energy)', 'sensor.grid_in - sensor.grid_out (energy)', 'sensor.solar_power (identity)', 'sensor.x (override)'])
      expect(formatSource(parseSource(t)!)).toBe(t);
    expect(parseSource('')).toBeNull();
    expect(sourceKind(parseSource('sensor.x (override)')).label).toBe('Manual');
    expect(sourceKind(parseSource('sensor.x (device)')).auto).toBe(true);
    expect(sourceKind(null).label).toBe('None');
  });
});
