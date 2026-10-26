// Logical entity ids (firmware core/entities.h) and the settings `entities` overrides (firmware core/entity_map.h,
// PUT /api/v1/settings in net/web_server.cpp). Shared by the device simulator, the emulator and the web console's
// tile source in the screen editor (#191).
export const ROUTE_PREFIX = 'sensor.x4_route_';

export type LogicalGroup = 'Energy now' | 'Energy today' | 'House';
/** `flip`: a power value where HA's sign convention may be the opposite of the UI's (+ = charging / importing). */
export type LogicalDef = { id: string; label: string; group: LogicalGroup; unit: string; flip?: boolean; hint?: string };

/** = fixedLogical() in firmware core/entity_map.cpp, in the same order. Routes are user tiles with their own entity (#145). */
export const LOGICAL: LogicalDef[] = [
  { id: 'sensor.solar_power', label: 'Solar power', group: 'Energy now', unit: 'W', flip: true, hint: '+ = producing' },
  { id: 'sensor.grid_power', label: 'Grid power', group: 'Energy now', unit: 'W', flip: true, hint: '+ = importing, − = exporting' },
  { id: 'sensor.battery_power', label: 'Battery power', group: 'Energy now', unit: 'W', flip: true, hint: '+ = charging, − = discharging (HA’s Energy dashboard uses the opposite)' },
  { id: 'sensor.home_power', label: 'Home use', group: 'Energy now', unit: 'W', flip: true, hint: '+ = using' },
  { id: 'sensor.home_battery_soc', label: 'Home battery charge', group: 'Energy now', unit: '%' },
  { id: 'sensor.energy_prices', label: 'Electricity prices', group: 'Energy now', unit: '€/kWh', hint: 'Needs hourly prices in its attributes (Nord Pool, Tibber, EnergyZero, ENTSO-e …)' },
  { id: 'sensor.solar_today', label: 'Solar today', group: 'Energy today', unit: 'kWh' },
  { id: 'sensor.grid_import_today', label: 'Imported today', group: 'Energy today', unit: 'kWh' },
  { id: 'sensor.grid_export_today', label: 'Exported today', group: 'Energy today', unit: 'kWh' },
  { id: 'sensor.energy_today', label: 'Used today', group: 'Energy today', unit: 'kWh' },
  { id: 'sensor.energy_usage_hourly', label: 'Hourly use', group: 'Energy today', unit: 'kWh', hint: 'attribute today = 24 hourly values' },
  { id: 'sensor.solar_hourly', label: 'Hourly solar', group: 'Energy today', unit: 'kWh', hint: 'attribute today = 24 hourly values' },
  { id: 'sensor.living_temperature', label: 'Inside temperature', group: 'House', unit: '°C', hint: 'No Home Assistant convention: map it to a room sensor' },
];
export const LOGICAL_GROUPS: LogicalGroup[] = ['Energy now', 'Energy today', 'House'];

const FIXED = new Set(LOGICAL.map((l) => l.id));
/** = EntityAdapter::isLogicalId: a fixed id or any sensor.x4_route_* (older configs mapped routes here; still accepted). */
export const isLogicalId = (id: string): boolean => FIXED.has(id) || id.startsWith(ROUTE_PREFIX);

/** = validEntityId() in firmware net/web_server.cpp: optional leading "-", domain.object_id, [a-z0-9_]. */
export function validEntityRef(v: string): boolean {
  const i = v.startsWith('-') ? 1 : 0; const dot = v.indexOf('.', i);
  if (dot < 0 || dot === i || dot + 1 >= v.length) return false;
  for (let k = i; k < v.length; k++) { const c = v[k]; if (!(/[a-z0-9_]/.test(c) || (c === '.' && k === dot))) return false; }
  return true;
}

export type EntityOverrides = Record<string, string>;
/** PUT /settings `entities` merge: null or "" removes. Error messages = firmware putSettings(). */
export function mergeEntities(cur: EntityOverrides, patch: unknown): EntityOverrides | string {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'entities must be an object {logical id: HA entity id}';
  const o = { ...cur };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!isLogicalId(k)) return 'entities: unknown logical id ' + k;
    if (v === null || v === '') { delete o[k]; continue; }
    if (typeof v !== 'string' || !validEntityRef(v)) return 'entities: ' + k + ' must name an HA entity like sensor.my_power';
    o[k] = v;
  }
  return o;
}

export type SourceWhy = 'override' | 'energy' | 'device' | 'identity';
export type Source = { ha: string; minus: string; negate: boolean; why: SourceWhy | string };
/** One `entity_sources` value as HaClient::publishSources() writes it: "[-]ha[ - minus] (why)". */
export const formatSource = (s: Source): string => (s.negate ? '-' : '') + s.ha + (s.minus ? ' - ' + s.minus : '') + ' (' + s.why + ')';
export function parseSource(text: string): Source | null {
  const m = /^(-?)(\S+?)(?: - (\S+))? \(([a-z]+)\)$/.exec(text || '');
  return m ? { negate: m[1] === '-', ha: m[2], minus: m[3] || '', why: m[4] } : null;
}
/** Console wording for where a value comes from. */
export function sourceKind(s: Source | null): { label: string; auto: boolean } {
  if (!s) return { label: 'None', auto: false };
  if (s.why === 'override') return { label: 'Manual', auto: false };
  if (s.why === 'energy') return { label: 'Energy dashboard', auto: true };
  if (s.why === 'device') return { label: 'Energy dashboard device', auto: true };
  if (s.why === 'identity') return { label: 'Same id in HA', auto: true };
  return { label: s.why, auto: true };
}
/** An override value → entity + sign. */
export const splitRef = (v: string): { ha: string; negate: boolean } => (v.startsWith('-') ? { ha: v.slice(1), negate: true } : { ha: v, negate: false });
