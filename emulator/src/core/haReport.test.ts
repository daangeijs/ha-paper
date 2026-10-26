import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportDue, reportLine, reportStates, type Health, type ReportLast, type ReportState } from './haReport.ts';

const v = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'spec', 'test-vectors', 'ha-report.json'), 'utf8')) as {
  states: { name: string; input: Health; expect: ReportState[] }[];
  due: { name: string; last: ReportLast | null; force: boolean; nowMs: number; battery: number; charging: boolean; expect: boolean }[];
};

describe('reportStates (spec/test-vectors/ha-report.json)', () => {
  for (const c of v.states) it(c.name, () => {
    const got = reportStates(c.input);
    expect(got).toEqual(c.expect);
    expect(JSON.stringify(got)).toBe(JSON.stringify(c.expect));   // key order too: the firmware builds the same text
  });
});

describe('reportLine (web console)', () => {
  const clock = (e: number) => new Date(e * 1000).toISOString().slice(11, 16);
  it('words every state', () => {
    expect(reportLine({ enabled: true, state: 'ok', last_push_epoch: 1760600640 }, clock)).toBe('On · last 07:44');
    expect(reportLine({ enabled: false, state: 'off', last_push_epoch: 1760600640 }, clock)).toBe('Off');
    expect(reportLine({ enabled: true, state: 'not_admin', last_push_epoch: null }, clock)).toBe('Off — the linked Home Assistant user is not an administrator. Make it one in Home Assistant (Settings → People) and restart the display, or turn this off.');
    expect(reportLine({ enabled: true, state: 'waiting', last_push_epoch: null }, clock)).toBe('On · waiting for Home Assistant');
    expect(reportLine({ enabled: true, state: 'error', last_push_epoch: null }, clock)).toBe('On · last push failed, retrying');
  });
});

describe('reportDue (spec/test-vectors/ha-report.json)', () => {
  for (const c of v.due) it(c.name, () => { expect(reportDue(c.last, c.force, c.nowMs, c.battery, c.charging)).toBe(c.expect); });
});
