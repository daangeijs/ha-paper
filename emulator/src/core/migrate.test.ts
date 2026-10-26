import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_SCHEMA, SETTINGS_SCHEMA, migrateSettings, persistSettings, schemaStatus } from './migrate.ts';
import { migrateState, presetState, type Persisted } from '../../server/device.ts';

const dir = join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

type Case = { name: string; op: 'migrate' | 'persist' | 'device'; stored?: unknown; raw?: string; known?: Record<string, unknown>;
  expect: { status?: string; from?: number; version?: number; output?: unknown } };

describe('migrations (spec/test-vectors/migrations)', () => {
  it('has vectors', () => { expect(files.length).toBeGreaterThanOrEqual(6); });
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { cases: Case[] };
    describe(f, () => {
      for (const c of v.cases) it(c.name, () => {
        const text = c.raw ?? (c.stored === undefined ? null : JSON.stringify(c.stored));
        if (c.op === 'device') { expect(schemaStatus(c.stored as number, DEVICE_SCHEMA)).toBe(c.expect.status); return; }
        if (c.op === 'persist') { expect(JSON.stringify(persistSettings(text, c.known!))).toBe(JSON.stringify(c.expect.output)); return; }
        const m = migrateSettings(text!);
        expect({ status: m.status, from: m.from, version: m.version }).toEqual({ status: c.expect.status, from: c.expect.from, version: c.expect.version });
        if (c.expect.output !== undefined) expect(JSON.stringify(m.doc)).toBe(JSON.stringify(c.expect.output));   // key order too
      });
    });
  }
});

describe('device sim state file (server/device.ts migrateState)', () => {
  const old = (): Persisted => { const p = presetState('installed', 'http://ha.local:8123') as Persisted & Record<string, unknown>; delete p.schema; return p; };
  it('state file from before versioning: stamped, values kept', () => {
    const p = old();
    p.settings.display.brightness = 70;
    migrateState(p);
    expect(p.schema).toEqual({ device: DEVICE_SCHEMA, settings: SETTINGS_SCHEMA });
    expect(p.settings.display.brightness).toBe(70);
  });
  it('newer state file (rollback): numbers and unknown keys stay', () => {
    const p = old() as Persisted & Record<string, unknown>;
    p.schema = { device: 9, settings: 9 };
    (p.settings.display as unknown as Record<string, unknown>).dimAt = '22:00';
    p.future = { x: 1 };
    migrateState(p);
    expect(p.schema).toEqual({ device: 9, settings: 9 });
    expect((p.settings.display as unknown as Record<string, unknown>).dimAt).toBe('22:00');
    expect(p.future).toEqual({ x: 1 });
  });
});
