import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { otaErrOf, otaLine, HTTP_LOW_MEMORY } from './otaStatus.ts';
import { otaStatusVectors } from '../../scripts/gen-vectors.ts';

describe('OTA status line (eink-ha-os#250, spec/test-vectors/ota-status.json)', () => {
  it('vectors are current (npm run vectors)', () => {
    const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'ota-status.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(otaStatusVectors())));
  });
  it('known failures read as plain words, no HTTP codes', () => {
    expect(otaErrOf(HTTP_LOW_MEMORY, true)).toBe('memory');
    expect(otaErrOf(403, true)).toBe('busy');
    expect(otaErrOf(-1, true)).toBe('network');
    expect(otaErrOf(HTTP_LOW_MEMORY, false)).toBe('network');
    const l = otaLine('en', { status: 'error', error: 'memory', version: '', checked: '16:42', channel: 'stable', message: 'HTTP -100' });
    expect(l).toEqual({ title: 'Not enough memory', sub: 'Try again in a minute' });
  });
  it('a result carries the time of the check', () => {
    expect(otaLine('en', { status: 'uptodate', error: null, version: '', checked: '16:42', channel: 'stable', message: '' }))
      .toEqual({ title: 'Up to date', sub: 'Checked 16:42 · stable channel' });
    expect(otaLine('nl', { status: 'checking', error: null, version: '', checked: '16:42', channel: 'beta', message: '' }).title).toBe('Zoeken…');
  });
});
