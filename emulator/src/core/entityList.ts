// The console's entity list (GET /api/v1/ha/entities, #150): which HA entities the display offers when a house has
// more than LIST_MAX of them. HA renders it (firmware net/ha_client.cpp kEntityListTemplate); this is the same rule in
// TypeScript for the fake HA and the device-sim. Sorting by entity_id and stopping at 800 dropped every switch.* and
// weather.* of a real house; now each domain gets a budget of pickable entities first (the budgets add up to
// LIST_MAX), then what is left over fills the rest: pickable ones past their budget, then the rest (unavailable /
// unknown, sensors without a unit, signal strength). `t` = how many HA has, so the console can say the list was cut.
import { statSource } from './format.ts';

export const LIST_MAX = 800;
/** Domain → budget of pickable entities, in list order. Sum = LIST_MAX. */
export const LIST_BUDGET: [string, number][] = [
  ['climate', 50], ['weather', 10], ['light', 100], ['switch', 100], ['input_boolean', 30], ['input_number', 30], ['fan', 20],
  ['binary_sensor', 60], ['number', 30], ['scene', 30], ['script', 30], ['sensor', 310],   // scene / script: #146
];
/** One row as the template sends it: [entity_id, name, unit, state, area_id ('' = none)]. */
export type ListRow = [string, string, string, string, string];
type St = { entity_id: string; state: string; attributes: Record<string, unknown> };

/** Unit and state the list shows: a climate's current temperature (weather: its temperature), else HA's state. */
export function listReading(e: St): { unit: string; state: string } {
  const gap = e.state === 'unavailable' || e.state === 'unknown';
  const r = gap ? undefined : statSource(e.entity_id, e.state, e.attributes);
  if (r?.state !== undefined) return { unit: r.unit, state: r.state };
  return { unit: e.attributes.unit_of_measurement == null ? '' : String(e.attributes.unit_of_measurement), state: String(e.state ?? '') };
}

/** Not worth a place unless there is room: no value, or a sensor that is no reading (no unit, or signal strength).
 *  A scene is "unknown" until it first runs (#146): only unavailable counts there. */
export function listLowValue(e: St): boolean {
  if (e.state === 'unavailable' || (e.state === 'unknown' && !e.entity_id.startsWith('scene.'))) return true;
  return e.entity_id.startsWith('sensor.') && (!e.attributes.unit_of_measurement || e.attributes.device_class === 'signal_strength');
}

/** The template's answer: {t: entities HA has in the list's domains, e: at most LIST_MAX rows}. */
export function entityListAnswer(states: Iterable<St>, areaOf: (id: string) => string): { t: number; e: ListRow[] } {
  const all = [...states];
  const a: ListRow[] = [], b: ListRow[] = [], c: ListRow[] = [];
  for (const [d, cap] of LIST_BUDGET) {
    let k = 0;
    for (const e of all.filter((x) => x.entity_id.split('.')[0] === d).sort((x, y) => (x.entity_id < y.entity_id ? -1 : 1))) {
      const r = listReading(e);
      const row: ListRow = [e.entity_id, String(e.attributes.friendly_name ?? e.entity_id), r.unit, r.state, areaOf(e.entity_id)];
      if (listLowValue(e)) c.push(row);
      else if (k >= cap) b.push(row);
      else { a.push(row); k++; }
    }
  }
  return { t: a.length + b.length + c.length, e: [...a, ...[...b, ...c].slice(0, LIST_MAX - a.length)] };
}
