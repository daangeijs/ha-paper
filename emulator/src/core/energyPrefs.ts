// HA energy/get_prefs sources → meters, price and power entities. Firmware: gridFlows() / EntityAdapter::setEnergyPrefs
// in core/entity_map.cpp; vectors: spec/test-vectors/energy-prefs.json.

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** stat_rate | power[0].stat_rate | power_config.stat_rate (one entity, HA's sign). */
export function rateOf(s: Record<string, any>): string {
  if (str(s.stat_rate)) return s.stat_rate;
  if (Array.isArray(s.power)) for (const p of s.power) if (str(p?.stat_rate)) return p.stat_rate;
  return obj(s.power_config) ? str(s.power_config.stat_rate) : '';
}

/** Import / export meters and price entities of one grid source (#274), both shapes: legacy flow_from[] / flow_to[]
 * (stat_energy_from / stat_energy_to, entity_energy_price) and HA 2025.12+ flat stat_energy_from / stat_energy_to /
 * entity_energy_price / entity_energy_price_export. Legacy first; a meter listed in both counts once; first price wins. */
export type GridFlows = { import: string[]; export: string[]; price: string; priceExport: string };
export function gridFlows(s: unknown): GridFlows {
  const g: GridFlows = { import: [], export: [], price: '', priceExport: '' };
  if (!obj(s)) return g;
  const add = (l: string[], m: unknown) => { if (str(m) && !l.includes(m as string)) l.push(m as string); };
  for (const f of Array.isArray(s.flow_from) ? s.flow_from : []) {
    if (!obj(f)) continue;
    add(g.import, f.stat_energy_from);
    if (!g.price) g.price = str(f.entity_energy_price);
  }
  for (const f of Array.isArray(s.flow_to) ? s.flow_to : []) {
    if (!obj(f)) continue;
    add(g.export, f.stat_energy_to);
    if (!g.priceExport) g.priceExport = str(f.entity_energy_price);
  }
  add(g.import, s.stat_energy_from);
  add(g.export, s.stat_energy_to);
  if (!g.price) g.price = str(s.entity_energy_price);
  if (!g.priceExport) g.priceExport = str(s.entity_energy_price_export);
  return g;
}

/** = EntityAdapter::statisticIds() after setEnergyPrefs: solar, import, export, battery out, battery in meters, once each. */
export function statisticIds(prefs: unknown): string[] {
  const m = { solar: [] as string[], imp: [] as string[], exp: [] as string[], out: [] as string[], in: [] as string[] };
  const srcs = obj(prefs) && Array.isArray(prefs.energy_sources) ? prefs.energy_sources : [];
  for (const s of srcs) {
    if (!obj(s)) continue;
    if (s.type === 'solar' && str(s.stat_energy_from)) m.solar.push(s.stat_energy_from);
    else if (s.type === 'battery') { if (str(s.stat_energy_from)) m.out.push(s.stat_energy_from); if (str(s.stat_energy_to)) m.in.push(s.stat_energy_to); }
    else if (s.type === 'grid') { const g = gridFlows(s); m.imp.push(...g.import); m.exp.push(...g.export); }
  }
  const ids: string[] = [];
  for (const l of [m.solar, m.imp, m.exp, m.out, m.in]) for (const id of l) if (!ids.includes(id)) ids.push(id);
  return ids;
}
