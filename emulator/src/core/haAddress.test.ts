import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { haAddressVectors } from '../../scripts/gen-vectors.ts';

const file = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'ha-address.json');

describe('HA address (spec/test-vectors/ha-address.json, eink-ha-os#54)', () => {
  it('generator output matches the file on disk (run `npm run vectors` after changing haAddress.ts)', async () => {
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(await haAddressVectors())));
  });
  it('covers the cases the issue names', async () => {
    const v = await haAddressVectors();
    const errs = v.resolve.map((c) => ('error' in c.result ? c.result.status : 200));
    expect(errs).toContain(502);   // unreachable
    expect(v.resolve.some((c) => 'error' in c.result && /not Home Assistant/.test(c.result.error))).toBe(true);
    expect(v.resolve.some((c) => 'error' in c.result && /not over https/.test(c.result.error))).toBe(true);
    expect(v.parse.find((p) => p.input === 'homeassistant.local')).toMatchObject({ url: 'http://homeassistant.local:8123' });
  });
});
