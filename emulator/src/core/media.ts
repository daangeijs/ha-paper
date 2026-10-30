// Now playing tile (eink-ha-os#319, spec/SCHEMA.md media): favorites, what a tap asks HA, what the tile shows, what fits.
// The firmware's core/media.cpp matches spec/test-vectors/media.json (generated from this file).
import { entityGap, type EntityGap } from './format.ts';

export const MEDIA_DOMAINS = ['media_player'];
export const MAX_FAVORITES = 6;
/** A favorite: `entity` (script / scene, → turn_on) or `type` + `id` (→ media_player.play_media). */
export type Favorite = { label: string; entity?: string; type?: string; id?: string };
const RUN = /^(script|scene)\.[a-z0-9_]+$/;
const TYPE = /^[a-z0-9_/+.-]+$/;

/** `favorites` "Name=target; …" → items in order (trimmed, empty items skipped); a bad item → { bad: item text }. */
export function parseFavorites(v: unknown): (Favorite | { bad: string })[] {
  if (v === undefined) return [];
  return String(v).split(';').map((x) => x.trim()).filter(Boolean).map((x) => {
    const eq = x.indexOf('=');
    const label = eq < 0 ? '' : x.slice(0, eq).trim(), t = eq < 0 ? '' : x.slice(eq + 1).trim();
    if (!label) return { bad: x };
    if (RUN.test(t)) return { label, entity: t };
    const c = t.indexOf(':');
    if (c <= 0 || c === t.length - 1 || !TYPE.test(t.slice(0, c))) return { bad: x };
    return { label, type: t.slice(0, c), id: t.slice(c + 1).trim() };
  });
}
/** The valid favorites of a media tile (parseYaml rejects the bad ones). */
export const favoritesOf = (w: { [k: string]: unknown }): Favorite[] => parseFavorites(w.favorites).filter((f): f is Favorite => !('bad' in f));
/** parseYaml's message for a media tile's favorites, or null. */
export function favoritesError(w: { [k: string]: unknown }): string | null {
  const fs = parseFavorites(w.favorites);
  const bad = fs.find((f) => 'bad' in f) as { bad: string } | undefined;
  if (bad) return 'media: “' + bad.bad + '” in favorites is not Name=type:id or Name=script.<id> / scene.<id>';
  return fs.length > MAX_FAVORITES ? 'media: at most ' + MAX_FAVORITES + ' favorites' : null;
}
/** Back to the YAML value (console editor). */
export const favoritesText = (fs: Favorite[]): string => fs.map((f) => f.label + '=' + (f.entity ?? f.type + ':' + f.id)).join('; ');

export type MediaTarget = 'prev' | 'play' | 'next' | 'down' | 'up' | 'fav' | 'set';
export type MediaAction = { domain: string; service: string; data: Record<string, string | number> };
const SERVICE: Record<string, string> = { prev: 'media_previous_track', play: 'media_play_pause', next: 'media_next_track', down: 'volume_down', up: 'volume_up' };
/** What a tap asks HA. `n`: for `fav` the index into favoritesOf(w), null = nothing (no such favorite); for `set` the
 *  volume in % (eink-ha-os#351: the slider, clamped 0–100) → one volume_set. Volume steps are HA's volume_down / volume_up: HA
 *  steps from its own level, so quick taps add up without a local guess. */
export function mediaAction(w: { [k: string]: unknown }, t: MediaTarget, n = 0): MediaAction | null {
  const e = String(w.entity ?? ''), fav = n;
  if (t === 'set') return { domain: 'media_player', service: 'volume_set', data: { entity_id: e, volume_level: Math.max(0, Math.min(100, Math.round(n))) / 100 } };
  if (t !== 'fav') return { domain: 'media_player', service: SERVICE[t], data: { entity_id: e } };
  const f = favoritesOf(w)[fav];
  if (!f) return null;
  if (f.entity) return { domain: f.entity.split('.')[0], service: 'turn_on', data: { entity_id: f.entity } };
  return { domain: 'media_player', service: 'play_media', data: { entity_id: e, media_content_id: f.id!, media_content_type: f.type! } };
}

/** playing / buffering show the pause button; idle covers idle, standby, on and anything else HA says. */
export type MediaPhase = 'playing' | 'paused' | 'buffering' | 'idle' | 'off';
export type MediaView = { gap: EntityGap | null; phase: MediaPhase; title: string; artist: string; vol: number | null; slider: boolean };
/** HA MediaPlayerEntityFeature.VOLUME_SET. */
export const VOLUME_SET = 4;
/** What the tile shows from the player's state + attributes (the firmware store keeps them as text). Only these feed
 *  the drawing, so media_position and friends never cause a redraw. `slider` (eink-ha-os#351): `supported_features` (an integer)
 *  has VOLUME_SET, so the volume is a bar to tap or drag; otherwise − / + (volume_down / volume_up). */
export function mediaView(state: string | null | undefined, attrs: Record<string, unknown> = {}): MediaView {
  const s = state ?? '';
  const phase: MediaPhase = s === 'playing' || s === 'paused' || s === 'buffering' || s === 'off' ? s : 'idle';
  const txt = (k: string) => (attrs[k] == null ? '' : String(attrs[k]).trim());
  const vs = attrs.volume_level == null ? '' : String(attrs.volume_level).trim(), v = vs === '' ? NaN : Number(vs);
  return { gap: entityGap(state), phase, title: phase === 'off' ? '' : txt('media_title'), artist: phase === 'off' ? '' : txt('media_artist'),
    vol: Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 100) : null, slider: (featureBits(attrs.supported_features) & VOLUME_SET) !== 0 };
}
function featureBits(f: unknown): number {
  const t = f == null ? '' : String(f).trim();
  return /^[0-9]{1,10}$/.test(t) ? Number(t) : 0;   // & below keeps the low bits of any 10-digit value
}

/** Volume slider (eink-ha-os#351): a tap or the end of a drag at `x` on a bar from `bx`, `bw` px wide → the level in % (whole,
 *  clamped to the bar). */
export function volumeAt(x: number, bx: number, bw: number): number {
  return bw <= 0 ? 0 : Math.round(Math.max(0, Math.min(1, (x - bx) / bw)) * 100);
}

/** What fits a cs × rs tile (both renderers): volume − / + from 2 wide; a 2-high tile lists favorites inline (2 columns
 *  from 2 wide, 4 rows); ★ opens the picker when some favorites are not inline; the picker fills the tile (rows of 44 px:
 *  4 on 1 high, 8 on 2 high) and its last cell is ×. */
export type MediaLayout = { volume: boolean; inlineCols: number; inlineShown: number; star: boolean; pickCols: number; pickRows: number; pickShown: number };
export function mediaLayout(cs: number, rs: number, nFav: number): MediaLayout {
  const cols = cs >= 2 ? 2 : 1;
  const inlineShown = rs >= 2 ? Math.min(nFav, cols * 4) : 0;
  const pickRows = rs >= 2 ? 8 : 4;
  return { volume: cs >= 2, inlineCols: cols, inlineShown, star: nFav > inlineShown, pickCols: cols, pickRows, pickShown: Math.min(nFav, cols * pickRows - 1) };
}
