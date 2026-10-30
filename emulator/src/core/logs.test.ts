import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logsVectors } from '../../scripts/gen-vectors.ts';
import { LOG_CAP, logPush, logRing, logsQuery, logsQueryOf, logSplit, logTail, logText, redact } from './logs.ts';

describe('device log ring (spec/test-vectors/logs.json, eink-ha-os#200)', () => {
  it('the committed vectors are current', () => {
    const disk = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'logs.json'), 'utf8'));
    expect(disk).toEqual(JSON.parse(JSON.stringify(logsVectors())));
  });
  it('polling with since = seq sees every line once; dropped when the ring overtook the client', () => {
    let r = logRing(200);
    r = logPush(r, 1, 0, 'I', 'A', 'one');
    const a = logsQuery(r);
    r = logPush(r, 2, 0, 'I', 'A', 'two');
    const b = logsQuery(r, { since: a.seq });
    expect(b.lines.map((l) => l.msg)).toEqual(['two']);
    for (let i = 0; i < 20; i++) r = logPush(r, 3 + i, 0, 'I', 'A', 'filler line ' + i);
    expect(logsQuery(r, { since: b.seq }).dropped).toBe(true);
    expect(r.used).toBeLessThanOrEqual(200);
  });
  it('a full 64 KB ring holds about a thousand typical lines; the tail fits 2 KB', () => {
    let r = logRing();
    for (let i = 0; i < 3000; i++) r = logPush(r, i, 0, 'I', 'HEAP', 'free 182344 min 141020 largest 110592 psram 7864320');
    expect(r.used).toBeLessThanOrEqual(LOG_CAP);
    expect(r.lines.length).toBeGreaterThan(900);
    expect(logTail(r).used).toBeLessThanOrEqual(2048);
  });
  it('query parameters', () => {
    expect(logsQueryOf({ since: '12', level: 'w', tag: 'ha, epd', limit: '5' })).toEqual({ since: 12, level: 'W', tags: ['HA', 'EPD'], limit: 5 });
    expect(logsQueryOf({ level: 'debug' })).toBe('level must be E, W or I');
    expect(logsQueryOf({ limit: '0' })).toMatch(/^limit/);
    expect(logsQueryOf({ since: '-1' })).toMatch(/^since/);
  });
  it('redaction never lets a known secret shape through', () => {
    for (const s of ['password: hunter2', 'psk token=abc', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'x4_ABCDEFGHJKMNPQRSTVWXYZ23', 'a'.repeat(128)]) {
      expect(redact(s)).toContain('***');
      expect(redact(redact(s))).toBe(redact(s));
    }
  });
  it('device-sim lines: leading uppercase word is the tag', () => {
    expect(logSplit('EPD full (boot)')).toEqual({ tag: 'EPD', msg: 'full (boot)' });
    expect(logSplit('API token "a" revoked')).toEqual({ tag: 'API', msg: 'token "a" revoked' });
    expect(logSplit('browser said hi')).toEqual({ tag: 'SIM', msg: 'browser said hi' });
    expect(logText({ seq: 1, ms: 1234, epoch: null, level: 'W', tag: 'NET', msg: 'x' })).toBe('     1.234 W [NET] x');
  });
});

describe('console Device log page (eink-ha-os#200)', async () => {
  const { logsMerge, logsShown } = await import('../webconsole/logsView.ts');
  const l = (seq: number, level: 'E' | 'W' | 'I', tag: string) => ({ seq, ms: seq, epoch: null, level, tag, msg: 'm' });
  it('appends polls; a lower seq means the display restarted', () => {
    const a = logsMerge([], 0, { seq: 2, lines: [l(1, 'I', 'A'), l(2, 'W', 'B')] });
    expect(a).toMatchObject({ seq: 2, restarted: false });
    expect(logsMerge(a.lines, 2, { seq: 3, lines: [l(3, 'E', 'A')] }).lines.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(logsMerge(a.lines, 2, { seq: 1, lines: [] })).toEqual({ lines: [], seq: 0, restarted: true });
    expect(logsMerge(a.lines, 2, { seq: 9, lines: [{ ...l(3, 'I', 'A'), ms: 0 }] }).restarted).toBe(true);   // new boot already past seq 2
  });
  it('level and tag filters', () => {
    const ls = [l(1, 'I', 'HEAP'), l(2, 'W', 'net'), l(3, 'E', 'EPD')];
    expect(logsShown(ls, 'W', '').map((x) => x.seq)).toEqual([2, 3]);
    expect(logsShown(ls, 'E', '').map((x) => x.seq)).toEqual([3]);
    expect(logsShown(ls, 'all', 'NET, epd').map((x) => x.seq)).toEqual([2, 3]);
  });
});
