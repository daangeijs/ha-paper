// Tile source in the screen editor (#191; replaces the Data sources tab, #24). A tile reads either its own HA entity
// (`entity`, picked in the editor, saved with Push) or a logical id (core/entityMap.ts) that the display maps to an HA
// entity: auto from the Energy dashboard, or an override saved right away with PUT /settings `entities`.
// Logical ids stay hidden: the editor shows the HA entity, where it comes from, and which other tiles share it.
import { BARS_SERIES, GAUGE_DEFAULT_ENTITY, type Config, type Widget } from '../core/config.ts';
import { LOGICAL, ROUTE_PREFIX, isLogicalId, parseSource, splitRef, validEntityRef, type LogicalDef, type Source } from '../core/entityMap.ts';
import type { HaEntity } from '../core/data.ts';
import { entityGap } from '../core/format.ts';
import type { DeviceSettings, SettingsPatch } from '../core/settings.ts';
import type { StrKey } from '../core/strings.ts';
import { entitiesFor, entityValue } from './configEdit.ts';

const SERIES_ID: Record<string, string> = { prices: 'sensor.energy_prices', usage: 'sensor.energy_usage_hourly', solar: 'sensor.solar_hourly' };

/** The logical id a tile reads (= what the firmware subscribes for it), or null: the tile has its own HA entity. */
export function tileLogical(w: Widget): string | null {
  if (w.type === 'price') return 'sensor.energy_prices';
  if (w.type === 'bars') return SERIES_ID[BARS_SERIES.includes(String(w.series)) ? String(w.series) : 'usage'];
  if (w.type === 'gauge' && !w.entity) return GAUGE_DEFAULT_ENTITY;
  const e = typeof w.entity === 'string' ? w.entity : '';
  return e && isLogicalId(e) && !e.startsWith(ROUTE_PREFIX) ? e : null;
}

/** Other tiles in the config that read the same logical id as tile `tile` of screen `screen`. */
export function sharedWith(cfg: Config, screen: number, tile: number): { screen: number; tile: number }[] {
  const w = cfg.screens[screen]?.widgets[tile]; const id = w ? tileLogical(w) : null;
  if (!id) return [];
  const out: { screen: number; tile: number }[] = [];
  cfg.screens.forEach((sc, i) => sc.widgets.forEach((x, j) => { if ((i !== screen || j !== tile) && tileLogical(x) === id) out.push({ screen: i, tile: j }); }));
  return out;
}

/** Where a logical id's entity comes from, as the source line says it. */
export const fromKey = (s: Source | null): StrKey => (!s ? 'srcFromNone' : s.why === 'override' ? 'srcByYou' : s.why === 'identity' ? 'srcSameId' : 'srcFromEnergy');
/** PUT /settings body for one logical id: an HA entity ("-" = flipped sign), or null = automatic again. */
export const sourcePatch = (id: string, ha: string | null, flip = false): SettingsPatch => ({ entities: { [id]: ha === null ? null : (flip ? '-' : '') + ha } });

type T = (k: StrKey, ...a: (string | number)[]) => string;
/** "A", "A and B", "A, B and C". */
export const joinNames = (t: T, names: string[]): string => (names.length < 2 ? names.join('') : t('listAnd', names.slice(0, -1).join(', '), names[names.length - 1]));
/** The amber line under a shared source ('' when not shared). */
export const sharedLine = (t: T, names: string[]): string => (!names.length ? '' : names.length === 1 ? t('srcShared1', names[0]) : t('srcSharedN', names.length, joinNames(t, names)));
/** "Now 1 840 W" from HA's entity list, '' when the list does not have it. */
export function nowLine(t: T, tm: (s: string) => string, list: HaEntity[], ha: string): string {
  const en = list.find((e) => e.id === ha); if (!en) return '';
  const g = entityGap(en.state);
  return t('srcNowVal', g ? t(g === 'unavailable' ? 'gapUnavailable' : 'gapUnknown') : tm(entityValue(en)));
}

export type SourceInput = {
  id: string; settings: DeviceSettings | null; list: HaEntity[]; ready: boolean; q: string; flip: boolean;
  t: T; tm: (s: string) => string;
  /** PUT /settings `entities`; `done` is the saved message. */
  put: (patch: SettingsPatch, done: string, warn?: boolean) => void;
};
/** The Change panel of a logical tile: entity search, sign toggle (power ids only), Use automatic. Picks apply at once. */
export function logicalSource(i: SourceInput) {
  const { t, tm } = i;
  const def: LogicalDef = LOGICAL.find((l) => l.id === i.id) || LOGICAL[0];
  const override = i.settings?.entities?.[def.id] || '';
  const src = parseSource(i.settings?.entity_sources?.[def.id] || '');
  // sign: the saved override's, else the choice made before picking an entity
  const flipNow = override ? splitRef(override).negate : i.flip;
  const name = tm(def.label);
  const unlisted = (ha: string) => i.ready && !i.list.some((e) => e.id === ha);
  const pick = (ha: string, warn = false) => i.put(sourcePatch(def.id, ha, !!def.flip && flipNow), t('savedReads', name, ha) + (warn ? '. ' + t('unlisted') : ''), warn);
  const candidates = entitiesFor(i.list, 'gauge', i.q).filter((e) => !isLogicalId(e.id));
  const typed = i.q.trim();
  return {
    entity: src ? (src.negate ? '−' : '') + src.ha + (src.minus ? ' − ' + src.minus : '') : '—',
    from: t(fromKey(src)),
    now: src && !src.minus ? nowLine(t, tm, i.list, src.ha) : '',
    hint: tm(def.hint || ''),
    note: !src ? t('srcPick') : src.why === 'override' ? t('srcManualNote') + (unlisted(src.ha) ? ' ' + t('unlisted') : '') : src.why === 'identity' ? t('srcIdentityNote') : t('srcEnergyNote'),
    manual: !!override,
    auto: () => i.put(sourcePatch(def.id, null), t('savedAuto', name)),
    hasFlip: !!def.flip,
    flipNote: t(flipNow ? 'flippedNote' : 'asReported'),
    flips: [false, true].map((f) => ({ label: t(f ? 'flipSign' : 'asIs'), on: flipNow === f, flip: f,
      // a saved override flips at once; before any pick the choice applies to the entity picked next
      apply: () => { if (override && splitRef(override).negate !== f) i.put(sourcePatch(def.id, splitRef(override).ha, f), t(f ? 'savedFlipped' : 'savedAsReported')); } })),
    entities: candidates.slice(0, 200).map((en) => ({ id: en.id, name: en.name, value: entityGap(en.state) ? '' : tm(entityValue(en)),
      on: !!override && splitRef(override).ha === en.id, pick: () => pick(en.id) })),
    // an entity the list does not carry (other domains, > 800 entities): type its id
    typed: validEntityRef(typed) && !typed.startsWith('-') && !candidates.some((e) => e.id === typed) ? typed : '',
    typedNote: validEntityRef(typed) && unlisted(typed) ? t('notInList') : '',
    useTyped: () => pick(typed, unlisted(typed)),
    noEntities: i.ready && !candidates.length,
    noEntitiesText: typed ? t('noMatch', typed) : t('noFit'),
  };
}
