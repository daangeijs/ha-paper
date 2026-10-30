import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { favoritesError, favoritesOf, favoritesText, mediaAction, mediaLayout, mediaView, volumeAt } from './media.ts';
import { validateYaml } from './config.ts';
import { mediaVectors } from '../../scripts/gen-vectors.ts';
import { FakeHa } from '../../server/fake-ha.ts';

describe('now playing tile (#319)', () => {
  it('media.json is in sync', () => {
    expect(JSON.parse(readFileSync(join(import.meta.dirname, '../../../spec/test-vectors/media.json'), 'utf8'))).toEqual(mediaVectors());
  });
  it('favorites: script / scene run, anything else is type:id on the player', () => {
    const w = { type: 'media', entity: 'media_player.x', favorites: 'Radio=music:http://a/b; Night=script.good_night' };
    expect(favoritesOf(w)).toEqual([{ label: 'Radio', type: 'music', id: 'http://a/b' }, { label: 'Night', entity: 'script.good_night' }]);
    expect(mediaAction(w, 'fav', 0)).toEqual({ domain: 'media_player', service: 'play_media', data: { entity_id: 'media_player.x', media_content_id: 'http://a/b', media_content_type: 'music' } });
    expect(mediaAction(w, 'fav', 1)).toEqual({ domain: 'script', service: 'turn_on', data: { entity_id: 'script.good_night' } });
    expect(mediaAction(w, 'fav', 2)).toBeNull();
    expect(favoritesText(favoritesOf(w))).toBe('Radio=music:http://a/b; Night=script.good_night');
    expect(favoritesError({ favorites: 'x' })).toMatch(/“x” in favorites/);
  });
  it('a favorites value survives the YAML round trip (colons and slashes in ids)', () => {
    const y = '# HA Paper display config\nversion: 1\nscreens:\n  - id: a\n    widgets:\n      - {type: media, entity: media_player.x, cs: 2, favorites: R=music:http://h:8000/s.mp3; S=scene.a}\n';
    const r = validateYaml(y);
    expect(r.ok && favoritesOf(r.config.screens[0].widgets[0])).toEqual([{ label: 'R', type: 'music', id: 'http://h:8000/s.mp3' }, { label: 'S', entity: 'scene.a' }]);
  });
  it('the view reads only title, artist, state and volume', () => {
    const a = mediaView('playing', { media_title: 'T', media_artist: 'A', volume_level: 0.5, media_position: 12 });
    expect(a).toEqual(mediaView('playing', { media_title: 'T', media_artist: 'A', volume_level: '0.5', media_position: 99 }));
    expect(a.vol).toBe(50);
  });
  it('layout: volume from 2 wide, inline favorites on 2 high, ★ for the rest', () => {
    expect(mediaLayout(1, 1, 3)).toMatchObject({ volume: false, inlineShown: 0, star: true, pickShown: 3 });
    expect(mediaLayout(2, 2, 6)).toMatchObject({ volume: true, inlineShown: 6, star: false });
  });
  it('volume slider (#351): VOLUME_SET gets the bar, a tap sets the level with one volume_set', () => {
    expect(mediaView('playing', { volume_level: 0.32, supported_features: 152_511 }).slider).toBe(true);
    expect(mediaView('playing', { volume_level: 0.32, supported_features: 1024 }).slider).toBe(false);
    expect(mediaView('playing', { volume_level: 0.32 }).slider).toBe(false);
    expect(volumeAt(200 + 120, 200, 160)).toBe(75);
    expect(mediaAction({ entity: 'media_player.x' }, 'set', volumeAt(320, 200, 160))).toEqual({ domain: 'media_player', service: 'volume_set', data: { entity_id: 'media_player.x', volume_level: 0.75 } });
  });
  it('the fake HA speaker answers the tile\'s calls', () => {
    const ha = new FakeHa({ tickMs: 0 }) as any; const id = 'media_player.living_room';
    const call = (service: string, data: Record<string, unknown> = {}) => ha.callService({ domain: 'media_player', service, service_data: { entity_id: id, ...data } }, () => {}, (c: string) => { throw new Error(c); });
    expect(ha.states.get(id).attributes.media_title).toBe('Evening Radio Hour');
    call('media_next_track'); expect(ha.states.get(id).attributes.media_title).toBe('Clair de lune');
    call('media_previous_track'); call('media_previous_track'); expect(ha.states.get(id).attributes.media_title).toBe('So What');
    call('media_play_pause'); expect(ha.states.get(id).state).toBe('paused');
    call('volume_up'); expect(ha.states.get(id).attributes.volume_level).toBe(0.42);
    call('volume_set', { volume_level: 0.75 }); expect(ha.states.get(id).attributes.volume_level).toBe(0.75);
    call('play_media', { media_content_id: 'http://x/r1.mp3', media_content_type: 'music' }); expect(ha.states.get(id).state).toBe('playing');
  });
});
