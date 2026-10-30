import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EMPTY_SOURCE, EMPTY_WAIT_S, emptyNextAt, emptyWaitS, houseEmpty, houseFacts, validEmptySource, type FactEntity, type HouseFacts } from './emptyHouse.ts';

type V = {
  waitS: number; defaultSource: string;
  validSource: { v: string; ok: boolean }[];
  houseEmpty: { entity: string; state: string | null; empty: boolean }[];
  wait: { name: string; localSec: number; quiet: string; s: number }[];
  nextAt: { localSec: number; quiet: string; clock: string; t: string }[];
  facts: { name: string; inside: number | null; entities: FactEntity[]; expect: HouseFacts }[];
};
const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'empty-house.json'), 'utf8')) as V;

describe('empty house (spec/test-vectors/empty-house.json, eink-ha-os#331)', () => {
  it('constants', () => { expect(EMPTY_WAIT_S).toBe(v.waitS); expect(DEFAULT_EMPTY_SOURCE).toBe(v.defaultSource); });
  for (const c of v.validSource) it('validEmptySource ' + JSON.stringify(c.v), () => expect(validEmptySource(c.v)).toBe(c.ok));
  for (const c of v.houseEmpty) it('houseEmpty ' + c.entity + ' = ' + c.state, () => expect(houseEmpty(c.entity, c.state)).toBe(c.empty));
  for (const c of v.wait) it('emptyWaitS: ' + c.name, () => expect(emptyWaitS(c.localSec, c.quiet)).toBe(c.s));
  for (const c of v.nextAt) it('emptyNextAt ' + c.localSec + ' ' + c.quiet + ' ' + c.clock, () => expect(emptyNextAt(c.localSec, c.quiet, c.clock)).toBe(c.t));
  for (const c of v.facts) it('houseFacts: ' + c.name, () => expect(houseFacts(c.inside, c.entities)).toEqual(c.expect));
});
