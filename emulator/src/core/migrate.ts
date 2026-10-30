// Schema versions + migrations of persisted state (issue eink-ha-os#12). Behaviour spec for firmware/src/core/migrate.{h,cpp};
// vectors spec/test-vectors/migrations/*.json. Map of what is versioned: firmware/src/net/storage.h.
//
// Rules for every step (crosspoint PersistableStore idea, stricter):
//  * upgrade one version at a time (step n: n → n+1), in place, never down;
//  * keep keys the step does not own: a newer firmware may have written them before an OTA rollback;
//  * never change the meaning of an existing key, move the value to a new key instead: firmware from before the step
//    can still write the old key after a rollback;
//  * newer or unreadable schema: read what you can, don't write at boot (status newer/unknown/invalid).

import { quietFromNight } from './quiet.ts';

/** userdata /settings.json `schema`. 0 = file from before versioning (no key). */
export const SETTINGS_SCHEMA = 2;
/** NVS x4dev/schema, one number for x4wifi, x4ha, x4tok, x4dev and x4ota. 0 = no key. */
export const DEVICE_SCHEMA = 1;

export type MigrateStatus = 'current' | 'upgrade' | 'newer' | 'unknown' | 'invalid';
type Obj = Record<string, unknown>;

const SETTINGS_STEPS: ((d: Obj) => void)[] = [
  () => {},   // 0 → 1: files from before versioning, same shape; only stamped
  // 1 → 2 (eink-ha-os#295): quiet hours. New key `quiet` from `night` (kept for a rollback); "Sleep at night" becomes glance.
  (d) => {
    if (!('quiet' in d)) d.quiet = quietFromNight(d.night);
    if (d.powerSave === 'night') d.powerSave = 'glance';
  },
];

export const schemaStatus = (stored: number, current: number): MigrateStatus => (stored < 0 ? 'unknown' : stored === current ? 'current' : stored < current ? 'upgrade' : 'newer');

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `schema` of a stored object: missing = 0; not a non-negative integer = -1 (unknown). */
export function schemaOf(doc: Obj): number {
  if (!('schema' in doc)) return 0;
  const s = doc.schema;
  return typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= 1e6 ? s : -1;
}

/** Sets `schema` where it is, or as the first key. */
function withSchema(doc: Obj, v: number): Obj {
  if ('schema' in doc) { doc.schema = v; return doc; }
  return { schema: v, ...doc };
}

export type Migrated = { status: MigrateStatus; from: number; version: number; doc: Obj | null };

/** Upgrades a parsed settings object to SETTINGS_SCHEMA. `doc` is the object to write back only for status 'upgrade'. */
export function migrate(doc: unknown, from: number = isObj(doc) ? schemaOf(doc) : -1): Migrated {
  if (!isObj(doc)) return { status: 'invalid', from: -1, version: -1, doc: null };
  const status = schemaStatus(from, SETTINGS_SCHEMA);
  if (status !== 'upgrade') return { status, from, version: from, doc };
  let d = structuredClone(doc);
  for (let v = from; v < SETTINGS_SCHEMA; v++) SETTINGS_STEPS[v](d);
  d = withSchema(d, SETTINGS_SCHEMA);
  return { status, from, version: SETTINGS_SCHEMA, doc: d };
}

/** /settings.json text → migrate(). Unparseable text is 'invalid'. */
export function migrateSettings(text: string): Migrated {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { status: 'invalid', from: -1, version: -1, doc: null }; }
  return migrate(doc);
}

/** What to write on a settings save: the stored object (upgraded if older) with the known keys replaced. Unknown keys
 * stay; a newer `schema` stays (no downgrade); missing, older or unreadable becomes SETTINGS_SCHEMA. */
export function persistSettings(stored: string | null, known: Obj): Obj {
  const m = stored == null ? null : migrateSettings(stored);
  let d: Obj = m?.doc ? structuredClone(m.doc) : {};
  if (!(m && m.status === 'newer')) d = withSchema(d, SETTINGS_SCHEMA);
  for (const [k, v] of Object.entries(known)) d[k] = v;
  return d;
}
