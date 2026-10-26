import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsPutError, validPosixTz } from './settings.ts';

const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'settings-put.json'), 'utf8')) as {
  tz: { tz: string; ok: boolean }[];
  put: { name: string; body: Record<string, unknown>; error: string | null }[];
};

describe('validPosixTz (spec/test-vectors/settings-put.json)', () => {
  for (const c of v.tz) it(JSON.stringify(c.tz), () => expect(validPosixTz(c.tz)).toBe(c.ok));
});

describe('settingsPutError (spec/test-vectors/settings-put.json)', () => {
  for (const c of v.put) it(c.name, () => expect(settingsPutError(c.body)).toBe(c.error));
});
