// Contract tests for the device HTTP API (spec/openapi.yaml + AGENT_README §5), over real HTTP.
//
//   npm test / npm run test:contract           boots the device simulator + fake HA on random ports
//   DEVICE_URL=http://ha-paper-XXXX.local \
//   X4_TOKEN_RW=x4_… [X4_TOKEN_RO=x4_…] [X4_SESSION=<x4_session cookie>] npm run test:contract
//                                              runs the same checks against a real display (nothing is booted).
//
// Against a real device: tests that need the simulator (fake HA OAuth, /__sim/state, OTA upload, first install)
// are skipped; token lifecycle tests need X4_SESSION (copy the x4_session cookie from the browser after signing in);
// 403 needs X4_TOKEN_RO or X4_SESSION. PUT /config restores the original config afterwards.
//
//   DEVICE_URL=http://127.0.0.1:8080 X4_FAKE_HA=http://127.0.0.1:8123 X4_FAKE_HA_DEVICE=http://10.0.2.2:8123 npm run test:contract
//                                              real firmware + a standalone fake HA (`npm run fake-ha`; `make qemu-contract`):
// the suite signs in through the fake HA itself (the device does the real OAuth2 + PKCE code exchange and WebSocket
// against X4_FAKE_HA_DEVICE, the address the *device* uses for it), so the OAuth, revoke/re-link, long-lived token,
// live-data and rate-limit tests run against the firmware too. Simulator-only checks (/__sim, OTA mock feed) stay skipped.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request as nodeRequest, type ClientRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '../src/core/config.ts';
import { tr } from '../src/core/strings.ts';
import { FW_INSTALLED } from '../src/core/data.ts';
import { listCounts } from '../src/core/paging.ts';
import { LIST_BUDGET, listLowValue, listReading } from '../src/core/entityList.ts';
import { startSimulator, type RunningSim } from './index.ts';
import { HaSocket, exchangeCode } from './ha-client.ts';
import { sha256, syntheticImage, WWW_PARTITION_SIZE } from './ota.ts';
import { SIM_OTA_REPO, tokenHash } from './device.ts';
import { REAL_AREAS, REAL_DEVICES, REAL_ENTITIES, type RealEntity } from './fake-ha-real.ts';

const DEVICE_URL = process.env.DEVICE_URL?.replace(/\/$/, '');
const REAL = !!DEVICE_URL;
/** Real device + standalone fake HA: X4_FAKE_HA = how this runner reaches it, X4_FAKE_HA_DEVICE = how the device does. */
const FAKE_HA = REAL ? process.env.X4_FAKE_HA?.replace(/\/$/, '') || '' : '';
const FAKE_HA_DEVICE = process.env.X4_FAKE_HA_DEVICE?.replace(/\/$/, '') || FAKE_HA;
/** The same fake HA over https with a test CA only x4qemu trusts (sim/qemu/contract.sh, #79). */
const FAKE_HA_DEVICE_TLS = process.env.X4_FAKE_HA_DEVICE_TLS?.replace(/\/$/, '') || '';
const FAKE = !!FAKE_HA;
/** CONTRACT_HA_TLS=1 (sim/qemu/contract.sh): the device links to the fake HA over https; this runner still controls it over http. */
const HA_TLS = FAKE_HA_DEVICE.startsWith('https:');
/** HA URLs the device hands out point at FAKE_HA_DEVICE (e.g. QEMU's 10.0.2.2); fetch them via FAKE_HA. */
const toRunner = (u: string) => (FAKE && u.startsWith(FAKE_HA_DEVICE) ? FAKE_HA + u.slice(FAKE_HA_DEVICE.length) : u);
/** Fake HA as seen by the device (redirects, client checks) and by this runner (control, token endpoint). */
const haUrl = () => (FAKE ? FAKE_HA_DEVICE : run!.haUrl);
const haLocal = () => (FAKE ? FAKE_HA : run!.haUrl);
const fakeCtl = async (path: string, body?: unknown) => {
  if (!FAKE) throw new Error('fake HA control needs X4_FAKE_HA');
  const r = await fetch(FAKE_HA + '/__fake/' + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
};
// A real display (QEMU, Wi-Fi) answers in hundreds of ms and reconnects to HA in seconds.
if (REAL) vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });
const FAST = { wifiMs: 30, scanMs: 0, otaCheckMs: 20, otaStepMs: 10, rebootMs: 40, haRetryMs: 30 };

type Res = { status: number; headers: Headers; text: string; json: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HA_START = '/api/v1/auth/ha/start';
/** Cookie writes get Origin = base, like a browser on the console page; origin: null sends none.
 *  POST /auth/ha/start waits out the one-probe-at-a-time 429 (#75) unless once: true. */
async function http(base: string, method: string, path: string, o: { token?: string | null; cookie?: string | null; origin?: string | null; body?: string | Uint8Array | FormData; type?: string; accept?: string; headers?: Record<string, string>; once?: boolean } = {}): Promise<Res> {
  for (let i = 0; path === HA_START && !o.once; i++) {
    const r = await http(base, method, path, { ...o, once: true });
    if (r.status !== 429 || i >= 30) return r;
    await sleep(Number(r.headers.get('retry-after') || 1) * 1000 + 100);
  }
  const headers: Record<string, string> = { ...(o.headers || {}) };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (o.cookie) headers.Cookie = 'x4_session=' + o.cookie;
  if (o.cookie && method !== 'GET' && method !== 'HEAD' && o.origin !== null) headers.Origin = o.origin ?? new URL(base).origin;
  if (o.type) headers['Content-Type'] = o.type;
  if (o.accept) headers.Accept = o.accept;
  const r = await fetch(base + path, { method, headers, body: o.body as BodyInit | undefined, redirect: 'manual' });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
}
/** Request with an explicit Host header (node:http) for "opened as http://ha-paper-XXXX.local" vs "opened by IP". */
async function httpWithHost(base: string, method: string, path: string, host: string, body: string): Promise<{ status: number; json: any }> {
  for (let i = 0; ; i++) {
    const r = await httpWithHostOnce(base, method, path, host, body);
    if (r.status !== 429 || i >= 30) return r;
    await sleep(1100);
  }
}
function httpWithHostOnce(base: string, method: string, path: string, host: string, body: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = nodeRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers: { Host: host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });
      res.on('end', () => { let j: any = null; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode || 0, json: j }); });
    });
    req.on('error', reject); req.end(body);
  });
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error('timeout; last value: ' + JSON.stringify(v)); await new Promise((r) => setTimeout(r, 20)); v = await fn(); }
  return v;
}
const cookieOf = (h: Headers): string | null => (h.getSetCookie().find((c) => c.startsWith('x4_session=')) || '').match(/^x4_session=([^;]*)/)?.[1] || null;

/** Full "Sign in with Home Assistant" round trip against the fake HA. Returns the device's 302 + cookie. */
/** The seeded screens.yaml names only entities HA has (#82): no "—" from ids that do not exist. */
async function expectSeededEntitiesExist(b: string, cookie: string | null, haIds: string[]) {
  const cfg = await http(b, 'GET', '/api/v1/config', { cookie });
  expect(cfg.status, cfg.text).toBe(200);
  const ids = [...cfg.text.matchAll(/\bentity: ([a-z0-9_.]+)/g)].map((m) => m[1]);
  const have = new Set(haIds);
  expect(ids.filter((id) => !have.has(id))).toEqual([]);
  return ids;
}

async function signIn(base: string, opts: { user?: string; admin?: boolean; returnTo?: string; tamperState?: boolean } = {}) {
  const start = await http(base, 'POST', '/api/v1/auth/ha/start', { body: JSON.stringify({ return_to: opts.returnTo ?? '/', ...(FAKE ? { ha_url: FAKE_HA_DEVICE } : {}) }), type: 'application/json' });
  expect(start.status, start.text).toBe(200);
  const auth = new URL(start.json.authorize_url);
  const page = await fetch(toRunner(auth.toString())); expect(page.status).toBe(200); expect(await page.text()).toContain('<form');
  const form = new URLSearchParams(auth.searchParams); form.set('username', opts.user ?? 'user'); form.set('password', 'x'); if (opts.admin !== false) form.set('admin', '1');
  const login = await fetch(toRunner(auth.origin) + '/auth/authorize', { method: 'POST', body: form, redirect: 'manual' });
  expect(login.status).toBe(302);
  const cb = new URL(login.headers.get('location')!);
  if (opts.tamperState) cb.searchParams.set('state', 'forged-' + cb.searchParams.get('state'));
  const res = await http(base, 'GET', cb.pathname + cb.search);
  return { start, auth, callback: cb, res, cookie: cookieOf(res.headers) };
}

/** A throwaway HTTP server on 127.0.0.1 (QEMU reaches it as 10.0.2.2:port). */
async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; close: () => Promise<void> }> {
  const srv: Server = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as AddressInfo).port, close: () => { srv.closeAllConnections(); return new Promise<void>((r) => srv.close(() => r())); } };
}

/** #54, on a display that is not linked: the typed HA address is checked before sign-in. haDev = HA as the device sees it. */
async function checkHaAddress(b: string, haDev: string) {
  const start = (ha_url: string) => http(b, 'POST', '/api/v1/auth/ha/start', { body: JSON.stringify({ return_to: '/', ha_url }), type: 'application/json' });
  const bad = await start('ftp://ha.local');
  expect(bad.status, bad.text).toBe(422); expect(bad.json).toMatchObject({ need: 'ha_url' }); expect(bad.json.error).toMatch(/http or https/);
  if (FAKE_HA_DEVICE_TLS) {   // #79: one real TLS handshake + certificate check on the device, within the probe timeout
    const t0 = Date.now();
    const tls = await start(FAKE_HA_DEVICE_TLS);
    expect(tls.status, tls.text).toBe(200); expect(tls.json?.authorize_url, 'not JSON or no authorize_url (#300): ' + tls.text).toBeTypeOf('string');
    expect(tls.json.authorize_url.startsWith(FAKE_HA_DEVICE_TLS + '/auth/authorize?')).toBe(true);
    expect(Date.now() - t0, 'https probe time').toBeLessThan(15_000);
    // #87: a TLS host that accepts and then stalls, answers late, or resets mid-handshake
    const tlsProbe = async (mode: string, delay_s = 0) => {
      await fakeCtl('tls', { mode, delay_s });
      await sleep(1100);   // probe cooldown
      const t = Date.now(); const r = await start(FAKE_HA_DEVICE_TLS);
      return { ...r, ms: Date.now() - t };
    };
    try {
      const hung = await tlsProbe('hang');
      expect(hung.status, hung.text).toBe(502); expect(hung.json.need).toBe('ha_url');
      expect(hung.json.error).toContain('can’t reach ' + FAKE_HA_DEVICE_TLS + '.');
      expect(hung.ms, 'hung handshake probe time').toBeLessThan(15_000);
      expect((await fakeCtl('state')).tls.accepted.hang, 'the probe met the hung handshake').toBeGreaterThanOrEqual(1);
      const reset = await tlsProbe('reset');
      expect(reset.status, reset.text).toBe(502); expect(reset.json.error).toContain('can’t reach ' + FAKE_HA_DEVICE_TLS + '.');
      const slow = await tlsProbe('slow', 1.5);   // inside the probe's 5 s
      expect(slow.status, slow.text).toBe(200); expect(slow.ms).toBeGreaterThanOrEqual(1500);
    } finally { await fakeCtl('tls', { mode: 'ok' }); }
  }
  const dead = await start(new URL(haDev).hostname + ':9');   // discard port: nothing listens
  expect(dead.status, dead.text).toBe(502); expect(dead.json.need).toBe('ha_url'); expect(dead.json.error).toMatch(/can’t reach http:\/\/[^ ]+:9\./);
  // #75: loopback and link-local are refused before any probe (LAN addresses like haDev stay fine)
  for (const a of ['127.0.0.1:8080', 'http://[::1]', '169.254.1.1', 'localhost.']) {
    const r = await start(a);
    expect(r.status, a + ' ' + r.text).toBe(422); expect(r.json.error, a).toMatch(/loopback or link-local/);
  }
  // #75: a redirect to another port (or host) is not followed; the probed body is never echoed
  const host = new URL(haDev).hostname;
  const away = await listen((_q, res) => { res.writeHead(302, { Location: haDev + '/auth/providers' }); res.end('secret-body'); });
  try {
    const r = await start('http://' + host + ':' + away.port);
    expect(r.status, r.text).toBe(422); expect(r.json.error).toMatch(/redirects to another address/); expect(r.text).not.toMatch(/secret-body/);
  } finally { await away.close(); }
  // #75: one probe in flight: a second start while a stalled one runs gets 429 + Retry-After
  await sleep(1100);   // past the cooldown of the probe above
  const stall = await listen(() => { /* never answers */ });
  try {
    const slow = start('http://' + host + ':' + stall.port);
    await sleep(500);
    const busy = await http(b, 'POST', HA_START, { body: JSON.stringify({ return_to: '/', ha_url: haDev }), type: 'application/json', once: true });
    expect(busy.status, busy.text).toBe(429); expect(busy.headers.get('retry-after')).toBe('1'); expect(busy.json.error).toMatch(/still checking/);
    expect((await slow).status).toBe(502);
  } finally { await stall.close(); }
  const ok = await start(haDev.startsWith('http://') ? haDev.slice(7) : haDev);   // no scheme typed: http:// is added
  expect(ok.status, ok.text).toBe(200); expect(ok.json.authorize_url.startsWith(haDev + '/auth/authorize?')).toBe(true);
  const cs = await http(b, 'GET', '/api/v1/console/state');
  expect(cs.json.home_assistant.server).toBe(haDev);   // remembered once it answered as Home Assistant
  expect(Array.isArray(cs.json.home_assistant.discovered)).toBe(true);
}

/** QEMU has no mDNS (slirp): POST /debug/ha-discovered (x4qemu only) hands the firmware what a browse would find.
 *  What uses the result on an unlinked display with no address stored (#90): console state lists it, the link page
 *  offers the first one (server ∈ discovered = "Found … on your network", useConsole), and it is remembered only once
 *  it answers as Home Assistant (#54). Leaves haDev remembered and nothing discovered. */
async function checkDiscovered(b: string, haDev: string) {
  const inject = async (urls: string[]) => {
    const r = await http(b, 'POST', '/api/v1/debug/ha-discovered', { body: JSON.stringify({ urls }), type: 'application/json' });
    expect(r.status, r.text).toBe(200);
  };
  const ha = async () => (await http(b, 'GET', '/api/v1/console/state')).json.home_assistant;
  const start = () => http(b, 'POST', '/api/v1/auth/ha/start', { body: '{"return_to":"/"}', type: 'application/json' });
  const dead = 'http://' + new URL(haDev).hostname + ':9';   // discard port: nothing listens
  expect(await ha()).toMatchObject({ linked: false, server: '', discovered: [] });
  await inject([dead + '/', haDev, dead]);   // normalized, deduped, in browse order
  const found = await ha();
  expect(found.discovered).toEqual([dead, haDev]);
  expect(found.server).toBe(dead);   // offered first: "Found … on your network"
  const bad = await start();   // the offered address does not answer: 502, nothing remembered
  expect(bad.status, bad.text).toBe(502); expect(bad.json.need).toBe('ha_url');
  await inject([]);
  expect(await ha()).toMatchObject({ server: '', discovered: [] });
  await inject([haDev]);
  const ok = await start();
  expect(ok.status, ok.text).toBe(200); expect(ok.json.authorize_url.startsWith(haDev + '/auth/authorize?')).toBe(true);
  await inject([dead]);   // a later browse does not replace the remembered address
  expect(await ha()).toMatchObject({ server: haDev, discovered: [dead] });
  await inject([]);
  expect(await ha()).toMatchObject({ server: haDev, discovered: [] });
}

let run: RunningSim | null = null;
let base = DEVICE_URL || '';
let stateFile = '';
let session: string | null = process.env.X4_SESSION || null;
let rw: string | null = process.env.X4_TOKEN_RW || null;
let ro: string | null = process.env.X4_TOKEN_RO || null;

const mkToken = async (scope: 'read' | 'write') => {
  const r = await http(base, 'POST', '/api/v1/tokens', { cookie: session, body: JSON.stringify({ name: 'contract-' + scope, scope }), type: 'application/json' });
  expect(r.status).toBe(201); temp.push(r.json.id); return r.json.token as string;
};

beforeAll(async () => {
  if (FAKE && !session) {
    // #300: quiet hours (default 23-07) off before the first sign-in, so a night run links like one at noon; settings
    // need a token until then, so the QEMU-only hook sets it. The first-run path below is unchanged.
    const q = await http(base, 'POST', '/__qemu/settings?display=' + encodeURIComponent('{"quiet":"off"}'));
    expect(q.status, q.text).toBe(204);
    // Real firmware + fake HA: sign in like a user would (first sign-in also links the display).
    // QEMU has no mDNS: the discovery result is injected (#90), then the typed address's errors are checked (#54).
    if (!(await http(base, 'GET', '/api/v1/console/state')).json.home_assistant?.linked) {
      await checkDiscovered(base, FAKE_HA_DEVICE);
      await checkHaAddress(base, FAKE_HA_DEVICE);
    }
    const s = await signIn(base);
    expect(s.res.status, s.res.text).toBe(302);
    session = s.cookie;
    // …and wait for the first-run screens from HA (#23): they replace the config once, right after linking.
    await until(() => http(base, 'GET', '/api/v1/console/state', { cookie: session }), (r) => r.json.home_assistant?.linked === true && r.json.offline === false && r.json.seed_pending === false, 60_000);
    // …without a single undefined attribute read that real HA would report (#58)
    expect(await fakeCtl('template-errors')).toEqual([]);
    // …and every tile names an entity this HA has (#82)
    await expectSeededEntitiesExist(base, session, await fakeCtl('entities'));
  }
  if (REAL) {
    // With a session cookie the suite makes its own temporary tokens (revoked again in afterAll).
    if (session && !rw) rw = await mkToken('write');
    if (session && !ro) ro = await mkToken('read');
    // #87: the hung TLS probes above (and anything else so far) ran without a watchdog reset
    if (FAKE) expectNoWatchdogReset(await diagnostics());
    // QEMU keeps real (SNTP) time: no quiet face in the middle of a run, whatever the hour.
    // fullEvery 30: a "clean screen" full refresh after a few clock partials would make refresh counting flaky;
    // intervalSec 5: live data is drawn at most once per "Live data" interval (default 30 s).
    if (FAKE) expect((await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display: { quiet: 'off', fullEvery: 30, intervalSec: 5 } }), type: 'application/json' })).status).toBe(200);
    return;
  }
  stateFile = join(mkdtempSync(join(tmpdir(), 'x4-sim-')), 'state.json');
  run = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'installed', stateFile, delays: FAST });
  base = run.url;
  await until(() => http(base, 'GET', '/__sim/state'), (r) => r.json.ha.connected === true);
  const s = await signIn(base); session = s.cookie;
  rw = await mkToken('write'); ro = await mkToken('read');
}, 60_000);
afterAll(async () => {
  if (FAKE && HA_TLS) await fakeCtl('tls', { mode: 'ok' }).catch(() => {});   // a failed TLS-fault test never leaks its mode
  if (REAL && session) for (const id of temp) await http(base, 'DELETE', '/api/v1/tokens/' + id, { cookie: session });
  await run?.close();
});

const sim = !REAL;
// Collection-time skips for a real device (in the simulator every credential is created in beforeAll).
const NO_SESSION = REAL && !process.env.X4_SESSION && !FAKE;
const NO_RW = REAL && !process.env.X4_TOKEN_RW && NO_SESSION;
const NO_RO = REAL && !process.env.X4_TOKEN_RO && NO_SESSION;
const temp: string[] = [];
const diagnostics = async () => { const r = await http(base, 'GET', '/api/v1/diagnostics', { token: rw }); expect(r.status, r.text).toBe(200); return r.json; };
const expectNoWatchdogReset = (d: { reset_reason: string; boots: { reason: string }[] }) => {
  expect(d.reset_reason).not.toMatch(/WDT|PANIC/);
  expect(d.boots.map((b) => b.reason).filter((r) => /WDT|PANIC/.test(r))).toEqual([]);
};
const simState = async () => (await http(base, 'GET', '/__sim/state')).json;
/** Real display: the clock redraws on the minute; count refreshes only well inside a minute, with `headroom` seconds
 *  left before the next one (#71: a test that runs longer than its headroom sees the clock partial). */
const quietMinute = async (headroom = 20) => {
  if (!REAL) return;
  // settle: nothing queued for the main loop (QEMU `busy`: a config / settings / refresh still rendering, e.g. the
  // screens seeded from HA, #71) and no refresh for 2 s (sign-in welcome, settings, the previous test's config restore)
  const busy = async () => (await http(base, 'GET', '/__qemu/state')).json?.busy === true;
  for (let i = 0; i < 240 && await busy(); i++) await new Promise((r) => setTimeout(r, 500));
  let last = JSON.stringify(await refreshCounts());
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2000)); const n = JSON.stringify(await refreshCounts()); if (n === last && !(await busy())) break; last = n; }
  for (;;) { const sec = new Date().getSeconds(); if (sec >= 2 && sec <= 60 - headroom) return; await new Promise((r) => setTimeout(r, 500)); } };
/** Real display: wait until the full refresh a write just queued has been counted. Under QEMU the render takes seconds
 *  (more on a loaded runner), longer than quietMinute's 2 s settle, so it would land in the next test's count (#71). */
const fullLanded = async (before: { full: number } | null) => {
  if (REAL && before) await until(refreshCounts, (c) => !!c && c.full > before.full, 120_000);
};
/** Refresh counters: the simulator's /__sim/state, or the QEMU firmware's /__qemu/state (real panel: none → checks skipped).
 *  (A real device answers unknown extension-less GETs with the console page, so check the JSON, not the status.) */
const refreshCounts = async (): Promise<{ full: number; partial: number } | null> => {
  const r = await http(base, 'GET', '/__sim/state'); if (r.json?.refreshes) return r.json.refreshes;
  const q = await http(base, 'GET', '/__qemu/state'); return typeof q.json?.full === 'number' ? { full: q.json.full, partial: q.json.partial } : null;
};

describe('web console from flash', () => {
  it('serves index.html gzipped, with the SPA fallback for /setup', async () => {
    for (const p of ['/', '/setup', '/link', '/api-access']) {
      const r = await fetch(base + p, { headers: { 'Accept-Encoding': 'gzip' } });
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/html/);
      expect(await r.text()).toContain('<div id="root">');
    }
    const js = await fetch(base + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(js.status).toBe(200); expect(js.headers.get('content-type')).toMatch(/javascript/);
    if (sim) expect(js.headers.get('content-encoding')).toBe('gzip');
    expect((await fetch(base + '/nope.js')).status).toBe(404);
  });
});

describe('API auth (401 / 403)', () => {
  it('401 "missing token" without a token', async () => {
    for (const [m, p] of [['GET', '/status'], ['GET', '/config'], ['PUT', '/config'], ['POST', '/display/refresh'], ['GET', '/ota']]) {
      const r = await http(base, m, '/api/v1' + p, { body: m === 'PUT' ? 'version: 1\n' : undefined, type: m === 'PUT' ? 'application/yaml' : undefined });
      expect(r.status, m + ' ' + p).toBe(401);
      expect(r.json).toEqual({ error: 'missing token' });
    }
  });
  it('401 "session expired, sign in again" with a session cookie the display does not know', async () => {
    const r = await http(base, 'GET', '/api/v1/settings', { cookie: 'stalesessionxxxxxxxxxxxxxxxx' });
    expect(r.status).toBe(401); expect(r.json).toEqual({ error: 'session expired, sign in again' });
  });
  it('401 "invalid or revoked token" with an unknown token', async () => {
    const r = await http(base, 'GET', '/api/v1/status', { token: 'x4_notarealtokenatallxxxxxxx' });
    expect(r.status).toBe(401); expect(r.json).toEqual({ error: 'invalid or revoked token' });
  });
  it.skipIf(NO_RW)('GET /status with a token', async () => {
    const r = await http(base, 'GET', '/api/v1/status', { token: rw });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: expect.any(String), firmware: expect.any(String), battery: expect.any(Number), screens: expect.any(Number) });
    expect(['linked', 'not linked', 'revoked', 'offline']).toContain(r.json.home_assistant);
    expect(r.json.hostname).toMatch(/^ha-paper-[0-9a-f]{4}\.local$/);   // unique per display (last 4 hex of the Wi-Fi MAC)
    for (const k of ['free_heap', 'heap_largest_block', 'heap_min_free']) expect(r.json[k], k).toEqual(expect.any(Number));
    expect(['ok', 'failed']).toContain(r.json.panel);   // #181
    // #73: CW2017 VCELL in mV, null until read; a 1S Li-ion cell stays within 2.5–4.5 V
    expect('battery_mv' in r.json).toBe(true);
    if (r.json.battery_mv !== null) expect(r.json.battery_mv >= 2500 && r.json.battery_mv <= 4500, String(r.json.battery_mv)).toBe(true);
    // power instrumentation (ROBUSTNESS_PLAN 3.0): no deep sleep yet, so always awake with no planned wake
    expect(r.json.power).toMatchObject({ source: expect.stringMatching(/^(usb|battery)$/), charging: expect.any(Boolean), cpuMhz: expect.any(Number), mode: 'awake', nextWakeEpoch: null });
    expect([null, 'none', 'min', 'max']).toContain(r.json.power.wifiPs);
    if (r.json.power.charging) expect(r.json.power.source).toBe('usb');   // #11: never "charging" on battery
    expect(r.json.power.applied).toMatchObject({ cpuMhz: expect.any(Number), wifiPs: expect.stringMatching(/^(none|min)$/), psOffHeld: expect.any(Boolean) });
  });
  // #177: the power rules' CPU profile and Wi-Fi power save are applied. Simulator: /__sim/control usb; QEMU: /__qemu/power
  // (no clocks or radio there: `applied` is what the firmware would set). A real display can't be unplugged by a test.
  it.skipIf(NO_RW)('power.applied follows the power rules: 80 MHz + modem sleep on battery, 240 MHz + none on USB', async () => {
    const q = !sim && typeof (await http(base, 'GET', '/__qemu/state')).json?.full === 'number';
    if (!sim && !q) return;
    const source = async (battery: boolean) => {
      if (sim) await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ usb: !battery }), type: 'application/json' });
      else await http(base, 'POST', '/__qemu/power?source=' + (battery ? 'battery' : 'usb'));
    };
    // /status `source` comes from the hub's gauge poll, the rules read the board each second: wait for both
    const applied = (want: object, src: string) => until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => {
      const a = r.json?.power?.applied; return !!a && r.json.power.source === src && Object.entries(want).every(([k, v]) => a[k] === v);
    }, 30_000);
    const usb0 = sim ? (await http(base, 'GET', '/__sim/state')).json.power?.usb !== false : true;
    try {
      await source(true);
      const b = await applied({ cpuMhz: 80, wifiPs: 'min' }, 'battery');   // each status poll is an API request: keeps it awake
      expect(b.json.power.applied.cpuMhz).toBe(80);
      if (sim) expect(b.json.power).toMatchObject({ cpuMhz: 80, wifiPs: 'min' });
      await source(false);
      const u = await applied({ cpuMhz: 240, wifiPs: 'none' }, 'usb');
      expect(u.json.power.applied).toMatchObject({ cpuMhz: 240, wifiPs: 'none' });
    } finally {
      await source(!usb0);
    }
  });
  // #249: unplugged from a USB host with a full cell (≥ 4.15 V, charger STAT seen this boot): battery profile within
  // seconds, not after the 30-minute recent-charge rule (#73). QEMU only: the simulator has no recent-charge memory.
  it.skipIf(NO_RW)('power.applied switches to battery after a USB unplug with a full, just-charged cell (QEMU)', async () => {
    if (sim || typeof (await http(base, 'GET', '/__qemu/state')).json?.full !== 'number') return;
    const applied = (want: object, src: string) => until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => {
      const a = r.json?.power?.applied; return !!a && r.json.power.source === src && Object.entries(want).every(([k, v]) => a[k] === v);
    }, 30_000);
    try {
      expect((await http(base, 'POST', '/__qemu/power?source=usb&charging=1&mv=4180')).status).toBe(204);
      await applied({ cpuMhz: 240, wifiPs: 'none' }, 'usb');
      await http(base, 'POST', '/__qemu/power?source=usb&mv=4180');   // full: STAT drops, host still there
      await new Promise((res) => setTimeout(res, 1500));
      await http(base, 'POST', '/__qemu/power?source=battery&mv=4180');   // unplugged
      const b = await applied({ cpuMhz: 80, wifiPs: 'min' }, 'battery');
      expect(b.json.power.applied).toMatchObject({ cpuMhz: 80, wifiPs: 'min' });
    } finally {
      await http(base, 'POST', '/__qemu/power?source=usb');
    }
  });
  it.skipIf(NO_RO)('403 "token is read-only" for writes with a read token; reads work', async () => {
    expect((await http(base, 'GET', '/api/v1/config', { token: ro })).status).toBe(200);
    for (const [m, p, body] of [['PUT', '/config', 'version: 1\n'], ['POST', '/display/refresh', undefined], ['POST', '/ota/check', undefined]] as const) {
      const r = await http(base, m, '/api/v1' + p, { token: ro, body, type: body ? 'application/yaml' : undefined });
      expect(r.status, m + ' ' + p).toBe(403); expect(r.json).toEqual({ error: 'token is read-only' });
    }
  });
  it.skipIf(NO_SESSION)('a token is shown once, stored as SHA-256, and 401 after revoke', async () => {
    const c = await http(base, 'POST', '/api/v1/tokens', { cookie: session, body: JSON.stringify({ name: 'Laptop', scope: 'read' }), type: 'application/json' });
    expect(c.status).toBe(201);
    const secret: string = c.json.token;
    expect(secret).toMatch(/^x4_[a-z0-9]{20,}$/);
    expect(c.json).toMatchObject({ id: expect.any(String), name: 'Laptop', scope: 'read', last_used: null, masked: secret.slice(0, 6) + '…' + secret.slice(-4) });
    const list = await http(base, 'GET', '/api/v1/tokens', { cookie: session });
    expect(list.status).toBe(200); expect(list.text).not.toContain(secret);
    expect(list.json.find((t: any) => t.id === c.json.id)).not.toHaveProperty('token');
    const cs = await http(base, 'GET', '/api/v1/console/state', { cookie: session });
    expect(cs.text).not.toContain(secret);
    if (sim) {
      const st = await simState();
      expect(st.tokens.find((t: any) => t.id === c.json.id).hash).toBe(tokenHash(secret));
      const saved = readFileSync(stateFile, 'utf8');
      expect(saved).not.toContain(secret); expect(saved).toContain(tokenHash(secret));
    }
    expect((await http(base, 'GET', '/api/v1/status', { token: secret })).status).toBe(200);
    expect((await http(base, 'GET', '/api/v1/tokens', { cookie: session })).json.find((t: any) => t.id === c.json.id).last_used).toMatch(/\d\d:\d\d$/);
    expect((await http(base, 'DELETE', '/api/v1/tokens/' + c.json.id, { cookie: session })).status).toBe(204);
    const after = await http(base, 'GET', '/api/v1/status', { token: secret });
    expect(after.status).toBe(401); expect(after.json).toEqual({ error: 'invalid or revoked token' });
    expect((await http(base, 'DELETE', '/api/v1/tokens/' + c.json.id, { cookie: session })).status).toBe(404);
  });
  it.skipIf(NO_SESSION)('cookie writes need a same-origin Origin or Referer; bearer writes do not (#37)', async () => {
    const origin = new URL(base).origin;
    const mk = (o: { origin?: string | null; headers?: Record<string, string> }) =>
      http(base, 'POST', '/api/v1/config/validate', { cookie: session, body: 'version: 1\nscreens: []\n', type: 'application/yaml', ...o });
    for (const [what, o] of [['no Origin/Referer', { origin: null }], ['foreign Origin', { origin: 'http://evil.example' }], ['Origin "null"', { origin: 'null' }],
      ['foreign Referer', { origin: null, headers: { Referer: 'http://evil.example/' + origin } }], ['foreign Origin + our Referer', { origin: 'http://evil.example', headers: { Referer: origin + '/' } }]] as const) {
      const r = await mk(o);
      expect(r.status, what).toBe(403); expect(r.json, what).toEqual({ error: 'cross-origin request refused' });
    }
    expect((await mk({ origin: null, headers: { Referer: origin + '/screens' } })).status).not.toBe(403);
    expect((await mk({})).status).not.toBe(403);
    // Session-only routes too (a revoke from another site must not go through).
    expect((await http(base, 'DELETE', '/api/v1/tokens/nope', { cookie: session, origin: 'http://evil.example' })).status).toBe(403);
    expect((await http(base, 'DELETE', '/api/v1/tokens/nope', { cookie: session })).status).toBe(404);
    // Reads with the cookie and bearer writes need neither header.
    expect((await http(base, 'GET', '/api/v1/tokens', { cookie: session })).status).toBe(200);
    if (rw) expect((await http(base, 'POST', '/api/v1/config/validate', { token: rw, body: 'version: 1\nscreens: []\n', type: 'application/yaml' })).status).not.toBe(403);
  });
  it('linked: GET /console/state without a session does not reveal the HA server or account (#37)', async () => {
    const anon = await http(base, 'GET', '/api/v1/console/state');
    expect(anon.status).toBe(200);
    expect(anon.json.home_assistant.linked).toBe(true);
    expect(anon.json.home_assistant.server).toBe(''); expect(anon.json.home_assistant.user).toBe('');
    expect(anon.json.home_assistant.discovered ?? []).toEqual([]);
    expect(anon.json.session).toEqual({ signed_in: false, user: '', admin: false });
    if (session) {
      const cs = await http(base, 'GET', '/api/v1/console/state', { cookie: session });
      expect(cs.json.home_assistant.server).not.toBe(''); expect(cs.json.home_assistant.user).not.toBe('');
      expect(anon.text).not.toContain(cs.json.home_assistant.server);
    }
  });
  it.skipIf(NO_RW)('token management is session-only (a bearer token is not enough)', async () => {
    expect((await http(base, 'GET', '/api/v1/tokens', { token: rw })).status).toBe(401);
    expect((await http(base, 'POST', '/api/v1/tokens', { token: rw, body: '{"name":"x","scope":"write"}', type: 'application/json' })).status).toBe(401);
  });
});

describe('config (PUT /config, /config/validate)', () => {
  it.skipIf(NO_RW)('422 with the line number for a wrong-domain entity (PUT and validate), nothing applied', async () => {
    const yaml = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
    const lines = yaml.split('\n');
    const n = lines.findIndex((l) => l.includes('entity: sensor.')) + 1; expect(n).toBeGreaterThan(0);
    lines[n - 1] = lines[n - 1].replace(/entity: sensor\.[a-z_]+/, 'entity: switch.sola_power');
    await quietMinute();
    const before = await refreshCounts();
    const put = await http(base, 'PUT', '/api/v1/config', { token: rw, body: lines.join('\n'), type: 'application/yaml' });
    expect(put.status).toBe(422);
    const msg = 'stat: “switch.sola_power” is not a sensor / binary_sensor / input_number / number / climate / weather entity';
    expect(put.json).toEqual({ error: 'line ' + n + ': ' + msg, line: n, message: msg });
    const v = await http(base, 'POST', '/api/v1/config/validate', { token: rw, body: lines.join('\n'), type: 'application/yaml' });
    expect(v.status).toBe(422); expect(v.json).toEqual(put.json);
    if (before) { if (REAL) await new Promise((r) => setTimeout(r, 1000)); expect((await refreshCounts())!.full).toBe(before.full); }
    expect((await http(base, 'GET', '/api/v1/config', { token: rw })).text).toBe(yaml);
  });
  it.skipIf(NO_RW)('PUT a valid config → 200 and exactly one full refresh; GET returns it (YAML and JSON)', async () => {
    const original = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
    const { screens } = parseYaml(original);
    const at = Math.max(0, screens.findIndex((s) => s.id === 'overview')) + 1;
    screens.splice(at, 0, { id: 'morning', app: 'home', title: 'Morning', widgets: [{ type: 'clock', cs: 2 }, { type: 'price' }, { type: 'route', route: 'arn_nm', cs: 2 }] });
    await quietMinute();
    const before = await refreshCounts();
    const put = await http(base, 'PUT', '/api/v1/config', { token: rw, body: JSON.stringify({ version: 1, screens }), type: 'application/json' });
    try {
      expect(put.status).toBe(200); expect(put.json).toEqual({ status: 'applied', screens: screens.length });
      if (before) {
        const after = REAL ? await until(refreshCounts, (x) => x!.full > before.full, 60_000) : await refreshCounts();
        if (REAL) await new Promise((r) => setTimeout(r, 1500));   // the main loop applies config asynchronously
        expect((await refreshCounts())!.full - before.full).toBe(1);
        if (sim) expect((await simState()).last_refresh).toMatchObject({ kind: 'clean', reason: 'new config' });
        void after;
      }
      const j = await http(base, 'GET', '/api/v1/config', { token: rw, accept: 'application/json' });
      expect(j.json.screens.map((s: any) => s.id)).toContain('morning');
      const y = await http(base, 'GET', '/api/v1/config', { token: rw });
      expect(y.headers.get('content-type')).toMatch(/yaml/); expect(y.text).toContain('  - id: morning');
      expect((await http(base, 'POST', '/api/v1/config/validate', { token: rw, body: y.text, type: 'application/yaml' })).status).toBe(200);
    } finally {
      const pre = await refreshCounts();
      const back = await http(base, 'PUT', '/api/v1/config', { token: rw, body: original, type: 'application/yaml' });
      expect(back.status).toBe(200);
      await fullLanded(pre);
    }
  });
  it.skipIf(NO_RW)('415 for a form-encoded body (curl --data-binary without Content-Type)', async () => {
    const r = await http(base, 'PUT', '/api/v1/config', { token: rw, body: 'version: 1\n', type: 'application/x-www-form-urlencoded' });
    expect(r.status).toBe(415);
    expect((await http(base, 'POST', '/api/v1/config/validate', { token: rw, body: 'version: 1\n', type: 'application/x-www-form-urlencoded' })).status).toBe(415);
  });
  it.skipIf(NO_RW)('POST /display/refresh → 204, one full refresh', async () => {
    await quietMinute();
    const before = await refreshCounts();
    expect((await http(base, 'POST', '/api/v1/display/refresh', { token: rw })).status).toBe(204);
    if (before && REAL) { await until(refreshCounts, (x) => x!.full > before.full, 60_000); await new Promise((r) => setTimeout(r, 1000)); }
    if (before) expect((await refreshCounts())!.full - before.full).toBe(1);
  });
  it.skipIf(NO_RW)('GET /screens/{id}/preview.png → 800×480 PNG; unknown → 404', async () => {
    const r = await fetch(base + '/api/v1/screens/overview/preview.png', { headers: { Authorization: 'Bearer ' + rw } });
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('image/png');
    const b = Buffer.from(await r.arrayBuffer());
    expect(b.subarray(1, 4).toString()).toBe('PNG'); expect(b.readUInt32BE(16)).toBe(800); expect(b.readUInt32BE(20)).toBe(480);
    expect((await http(base, 'GET', '/api/v1/screens/nope/preview.png', { token: rw })).status).toBe(404);
  });
  it.skipIf(NO_SESSION)('GET /screens/{id}/preview.png with the console session cookie (Values view, #83)', async () => {
    const r = await fetch(base + '/api/v1/screens/overview/preview.png', { headers: { Cookie: 'x4_session=' + session } });
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await r.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    expect((await http(base, 'GET', '/api/v1/screens/overview/preview.png', { cookie: 'stalesessionxxxxxxxxxxxxxxxx' })).status).toBe(401);
  });
  it.skipIf(NO_RW)('GET /screens/{id}/values → one value per tile, as the display formats it (#122); unknown → 404', async () => {
    const ws: { type: string }[] = (await http(base, 'GET', '/api/v1/config', { token: rw, accept: 'application/json' })).json.screens.find((s: any) => s.id === 'overview').widgets;
    // the firmware formats on its main loop: the first ask can answer ready: false
    const r = await until(() => http(base, 'GET', '/api/v1/screens/overview/values', { token: rw }), (x) => x.status !== 200 || x.json.ready === true, 15_000);
    expect(r.status).toBe(200);
    expect(r.json.values).toHaveLength(ws.length);
    ws.forEach((w, i) => {
      const v = r.json.values[i];
      expect(typeof v, w.type).toBe('string');
      if (w.type === 'clock') expect(v).toMatch(/^(\d{1,2}:\d{2}|--:--)$/);
      else if (['stat', 'gauge', 'switch', 'thermo', 'price'].includes(w.type)) expect(v, w.type).not.toBe('');
      else expect(v, w.type).toBe('');
    });
    expect((await http(base, 'GET', '/api/v1/screens/nope/values', { token: rw })).status).toBe(404);
    expect((await http(base, 'GET', '/api/v1/screens/overview/values')).status).toBe(401);
  });
  it.skipIf(NO_SESSION)('GET /screens/{id}/values with the console session cookie (Values view, #122)', async () => {
    const r = await until(() => http(base, 'GET', '/api/v1/screens/overview/values', { cookie: session }), (x) => x.status !== 200 || x.json.ready === true, 15_000);
    expect(r.status).toBe(200); expect(Array.isArray(r.json.values)).toBe(true);
  });
});

describe.skipIf(REAL && !FAKE)('Sign in with Home Assistant (OAuth2 + PKCE against the fake HA)', () => {
  it('device redirects to HA with client_id/redirect_uri on the same host, state and an S256 challenge', async () => {
    const s = await signIn(base, { returnTo: '/api-access' });
    const q = s.auth.searchParams;
    expect(s.auth.origin).toBe(haUrl());
    expect(q.get('client_id')).toBe(base + '/');
    expect(q.get('redirect_uri')).toBe(base + '/auth/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(16);
    expect(s.res.status).toBe(302); expect(s.res.headers.get('location')).toBe('/api-access');
    expect(s.cookie).toBeTruthy();
    const sc = s.res.headers.getSetCookie().join(';'); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Max-Age=43200/);
    const cs = await http(base, 'GET', '/api/v1/console/state', { cookie: s.cookie });
    expect(cs.json.session).toEqual({ signed_in: true, user: 'user', admin: true });
    expect(cs.json.screens.length).toBeGreaterThan(0);
  });
  it('sign-in works whichever name the browser used: client_id follows the Host header (mDNS name or IP)', async () => {
    const body = JSON.stringify({ return_to: '/', ...(FAKE ? { ha_url: FAKE_HA_DEVICE } : {}) });
    const ip = new URL(base).host;   // the runner reaches the device by IP (127.0.0.1:port)
    for (const host of ['ha-paper-a1b2.local', ip]) {
      const r = await httpWithHost(base, 'POST', '/api/v1/auth/ha/start', host, body);
      expect(r.status, host).toBe(200);
      const q = new URL(r.json.authorize_url).searchParams;
      expect(q.get('client_id')).toBe('http://' + host + '/');
      expect(q.get('redirect_uri')).toBe('http://' + host + '/auth/callback');
    }
  });
  it('GET /auth/start 302s straight to HA', async () => {
    const r = await http(base, 'GET', '/auth/start?return_to=/');
    expect(r.status).toBe(302); expect(r.headers.get('location')).toContain(haUrl() + '/auth/authorize?');
  });
  it('rejects a callback with a forged / unknown state (no session)', async () => {
    const s = await signIn(base, { tamperState: true });
    expect(s.res.status).toBe(400); expect(s.cookie).toBeNull(); expect(s.res.text).toMatch(/state/);
    expect((await http(base, 'GET', '/auth/callback?code=abc&state=nope')).status).toBe(400);
  });
  it('a state is single use (replaying the callback fails)', async () => {
    const s = await signIn(base);
    expect(s.res.status).toBe(302);
    const again = await http(base, 'GET', s.callback.pathname + s.callback.search);
    expect(again.status).toBe(400); expect(cookieOf(again.headers)).toBeNull();
  });
  it('HA refuses the code without the right PKCE verifier (invalid_grant)', async () => {
    const start = await http(base, 'POST', '/api/v1/auth/ha/start', { body: '{}', type: 'application/json' });
    const auth = new URL(start.json.authorize_url); const form = new URLSearchParams(auth.searchParams); form.set('username', 'mallory');
    const login = await fetch(toRunner(auth.origin) + '/auth/authorize', { method: 'POST', body: form, redirect: 'manual' });
    const code = new URL(login.headers.get('location')!).searchParams.get('code')!;
    await expect(exchangeCode(haLocal(), code, base + '/', 'wrong-verifier-wrong-verifier-wrong-verifier')).rejects.toMatchObject({ status: 400, code: 'invalid_grant' });
  });
  it('a non-admin HA user gets a view-only session: reads work, writes and session-only endpoints → 403 (#22)', async () => {
    const s = await signIn(base, { user: 'kid', admin: false });
    expect(s.res.status).toBe(302); expect(s.res.headers.get('location')).toBe('/'); expect(s.cookie).toBeTruthy();
    const cookie = s.cookie;
    const cs = await http(base, 'GET', '/api/v1/console/state', { cookie });
    expect(cs.json.session).toEqual({ signed_in: true, user: 'kid', admin: false });
    expect(cs.json.screens.length).toBeGreaterThan(0); expect(cs.json.tokens).toEqual([]);
    expect((await http(base, 'GET', '/api/v1/config', { cookie })).status).toBe(200);
    expect((await http(base, 'GET', '/api/v1/status', { cookie })).status).toBe(200);
    expect((await http(base, 'GET', '/api/v1/settings', { cookie })).status).toBe(200);
    const admin = { error: 'Home Assistant admin required' };
    const put = await http(base, 'PUT', '/api/v1/config', { cookie, body: 'version: 1\nscreens: []\n', type: 'application/yaml' });
    expect(put.status).toBe(403); expect(put.json).toEqual(admin);
    expect((await http(base, 'PUT', '/api/v1/settings', { cookie, body: '{"name":"x"}', type: 'application/json' })).json).toEqual(admin);
    expect((await http(base, 'POST', '/api/v1/ota/check', { cookie })).status).toBe(403);
    expect((await http(base, 'GET', '/api/v1/tokens', { cookie })).status).toBe(403);
    expect((await http(base, 'POST', '/api/v1/tokens', { cookie, body: '{"name":"k","scope":"read"}', type: 'application/json' })).status).toBe(403);
    expect((await http(base, 'DELETE', '/api/v1/ha', { cookie })).status).toBe(403);
    expect((await http(base, 'GET', '/api/v1/console/state', { cookie })).json.home_assistant.linked).toBe(true);
    expect((await http(base, 'POST', '/api/v1/session/logout', { cookie })).status).toBe(204);
  });
  it('session endpoints: 401 without a session, logout ends it', async () => {
    expect((await http(base, 'GET', '/api/v1/tokens')).status).toBe(401);
    const s = await signIn(base);
    expect((await http(base, 'GET', '/api/v1/tokens', { cookie: s.cookie })).status).toBe(200);
    const out = await http(base, 'POST', '/api/v1/session/logout', { cookie: s.cookie });
    expect(out.status).toBe(204); expect(out.headers.getSetCookie().join()).toMatch(/Max-Age=0/);
    expect((await http(base, 'GET', '/api/v1/tokens', { cookie: s.cookie })).status).toBe(401);
    const cs = await http(base, 'GET', '/api/v1/console/state', { cookie: s.cookie });
    expect(cs.json.session.signed_in).toBe(false); expect(cs.json.screens).toEqual([]); expect(cs.json.tokens).toEqual([]);
  });
  it('display uses refresh tokens: HA revoking the key → "revoked"; signing in again re-links', async () => {
    if (FAKE) await fakeCtl('revoke-all', {}); else run!.fakeHa!.revokeAll();
    await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => r.json.home_assistant === 'revoked', FAKE ? 60_000 : 5000);
    const s = await signIn(base); expect(s.res.status).toBe(302);
    session = s.cookie;
    await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => r.json.home_assistant === 'linked', FAKE ? 60_000 : 5000);
    if (FAKE) return;
    const st = await simState();
    expect(st.ha).toMatchObject({ linked: true, revoked: false, connected: true, user: 'user', client_id: base + '/' });
    expect(st.ha.entities).toBeGreaterThan(20);
  });
});

describe.skipIf(REAL)('fake HA WebSocket API', () => {
  it('auth, current_user, energy prefs, areas, subscribe_entities, call_service', async () => {
    const tok = await fetch(run!.haUrl + '/auth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: run!.sim.p.ha.refreshToken!, client_id: run!.sim.p.ha.clientId! }) }).then((r) => r.json());
    const ws = new HaSocket(); await ws.connect(run!.haUrl, tok.access_token);
    try {
      expect(await ws.command({ type: 'auth/current_user' })).toMatchObject({ name: expect.any(String), is_admin: expect.any(Boolean) });
      expect((await ws.command({ type: 'energy/get_prefs' })).energy_sources.length).toBe(3);
      expect((await ws.command<any[]>({ type: 'config/area_registry/list' })).map((a) => a.area_id)).toContain('living');
      const events: any[] = [];
      await ws.subscribeEntities(['climate.living'], (e) => events.push(e));
      await until(async () => events.length, (n) => n >= 1);
      expect(events[0].a['climate.living'].a.temperature).toBe(21);
      await ws.command({ type: 'call_service', domain: 'climate', service: 'set_temperature', service_data: { temperature: 22.5 }, target: { entity_id: 'climate.living' } });
      await until(async () => events.length, (n) => n >= 2);
      expect(events[1].c['climate.living']['+'].a.temperature).toBe(22.5);
      await expect(ws.command({ type: 'call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.nope' } })).rejects.toThrow(/not found/);
    } finally { ws.close(); }
    await expect(new HaSocket().connect(run!.haUrl, 'bad-token')).rejects.toMatchObject({ code: 'auth_invalid' });
  });
  it('live data that changes nothing visible → no redraw; a changed value → one partial region', async () => {
    await until(simState, (s) => s.ha.connected && s.screen === 'overview');
    await http(base, 'POST', '/api/v1/display/refresh', { token: rw }); // start a fresh "clean screen" cycle
    const changes = async (v: string) => {
      const a = (await simState()).refreshes; const total = (r: any) => r.full + r.partial + r.skipped;
      run!.fakeHa!.setState('sensor.home_power', v);
      const b = await until(simState, (s) => total(s.refreshes) > total(a));
      return { a: a, b: b.refreshes, last: b.last_refresh };
    };
    await changes('3456');                                  // 3.5 kW
    const same = await changes('3460');                     // still 3.5 kW → nothing visible changed
    expect(same.b.partial).toBe(same.a.partial); expect(same.b.full).toBe(same.a.full); expect(same.last.kind).toBe('skip');
    const diff = await changes('1234');                     // 1.2 kW → only that tile
    expect(diff.last).toMatchObject({ kind: 'partial', regions: ['t4'] });
  });
});

// The fake HA's recorder answers, pinned to HA core's shapes (server/fake-ha-history.ts cites the source, #266). Runs
// from this runner against the simulator's fake HA or the standalone one of `make qemu-contract`; the device is not involved.
describe.skipIf(REAL && !FAKE)('fake HA recorder: statistics_during_period + history_during_period (#266)', () => {
  const ctl = async (path: string, body?: unknown) =>
    (await fetch(haLocal() + '/__fake/' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })).json();
  let ws: HaSocket;
  const iso = (agoS: number) => new Date(Date.now() - agoS * 1000).toISOString();
  beforeAll(async () => {
    const { token } = await ctl('llat', { name: 'recorder-test', admin: false });
    ws = new HaSocket(); await ws.connect(haLocal(), token);
  });
  afterAll(async () => { ws?.close(); await ctl('history', { chatty: false, reset_calls: true }); });
  const stats = (b: Record<string, unknown>) => ws.command<Record<string, any[]>>({ type: 'recorder/statistics_during_period', ...b });
  const hist = (b: Record<string, unknown>) => ws.command<Record<string, any[]>>({ type: 'history/history_during_period', ...b });

  it('statistics, period hour: {id: [{start, end (ms), mean, min, max}]} per compiled hour; meters without stats absent', async () => {
    const now = Date.now();
    const r = await stats({ start_time: iso(86400), statistic_ids: ['sensor.outdoor_temperature', 'sensor.rain_rate', 'sensor.train_delay', 'sensor.grid_import_today'], period: 'hour', types: ['mean', 'min', 'max'] });
    expect(Object.keys(r).sort()).toEqual(['sensor.outdoor_temperature', 'sensor.rain_rate']);   // train_delay has no state_class
    const rows = r['sensor.outdoor_temperature'];
    expect(rows.length).toBeGreaterThanOrEqual(23); expect(rows.length).toBeLessThanOrEqual(24);
    for (const x of rows) {
      expect(Object.keys(x).sort()).toEqual(['end', 'max', 'mean', 'min', 'start']);
      expect(Number.isInteger(x.start) && x.start % 3_600_000 === 0 && x.end - x.start === 3_600_000).toBe(true);
      expect(x.end).toBeLessThanOrEqual(now); expect(x.min).toBeLessThanOrEqual(x.mean); expect(x.mean).toBeLessThanOrEqual(x.max);
    }
    expect(rows[0].start).toBeGreaterThanOrEqual(now - 86_400_000);
    // deterministic: the same request gives the same rows
    expect((await stats({ start_time: new Date(rows[0].start).toISOString(), end_time: new Date(rows[2].end).toISOString(), statistic_ids: ['sensor.outdoor_temperature'], period: 'hour', types: ['mean', 'min', 'max'] }))['sensor.outdoor_temperature']).toEqual(rows.slice(0, 3));
    expect(await stats({ start_time: iso(86400), statistic_ids: ['sensor.grid_import_today'], period: 'hour', types: ['change'] })).toEqual({});   // energy path unchanged
    await expect(stats({ start_time: 'yesterday', statistic_ids: ['sensor.rain_rate'], period: 'hour' })).rejects.toThrow('Invalid start_time');
  });

  it('statistics, 5minute and day; total_increasing: change = sum delta, sum only when asked, day rows at local midnight', async () => {
    const five = (await stats({ start_time: iso(3600), statistic_ids: ['sensor.rain_rate'], period: '5minute', types: ['max'] }))['sensor.rain_rate'];
    expect(five.length).toBeGreaterThanOrEqual(11);
    for (const x of five) { expect(Object.keys(x).sort()).toEqual(['end', 'max', 'start']); expect(x.end - x.start).toBe(300_000); }
    const tz = (await ws.command<any>({ type: 'get_config' })).time_zone as string;
    const day = await stats({ start_time: iso(7 * 86400), statistic_ids: ['sensor.rain_total', 'sensor.outdoor_temperature'], period: 'day', types: ['change', 'sum', 'mean'] });
    const rain = day['sensor.rain_total'], temp = day['sensor.outdoor_temperature'];
    expect(rain.length).toBeGreaterThanOrEqual(7);
    const hhmm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    for (const x of rain) { expect(hhmm(x.start)).toBe('00:00'); expect(hhmm(x.end)).toBe('00:00'); expect(x.mean).toBeNull(); expect(x.change).toBeGreaterThanOrEqual(0); }
    for (let i = 1; i < rain.length; i++) expect(rain[i].change).toBeCloseTo(rain[i].sum - rain[i - 1].sum, 6);
    expect(temp[0].sum).toBeNull(); expect(temp[0].change).toBeNull(); expect(typeof temp[0].mean).toBe('number');   // mixed ids: null for the other kind
    const onlyChange = (await stats({ start_time: iso(3 * 3600), statistic_ids: ['sensor.rain_total'], period: 'hour', types: ['change'] }))['sensor.rain_total'];
    expect(Object.keys(onlyChange[0]).sort()).toEqual(['change', 'end', 'start']);
  });

  it('history, minimal_response + no_attributes: first row {s, lu = start}, then {s, lu} on every change only', async () => {
    const t0 = Date.now() - 6 * 3600_000;
    const r = await hist({ start_time: new Date(t0).toISOString(), entity_ids: ['sensor.train_delay', 'sensor.outdoor_temperature', 'sensor.not_recorded'], minimal_response: true, no_attributes: true, significant_changes_only: false });
    expect(Object.keys(r).sort()).toEqual(['sensor.outdoor_temperature', 'sensor.train_delay']);
    for (const rows of Object.values(r)) {
      expect(rows[0]).toEqual({ s: expect.any(String), lu: t0 / 1000 });
      for (let i = 1; i < rows.length; i++) {
        expect(Object.keys(rows[i]).sort()).toEqual(['lu', 's']);
        expect(rows[i].s).not.toBe(rows[i - 1].s); expect(rows[i].lu).toBeGreaterThan(rows[i - 1].lu);
      }
      expect(rows.at(-1)!.lu).toBeLessThanOrEqual(Date.now() / 1000);
    }
    expect(r['sensor.outdoor_temperature'].length).toBeGreaterThan(20);   // 5-minute sensor
    const night = await hist({ start_time: iso(2 * 86400), entity_ids: ['sensor.train_delay'], minimal_response: true, no_attributes: true });
    expect(night['sensor.train_delay'].map((x) => x.s)).toContain('unavailable');   // no trains at night
    const withAttr = await hist({ start_time: iso(3600), entity_ids: ['sensor.outdoor_temperature'], minimal_response: true });
    expect(withAttr['sensor.outdoor_temperature'][0].a).toMatchObject({ unit_of_measurement: '°C', state_class: 'measurement' });
    expect(withAttr['sensor.outdoor_temperature'].slice(1).every((x) => !('a' in x))).toBe(true);
    expect(await hist({ start_time: new Date(Date.now() + 3600_000).toISOString(), entity_ids: ['sensor.outdoor_temperature'] })).toEqual({});
    await expect(hist({ start_time: iso(3600), entity_ids: ['Not An Entity'] })).rejects.toThrow('Invalid entity_ids');
  });

  it('chatty sensor (opt-in): a 6 h history answer is over 512 KB; the call log counts requests and bytes', async () => {
    await ctl('history', { chatty: true, reset_calls: true });
    const r = await hist({ start_time: iso(6 * 3600), entity_ids: ['sensor.chatty_power'], minimal_response: true, no_attributes: true });
    expect(r['sensor.chatty_power'].length).toBeGreaterThan(15_000);
    const info = await ctl('history');
    expect(info.chatty).toBe(true);
    expect(info.calls).toHaveLength(1);
    expect(info.calls[0]).toMatchObject({ type: 'history/history_during_period', ids: ['sensor.chatty_power'], rows: r['sensor.chatty_power'].length });
    expect(info.calls[0].bytes).toBeGreaterThan(512 * 1024);
    await ctl('history', { chatty: false });
    expect(await hist({ start_time: iso(600), entity_ids: ['sensor.chatty_power'] })).toEqual({});
  });
});

// #350: the web console on the www partition. Refusals happen before anything is written (any device); the write
// round trip needs a real www.bin (X4_WWW_BIN, sim/qemu/contract.sh) or the simulator.
const WWW_BIN = process.env.X4_WWW_BIN || '';
describe('web console update (www partition, #350)', () => {
  it.skipIf(NO_RW)('GET /ota www; POST /ota/upload-www refuses before writing; a wrong sha → failed; www.bin → current', async () => {
    const ota = async () => (await http(base, 'GET', '/api/v1/ota', { token: rw })).json;
    const before = await ota();
    expect(before.www).toMatchObject({ current: expect.any(Boolean), state: expect.stringMatching(/^(current|stale|missing|failed)$/) });
    if (!REAL || WWW_BIN) expect(before.www).toMatchObject({ version: before.installed, current: true, state: 'current' });
    const up = (q: string, body: Uint8Array, token: string | null = rw) =>
      http(base, 'POST', '/api/v1/ota/upload-www' + q, { token, body, type: 'application/octet-stream' });
    const ff = '?sha256=' + 'f'.repeat(64);
    expect((await up(ff, new Uint8Array(16), null)).status).toBe(401);
    if (ro) expect((await up(ff, new Uint8Array(16), ro)).status).toBe(403);
    const noSha = await up('', new Uint8Array(16));
    expect(noSha.status).toBe(400); expect(noSha.json.error).toMatch(/sha256/);
    const small = await up(ff, new Uint8Array(4096));
    expect(small.status).toBe(413); expect(small.json.error).toMatch(/size of the www partition/);
    expect((await ota()).www.state).toBe(before.www.state);   // nothing written
    if (REAL && !WWW_BIN) return;
    const img = WWW_BIN ? readFileSync(WWW_BIN) : Buffer.alloc(WWW_PARTITION_SIZE, 0x5a);
    expect(img.length).toBe(WWW_PARTITION_SIZE);
    const bad = await up(ff, new Uint8Array(img));
    expect(bad.status).toBe(422); expect(bad.json.error).toMatch(/SHA-256 does not match/);
    const failed = (await ota()).www;
    expect(failed).toMatchObject({ current: false, state: 'failed' }); expect(failed.message).toMatch(/SHA-256/);
    if (REAL) expect((await http(base, 'GET', '/')).text).toMatch(/Web console not available/);
    const ok = await up('?sha256=' + sha256(img), new Uint8Array(img));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: 'written', version: before.installed, sha256: sha256(img), current: true });
    expect((await ota()).www).toMatchObject({ version: before.installed, sha256: sha256(img), current: true, state: 'current', message: '' });
    if (REAL) {
      const page = await http(base, 'GET', '/');
      expect(page.status).toBe(200); expect(page.text).not.toMatch(/Web console/);
      // console files are read chunk by chunk from the partition (no serveStatic File handles across a rewrite)
      expect((await http(base, 'GET', '/version.txt')).text.trim()).toBe(before.installed);
      const js = await http(base, 'GET', '/app.js');
      expect(js.status).toBe(200); expect(js.text.length).toBeGreaterThan(100_000);
    }
  }, 240_000);
});

describe.skipIf(REAL)('OTA', () => {
  it('check → available; upload with a wrong image → 422, nothing changed; right image → reboot into it', async () => {
    expect((await http(base, 'POST', '/api/v1/ota/check', { token: rw })).status).toBe(202);
    const o = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json.status === 'available');
    expect(o.json).toMatchObject({ installed: FW_INSTALLED, channel: 'stable', available: { version: '0.4.0' } });
    const fd = (img: Buffer, manifest?: object) => { const f = new FormData(); f.append('firmware', new Blob([new Uint8Array(img)]), 'firmware.bin'); if (manifest) f.append('manifest', new Blob([JSON.stringify(manifest)]), 'manifest.json'); return f; };
    const bad = await http(base, 'POST', '/api/v1/ota/upload', { token: rw, body: fd(Buffer.from('not firmware')) });
    expect(bad.status).toBe(422); expect(bad.json.error).toMatch(/does not match manifest\.json/);
    expect((await http(base, 'POST', '/api/v1/ota/upload', { token: ro, body: fd(Buffer.from('x')) })).status).toBe(403);
    const img = syntheticImage('0.4.0');
    const ok = await http(base, 'POST', '/api/v1/ota/upload', { token: rw, body: fd(img, { version: '0.4.0', sha256: sha256(img), size: img.length, notes: [] }) });
    expect(ok.status).toBe(202); expect(ok.json).toMatchObject({ status: 'rebooting', version: '0.4.0', sha256: sha256(img) });
    const up = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json.status === 'updated' && r.json.installed === '0.4.0');
    // #350: the confirmed image fetched the console of its own release
    expect(up.json.www).toMatchObject({ version: '0.4.0', current: true, state: 'current' });
    const raw = await http(base, 'POST', '/api/v1/ota/upload?sha256=' + 'f'.repeat(64), { token: rw, body: new Uint8Array(img), type: 'application/octet-stream' });
    expect(raw.status).toBe(422);
  });
  // #250: Check gave no sign it ran. GET /ota right after the 202 says checking; then the result with last_check, or a
  // failed check as `error` (the display and the console turn it into plain words, core/otaStatus.ts).
  it('POST /ota/check → checking at once → uptodate/available with last_check; a failed check → error + reason', async () => {
    const ctl = (b: object) => http(base, 'POST', '/__sim/control', { body: JSON.stringify(b), type: 'application/json' });
    try {
      for (const [fail, error, msg] of [['memory', 'memory', /Not enough memory/], ['busy', 'busy', /HTTP 403/], ['network', 'network', /not reachable/]] as const) {
        await ctl({ ota_check_fail: fail });
        expect((await http(base, 'POST', '/api/v1/ota/check', { token: rw })).status).toBe(202);
        const e = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json.status === 'error');
        expect(e.json).toMatchObject({ error, message: expect.stringMatching(msg), available: null });
      }
      await ctl({ ota_check_fail: 'ok' });
      expect((await http(base, 'POST', '/api/v1/ota/check', { token: rw })).status).toBe(202);
      const now = await http(base, 'GET', '/api/v1/ota', { token: rw });
      expect(now.json).toMatchObject({ status: 'checking', error: null });
      const done = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json.status !== 'checking');
      expect(done.json).toMatchObject({ status: expect.stringMatching(/^(uptodate|available)$/), error: null, message: '' });
      expect(Date.now() - Date.parse(done.json.last_check)).toBeLessThan(60_000);
      expect((await ctl({ ota_check_fail: 'nope' })).status).toBe(400);
    } finally { await ctl({ ota_check_fail: 'ok' }); }
  });
  it('POST /ota is blocked under 30 % battery (409); a corrupted download changes nothing', async () => {
    await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ preset: 'installed' }), type: 'application/json' });
    expect((await http(base, 'POST', '/api/v1/ota/check', { token: rw })).status).toBe(401); // preset = factory state: tokens gone
    const s = await signIn(base); session = s.cookie;
    rw = await mkToken('write'); ro = await mkToken('read');
    await http(base, 'POST', '/api/v1/ota/check', { token: rw });
    await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json.status === 'available');
    await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ battery: 15 }), type: 'application/json' });
    const low = await http(base, 'POST', '/api/v1/ota', { token: rw });
    expect(low.status).toBe(409); expect(low.json.error).toMatch(/Battery at 15%/);
    await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ battery: 76, ota_fail: 'hash' }), type: 'application/json' });
    expect((await http(base, 'POST', '/api/v1/ota', { token: rw })).status).toBe(202);
    const e = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json.status === 'error');
    expect(e.json).toMatchObject({ installed: FW_INSTALLED, message: expect.stringMatching(/corrupted/) });
    await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ ota_fail: 'boot' }), type: 'application/json' });
    expect((await http(base, 'POST', '/api/v1/ota', { token: rw })).status).toBe(202);
    const rb = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json.status === 'error' && /restored/.test(r.json.message));
    expect(rb.json.installed).toBe(FW_INSTALLED);
    await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ ota_fail: 'ok' }), type: 'application/json' });
  });
});

// Fork ("[YOU]") and QEMU builds leave X4_OTA_REPO at the placeholder: no GitHub checks, POST /ota → 409, upload still works.
// The sim models such a build with __sim/control {ota_repo: ''}; a real device is only checked when its build has no repo.
describe('OTA with update checks off (no release repository in the build)', () => {
  it.skipIf(NO_RW)('GET /ota → auto off, repo "", the checks-off message; POST /ota → 409; POST /ota/check → 202, stays idle', async (ctx) => {
    if (sim) await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ ota_repo: '' }), type: 'application/json' });
    try {
      const g = await http(base, 'GET', '/api/v1/ota', { token: rw });
      expect(g.status).toBe(200);
      if (REAL && g.json.repo !== '') return ctx.skip();
      expect(g.json).toMatchObject({ auto: 'off', repo: '', status: 'idle', available: null, error: null, message: expect.stringMatching(/^Update checks are off/) });
      const inst = await http(base, 'POST', '/api/v1/ota', { token: rw });
      expect(inst.status).toBe(409); expect(inst.json.error).toMatch(/^Update checks are off.*ota\/upload/);
      expect((await http(base, 'POST', '/api/v1/ota/check', { token: rw })).status).toBe(202);
      if (REAL) await new Promise((r) => setTimeout(r, 1000));
      const after = await http(base, 'GET', '/api/v1/ota', { token: rw });
      expect(after.json).toMatchObject({ status: 'idle', available: null, message: expect.stringMatching(/^Update checks are off/) });
    } finally {
      if (sim) await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ ota_repo: SIM_OTA_REPO }), type: 'application/json' });
    }
  });
  // #237: the install face said "Updating to" + a bare "v" for an upload; GET /ota `available` mirrors its version line
  it.skipIf(NO_RW)('POST /ota/upload: the version from ?version= shows while the image streams; a 422 leaves none behind', async () => {
    const img = Buffer.alloc(16 * 1024); img[0] = 0xe9;   // ESP image magic: the updater accepts the first 4 KB block
    const u = new URL(base + '/api/v1/ota/upload?version=v0.5.0-test&sha256=' + 'f'.repeat(64));
    let req!: ClientRequest;
    const done = new Promise<{ status: number; json: any }>((resolve, reject) => {
      req = nodeRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
        headers: { Authorization: 'Bearer ' + rw, 'Content-Type': 'application/octet-stream', 'Content-Length': img.length } }, (res) => {
        let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });
        res.on('end', () => { let j: any = null; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode || 0, json: j }); });
      });
      req.on('error', reject);
    });
    req.write(img.subarray(0, 1024));
    try {
      const mid = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (r) => r.json?.status === 'installing', 15000);
      expect(mid.json.available).toMatchObject({ version: '0.5.0-test' });   // "v" stripped: the face adds it
      if (sim) expect((await simState()).progress).toMatchObject({ version: '0.5.0-test' });
    } finally { req.end(img.subarray(1024)); }
    const r = await done;
    expect(r.status).toBe(422); expect(r.json.error).toMatch(/SHA-256/);
    const after = await until(() => http(base, 'GET', '/api/v1/ota', { token: rw }), (x) => x.json?.status !== 'installing', 15000);
    expect(after.json).toMatchObject({ status: 'error', available: null });
    if (sim) expect((await simState())).toMatchObject({ mode: 'main', progress: null });
  });
});

describe('settings (x-firmware)', () => {
  it.skipIf(NO_RW)('GET → object; PUT partial update; invalid value → 422; read token → 403', async () => {
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    expect(g.status).toBe(200); expect(g.json).toMatchObject({ display: { fullEvery: expect.any(Number) }, ota_channel: expect.stringMatching(/stable|beta/) });
    const orig = g.json.display.warmth;
    const p = await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display: { warmth: orig === 50 ? 60 : 50 } }), type: 'application/json' });
    expect(p.status).toBe(200); expect(p.json.display.warmth).toBe(orig === 50 ? 60 : 50); expect(p.json.display.fullEvery).toBe(g.json.display.fullEvery);
    expect((await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display: { brightness: 101 } }), type: 'application/json' })).status).toBe(422);
    if (ro) expect((await http(base, 'PUT', '/api/v1/settings', { token: ro, body: '{}', type: 'application/json' })).status).toBe(403);
    await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display: { warmth: orig } }), type: 'application/json' });
  });
  it.skipIf(NO_RW)('unknown keys and a non-POSIX tz → 422 naming the problem, nothing applied; a POSIX tz round-trips (#43)', async () => {
    const put = (b: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify(b), type: 'application/json' });
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    const tzMsg = 'tz must be "", a known zone like Europe/Amsterdam or a POSIX TZ string like CET-1CEST,M3.5.0,M10.5.0/3';
    for (const [b, msg] of [[{ powerSave: 'auto' }, 'unknown key: powerSave'], [{ display: { warmth: 10, sleepMode: 'auto' } }, 'unknown key: display.sleepMode'],
      [{ name: 'Not applied', entity_sources: {} }, 'unknown key: entity_sources'], [{ tz: 'Mars/Olympus' }, tzMsg], [{ tz: 'europe/amsterdam', name: 'Not applied' }, tzMsg], [{ tz: 3 }, tzMsg]] as const) {
      const r = await put(b);
      expect(r.status, JSON.stringify(b)).toBe(422); expect(r.json.error).toBe(msg);
    }
    const after = (await http(base, 'GET', '/api/v1/settings', { token: rw })).json;
    expect({ tz: after.tz, name: after.name, warmth: after.display.warmth }).toEqual({ tz: g.json.tz, name: g.json.name, warmth: g.json.display.warmth });
    const p = await put({ tz: 'GMT0BST,M3.5.0/1,M10.5.0' });
    expect(p.status).toBe(200); expect(p.json.tz).toBe('GMT0BST,M3.5.0/1,M10.5.0');
    expect((await put({ tz: g.json.tz })).status).toBe(200);
  });
  it.skipIf(NO_RW)('display style: style / typeface / surface with defaults, exact 422 messages, a new look = one full refresh', async () => {
    const put = (display: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display }), type: 'application/json' });
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    expect(g.json.display).toMatchObject({ style: expect.stringMatching(/^(classic|sleek)$/), typeface: expect.stringMatching(/^(archivo|bricolage|fraunces|geist)$/), surface: expect.stringMatching(/^(dither|dots)$/) });
    const orig = { style: g.json.display.style, typeface: g.json.display.typeface, surface: g.json.display.surface };
    for (const [display, msg] of [[{ style: 'modern' }, 'style must be classic or sleek'], [{ typeface: 'comic' }, 'typeface must be archivo, bricolage, fraunces or geist'], [{ surface: 'gray' }, 'surface must be dither or dots']] as const) {
      const r = await put(display);
      expect(r.status, JSON.stringify(display)).toBe(422); expect(r.json.error).toMatch(new RegExp(msg + '$'));
    }
    expect((await http(base, 'GET', '/api/v1/settings', { token: rw })).json.display).toMatchObject(orig);   // nothing applied
    await quietMinute();
    const before = await refreshCounts();
    const p = await put({ style: orig.style === 'sleek' ? 'classic' : 'sleek', typeface: 'fraunces' });
    expect(p.status).toBe(200); expect(p.json.display).toMatchObject({ style: orig.style === 'sleek' ? 'classic' : 'sleek', typeface: 'fraunces', surface: orig.surface });
    if (before) {
      // QEMU: a new look renders every region before the full-refresh counter moves; under emulation that takes
      // seconds of CPU (~10 s on an M-series Mac, several times longer on a GitHub runner). Real panel: well under 1 s.
      const t0 = Date.now();
      const after = await until(() => refreshCounts(), (c) => !!c && c.full > before.full, REAL ? 120_000 : 5000);
      if (REAL) console.info(`display style: full refresh counted after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (REAL) await new Promise((r) => setTimeout(r, 1500));
      expect((await refreshCounts())!.full).toBe(before.full + 1); expect(after!.partial).toBe(before.partial);
    }
    const pre = await refreshCounts();
    expect((await put(orig)).status).toBe(200);
    await fullLanded(pre);   // the old look back: one more full refresh, seconds of render under QEMU
  });
  it.skipIf(NO_RW)('power saving (#10): powerSave / wakeEvery / liveMin, glance by default, exact 422 messages', async () => {
    const put = (display: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display }), type: 'application/json' });
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    expect(g.json.display).toMatchObject({ powerSave: expect.stringMatching(/^(off|standby|glance)$/), wakeEvery: expect.any(Number), liveMin: expect.any(Number) });
    const orig = { powerSave: g.json.display.powerSave, wakeEvery: g.json.display.wakeEvery, liveMin: g.json.display.liveMin };
    for (const [display, msg] of [[{ powerSave: 'deep' }, 'display.powerSave must be off, standby or glance'], [{ powerSave: 'night' }, 'display.powerSave must be off, standby or glance'], [{ quiet: '7-23' }, 'display.quiet must be "off" or "HH-HH"'], [{ wakeEvery: 5 }, 'display.wakeEvery must be 15, 30 or 60'], [{ liveMin: 2 }, 'display.liveMin must be 1, 3, 5 or 10']] as const) {
      const r = await put(display);
      expect(r.status, JSON.stringify(display)).toBe(422); expect(r.json.error).toBe(msg);
    }
    const p = await put({ powerSave: 'off', wakeEvery: 30, liveMin: 5 });
    expect(p.status).toBe(200); expect(p.json.display).toMatchObject({ powerSave: 'off', wakeEvery: 30, liveMin: 5 });
    expect((await put(orig)).status).toBe(200);
  });
  it.skipIf(NO_RW)('empty-house source (#331): emptyHouse round trip, default off, exact 422 message', async () => {
    const put = (display: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display }), type: 'application/json' });
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    expect(typeof g.json.display.emptyHouse).toBe('string');
    const orig = g.json.display.emptyHouse;
    for (const bad of ['person.someone', 'zone', 1, 'Zone.Home']) {
      const r = await put({ emptyHouse: bad });
      expect(r.status, String(bad)).toBe(422); expect(r.json.error).toBe('display.emptyHouse must be "" or a zone, binary_sensor, input_boolean or group entity id');
    }
    for (const ok of ['zone.home', 'input_boolean.away_mode', '']) {
      const p = await put({ emptyHouse: ok });
      expect(p.status, ok).toBe(200); expect(p.json.display.emptyHouse).toBe(ok);
    }
    expect((await put({ emptyHouse: orig })).status).toBe(200);
  });
  it.skipIf(NO_RW)('good morning page (#330): morning round trip, default true, exact 422 message', async () => {
    const put = (display: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display }), type: 'application/json' });
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    expect(typeof g.json.display.morning).toBe('boolean');
    const orig = g.json.display.morning;
    for (const bad of ['true', 1]) {
      const r = await put({ morning: bad });
      expect(r.status, String(bad)).toBe(422); expect(r.json.error).toBe('display.morning must be true or false');
    }
    for (const v of [false, true]) {
      const p = await put({ morning: v });
      expect(p.status).toBe(200); expect(p.json.display.morning).toBe(v);
      expect((await http(base, 'GET', '/api/v1/settings', { token: rw })).json.display.morning).toBe(v);
    }
    expect((await put({ morning: orig })).status).toBe(200);
  });
  it.skipIf(NO_RW)('front light timeout (#220): lightTimeout round trip, default 60, exact 422 message', async () => {
    const put = (display: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display }), type: 'application/json' });
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    expect([30, 60, 120, 300, 0]).toContain(g.json.display.lightTimeout);
    const orig = g.json.display.lightTimeout;
    for (const bad of [45, '60', -1]) {
      const r = await put({ lightTimeout: bad });
      expect(r.status, String(bad)).toBe(422); expect(r.json.error).toBe('display.lightTimeout must be 0, 30, 60, 120 or 300');
    }
    for (const v of [30, 0]) {
      const p = await put({ lightTimeout: v });
      expect(p.status).toBe(200); expect(p.json.display.lightTimeout).toBe(v);
      expect((await http(base, 'GET', '/api/v1/settings', { token: rw })).json.display.lightTimeout).toBe(v);
    }
    expect((await put({ lightTimeout: orig })).status).toBe(200);
  });
  it.skipIf(NO_RW)('entities: the tile source round trip (#191) (PUT merges, "-" negates, null / "" removes, exact 422 messages)', async () => {
    const put = (entities: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ entities }), type: 'application/json' });
    const g = await http(base, 'GET', '/api/v1/settings', { token: rw });
    expect(g.json.entities).toEqual(expect.any(Object)); expect(g.json.entity_sources).toEqual(expect.any(Object));
    const keep = g.json.entities as Record<string, string>;
    const p = await put({ 'sensor.x4_route_car': 'sensor.contract_travel_time', 'sensor.grid_power': '-sensor.contract_meter_power' });
    expect(p.status, p.text).toBe(200);
    expect(p.json.entities).toMatchObject({ ...keep, 'sensor.x4_route_car': 'sensor.contract_travel_time', 'sensor.grid_power': '-sensor.contract_meter_power' });
    for (const [entities, msg] of [[{ 'sensor.nope': 'sensor.x' }, 'entities: unknown logical id sensor.nope'], [{ 'sensor.solar_power': 'Sensor.X' }, 'entities: sensor.solar_power must name an HA entity like sensor.my_power'], [{ 'sensor.solar_power': '-.x' }, 'entities: sensor.solar_power must name an HA entity like sensor.my_power']] as const) {
      const r = await put(entities);
      expect(r.status, JSON.stringify(entities)).toBe(422); expect(r.json.error).toBe(msg);
    }
    if (!REAL) {   // the simulator is connected to its fake HA: overrides show up as sources right away
      const s = await until(() => http(base, 'GET', '/api/v1/settings', { token: rw }), (r) => !!r.json.entity_sources['sensor.grid_power']?.includes('override'));
      expect(s.json.entity_sources['sensor.grid_power']).toBe('-sensor.contract_meter_power (override)');
    }
    const del = await put({ 'sensor.x4_route_car': null, 'sensor.grid_power': '' });
    expect(del.status).toBe(200); expect(del.json.entities).toEqual(keep);
  });
});

// Device health as HA entities (#32): the device POSTs /api/states/<id> to HA with its own key (admin only in HA).
describe.skipIf(REAL && !FAKE)('device health in Home Assistant (#32)', () => {
  type Posted = { entity_id: string; state: string; attributes: Record<string, unknown> };
  it('linked as an admin: battery, charging, firmware, reset reason become HA states; display.haReport toggles it', async () => {
    let dev = base, auth: { token?: string | null; cookie?: string | null } = { token: rw }, r4: RunningSim | null = null;
    if (!FAKE) {   // the main simulator is linked as the non-admin "X4 display" user: link a fresh one with an admin key
      r4 = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', delays: FAST });
      expect((await http(r4.url, 'POST', '/api/v1/ha/url', { body: JSON.stringify({ url: r4.haUrl }), type: 'application/json' })).status).toBe(200);
      const l = await http(r4.url, 'POST', '/api/v1/ha/token', { body: JSON.stringify({ token: r4.fakeHa!.issueLongLived('user', true) }), type: 'application/json' });
      expect(l.status, l.text).toBe(200);
      dev = r4.url; auth = { cookie: cookieOf(l.headers)! };
    }
    try {
      const posted = async (): Promise<Posted[]> => (FAKE ? fakeCtl('posted') : r4!.fakeHa!.posted);
      const st = (await http(dev, 'GET', '/api/v1/status', auth)).json;
      const id = String(st.hostname).replace(/\.local$/, '').replace(/[^a-z0-9]+/g, '_');
      const p = await until(posted, (x) => x.some((e) => e.entity_id === `sensor.${id}_reset_reason`), REAL ? 90_000 : 5000);
      const last = (eid: string) => [...p].reverse().find((e) => e.entity_id === eid);
      expect(last(`sensor.${id}_battery`)).toMatchObject({ attributes: { unit_of_measurement: '%', device_class: 'battery' } });
      expect(Number(last(`sensor.${id}_battery`)!.state)).toBeGreaterThanOrEqual(0);
      expect(last(`binary_sensor.${id}_charging`)?.state).toMatch(/^(on|off)$/);
      expect(last(`sensor.${id}_firmware`)?.state).toBe(st.firmware);
      expect(last(`sensor.${id}_reset_reason`)?.state).toMatch(/^[A-Z_]+$/);
      const status = () => http(dev, 'GET', '/api/v1/status', auth);
      // a failed push retries after 10 s, then 60 s (ha_report::kMinGapMs): one slow handshake under TCG must not fail this (#123)
      const ok = await until(status, (r) => r.json.ha_report?.state === 'ok', REAL ? 90_000 : 5000);
      expect(ok.json.ha_report).toEqual({ enabled: true, state: 'ok', last_push_epoch: expect.any(Number) });
      const put = (display: object) => http(dev, 'PUT', '/api/v1/settings', { ...auth, body: JSON.stringify({ display }), type: 'application/json' });
      expect((await http(dev, 'GET', '/api/v1/settings', auth)).json.display.haReport).toBe(true);
      const bad = await put({ haReport: 'yes' });
      expect(bad.status).toBe(422); expect(bad.json.error).toBe('display.haReport must be true or false');
      expect((await put({ haReport: false })).json.display.haReport).toBe(false);
      expect((await http(dev, 'GET', '/api/v1/settings', auth)).json.display.haReport).toBe(false);
      const off = await until(status, (r) => r.json.ha_report?.state === 'off', REAL ? 30_000 : 5000);
      expect(off.json.ha_report).toMatchObject({ enabled: false, state: 'off' });
      expect((await put({ haReport: true })).json.display.haReport).toBe(true);
      expect((await status()).json.ha_report.enabled).toBe(true);
    } finally { await r4?.close(); }
  });
  it.skipIf(REAL)('linked as a non-admin user: HA answers 401, the display stops reporting until the next connect', async () => {
    const r5 = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'installed', delays: FAST });
    try {
      const s = await until(async () => (await http(r5.url, 'GET', '/__sim/state')).json, (x) => x.ha.report === 'not_admin');
      expect(s.ha.user).toBe('X4 display');
      expect(r5.fakeHa!.posted).toEqual([]);
      const admin = await signIn(r5.url);   // an admin session; the display's key stays the non-admin one
      expect((await http(r5.url, 'GET', '/api/v1/status', { cookie: admin.cookie })).json.ha_report).toEqual({ enabled: true, state: 'not_admin', last_push_epoch: null });
      expect((await http(r5.url, 'DELETE', '/api/v1/ha', { cookie: admin.cookie })).status).toBe(204);   // unlink: status starts over (#44)
      expect((await http(r5.url, 'GET', '/__sim/state')).json.ha.report).toBe('waiting');
    } finally { await r5.close(); }
  });
});

/** GET /seed body (#89): counts match the tiles; each tile is filled (rule) or dropped (why), never both. */
function expectSeedReport(j: any) {
  expect(j).toMatchObject({ filled: expect.any(Number), total: expect.any(Number), dismissed: expect.any(Boolean), tiles: expect.any(Array) });
  expect(j.total).toBe(j.tiles.length);
  expect(j.filled).toBe(j.tiles.filter((t: any) => !t.why).length);
  for (const t of j.tiles) {
    expect(t).toMatchObject({ tile: expect.any(String), screen: expect.any(String) });
    expect(!!t.rule !== !!t.why, JSON.stringify(t)).toBe(true);
  }
}

describe('seed report (x-firmware, #89)', () => {
  it.skipIf(NO_RW)('GET → what the first-link seed filled and dropped (404 when none ran); 401 without a token; DELETE needs write, sets dismissed', async () => {
    expect((await http(base, 'GET', '/api/v1/seed')).status).toBe(401);
    const g = await http(base, 'GET', '/api/v1/seed', { token: rw });
    if (!FAKE) {   // simulator preset 'installed' saved its screens without a seed; a real display may have either
      expect(REAL ? [200, 404] : [404], g.text).toContain(g.status);
      if (g.status !== 200) { expect((await http(base, 'DELETE', '/api/v1/seed', { token: rw })).status).toBe(404); return; }
    }
    expect(g.status, g.text).toBe(200);   // the suite's own first sign-in seeded the screens
    expectSeedReport(g.json);
    if (ro) expect((await http(base, 'DELETE', '/api/v1/seed', { token: ro })).status).toBe(403);
    if (REAL && !FAKE) return;   // leave a real display's report alone
    expect((await http(base, 'DELETE', '/api/v1/seed', { token: rw })).status).toBe(204);
    const after = (await http(base, 'GET', '/api/v1/seed', { token: rw })).json;
    expect(after).toEqual({ ...g.json, dismissed: true });
  });
});

describe('logs (x-firmware, #200)', () => {
  type Line = { seq: number; ms: number; epoch: number | null; level: string; tag: string; msg: string };
  const logs = async (q = '', token = ro || rw) => http(base, 'GET', '/api/v1/logs' + q, { token });
  it.skipIf(NO_RW)('GET → this boot\'s lines; since polls; level / tag / limit filter; 422 on bad parameters; 401 without a token', async () => {
    expect((await http(base, 'GET', '/api/v1/logs')).status).toBe(401);
    const a = await logs('?limit=1000');
    expect(a.status, a.text).toBe(200);
    expect(a.json).toMatchObject({ boot: 'current', seq: expect.any(Number), first: expect.any(Number), dropped: false, more: expect.any(Boolean) });
    const ls = a.json.lines as Line[];
    expect(ls.length).toBeGreaterThan(0);
    for (const l of ls) {
      expect(l).toMatchObject({ seq: expect.any(Number), ms: expect.any(Number), level: expect.stringMatching(/^[EWI]$/), tag: expect.any(String), msg: expect.any(String) });
      expect(l.epoch === null || typeof l.epoch === 'number').toBe(true);
    }
    expect(ls.map((l) => l.seq)).toEqual(ls.map((_, i) => ls[0].seq + i));   // consecutive, oldest first
    // something that logs on both: a token is created ("API token … created")
    const t = await http(base, 'POST', '/api/v1/tokens', { cookie: session, body: JSON.stringify({ name: 'contract-logs', scope: 'read' }), type: 'application/json' });
    if (t.status === 201) temp.push(t.json.id);
    const b = await until(() => logs('?since=' + a.json.seq), (r) => r.json.lines.some((l: Line) => l.msg.includes('contract-logs')), 10_000);
    expect(b.json.lines.every((l: Line) => l.seq > a.json.seq)).toBe(true);
    expect(b.json.seq).toBeGreaterThan(a.json.seq);
    // filters
    const w = await logs('?level=w&limit=1000');
    expect(w.json.lines.every((l: Line) => l.level === 'W' || l.level === 'E')).toBe(true);
    const tag = ls[0].tag;
    const tg = await logs('?tag=' + encodeURIComponent(tag.toLowerCase() + ',nope') + '&limit=1000');
    expect(tg.json.lines.length).toBeGreaterThan(0);
    expect(tg.json.lines.every((l: Line) => l.tag.toUpperCase() === tag.toUpperCase())).toBe(true);
    const one = await logs('?limit=1');
    expect(one.json.lines.length).toBe(1);
    expect(one.json.more).toBe(true);
    expect(one.json.seq).toBe(one.json.lines[0].seq);
    for (const q of ['?level=debug', '?limit=0', '?limit=1001', '?since=-1', '?boot=yesterday']) expect((await logs(q)).status, q).toBe(422);
    const prev = await logs('?boot=previous');
    expect(prev.status).toBe(200);
    expect(prev.json.boot).toBe('previous');
  });
  it.skipIf(NO_RW)('no secret reaches the ring: API tokens, the session cookie, JWTs, long hex', async () => {
    const all: Line[] = [];
    for (const boot of ['current', 'previous']) all.push(...(await logs('?limit=1000&boot=' + boot)).json.lines);
    const text = all.map((l) => l.tag + ' ' + l.msg).join('\n');
    for (const secret of [rw, ro, session]) if (secret) expect(text.includes(secret), 'secret in the log').toBe(false);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_.-]{8,}/);
    expect(text).not.toMatch(/(^|[^0-9A-Za-z])[0-9a-fA-F]{32,}([^0-9A-Za-z]|$)/m);
    expect(text).not.toMatch(/x4_[0-9A-Za-z]{20,}/);
    expect(text).not.toMatch(/(password|token|secret)["']?\s*[:=]\s*["']?(?!\*\*\*)[^\s"',;&]+/i);
  });
  it.skipIf(!FAKE)('firmware: the minute HEAP line has min_dma + min_8bit_int + TLS reserve use/spills; refresh lines carry the panel time', async () => {
    const h = await logs('?tag=HEAP&limit=1000');
    expect(h.json.lines.some((l: Line) => /^free \d+ min \d+ largest \d+ psram \d+ min_dma \d+ min_8bit_int \d+ · net stack \d+ · tls \d+\/\d+ spills \d+$/.test(l.msg)), JSON.stringify(h.json.lines.slice(-3))).toBe(true);
    const a = await logs('?tag=APP&limit=1000');
    expect(a.json.lines.some((l: Line) => /^EPD (clean refresh|fast refresh|partial) \(.*\) · (\d+ ms|held) · render \d+ ms( \(build \d+ · record \d+ · paint \d+( · slow .+)?\))?$/.test(l.msg)), JSON.stringify(a.json.lines.slice(-3))).toBe(true);
  });
  it.skipIf(REAL)('a restart keeps the previous boot\'s tail; this boot starts at seq 1', async () => {
    expect((await http(base, 'POST', '/api/v1/device/restart', { token: rw })).status).toBe(202);
    await until(simState, (s) => s.mode === 'main' && s.ha.connected);
    const prev = (await logs('?boot=previous')).json;
    expect(prev.lines.some((l: Line) => l.tag === 'RESTART')).toBe(true);
    expect(prev.lines.reduce((n: number, l: Line) => n + 16 + Buffer.byteLength(l.tag) + Buffer.byteLength(l.msg), 0)).toBeLessThanOrEqual(2048);
    expect((await logs()).json.first).toBe(1);
  });
});

describe('diagnostics (x-firmware)', () => {
  it.skipIf(NO_RW)('GET → boot ring, heap, panel, core dump; 401 without a token; DELETE needs write, empties the ring and the core dump', async () => {
    expect((await http(base, 'GET', '/api/v1/diagnostics')).status).toBe(401);
    const g = await http(base, 'GET', '/api/v1/diagnostics', { token: rw });
    expect(g.status, g.text).toBe(200);
    const d = g.json;
    expect(d).toMatchObject({ firmware: expect.any(String), uptime_s: expect.any(Number), reset_reason: expect.stringMatching(/^[A-Z_]+$/),
      heap: { free_internal: expect.any(Number), min_free_internal: expect.any(Number), largest_free_internal: expect.any(Number), free_psram: expect.any(Number) },
      panel: { controller: expect.any(String), source: expect.stringMatching(/^(probe|default|none)$/), promoted: expect.any(Boolean) } });
    expect(d.heap.largest_free_internal).toBeGreaterThan(0);
    // #198: the last internal-heap low point with its context (null before the first checkpoint)
    expect(d.heap.low_point === null || (typeof d.heap.low_point.min_free_internal === 'number' && typeof d.heap.low_point.where === 'string' && typeof d.heap.low_point.tls_slots === 'number')).toBe(true);
    if (FAKE) expect(d.heap.low_point).not.toBeNull();   // the health loop checks every 10 s
    expect(d.boots.length).toBeGreaterThanOrEqual(1); expect(d.boots.length).toBeLessThanOrEqual(8);
    expect(d.boots[0]).toMatchObject({ reason: d.reset_reason, crash: expect.any(Boolean), version: d.firmware, uptime_s: expect.any(Number), min_free_heap: expect.any(Number) });
    expect(d.coredump === null || typeof d.coredump.task === 'string').toBe(true);
    expect(d.touch_recoveries === null || typeof d.touch_recoveries === 'number').toBe(true);
    expect(d.deep_sleep).toMatchObject({ armed: expect.any(Boolean), boots_left: expect.any(Number) });   // #10 first-boot safety
    expect(d.deep_sleep.armed).toBe(d.deep_sleep.boots_left === 0);
    // #225 power trail (/power.txt): the last line when this boot started and the newest lines
    expect(d.power_trail.before_boot === null || typeof d.power_trail.before_boot === 'string').toBe(true);
    expect(Array.isArray(d.power_trail.lines) && d.power_trail.lines.length <= 8).toBe(true);
    expect(d.power_trail.lines.every((l: unknown) => typeof l === 'string')).toBe(true);
    expect(Number.isInteger(d.power_trail.empty_house_sleeps) && d.power_trail.empty_house_sleeps >= 0).toBe(true);   // #331
    const ph = d.power_trail.phases;   // #327: awake phases; the device-sim has no power path (boot null, wakes [])
    expect(Array.isArray(ph.wakes) && ph.wakes.length <= 12).toBe(true);
    const keys = ['boot_ms', 'wifi_ms', 'ha_ms', 'render_ms', 'panel_ms', 'idle_ms', 'total_ms'];
    for (const w of [ph.boot, ...ph.wakes].filter((x) => x !== null)) {
      expect(['cold', 'timer', 'button', 'charger', 'other']).toContain(w.wake);
      for (const k of keys) expect(Number.isInteger(w[k]) && w[k] >= 0, k).toBe(true);
      expect(w.boot_ms + w.wifi_ms + w.ha_ms + w.idle_ms <= w.total_ms).toBe(true);
    }
    if (REAL) expect(ph.boot).not.toBeNull();   // firmware: this boot is measured
    expect(d.deep_sleep.armed_by === null ? !d.deep_sleep.armed : ['uptime', 'boots'].includes(d.deep_sleep.armed_by)).toBe(true);   // #231
    // #231 battery history: the first sample is taken as soon as the gauge is read (the device and the simulator both have one)
    expect(d.battery).toMatchObject({ interval_s: 300, fields: ['t', 'pct', 'mv', 'chg', 'usb', 'power', 'rssi'] });
    expect(d.battery.history.length).toBeGreaterThanOrEqual(1); expect(d.battery.history.length).toBeLessThanOrEqual(288);
    const row = d.battery.history[d.battery.history.length - 1];
    expect(row).toHaveLength(7); expect(row[1]).toBeGreaterThanOrEqual(0); expect([0, 1]).toContain(row[3]); expect([0, 1]).toContain(row[4]); expect(typeof row[5]).toBe('string');
    // #227 inbound path: this request is open; earlier ones were served; QEMU has no mDNS responder and no RSSI
    expect(d.web).toMatchObject({ open: expect.any(Number), served: expect.any(Number), refused_503: expect.any(Number) });
    // open is 0 on the firmware today: handleRequest's onDisconnect replaces the connection gate's (counted at dispatch)
    expect(d.web.open).toBeGreaterThanOrEqual(0); expect(d.web.served).toBeGreaterThanOrEqual(1);
    expect(typeof d.web.last_request_age_s).toBe('number');
    expect(d.mdns).toMatchObject({ up: expect.any(Boolean), restarts: expect.any(Number) });
    expect(d.mdns.last_restart_reason === null || ['connect', 'got_ip', 'bssid', 'idle'].includes(d.mdns.last_restart_reason)).toBe(true);
    expect(d.wifi).toMatchObject({ idle_checks: expect.any(Number), idle_reconnects: expect.any(Number) });
    expect(d.wifi.bssid === null || /^[0-9a-f]{4}$/.test(d.wifi.bssid)).toBe(true);
    expect(d.wifi.rssi === null || typeof d.wifi.rssi === 'number').toBe(true);
    expect(d.panel.failed).toEqual(expect.any(Boolean));   // #181: null failure while the panel is fine
    expect(d.panel.failed ? typeof d.panel.failure === 'string' : d.panel.failure === null).toBe(true);
    expect((await http(base, 'GET', '/api/v1/status', { token: rw })).json.uptime_s).toEqual(expect.any(Number));
    if (ro) {
      expect((await http(base, 'GET', '/api/v1/diagnostics', { token: ro })).status).toBe(200);
      expect((await http(base, 'DELETE', '/api/v1/diagnostics', { token: ro })).status).toBe(403);
      expect((await http(base, 'GET', '/api/v1/diagnostics/coredump', { token: ro })).status).toBe(403);   // RAM contents: write scope
    }
    if (REAL && !FAKE) return;   // a real display keeps its crash history
    expect((await http(base, 'DELETE', '/api/v1/diagnostics', { token: rw })).status).toBe(204);
    const after = (await http(base, 'GET', '/api/v1/diagnostics', { token: rw })).json;
    expect(after).toMatchObject({ boots: [], last_crash: null, coredump: null, reset_reason: d.reset_reason });
    expect((await http(base, 'GET', '/api/v1/diagnostics/coredump', { token: rw })).status).toBe(404);
  });
  it.skipIf(REAL)('a panic leaves PANIC + message + core dump; the crashed boot keeps its uptime; restart → SW', async () => {
    expect((await http(base, 'POST', '/api/v1/device/restart', { token: rw })).status).toBe(202);   // a boot to crash in
    await until(simState, (s) => s.mode === 'main' && s.ha.connected);
    await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ crash: 'panic' }), type: 'application/json' });
    await until(simState, (s) => s.mode === 'main' && s.ha.connected);
    const d = (await http(base, 'GET', '/api/v1/diagnostics', { token: rw })).json;
    expect(d.reset_reason).toBe('PANIC');
    expect(d.boots[0]).toMatchObject({ reason: 'PANIC', crash: true, panic: expect.stringMatching(/^assert failed/) });
    expect(d.last_crash).toMatchObject({ reason: 'PANIC', panic: d.boots[0].panic, version: FW_INSTALLED, uptime_s: expect.any(Number) });
    expect(d.coredump).toMatchObject({ task: 'loopTask', pc: expect.stringMatching(/^0x[0-9a-f]{8}$/), backtrace: expect.any(Array), size: expect.any(Number) });
    const raw = await fetch(base + '/api/v1/diagnostics/coredump', { headers: { Authorization: 'Bearer ' + rw } });
    expect(raw.status).toBe(200); expect(raw.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = new Uint8Array(await raw.arrayBuffer());
    expect(bytes.length).toBe(d.coredump.size); expect(Array.from(bytes.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect((await http(base, 'POST', '/api/v1/device/restart', { token: rw })).status).toBe(202);
    const r = await until(() => http(base, 'GET', '/api/v1/diagnostics', { token: rw }), (x) => x.json.reset_reason === 'SW');
    expect(r.json.boots.map((b: any) => b.reason).slice(0, 3)).toEqual(['SW', 'PANIC', 'SW']);
    expect(r.json.last_crash.reason).toBe('PANIC');   // still the newest crash
    await until(simState, (s) => s.mode === 'main' && s.ha.connected);
    expect((await http(base, 'DELETE', '/api/v1/diagnostics', { token: rw })).status).toBe(204);
  });
});

// #181: a panel whose BUSY never releases (QEMU: POST /__qemu/panel?stuck=1) is given up after one 20 s wait instead of
// boot-looping on the task watchdog; the display keeps serving and skips every refresh. A real display skips this.
// #214: remote input and the frame on the glass, for measuring render/refresh on hardware. Off by default.
describe.skipIf(NO_RW)('remote input + framebuffer (#214)', () => {
  const putS = (on: boolean) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display: { debugInput: on } }), type: 'application/json' });
  const input = (q: string, token = rw) => http(base, 'POST', '/api/v1/debug/input?' + q, { token });
  const qemu = async () => (await http(base, 'GET', '/__qemu/state')).json;
  const idle = async () => { for (let i = 0; i < 120 && (await qemu())?.busy === true; i++) await sleep(500); };
  const frame = async () => {
    const r = await fetch(base + '/api/v1/debug/framebuffer.png', { headers: { Authorization: 'Bearer ' + rw } });
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toMatch(/^image\/png/);
    const b = Buffer.from(await r.arrayBuffer());
    expect(b.readUInt32BE(16)).toBe(800); expect(b.readUInt32BE(20)).toBe(480);
    return b.toString('base64');
  };
  const screen = async () => (sim ? (await simState()).screen : (await qemu())?.screen) as string | undefined;
  afterAll(async () => { await putS(false); });

  it('off by default → 403; on: key=next changes what the panel shows; bad spec 400; read token 403', async () => {
    expect((await http(base, 'GET', '/api/v1/settings', { token: rw })).json.display.debugInput).toBe(false);
    const off = await input('key=next');
    expect(off.status).toBe(403); expect(off.json.error).toBe('remote input is off');
    expect((await putS(true)).json.display.debugInput).toBe(true);
    expect((await input('key=up')).status).toBe(400);
    if (!NO_RO) expect((await input('key=next', ro)).status).toBe(403);
    const real = REAL && !(await qemu());
    if (real) return;   // a real panel: no way to read back what it shows
    await idle();
    const s0 = await screen(), f0 = await frame();
    let changed = false;
    for (let k = 0; k < 3 && !changed; k++) {
      expect((await input('key=next')).status).toBe(204);
      await idle(); await sleep(sim ? 0 : 1500); await idle();
      changed = s0 !== undefined ? (await screen()) !== s0 : (await frame()) !== f0;   // a first press may close chrome only
    }
    expect(changed).toBe(true);
    expect((await input('key=prev')).status).toBe(204);
    await idle();
    expect((await putS(false)).json.display.debugInput).toBe(false);
    expect((await input('key=next')).status).toBe(403);
  }, REAL ? 120_000 : 10_000);
});

describe('stuck panel BUSY (#181)', () => {
  it.skipIf(NO_RW)('BUSY never releases → panel failed once, refreshes skipped, /status keeps answering', async () => {
    if (typeof (await http(base, 'GET', '/__qemu/state')).json?.full !== 'number') return;   // QEMU only
    const idle = async () => { for (let i = 0; i < 120 && (await http(base, 'GET', '/__qemu/state')).json?.busy === true; i++) await new Promise((r) => setTimeout(r, 500)); };
    await quietMinute(50);
    expect((await http(base, 'POST', '/__qemu/panel?stuck=1')).status).toBe(204);
    try {
      const before = await refreshCounts();
      const t0 = Date.now();
      expect((await http(base, 'POST', '/api/v1/display/refresh', { token: rw })).status).toBe(204);
      await new Promise((r) => setTimeout(r, 3000));   // loopTask now sits in the BUSY wait
      const mid = await http(base, 'GET', '/api/v1/status', { token: rw });
      expect(mid.status).toBe(200); expect(mid.json.panel).toBe('ok');
      await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (x) => x.json?.panel === 'failed', 60_000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(19_000);
      const d = await diagnostics();
      expect(d.panel).toMatchObject({ failed: true, failure: expect.stringMatching(/^BUSY stuck 20 s/) });
      expectNoWatchdogReset(d);
      // the next refresh returns at once and draws nothing
      const t1 = Date.now();
      expect((await http(base, 'POST', '/api/v1/display/refresh', { token: rw })).status).toBe(204);
      await new Promise((r) => setTimeout(r, 1000)); await idle();
      expect(Date.now() - t1).toBeLessThan(15_000);
      expect(await refreshCounts()).toEqual(before);
      expect((await fetch(base + '/')).status).toBe(200);   // the web console still serves
    } finally {
      await http(base, 'POST', '/__qemu/panel?stuck=0');
    }
    expect((await http(base, 'GET', '/api/v1/status', { token: rw })).json.panel).toBe('ok');
    expect((await diagnostics()).panel).toMatchObject({ failed: false, failure: null });
  }, 180_000);   // quietMinute(50) up to ~60 s + the 20 s BUSY wait + idle polls: 120 s was too tight on a loaded runner (#207)
});

// #178: power measurement hooks. /status power counters + refreshes, POST /device/sleep. The sleep round trip runs on
// the simulator (POST /__sim/control {wake}) and QEMU (simulated deep sleep: ≤ 8 s, then a reset with the wake cause);
// a real display is left awake.
describe('power measurement hooks (#178)', () => {
  const status = async () => { const r = await http(base, 'GET', '/api/v1/status', { token: rw }); expect(r.status, r.text).toBe(200); return r.json; };
  const sleepReq = (body: string, token = rw) => http(base, 'POST', '/api/v1/device/sleep', { token, body, type: 'application/json' });
  const isQemu = async () => typeof (await http(base, 'GET', '/__qemu/state')).json?.full === 'number';
  it.skipIf(NO_RW)('/status: wake counters, last wake, refreshes since power-on and this boot', async () => {
    const s = await status();
    expect(s.power).toMatchObject({ wakes: expect.any(Number), redraws: expect.any(Number), failedWakes: expect.any(Number), awakeS: expect.any(Number), asleepS: expect.any(Number) });
    expect('lastWake' in s.power).toBe(true);
    if (s.power.lastWake) expect(s.power.lastWake).toMatchObject({ totalMs: expect.any(Number) });
    expect(s.power.awakeS).toBeGreaterThanOrEqual((s.uptime_s ?? 0) - 2);   // firmware: since setup(), uptime_s since the reset
    expect(s.refreshes).toMatchObject({ full: expect.any(Number), partial: expect.any(Number), boot: { full: expect.any(Number), partial: expect.any(Number) } });
    expect(s.refreshes.full).toBeGreaterThanOrEqual(s.refreshes.boot.full);
    if (s.refreshes.boot.fast !== undefined) expect(s.refreshes.boot).toMatchObject({ fast: expect.any(Number), clean: expect.any(Number) });   // #197
  });
  it.skipIf(NO_RW)('POST /device/sleep: 422 for bad seconds, 401 without a token, 409 on external power', async () => {
    const msg = 'seconds must be an integer from 60 to 86400';
    for (const b of ['{"seconds":59}', '{"seconds":86401}', '{"seconds":60.5}', '{"seconds":"600"}', '{}']) {
      const r = await sleepReq(b); expect(r.status, b).toBe(422); expect(r.json).toEqual({ error: msg });
    }
    expect((await sleepReq('{"seconds":60}', null)).status).toBe(401);
    if (ro) expect((await sleepReq('{"seconds":60}', ro)).status).toBe(403);
    const qemu = await isQemu();
    if (sim) await http(base, 'POST', '/__sim/control', { body: '{"usb":true}', type: 'application/json' });
    else if (qemu) await http(base, 'POST', '/__qemu/power?source=usb');
    else if ((await status()).power.source !== 'usb') return;   // real display on battery: would really sleep
    const r = await sleepReq('{"seconds":60}');
    expect(r.status).toBe(409); expect(r.json).toEqual({ error: 'stays awake: external power' });
    if (sim) await http(base, 'POST', '/__sim/control', { body: '{"usb":false}', type: 'application/json' });
  });
  it.skipIf(NO_RW)('POST /device/sleep → 202, no answer while asleep, back after the wake with wakes + 1', async (ctx) => {
    const qemu = await isQemu();
    if (!sim && !qemu) return ctx.skip();
    const before = await status();
    // QEMU: battery (not armed: once awake again it stays awake, "not armed", so the next tests find it up)
    if (qemu) expect((await http(base, 'POST', '/__qemu/power?source=battery')).status).toBe(204);
    // the firmware checks the power inputs its main loop cached (once a second): USB → battery shows up within ~1 s
    const r = await until(() => sleepReq('{"seconds":60}'), (x) => x.status !== 409 || x.json?.error !== 'stays awake: external power', 5000);
    expect(r.status, r.text).toBe(202); expect(r.json).toEqual({ status: 'sleeping', seconds: 60 });
    // QEMU keeps its network up through the simulated sleep (no Wi-Fi to switch off); the reset ends it
    const answer = async () => { try { if (qemu) await sleep(1000); return (await http(base, 'GET', '/api/v1/status', { token: rw })).json; } catch { return null; } };
    if (sim) {
      await until(simState, (x) => !!x.power.asleep);
      await expect(fetch(base + '/api/v1/status')).rejects.toThrow();   // radio off
      await http(base, 'POST', '/__sim/control', { body: '{"wake":"timer"}', type: 'application/json' });
    }
    const after = await until(answer, (x) => !!x && x.power?.wakes > before.power.wakes, qemu ? 180_000 : 5000);
    if (qemu) {
      expect((await http(base, 'GET', '/__qemu/state')).json.wake).toBe('timer');
      expect((await http(base, 'POST', '/__qemu/power?source=usb')).status).toBe(204);
    }
    expect(after.power.wakes).toBe(before.power.wakes + 1);
    expect(after.power.asleepS).toBeGreaterThanOrEqual(before.power.asleepS);
    expect(after.power.awakeS).toBeGreaterThanOrEqual(before.power.awakeS);   // the boot before the sleep counts
    expect(after.refreshes.full).toBeGreaterThanOrEqual(before.refreshes.full);
    if (sim) await until(simState, (x) => x.mode === 'main' && x.ha.connected);
    else {
      await until(answer, (x) => x?.home_assistant === 'linked', 120_000);   // HA connected again for the next tests
      if (FAKE) { const si = await signIn(base); expect(si.res.status, si.res.text).toBe(302); session = si.cookie; }   // sessions are RAM: the wake was a reset
    }
  });
});

// #202: a configured display boots straight to its dashboard: two full refreshes (boot, home), never the setup
// screens. The firmware read its status defaults (no Wi-Fi, never linked) when the boot refresh outlasted the boot
// screen: boot → "setup: Wi-Fi" → "setup: browser" on every boot of a real panel.
describe('configured boot (#202)', () => {
  const status = async () => { try { const r = await http(base, 'GET', '/api/v1/status', { token: rw }); return r.status === 200 ? r.json : null; } catch { return null; } };
  const signedIn = async () => { try { return (await http(base, 'GET', '/api/v1/console/state', { cookie: session })).json?.session?.signed_in === true; } catch { return null; } };
  it.skipIf(NO_RW)('restart of a linked display → boot + home, no setup refresh', async (ctx) => {
    const qemu = typeof (await http(base, 'GET', '/__qemu/state')).json?.full === 'number';
    if (!sim && !qemu) return ctx.skip();   // a real display: don't restart it
    if ((await status())?.home_assistant !== 'linked') return ctx.skip();
    if (qemu && !(await signedIn())) return ctx.skip();   // the reboot marker below
    const t0 = new Date().toISOString();
    expect((await http(base, 'POST', '/api/v1/device/restart', { token: rw })).status).toBe(202);
    if (sim) await until(simState, (s) => s.mode === 'main' && s.ha.connected);
    else {
      await until(signedIn, (x) => x === false, 60_000);   // the reset happened: sessions are RAM (QEMU's uptime_s survives esp_restart)
      await until(status, (x) => x?.home_assistant === 'linked', 120_000);
      for (let i = 0; i < 60 && (await http(base, 'GET', '/__qemu/state')).json?.busy === true; i++) await sleep(500);
      await sleep(5000);   // a late setup → home redraw would land here
      if (FAKE) { const si = await signIn(base); expect(si.res.status, si.res.text).toBe(302); session = si.cookie; }   // sessions are RAM
    }
    if (sim) {   // the simulator draws the boot screen twice around its reboot delay: check the reasons instead
      const fulls = (await simState()).events.filter((e: { t: string; kind: string }) => (e.kind === 'full' || e.kind === 'clean') && e.t >= t0).map((e: { reason: string }) => e.reason);
      expect(fulls.filter((r: string) => r.startsWith('setup:'))).toEqual([]);
      expect(fulls.at(-1)).toBe('home');
    } else expect((await status()).refreshes.boot.full).toBe(2);   // boot, home
  }, 180_000);
});

describe.skipIf(REAL)('first install (separate simulator)', () => {
  let r2: RunningSim;
  beforeAll(async () => { r2 = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'first-install', delays: FAST }); });
  afterAll(async () => { await r2.close(); });
  it('Wi-Fi on the SoftAP → "Finish in your browser" → one HA sign-in links the display and opens the console', async () => {
    const b = r2.url;
    let cs = await http(b, 'GET', '/api/v1/console/state');
    expect(cs.json).toMatchObject({ setup: 'wifi', softap: true, ip: null, home_assistant: { linked: false }, session: { signed_in: false } });
    expect(cs.json.hostname).toMatch(/^ha-paper-[0-9a-f]{4}\.local$/);
    expect((await http(b, 'POST', '/api/v1/wifi/scan')).json[0]).toMatchObject({ ssid: 'HomeNet', rssi: -48 });
    const short = await http(b, 'POST', '/api/v1/wifi', { body: JSON.stringify({ ssid: 'HomeNet-Guest', password: 'short' }), type: 'application/json' });
    expect(short.status).toBe(400); expect(short.json).toEqual({ error: 'Wi-Fi passwords have at least 8 characters.' });
    expect((await http(b, 'POST', '/api/v1/wifi', { body: JSON.stringify({ ssid: 'Neighbour-2G', password: 'whatever1' }), type: 'application/json' })).status).toBe(202);
    expect((await until(() => http(b, 'GET', '/api/v1/wifi'), (r) => r.json.state !== 'connecting')).json).toMatchObject({ state: 'failed', error: 'Wrong password. Try again.' });
    expect((await http(b, 'POST', '/api/v1/wifi', { body: JSON.stringify({ ssid: 'HomeNet-Guest', password: 'password1' }), type: 'application/json' })).status).toBe(202);
    await until(() => http(b, 'GET', '/api/v1/wifi'), (r) => r.json.state === 'connected');
    cs = await http(b, 'GET', '/api/v1/console/state');
    expect(cs.json).toMatchObject({ setup: 'web', softap: false, wifi: { connected: 'HomeNet-Guest' }, seed_pending: true });
    expect((await http(b, 'GET', '/__sim/state')).json.screen).toBe('setup_web');
    const s = await signIn(b, { returnTo: '/setup' });
    expect(s.res.status).toBe(302); expect(s.res.headers.get('location')).toBe('/setup');
    cs = await http(b, 'GET', '/api/v1/console/state', { cookie: s.cookie });
    expect(cs.json).toMatchObject({ setup: null, home_assistant: { linked: true }, session: { signed_in: true, admin: true } });
    const st = await until(() => http(b, 'GET', '/__sim/state'), (r) => r.json.ha.connected);
    expect(st.json.screen).toBe('overview');
    expect((await http(b, 'GET', '/api/v1/console/state')).json.seed_pending).toBe(false);
    expect(r2.fakeHa!.templateErrors).toEqual([]);   // no undefined attribute reads real HA would report (#58)
    expect(st.json.events.map((e: any) => e.reason)).toContain('welcome · live data');
    // After setup the Wi-Fi endpoints need a session again… unless never linked; linked now → 401.
    expect((await http(b, 'GET', '/api/v1/wifi')).status).toBe(401);
    expect((await http(b, 'DELETE', '/api/v1/ha', { cookie: s.cookie })).status).toBe(204);
    expect((await http(b, 'GET', '/api/v1/status', { token: null })).status).toBe(401);
    expect((await http(b, 'GET', '/api/v1/console/state')).json.home_assistant.linked).toBe(false);
  });
});

describe.skipIf(REAL)('first sign-in on a real-shaped Dutch house (separate simulators, #82)', () => {
  for (const house of ['dutch', 'dutch-energy'] as const) it(house + ': the seeded home tiles all exist in HA', async () => {
    const r = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', house, delays: FAST });
    try {
      const s = await signIn(r.url);
      expect(s.res.status, s.res.text).toBe(302);
      await until(() => http(r.url, 'GET', '/api/v1/console/state', { cookie: s.cookie }), (x) => x.json.seed_pending === false);
      const ids = await expectSeededEntitiesExist(r.url, s.cookie, [...r.fakeHa!.states.keys()]);
      expect(ids).toEqual(expect.arrayContaining(['sensor.solaredge_i1_ac_power', 'sensor.p1_meter_power', 'sensor.anker_solix_home_load', 'sensor.anker_solix_soc', 'sensor.buienradar_temperature']));
      // #89: the report names the same entities and says why the rest is missing
      const rep = await http(r.url, 'GET', '/api/v1/seed', { cookie: s.cookie });
      expect(rep.status, rep.text).toBe(200);
      expectSeedReport(rep.json);
      expect(rep.json.dismissed).toBe(false);
      for (const t of rep.json.tiles) if (t.entity && t.tile !== 'price') expect(ids).toContain(t.entity);
      const by = Object.fromEntries(rep.json.tiles.map((t: any) => [t.tile, t]));
      expect(by.solar_power).toMatchObject({ entity: 'sensor.solaredge_i1_ac_power', rule: house === 'dutch' ? 'name' : 'device' });
      expect(by.energy_today).toEqual({ tile: 'energy_today', screen: 'energy', why: 'no_sensor' });
      expect(by.usage_chart).toMatchObject(house === 'dutch' ? { why: 'no_energy' } : { rule: 'energy' });
    } finally { await r.close(); }
  });
});

describe.skipIf(REAL)('one sign-in with a non-admin account (separate simulator, #22)', () => {
  let r4: RunningSim;
  beforeAll(async () => { r4 = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', delays: FAST }); });
  afterAll(async () => { await r4.close(); });
  it('links the display, opens a view-only console; an admin sign-in afterwards gets full access, the key stays', async () => {
    const b = r4.url;
    const s = await signIn(b, { user: 'X4 display', admin: false, returnTo: '/link' });
    expect(s.res.status).toBe(302); expect(s.res.headers.get('location')).toBe('/link'); expect(s.cookie).toBeTruthy();
    const cs = await http(b, 'GET', '/api/v1/console/state', { cookie: s.cookie });
    expect(cs.json).toMatchObject({ setup: null, home_assistant: { linked: true, user: 'X4 display' }, session: { signed_in: true, admin: false } });
    await until(() => http(b, 'GET', '/__sim/state'), (x) => x.json.ha.connected);
    // Advanced route: the display keeps the dedicated user's key; the owner signs in with an admin account to edit.
    const a = await signIn(b, { user: 'user' });
    expect(a.cookie).toBeTruthy();
    const ca = await http(b, 'GET', '/api/v1/console/state', { cookie: a.cookie });
    expect(ca.json).toMatchObject({ home_assistant: { user: 'X4 display' }, session: { signed_in: true, user: 'user', admin: true } });
    expect((await http(b, 'POST', '/api/v1/tokens', { cookie: a.cookie, body: '{"name":"t","scope":"read"}', type: 'application/json' })).status).toBe(201);
  });
});

describe.skipIf(REAL)('Home Assistant address on the link page (separate simulator, #54)', () => {
  let r5: RunningSim;
  beforeAll(async () => { r5 = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', delays: FAST }); });
  afterAll(async () => { await r5.close(); });
  it('mDNS answer is "discovered"; a bad, dead or non-HA address → 422/502 with need: ha_url and nothing remembered', async () => {
    const cs = await http(r5.url, 'GET', '/api/v1/console/state');
    expect(cs.json.home_assistant).toMatchObject({ linked: false, server: r5.haUrl, discovered: [r5.haUrl] });
    const notHa = await http(r5.url, 'POST', '/api/v1/auth/ha/start', { body: JSON.stringify({ ha_url: r5.url }), type: 'application/json' });
    expect(notHa.status, notHa.text).toBe(422); expect(notHa.json).toEqual({ error: r5.url + ' answers, but it is not Home Assistant.', need: 'ha_url' });
    expect((await http(r5.url, 'GET', '/api/v1/console/state')).json.home_assistant.server).toBe(r5.haUrl);
    await checkHaAddress(r5.url, r5.haUrl);
  }, 30_000);
});

describe.skipIf(REAL)('linking alternatives, restart, factory reset, rate limit (separate simulator)', () => {
  let r3: RunningSim;
  beforeAll(async () => { r3 = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', delays: FAST }); });
  afterAll(async () => { await r3.close(); });
  it('GET /link?p=CODE (pairing code from the display) 302s to HA once; a used code → 400', async () => {
    const code = (await http(r3.url, 'GET', '/__sim/state')).json.pairing_code;
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    const r = await http(r3.url, 'GET', '/link?p=' + code);
    expect(r.status).toBe(302); expect(r.headers.get('location')).toContain('/auth/authorize?');
    expect((await http(r3.url, 'GET', '/link?p=' + code)).status).toBe(400);
    expect((await http(r3.url, 'GET', '/link')).status).toBe(200); // the console page
  });
  it('POST /ha/url (setup-open) and POST /ha/token (long-lived token) link the display', async () => {
    expect((await http(r3.url, 'POST', '/api/v1/ha/url', { body: '{"url":"not a url"}', type: 'application/json' })).status).toBe(422);
    expect((await http(r3.url, 'POST', '/api/v1/ha/url', { body: JSON.stringify({ url: r3.haUrl }), type: 'application/json' })).status).toBe(200);
    expect((await http(r3.url, 'POST', '/api/v1/ha/discover')).status).toBe(202);
    expect((await http(r3.url, 'POST', '/api/v1/ha/token', { body: '{"token":"nope"}', type: 'application/json' })).status).toBe(401);
    const t = r3.fakeHa!.issueLongLived('user', true);
    const r = await http(r3.url, 'POST', '/api/v1/ha/token', { body: JSON.stringify({ token: t }), type: 'application/json' });
    expect(r.status).toBe(200); expect(r.json).toEqual({ status: 'linked', user: 'user' });
    const cookie = cookieOf(r.headers); expect(cookie).toBeTruthy();
    await until(() => http(r3.url, 'GET', '/__sim/state'), (x) => x.json.ha.connected);
    expect((await http(r3.url, 'POST', '/api/v1/ha/url', { cookie, body: JSON.stringify({ url: r3.haUrl }), type: 'application/json' })).status).toBe(409);
    const tok = (await http(r3.url, 'POST', '/api/v1/tokens', { cookie, body: '{"name":"t","scope":"write"}', type: 'application/json' })).json.token;
    expect((await http(r3.url, 'POST', '/api/v1/device/restart', { token: tok })).status).toBe(202);
    await until(() => http(r3.url, 'GET', '/__sim/state'), (x) => x.json.mode === 'main' && x.json.ha.connected && x.json.events.some((e: any) => /restart/.test(e.reason)));
    expect((await http(r3.url, 'POST', '/api/v1/device/factory-reset', { token: tok })).status).toBe(401); // session only
    expect((await http(r3.url, 'POST', '/api/v1/device/factory-reset', { cookie })).status).toBe(202);
    const cs = await until(() => http(r3.url, 'GET', '/api/v1/console/state'), (x) => x.json.setup === 'wifi');
    expect(cs.json).toMatchObject({ home_assistant: { linked: false }, wifi: { connected: null, saved: [] } });
    expect((await http(r3.url, 'GET', '/api/v1/status', { token: tok })).status).toBe(401);
    expect((await http(r3.url, 'POST', '/api/v1/auth/ha/start', { body: '{}', type: 'application/json' })).status).toBe(409); // SoftAP: join Wi-Fi first
  });
  it('deep sleep (simulated): refused by the power rules, no answer while asleep, USB plugged wakes it', async () => {
    const ctl = (b: object) => http(r3.url, 'POST', '/__sim/control', { body: JSON.stringify(b), type: 'application/json' });
    await ctl({ preset: 'installed' });
    expect((await http(r3.url, 'GET', '/api/v1/status')).status).toBe(401);   // an API request …
    const recent = await ctl({ sleep: true });
    expect(recent.status).toBe(409); expect(recent.json.error).toBe('stays awake: recent api');   // … keeps it awake for 2 min
    await ctl({ usb: true });
    expect((await ctl({ api_idle: true, sleep: true })).json.error).toBe('stays awake: external power');
    await ctl({ usb: false });
    const ok = await ctl({ api_idle: true, sleep: true });
    expect(ok.status).toBe(200); expect(ok.json.power.asleep).toBeTruthy();
    await expect(fetch(r3.url + '/api/v1/status')).rejects.toThrow();   // radio off: no answer at all
    expect((await ctl({ usb: true })).json.power).toMatchObject({ usb: true, asleep: null });   // charger wake → reset
    expect((await http(r3.url, 'GET', '/__sim/state')).json.events.some((e: any) => /wake · charger/.test(e.reason))).toBe(true);
    await ctl({ usb: false });
  });
  it('429 + Retry-After after 5 failed token attempts', async () => {
    r3.sim.authFailures.clear();
    for (let i = 0; i < 5; i++) expect((await http(r3.url, 'GET', '/api/v1/status', { token: 'x4_wrong' + i })).status).toBe(401);
    const r = await http(r3.url, 'GET', '/api/v1/status', { token: 'x4_wrong' });
    expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('60');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// #57: a real HA (800 entities) — building the console's entity list split internal RAM below the TLS guard
// (#79: largest block >= 20 KB and internal free >= 64 KB, core/net_policy.h).
describe.skipIf(REAL && !FAKE)('entity picker on a big house (#57)', () => {
  const bigHouse = async (n: number) => { if (FAKE) await fakeCtl('big-house', { n }); else run!.fakeHa!.bigHouse(n); };
  afterAll(async () => { await bigHouse(0); });
  // A health report (#32) opens a second TLS session next to the WebSocket for a few seconds under TCG (~45 KB): sample
  // the heap outside that window (#123), the thresholds stay.
  const heapSettled = () => until(() => http(base, 'GET', '/api/v1/status', { token: rw }),
    (r) => r.json.free_heap >= 65536 && r.json.heap_largest_block >= 20480, 15_000);
  it('+1200 entities with long attributes: list capped at 800, opened 6×; TLS-sized heap block left, HA stays linked', async () => {
    await bigHouse(1200);
    await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => r.json.home_assistant === 'linked', 60_000);
    for (let i = 0; i < 6; i++) {
      const r = await until(() => http(base, 'GET', '/api/v1/ha/entities', { token: rw }), (x) => x.status === 200 && x.json?.ready === true, 60_000);
      expect(r.json.entities.length).toBe(800);
      // state (#84): HA's value when the list was read, shown in the console's entity picker
      expect(r.json.entities[0]).toMatchObject({ id: expect.stringMatching(/^[a-z_]+\.[a-z0-9_]+$/), name: expect.any(String), unit: expect.any(String), state: expect.any(String) });
      expect(r.json.entities.filter((e: { state: string }) => e.state !== '').length, 'entities with a state').toBeGreaterThan(0);
      expect(r.json.entities.some((e: { name: string }) => e.name.includes('"'))).toBe(true);   // quotes in names survive
      const s = await heapSettled();
      expect(s.json.heap_largest_block, 'largest free internal block').toBeGreaterThanOrEqual(20480);
      expect(s.json.free_heap, 'internal free').toBeGreaterThanOrEqual(65536);
      expect(s.json.home_assistant).toBe('linked');
    }
    await new Promise((r) => setTimeout(r, 3000));   // a dropped TLS socket shows up as "offline" within seconds
    const s = await heapSettled();
    expect(s.json.home_assistant).toBe('linked');
    expect(s.json.heap_largest_block).toBeGreaterThanOrEqual(20480);
    expect(s.json.free_heap).toBeGreaterThanOrEqual(65536);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// #127: lightList / zoneList picks: areas / entities in screens.yaml; the console's list picker reads areas, area ids
// and climate entities from GET /ha/entities. After #57: the entity list is cached (5 min), and that test needs the
// first read.
// #159: Settings is a fixed, built-in app. A config without it still shows it on the display, and PUT /settings shows
// up on its pages. Simulator: /__sim/state apps + screen; QEMU: the panel text (GET /__qemu/regions) after Home → Home
// (app switcher) → tap the second tile (the user's one app, then Settings).
describe.skipIf(NO_RW)('built-in Settings (#159)', () => {
  const put = (yaml: string) => http(base, 'PUT', '/api/v1/config', { token: rw, body: yaml, type: 'application/yaml' });
  const putSettings = (b: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify(b), type: 'application/json' });
  const panel = async () => { const r = await http(base, 'GET', '/__qemu/regions'); return r.status === 200 && /^text\/plain/.test(r.headers.get('content-type') || '') ? r.text : null; };
  const notBusy = async () => { for (let i = 0; i < 240 && (await http(base, 'GET', '/__qemu/state')).json?.busy === true; i++) await new Promise((r) => setTimeout(r, 500)); };
  const input = (q: string) => http(base, 'POST', '/__qemu/input?' + q);
  let original = '', warmth = 40;
  beforeAll(async () => {
    original = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
    warmth = (await http(base, 'GET', '/api/v1/settings', { token: rw })).json.display.warmth;
  });
  afterAll(async () => {
    // leave Settings first: a config push keeps the display on the page it shows, and the Settings pages always exist
    if (sim) await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ screen: 'only' }), type: 'application/json' });
    else if (await panel()) {
      // after 60 s idle the first key only brings the chrome / light back (#27, #220): press until the panel left Settings
      const state = () => http(base, 'GET', '/__qemu/state');
      for (let k = 0; k < 3 && (await state()).json?.screen !== 'only'; k++) {
        await notBusy(); await input('key=home'); await notBusy();
        await until(state, (r) => r.json?.screen === 'only', 15_000).catch(() => null);
      }
      expect((await state()).json?.screen, 'Home leaves the Settings page').toBe('only');
    }
    if (original) expect((await put(original)).status).toBe(200);
    await putSettings({ display: { warmth } });
  });

  it('a config without Settings screens: GET /config has none, the display keeps the Settings app; PUT /settings shows on its page', async () => {
    const yaml = 'version: 1\napps:\n  - id: home\n    title: Home\nscreens:\n  - id: only\n    app: home\n    title: Only\n    widgets:\n      - {type: clock, cs: 2}\n';
    expect((await put(yaml)).status).toBe(200);
    const g = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
    expect(g).not.toMatch(/app: settings|type: (setting|ota|wifi|ha|about)\b/);
    // an older file with Settings screens and tiles is accepted; they are dropped, not stored
    const legacy = yaml + '  - id: display\n    app: settings\n    title: Display\n    widgets:\n      - {type: setting, key: night}\n';
    expect((await put(legacy)).status).toBe(200);
    expect((await http(base, 'GET', '/api/v1/config', { token: rw })).text).toBe(g);
    const w = warmth === 30 ? 70 : 30;
    expect((await putSettings({ display: { warmth: w } })).status).toBe(200);
    if (sim) {
      expect((await simState()).apps).toEqual(['home', 'settings']);
      expect((await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ screen: 'display' }), type: 'application/json' })).status).toBe(200);
      expect((await simState()).screen).toBe('display');
      return;
    }
    if (!(await panel())) return;   // a real panel: no region text
    await notBusy();
    // on the first screen Home opens the app switcher (a first press may only wake the display)
    for (let k = 0; k < 3 && !/^menu\t/m.test((await panel()) || ''); k++) {
      await input('key=home'); await notBusy();
      await until(panel, (t) => !!t && /^menu\t/m.test(t), 15_000).catch(() => null);
    }
    await until(panel, (t) => !!t && /^menu\t.*(Settings|Instellingen)/m.test(t), 30_000);
    await input('tap=300,170'); await notBusy();   // classic or sleek: the second app tile
    await until(panel, (t) => !!t && t.includes(w + '%') && /warmth|warmte/i.test(t), 60_000);
  }, REAL ? 300_000 : 20_000);
});

describe('lightList / zoneList picks (#127)', () => {
  const H = 'version: 1\nscreens:\n  - id: picks\n    app: house\n    title: Picks\n    widgets:\n';
  it.skipIf(NO_RW)('validate: space-separated area ids / light / climate entities; a name or a wrong domain → 422 with the line', async () => {
    const ok = H + '      - {type: lightList, areas: living kitchen, entities: light.hall_stairs, cs: 4}\n      - {type: zoneList, entities: climate.living climate.office, cs: 4}\n';
    expect((await http(base, 'POST', '/api/v1/config/validate', { token: rw, body: ok, type: 'application/yaml' })).status).toBe(200);
    const area = await http(base, 'POST', '/api/v1/config/validate', { token: rw, body: H + '      - {type: lightList, areas: living Living Room}\n', type: 'application/yaml' });
    expect(area.status).toBe(422); expect(area.json).toMatchObject({ line: 7, message: 'lightList: “Living” is not an area id' });
    const zone = await http(base, 'POST', '/api/v1/config/validate', { token: rw, body: H + '      - {type: zoneList, entities: sensor.living_temperature}\n', type: 'application/yaml' });
    expect(zone.status).toBe(422); expect(zone.json.message).toBe('zoneList: “sensor.living_temperature” is not a climate entity');
  });
  it.skipIf(NO_RW)('PUT a pick → GET writes it back unchanged (YAML and JSON)', async () => {
    const original = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
    const lines = original.split('\n');
    const at = lines.findIndex((l) => l.includes('{type: lightList')); expect(at).toBeGreaterThan(0);
    lines[at] = '      - {type: lightList, areas: kitchen living, entities: light.hall_stairs, cs: 4, rs: 2}';
    const z = lines.findIndex((l) => l.includes('{type: zoneList'));
    if (z > 0) lines[z] = '      - {type: zoneList, entities: climate.office climate.living, cs: 4, rs: 2}';
    try {
      expect((await http(base, 'PUT', '/api/v1/config', { token: rw, body: lines.join('\n'), type: 'application/yaml' })).status).toBe(200);
      const y = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
      expect(y).toContain(lines[at] + '\n');
      const j = await http(base, 'GET', '/api/v1/config', { token: rw, accept: 'application/json' });
      expect(j.json.screens.flatMap((s: any) => s.widgets).find((w: any) => w.type === 'lightList')).toMatchObject({ areas: 'kitchen living', entities: 'light.hall_stairs' });
    } finally {
      const pre = await refreshCounts();
      expect((await http(base, 'PUT', '/api/v1/config', { token: rw, body: original, type: 'application/yaml' })).status).toBe(200);
      await fullLanded(pre);
    }
  });
  it.skipIf(REAL && !FAKE)('GET /ha/entities: areas in registry order, area ids on lights, climate entities listed', async () => {
    await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => r.json.home_assistant === 'linked', 60_000);
    const r = await until(() => http(base, 'GET', '/api/v1/ha/entities', { token: rw }), (x) => x.status === 200 && x.json?.ready === true, 60_000);
    expect(r.json.areas[0]).toEqual({ id: 'living', name: 'Living room' });
    expect(r.json.entities.find((e: { id: string }) => e.id === 'light.living_ceiling')).toMatchObject({ area: 'living' });
    expect(r.json.entities.find((e: { id: string }) => e.id === 'climate.office')).toMatchObject({ unit: expect.any(String), area: 'office' });
    expect(r.json.entities.filter((e: { id: string }) => e.id.startsWith('climate.')).length).toBeGreaterThanOrEqual(4);
  });
  it.skipIf(REAL && !FAKE)('GET /ha/entities lists (#134): climate / lights in HA and what an unpicked list shows (80 cap)', async () => {
    const r = await until(() => http(base, 'GET', '/api/v1/ha/entities', { token: rw }), (x) => x.status === 200 && x.json?.ready === true && x.json.lists?.lights.total > 0, 60_000);
    // totals follow HA now (the entity list may be up to 5 min older: the #57 test adds and removes the big house)
    const { climate, lights } = r.json.lists;
    expect(climate.total).toBeGreaterThanOrEqual(4);
    expect({ climate, lights }).toEqual(listCounts(climate.total, lights.total));
    // #150: entities in HA vs rows sent (800 at most)
    expect(r.json.lists.entities.shown).toBe(Math.min(800, r.json.lists.entities.total));
    expect(r.json.entities).toHaveLength(r.json.lists.entities.shown);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// #88: a house shaped like a real HA (fake-ha-real.ts: ~1050 entities, areas via devices, registry display_precision,
// unavailable / unknown, emoji and quotes in names). The simulator runs it on its own; real firmware opts in with
// FAKE_HA_HOUSE=real X4_VITEST_ARGS="-t #88" sim/qemu/contract.sh (the suite's beforeAll then signs in on this house:
// seed, template errors and seeded entities are checked there too).
const FAKE_HOUSE: string = FAKE ? String((await fakeCtl('state')).house ?? '') : '';
describe.skipIf(REAL && FAKE_HOUSE !== 'real')('real-shaped house (#88)', () => {
  const PICKABLE = LIST_BUDGET.map(([d]) => d);
  const devArea = new Map(REAL_DEVICES.map((d) => [d.id, d.area]));
  const areaOf = (e: RealEntity) => e.area ?? (e.device ? devArea.get(e.device) : null) ?? '';
  const byId = new Map(REAL_ENTITIES.map((e) => [e.id, e]));
  let r8: RunningSim | null = null;
  let b = '', cookie: string | null = null, tok: string | null = null;
  const haIds = async (): Promise<string[]> => (r8 ? [...r8.fakeHa!.states.keys()] : fakeCtl('entities'));
  const templateErrors = async (): Promise<string[]> => (r8 ? r8.fakeHa!.templateErrors : fakeCtl('template-errors'));
  beforeAll(async () => {
    if (REAL) { b = base; cookie = session; tok = rw; return; }
    r8 = await startSimulator({ port: 0, fakeHaPort: 0, haTickMs: 0, preset: 'never-linked', house: 'real', delays: FAST });
    b = r8.url;
    const s = await signIn(b); expect(s.res.status, s.res.text).toBe(302); cookie = s.cookie;
    await until(() => http(b, 'GET', '/api/v1/console/state', { cookie }), (x) => x.json.seed_pending === false, 15_000);
    const t = await http(b, 'POST', '/api/v1/tokens', { cookie, body: JSON.stringify({ name: 'contract-88', scope: 'write' }), type: 'application/json' });
    expect(t.status).toBe(201); tok = t.json.token;
  }, 60_000);
  afterAll(async () => { await r8?.close(); });

  it('seed: no undefined attribute reads, every tile names an entity HA has, the report adds up', async () => {
    expect(await templateErrors()).toEqual([]);
    const ids = await expectSeededEntitiesExist(b, cookie, await haIds());
    expect(ids.length).toBeGreaterThan(5);
    const rep = await http(b, 'GET', '/api/v1/seed', { token: tok });
    expect(rep.status, rep.text).toBe(200);
    expectSeedReport(rep.json);
    const by = Object.fromEntries(rep.json.tiles.map((t: any) => [t.tile, t]));
    expect(by.price).toMatchObject({ entity: 'sensor.nordpool_kwh_nl_eur_3_10_021', rule: 'energy' });
    expect(by.solar_power).toMatchObject({ entity: 'sensor.envoy_482100000000_current_power_production', rule: 'energy' });   // stat_rate
    expect(by.lights).toMatchObject({ rule: 'found' }); expect(by.heating).toMatchObject({ rule: 'found' });
    expect(by.rooms).toMatchObject({ rule: 'area' });
    // #136: real thermometers, not Zigbee chip temperatures; Envoy for home use / solar today; no weekly counter or
    // Envoy consumption as grid import / export (the grid meters have no today sensor)
    expect(by.inside).toMatchObject({ entity: 'sensor.co2_living_room_temperature', rule: 'area' });
    expect(by.outside).toMatchObject({ entity: 'sensor.shelly_ht_outdoor_temperature', rule: 'name' });
    expect(by.home_power).toMatchObject({ entity: 'sensor.envoy_482100000000_current_power_consumption', rule: 'name' });
    expect(by.solar_today).toMatchObject({ entity: 'sensor.envoy_482100000000_energy_production_today', rule: 'name' });
    expect(by.grid_import_today).toMatchObject({ why: 'no_sensor' }); expect(by.grid_export_today).toMatchObject({ why: 'no_sensor' });
    // #152: not the forecast's max of today (outside above), not the dryer plug's "today consumption" (imported / used today)
    expect(by.energy_today).toMatchObject({ entity: 'sensor.home_energy_usage_today', rule: 'name' });
    // room labels are HA's area names, '&' included; the Tesla's climate is not a heating zone
    const cfg = (await http(b, 'GET', '/api/v1/config', { token: tok })).text;
    expect(cfg).toContain('label: Playroom & Study}');
    expect(cfg).not.toContain('_device_temperature');
    expect(cfg).toContain('{type: zoneList, entities: climate.attic climate.bathroom climate.bedroom climate.kitchen climate.living_room climate.playroom, cs: 4, rs: 2}');
    // #152: the Better-Thermostat-style wrapper is no zone (above); per room its Hue group, not the second group or the
    // bulbs; rooms without a group keep their bulbs; the two lights without an area are left out
    expect(cfg).toContain('{type: lightList, entities: light.living_room light.kitchen light.hallway light.toilet light.bedroom light.desk_lamp_playroom light.playroom light.guest_room_lamp light.bathroom_mirror light.office_desk light.attic_tube_light light.garage_lamp light.outdoor light.driveway_spot, cs: 4, rs: 2}');
  });

  it('GET /ha/entities (#150): a fair 800 (every switch / weather / climate / light), the cut says so; names / states / units as HA has them, areas via the device', async () => {
    const pickable = REAL_ENTITIES.filter((e) => PICKABLE.includes(e.id.split('.')[0]));
    expect(pickable.length).toBeGreaterThan(800);
    const r = await until(() => http(b, 'GET', '/api/v1/ha/entities', { token: tok }), (x) => x.status === 200 && x.json?.ready === true, 60_000);
    expect(r.json.areas).toEqual(REAL_AREAS.map(([id, name]) => ({ id, name })));
    const got: { id: string; name: string; unit: string; state: string; area?: string }[] = r.json.entities;
    // capped at 800; besides the fixture HA has the display's own health entities (#32, posted meanwhile)
    expect(got).toHaveLength(800);
    expect(r.json.lists.entities.shown).toBe(800);
    expect(r.json.lists.entities.total).toBeGreaterThanOrEqual(pickable.length);
    const ids = new Set(got.map((e) => e.id));
    for (const d of ['switch', 'weather', 'climate', 'light', 'input_boolean', 'fan', 'scene', 'script']) {   // scene / script: #146
      const missing = pickable.filter((e) => e.id.startsWith(d + '.') && !ids.has(e.id)).map((e) => e.id);
      expect(missing, d + '.* left out').toEqual([]);
    }
    // what the cut drops: only entities without a value or sensors that are no reading (no unit, signal strength)
    const st = (e: RealEntity) => ({ entity_id: e.id, state: e.state, attributes: e.attrs });
    const dropped = pickable.filter((e) => !ids.has(e.id));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.filter((e) => !listLowValue(st(e))).map((e) => e.id)).toEqual([]);
    const off = got.filter((e) => {
      const h = byId.get(e.id); if (!h) return false;
      const want = listReading(st(h));
      return e.name !== String(h.attrs.friendly_name ?? e.id) || e.unit !== want.unit || e.state !== want.state || (e.area ?? '') !== areaOf(h);
    });
    expect(off.slice(0, 5)).toEqual([]);
    const at = (id: string) => got.find((e) => e.id === id);
    expect(at('light.living_room_ceiling')).toMatchObject({ area: 'living_room' });   // area of its device only
    expect(at('light.kitchen')).toMatchObject({ area: 'kitchen' });                  // own area; the bridge is in utility
    expect(at('light.hue_color_lamp_3')?.area ?? '').toBe('');                      // no area anywhere
    expect(at('light.kitchen_spot_3')).toMatchObject({ state: 'unavailable', area: 'kitchen' });
    expect(at('light.playroom')?.name).toBe('Playroom "starry sky"');
    expect(at('light.living_room_reading_lamp')?.name).toBe('Reading lamp 📖');
    expect(at('climate.living_room')).toMatchObject({ unit: '°C', state: '20.83' });   // #161: the temperature, not "auto"
    expect(at('climate.attic')).toMatchObject({ unit: '', state: 'unavailable' });
    expect(at('weather.forecast_home')).toMatchObject({ unit: '°C', state: '10.9' });
    expect(at('switch.coffee_maker')).toBeDefined();
  });

  it('lightList / zoneList picks (#127) on HA\'s own area ids: validate, PUT, GET writes them back', async () => {
    const H = 'version: 1\nscreens:\n  - id: picks\n    app: house\n    title: Picks\n    widgets:\n';
    const ok = H + '      - {type: lightList, areas: living_room kids_room office, entities: light.hue_color_lamp_3, cs: 4}\n      - {type: zoneList, entities: climate.living_room climate.bathroom, cs: 4}\n';
    expect((await http(b, 'POST', '/api/v1/config/validate', { token: tok, body: ok, type: 'application/yaml' })).status).toBe(200);
    const name = await http(b, 'POST', '/api/v1/config/validate', { token: tok, body: H + '      - {type: lightList, areas: Office 🖥️}\n', type: 'application/yaml' });
    expect(name.status).toBe(422); expect(name.json).toMatchObject({ line: 7, message: 'lightList: “Office” is not an area id' });
    const original = (await http(b, 'GET', '/api/v1/config', { token: tok })).text;
    const lines = original.split('\n');
    const li = lines.findIndex((l) => l.includes('{type: lightList')); expect(li).toBeGreaterThan(0);
    const zi = lines.findIndex((l) => l.includes('{type: zoneList')); expect(zi).toBeGreaterThan(0);
    lines[li] = '      - {type: lightList, areas: kids_room living_room, entities: light.hue_color_lamp_3 light.kitchen, cs: 4, rs: 2}';
    lines[zi] = '      - {type: zoneList, entities: climate.bathroom climate.living_room, cs: 4, rs: 2}';
    try {
      const put = await http(b, 'PUT', '/api/v1/config', { token: tok, body: lines.join('\n'), type: 'application/yaml' });
      expect(put.status, put.text).toBe(200);
      const y = (await http(b, 'GET', '/api/v1/config', { token: tok })).text;
      expect(y).toContain(lines[li] + '\n'); expect(y).toContain(lines[zi] + '\n');
      const w = (await http(b, 'GET', '/api/v1/config', { token: tok, accept: 'application/json' })).json.screens.flatMap((s: any) => s.widgets);
      expect(w.find((x: any) => x.type === 'lightList')).toMatchObject({ areas: 'kids_room living_room', entities: 'light.hue_color_lamp_3 light.kitchen' });
      expect(w.find((x: any) => x.type === 'zoneList')).toMatchObject({ entities: 'climate.bathroom climate.living_room' });
    } finally {
      const pre = await refreshCounts();
      expect((await http(b, 'PUT', '/api/v1/config', { token: tok, body: original, type: 'application/yaml' })).status).toBe(200);
      await fullLanded(pre);
    }
  });

  it('values view (#122): every seeded screen, and unavailable / unknown / switch / gauge tiles', async () => {
    const cfg = (await http(b, 'GET', '/api/v1/config', { token: tok, accept: 'application/json' })).json;
    const values = (id: string) => until(() => http(b, 'GET', '/api/v1/screens/' + id + '/values', { token: tok }), (x) => x.status !== 200 || x.json.ready === true, 15_000);
    for (const sc of cfg.screens.filter((s: any) => s.app !== 'settings')) {
      const r = await values(sc.id);
      expect(r.status, sc.id).toBe(200);
      expect(r.json.values, sc.id).toHaveLength(sc.widgets.length);
      for (const v of r.json.values) expect(v, sc.id).not.toMatch(/undefined|NaN|null/);
    }
    const original = (await http(b, 'GET', '/api/v1/config', { token: tok })).text;
    const lang = (await http(b, 'GET', '/api/v1/status', { token: tok })).json.language === 'nl' ? 'nl' : 'en';
    const tiles: [string, string][] = [
      ['{type: stat, entity: sensor.rain_gauge_battery}', tr(lang, 'gapUnavailable')],
      ['{type: stat, entity: sensor.rain_gauge_precipitation_today}', tr(lang, 'gapUnknown')],
      ['{type: switch, entity: switch.christmas_tree}', tr(lang, 'gapUnavailable')],
      ['{type: switch, entity: switch.coffee_maker}', tr(lang, byId.get('switch.coffee_maker')!.state === 'on' ? 'on' : 'off')],
      ['{type: gauge, entity: sensor.car_battery_level}', '71%'],
      ['{type: stat, entity: sensor.weather_station_outdoor_temperature}', '10.4 °C'],   // registry display_precision 1
    ];
    const yaml = original.replace(/\nscreens:\n/, '\nscreens:\n  - id: x88\n    app: house\n    title: Example house\n    widgets:\n' + tiles.map(([t]) => '      - ' + t + '\n').join('') +
      '  - id: x161\n    app: house\n    title: Climate\n    widgets:\n      - {type: stat, entity: climate.living_room}\n      - {type: stat, entity: weather.forecast_home}\n' +
      '      - {type: zoneList, entities: climate.living_room climate.bathroom climate.kitchen, cs: 2}\n      - {type: lightList, entities: light.kitchen light.living_room_ceiling, cs: 2}\n');
    try {
      const put = await http(b, 'PUT', '/api/v1/config', { token: tok, body: yaml, type: 'application/yaml' });
      expect(put.status, put.text).toBe(200);
      const r = await until(() => values('x88'), (x) => x.status === 200 && x.json.values.every((v: string) => v !== '—'), 30_000).catch(() => values('x88'));
      expect(r.json.values).toEqual(tiles.map(([, v]) => v));
      // #161: a climate / weather stat shows the temperature; list tiles count what they show
      const v = await until(() => values('x161'), (x) => x.status === 200 && x.json.values.every((s: string) => s !== '—'), 30_000).catch(() => values('x161'));
      const lit = ['light.kitchen', 'light.living_room_ceiling'].filter((id) => byId.get(id)!.state === 'on').length;
      expect(v.json.values).toEqual([expect.stringMatching(/^\d+[.,]\d °C$/), '10.9 °C', tr(lang, 'nOfHeating', 2, 3), tr(lang, 'lightsOnOf', lit, 2)]);
    } finally {
      const pre = await refreshCounts();
      expect((await http(b, 'PUT', '/api/v1/config', { token: tok, body: original, type: 'application/yaml' })).status).toBe(200);
      await fullLanded(pre);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// #98: the display follows HA's language (get_config `language`, asked after every auth_ok): nl → nl, others → en.
describe.skipIf(REAL && !FAKE)('language from Home Assistant (#98)', () => {
  const setLang = async (language: string) => { if (FAKE) await fakeCtl('language', { language }); else run!.fakeHa!.language = language; };
  const reconnect = async () => { if (FAKE) await fakeCtl('drop-ws', {}); else run!.fakeHa!.dropWs(); };
  const status = () => http(base, 'GET', '/api/v1/status', { token: rw });
  afterAll(async () => { await setLang('en'); await reconnect(); await until(status, (r) => r.json?.language === 'en', 60_000); });
  it('GET /status and /console/state report it; a language other than Dutch is English', async () => {
    await until(status, (r) => r.json?.home_assistant === 'linked' && r.json.language === 'en', 60_000);
    await setLang('nl'); await reconnect();
    await until(status, (r) => r.json?.language === 'nl', 60_000);
    expect((await http(base, 'GET', '/api/v1/console/state')).json.language).toBe('nl');
    await setLang('de'); await reconnect();
    await until(status, (r) => r.json?.language === 'en', 60_000);
  });
  // #110: the profile's number_format (frontend/get_user_data "language") is asked after auth_ok too
  it('a profile number_format redraws the display once; an HA answering null keeps the link', async () => {
    const setFmt = async (nf: string | null) => { if (FAKE) await fakeCtl('language', { language: 'en', number_format: nf }); else run!.fakeHa!.numberFormat = nf; };
    const qemu = async () => { const r = await http(base, 'GET', '/__qemu/state'); return r.status === 200 ? r.json : null; };
    const q0 = await qemu();
    try {
      await setFmt('decimal_comma'); await reconnect();
      if (sim) await until(simState, (s) => s.events.some((e: { reason: string }) => e.reason === 'number format'), 60_000);
      if (q0) await until(qemu, (q) => q?.number_format === 'decimal_comma' && q.full > q0.full, 60_000);
    } finally { await setFmt(null); await reconnect(); }
    if (q0) await until(qemu, (q) => q?.number_format === '', 60_000);
    await until(status, (r) => r.json?.home_assistant === 'linked', 60_000);
  });
});

// #147: the clock follows HA's get_config time_zone (a table maps it to POSIX) unless PUT /settings tz overrides it;
// price tiles show HA's currency (GET /status currency).
describe.skipIf(REAL && !FAKE)('time zone and currency from Home Assistant (#147)', () => {
  const setLocale = async (time_zone: string, currency: string) => {
    if (FAKE) await fakeCtl('language', { time_zone, currency }); else { run!.fakeHa!.timeZone = time_zone; run!.fakeHa!.currency = currency; }
  };
  const reconnect = async () => { if (FAKE) await fakeCtl('drop-ws', {}); else run!.fakeHa!.dropWs(); };
  const status = () => http(base, 'GET', '/api/v1/status', { token: rw });
  const settings = () => http(base, 'GET', '/api/v1/settings', { token: rw });
  const put = (b: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify(b), type: 'application/json' });
  let tz0: string | null = null;
  afterAll(async () => {
    await setLocale('Europe/Amsterdam', 'EUR'); if (tz0 !== null) await put({ tz: tz0 });
    await reconnect(); await until(status, (r) => r.json?.currency === 'EUR', 60_000);
  });
  it.skipIf(NO_RW)('HA time_zone is the clock zone unless tz overrides it; an unknown zone keeps it; currency in /status', async () => {
    await until(status, (r) => r.json?.home_assistant === 'linked', 60_000);
    tz0 = (await settings()).json.tz;
    expect((await put({ tz: '' })).status).toBe(200);
    await setLocale('America/New_York', 'USD'); await reconnect();
    await until(status, (r) => r.json?.currency === 'USD', 60_000);
    await until(settings, (r) => r.json?.tz_ha === 'America/New_York', 60_000);
    expect((await settings()).json).toMatchObject({ tz: '', tz_active: 'EST5EDT,M3.2.0,M11.1.0' });
    const p = await put({ tz: 'Europe/London' });
    expect(p.status).toBe(200); expect(p.json).toMatchObject({ tz: 'Europe/London', tz_ha: 'America/New_York', tz_active: 'GMT0BST,M3.5.0/1,M10.5.0' });
    expect((await put({ tz: 'UTC0' })).json.tz_active).toBe('UTC0');
    expect((await put({ tz: '' })).json.tz_active).toBe('EST5EDT,M3.2.0,M11.1.0');
    await setLocale('Mars/Olympus', 'SEK'); await reconnect();
    await until(status, (r) => r.json?.currency === 'SEK', 60_000);
    expect((await settings()).json).toMatchObject({ tz_ha: 'America/New_York', tz_active: 'EST5EDT,M3.2.0,M11.1.0' });
  });
});

// #146: the scene tile runs an HA scene or script; without entity it is all lights off. Tap → the HA service call the
// fake HA records. Simulator: POST /__sim/control {tap: n}; QEMU: /__qemu/input tap at the tile (classic and sleek
// share the grid: 4 × 2 cells from x 14, y 72, a cs 2 tile 380 × 191). Ambient chrome (#27) swallows the first touch
// 60 s after the last input: each tap is preceded by one on the empty fourth cell, so it lands on an awake display (#193).
describe.skipIf(NO_RW || (REAL && !FAKE))('scene tile (#146)', () => {
  const put = (yaml: string) => http(base, 'PUT', '/api/v1/config', { token: rw, body: yaml, type: 'application/yaml' });
  const panel = async () => { const r = await http(base, 'GET', '/__qemu/regions'); return r.status === 200 && /^text\/plain/.test(r.headers.get('content-type') || '') ? r.text : null; };
  const notBusy = async () => { for (let i = 0; i < 240 && (await http(base, 'GET', '/__qemu/state')).json?.busy === true; i++) await sleep(500); };
  const calls = async (): Promise<{ domain: string; service: string; data: Record<string, unknown> }[]> => (FAKE ? fakeCtl('calls') : run!.fakeHa!.calls);
  const setEnt = async (entity_id: string, state: string, name: string) => {
    const attributes = { friendly_name: name };
    if (FAKE) await fakeCtl('state', { entity_id, state, attributes }); else run!.fakeHa!.setState(entity_id, state, attributes);
  };
  const H = 'version: 1\nscreens:\n  - id: scenes\n    title: Scenes\n    widgets:\n';
  const AT = [[204, 167], [600, 167], [204, 366]];
  const awake = async () => {   // a tap on nothing: wakes an ambient display, else only restarts its 60 s idle timer
    await notBusy(); await http(base, 'POST', '/__qemu/input?tap=600,366');
    await until(() => http(base, 'GET', '/__qemu/state'), (r) => r.json?.ambient === false && r.json?.busy !== true, 30_000);
  };
  let original = '';
  beforeAll(async () => { original = (await http(base, 'GET', '/api/v1/config', { token: rw })).text; });
  afterAll(async () => { if (original) expect((await put(original)).status).toBe(200); });

  it('validate: a scene / script entity, a label, the older scene: all_off; another domain → 422 with the line', async () => {
    const v = (y: string) => http(base, 'POST', '/api/v1/config/validate', { token: rw, body: y, type: 'application/yaml' });
    expect((await v(H + '      - {type: scene, entity: scene.contract_movie, cs: 2}\n      - {type: scene, entity: script.contract_bed, label: Bedtime, cs: 2}\n      - {type: scene, scene: all_off, cs: 2}\n')).status).toBe(200);
    const bad = await v(H + '      - {type: clock}\n      - {type: scene, entity: switch.coffee}\n');
    expect(bad.status).toBe(422); expect(bad.json).toMatchObject({ line: 7, message: 'scene: “switch.coffee” is not a scene / script entity' });
  });

  it('tap: scene.turn_on, script.turn_on, light.turn_off all', async () => {
    await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => r.json?.home_assistant === 'linked', 60_000);
    await setEnt('scene.contract_movie', 'unknown', 'Contract movie');
    await setEnt('script.contract_bed', 'off', 'Contract bed');
    expect((await put(H + '      - {type: scene, entity: scene.contract_movie, cs: 2}\n      - {type: scene, entity: script.contract_bed, label: Bedtime, cs: 2}\n      - {type: scene, scene: all_off, cs: 2}\n')).status).toBe(200);
    const q = !sim && !!(await panel());
    if (sim) expect((await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ screen: 'scenes' }), type: 'application/json' })).status).toBe(200);
    else if (q) { await notBusy(); await until(panel, (t) => !!t && t.includes('Contract movie') && t.includes('Bedtime'), 60_000); }
    else return;   // a real panel without region text or touch input
    const want = [{ domain: 'scene', service: 'turn_on', data: { entity_id: 'scene.contract_movie' } },
      { domain: 'script', service: 'turn_on', data: { entity_id: 'script.contract_bed' } },
      { domain: 'light', service: 'turn_off', data: { entity_id: 'all' } }];
    for (let k = 0; k < want.length; k++) {
      const n0 = (await calls()).length;
      if (sim) expect((await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ tap: k }), type: 'application/json' })).status).toBe(200);
      else { await awake(); await http(base, 'POST', '/__qemu/input?tap=' + AT[k].join(',')); }
      const got = await until(calls, (c) => c.slice(n0).some((x) => x.domain === want[k].domain), REAL ? 30_000 : 5000);
      expect(got.slice(n0).filter((x) => x.domain === want[k].domain)).toEqual([want[k]]);
    }
    if (sim) expect((await http(base, 'POST', '/__sim/control', { body: JSON.stringify({ tap: 9 }), type: 'application/json' })).status).toBe(409);
  }, REAL ? 300_000 : 20_000);
});

// #86: one calm state per failure. What the API shows (console/state) and, under QEMU, what the panel draws
// (GET /__qemu/regions: the canvas text of every region). The simulator has no panel text: those checks are skipped.
describe.skipIf(REAL && !FAKE)('failure states (#86)', () => {
  const GAP = 'sensor.contract_gap';
  const setGap = async (state: string) => {
    const attributes = { friendly_name: 'Contract gap', unit_of_measurement: '°C' };
    if (FAKE) await fakeCtl('state', { entity_id: GAP, state, attributes }); else run!.fakeHa!.setState(GAP, state, attributes);
  };
  const panel = async () => { const r = await http(base, 'GET', '/__qemu/regions'); return r.status === 200 && /^text\/plain/.test(r.headers.get('content-type') || '') ? r.text : null; };
  const T = REAL ? 300_000 : 20_000;
  const consoleState = () => http(base, 'GET', '/api/v1/console/state', { cookie: session });
  const status = () => http(base, 'GET', '/api/v1/status', { token: rw });
  const put = (yaml: string) => http(base, 'PUT', '/api/v1/config', { token: rw, body: yaml, type: 'application/yaml' });
  let original = '';
  beforeAll(async () => { original = (await http(base, 'GET', '/api/v1/config', { token: rw })).text; });
  afterAll(async () => { if (original) expect((await put(original)).status).toBe(200); await setGap('12.5'); });

  it('an empty screen: the panel says so and where to add tiles', async () => {
    expect((await put('version: 1\nscreens:\n  - id: blank\n    title: Blank\n    widgets: []\n')).status).toBe(200);
    if (typeof (await http(base, 'GET', '/__qemu/state')).json?.full === 'number') expect(await panel(), 'GET /__qemu/regions').not.toBeNull();
    if (!(await panel())) return;
    await until(panel, (t) => !!t && t.includes(tr('en', 'emptyScreen')), 60_000);
    expect(await panel()).toContain(tr('en', 'addWidgetsAt', '').trim());
  }, T);
  it('an entity unavailable in HA: entity_gaps names it, the tile draws a ring and the reason; back → gone', async () => {
    await until(status, (r) => r.json.home_assistant === 'linked', 60_000);
    await setGap('unavailable');
    expect((await put('version: 1\nscreens:\n  - id: gaps\n    title: Gaps\n    widgets:\n      - { type: stat, entity: ' + GAP + ' }\n')).status).toBe(200);
    await until(consoleState, (r) => r.json.entity_gaps?.[GAP] === 'unavailable', 60_000);
    if (await panel()) await until(panel, (t) => !!t && t.includes(tr('en', 'gapUnavailable')), 60_000);
    await setGap('unknown');
    await until(consoleState, (r) => r.json.entity_gaps?.[GAP] === 'unknown', 60_000);
    if (await panel()) await until(panel, (t) => !!t && t.includes(tr('en', 'gapUnknown')), 60_000);
    await setGap('12.5');
    await until(consoleState, (r) => !(GAP in (r.json.entity_gaps || {})), 60_000);
    expect((await http(base, 'GET', '/api/v1/console/state')).json.entity_gaps, 'not without a session').toEqual({});
    if (await panel()) await until(panel, (t) => !!t && !t.includes(tr('en', 'gapUnknown')), 60_000);
  }, T);
  it('HA unreachable: offline in the API, "since hh:mm" next to the mark on the panel; back → linked', async () => {
    await until(status, (r) => r.json.home_assistant === 'linked', 60_000);
    if (FAKE) await fakeCtl('restart', { down_s: 40 }); else run!.fakeHa!.restart(4000);
    await until(consoleState, (r) => r.json.offline === true, 35_000);
    expect((await status()).json.home_assistant).toBe('offline');
    const q = (await http(base, 'GET', '/__qemu/state')).json;
    // "since" needs the time of the last data, so a set clock (SNTP over slirp)
    if (q?.time > 1_700_000_000) await until(panel, (t) => !!t && /^bar\t.*since \d\d:\d\d/m.test(t), 30_000);
    await until(status, (r) => r.json.home_assistant === 'linked', 150_000);
    if (await panel()) await until(panel, (t) => !!t && !/^bar\t.*since \d\d:\d\d/m.test(t), 30_000);
  }, T);
});

// #87 (CONTRACT_HA_TLS=1): the WebSocket runs over https. A TLS session reset mid-stream, then HA's TLS port accepts and
// never answers the handshake for a while (#79's hang): offline, no watchdog reset, relinked once handshakes work again.
describe.skipIf(!HA_TLS)('HA WebSocket over https (#87)', () => {
  const ha = () => http(base, 'GET', '/api/v1/status', { token: rw });
  it('TLS reset mid-session + hung handshakes for 25 s: offline, then relinks; no watchdog reset', async () => {
    await until(ha, (r) => r.json.home_assistant === 'linked', 60_000);
    const d0 = await diagnostics();
    const s0 = await fakeCtl('state');
    await fakeCtl('tls', { mode: 'hang' });
    try {
      expect((await fakeCtl('tls-reset', {})).reset, 'open https connections').toBeGreaterThanOrEqual(1);
      await until(ha, (r) => r.json.home_assistant === 'offline', 30_000);
      await until(() => fakeCtl('state'), (x: any) => x.tls.accepted.hang > s0.tls.accepted.hang, 90_000);   // a relink met the hang
      await sleep(25_000);
      expect((await ha()).json.home_assistant).toBe('offline');
    } finally { await fakeCtl('tls', { mode: 'ok' }); }
    await until(() => fakeCtl('state'), (x: any) => x.sessions > s0.sessions && x.connections >= 1, 120_000);
    await until(ha, (r) => r.json.home_assistant === 'linked', 60_000);
    const d1 = await diagnostics();
    expectNoWatchdogReset(d1);
    expect(d1.boots.length, 'no reboot').toBe(d0.boots.length);
    expect(d1.uptime_s).toBeGreaterThan(d0.uptime_s);
  });
  // #198: each HA report push opens a second TLS session next to the WebSocket. With a 3-slot reserve it took one
  // 16.7 KB record buffer from the internal heap per push, and over a night on the X4 Pro the largest internal block
  // fell to 17,396 B (TLS refused). Now both sessions live in the reserve: no record buffer from the heap, the largest
  // block holds over WebSocket reconnects + pushes. Report pushes are ≥ 60 s apart (core/ha_report.h kMinGapMs).
  it('WebSocket reconnects + HA report pushes: record buffers never leave the TLS reserve, largest internal block holds (#198)', async () => {
    const poll = async <T,>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number) => until(async () => { const v = await fn(); if (!ok(v)) await sleep(1000); return v; }, ok, ms);
    const q = async () => (await http(base, 'GET', '/__qemu/state')).json;
    const settled = () => poll(q, (x: any) => x.tls_slots === 2 && x.ha === 2, 120_000);   // WebSocket up, no second session
    const putReport = (haReport: boolean) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ display: { haReport } }), type: 'application/json' });
    const lastPost = async () => ((await fakeCtl('posted')) as { t: string }[]).at(-1)?.t ?? '';
    await until(ha, (r) => r.json.home_assistant === 'linked', 60_000);
    const s0 = await settled();
    const largest: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = await lastPost();
      await fakeCtl('drop-ws', {});
      // a relink within the report loop's 5 s check forces nothing: toggle the report off → on (forced push)
      expect((await putReport(false)).status).toBe(200);
      await poll(ha, (r) => r.json.ha_report?.state === 'off', 30_000);
      expect((await putReport(true)).status).toBe(200);
      await poll(lastPost, (t) => t > t0, 180_000);   // after the minimum gap (60 s)
      const s = await settled();
      largest.push(s.largest);
      expect(s.tls_spills, 'record buffers from the internal heap').toBe(s0.tls_spills);
    }
    console.log(`[#198] largest internal block ${s0.largest} → ${largest.join(' → ')} B, tls spills ${s0.tls_spills}`);
    // QEMU moves it by up to 8 KB around a relink (77,812 → 69,620 → 73,716 B); a record buffer is 16.7 KB
    expect(Math.min(...largest), 'largest internal block').toBeGreaterThanOrEqual(s0.largest - 12 * 1024);
    expect((await ha()).json.home_assistant).toBe('linked');
  }, 720_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Real firmware + standalone fake HA (make qemu-contract): live data, entity mapping, unlink + long-lived token, 429.
describe.skipIf(!FAKE)('real firmware with the fake HA', () => {
  const png = async () => Buffer.from(await (await fetch(base + '/api/v1/screens/overview/preview.png', { headers: { Authorization: 'Bearer ' + rw } })).arrayBuffer()).toString('base64');
  const qemu = async () => { const r = await http(base, 'GET', '/__qemu/state'); return r.status === 200 ? r.json : null; };
  it('HA state changes reach the panel: a visible change redraws, an invisible one does not', async () => {
    await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (r) => r.json.home_assistant === 'linked', 60_000);
    // ambient chrome (#27) comes 60 s after the last key, and only once the display is out of setup: after a re-link
    // that is seconds later, under QEMU sometimes inside the counting below (#71: partial 8 → 10). Let it land first.
    for (let i = 0; i < 90 && (await qemu())?.ambient === false; i++) await new Promise((r) => setTimeout(r, 1000));
    await fakeCtl('state', { entity_id: 'sensor.home_power', state: '3456' });
    // let the re-link's "linked · live data" full refresh and the 3.5 kW update land first
    let a = await png();
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 1500)); const n = await png(); if (n === a) break; a = n; }
    await quietMinute(40);                                // no clock redraw in between: up to one interval + 7 s, slow under QEMU
    a = await png();
    const q0 = await qemu();
    await fakeCtl('state', { entity_id: 'sensor.home_power', state: '1234' });            // 3.46 kW → 1.23 kW
    const b = await until(png, (x) => x !== a, 30_000);
    expect(b).not.toBe(a);
    const q1 = await qemu();
    if (q0 && q1) expect(q1.partial, JSON.stringify([q0, q1])).toBe(q0.partial + 1);          // one partial, no flash
    if (q0 && q1) expect(q1.full).toBe(q0.full);
    await fakeCtl('state', { entity_id: 'sensor.home_power', state: '1240' });            // 6 W: inside the deadband, still 1.23 kW (#85)
    await new Promise((r) => setTimeout(r, 7000));                                        // > one Live data interval
    expect(await png()).toBe(b);
    const q2 = await qemu();
    if (q1 && q2) { expect(q2.partial).toBe(q1.partial); expect(q2.full).toBe(q1.full); }
  });
  it('preview.png of another screen draws that screen off-screen: panel, refresh counts and internal heap untouched (#168)', async () => {
    const get = (id: string) => fetch(base + '/api/v1/screens/' + id + '/preview.png', { headers: { Authorization: 'Bearer ' + rw } });
    const pgm = async () => Buffer.from(await (await fetch(base + '/__qemu/framebuffer.pgm')).arrayBuffer()).toString('base64');
    await quietMinute(50);   // the renders below are compared byte for byte: no minute tick in between (slow CI, #207)
    const q0 = await until(qemu, (q) => !!q && typeof q.screen === 'string' && q.screen !== '', 60_000);
    const ids: string[] = (await http(base, 'GET', '/api/v1/config', { token: rw, accept: 'application/json' })).json.screens
      .filter((s: any) => s.widgets?.length).map((s: any) => s.id);
    const a = q0.screen, b = ids.find((id) => id !== a)!;
    expect(b, JSON.stringify(ids)).toBeTruthy();
    const ra = await get(a);
    expect(ra.headers.get('x-x4-preview')).toBe('current-panel');
    const pa = Buffer.from(await ra.arrayBuffer());
    const f0 = await pgm();
    const rb = await get(b);
    expect(rb.status).toBe(200); expect(rb.headers.get('x-x4-preview')).toBe('rendered');
    const pb = Buffer.from(await rb.arrayBuffer());
    expect(pb.subarray(1, 4).toString()).toBe('PNG'); expect(pb.readUInt32BE(16)).toBe(800); expect(pb.readUInt32BE(20)).toBe(480);
    expect(pb.equals(pa), 'screen B looks different from screen A').toBe(false);
    // concurrent asks: each one a PNG or 503 + Retry-After, never a hung request
    const many = await Promise.all([get(b), get(b), get(b)]);
    for (const r of many) {
      expect([200, 503]).toContain(r.status);
      if (r.status === 503) expect(r.headers.get('retry-after')).toBeTruthy();
      else expect(Buffer.from(await r.arrayBuffer()).equals(pb)).toBe(true);
    }
    // a loaded runner can answer all three 503 (one off-screen draw at a time, ~2.6 s each): one retry after Retry-After
    if (!many.some((r) => r.status === 200)) {
      await new Promise((res) => setTimeout(res, 1000 * Number(many[0].headers.get('retry-after') || 2)));
      const again = await get(b);
      expect(again.status).toBe(200);
      expect(Buffer.from(await again.arrayBuffer()).equals(pb)).toBe(true);
    }
    const q1 = (await qemu())!;
    expect(await pgm(), 'panel framebuffer unchanged').toBe(f0);
    expect([q1.full, q1.partial, q1.screen]).toEqual([q0.full, q0.partial, a]);
    console.log(`[#168] internal heap before ${q0.heap} after ${q1.heap} (${q1.heap - q0.heap} B)`);
    expect(q1.heap, 'internal heap').toBeGreaterThan(q0.heap - 8192);
    expect((await get('nope')).status).toBe(404);
  });
  // #269: the device asks the recorder only for the history tiles of the app on screen: statistics first, the history
  // fallback for an entity without statistics, and an answer over the 512 KB frame cap read and dropped (tile "tooMany",
  // asked once, the WebSocket stays up). /__qemu/state history: per series key {active, state, source, bytes, points}.
  it('history tiles: statistics first, history fallback, an oversized answer dropped without a reconnect; other apps not fetched; attribute + forecast (#292)', async () => {
    const q0 = await until(qemu, (q) => !!q && typeof q.screen === 'string' && q.screen !== '', 60_000);
    const original = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
    const cfg = (await http(base, 'GET', '/api/v1/config', { token: rw, accept: 'application/json' })).json;
    const app = cfg.screens.find((s: any) => s.id === q0.screen)?.app ?? 'home';
    const other = (cfg.apps?.map((a: any) => a.id) ?? ['home', 'house', 'travel']).find((a: string) => a !== app && a !== 'settings') ?? 'travel';
    await fakeCtl('history', { entities: [{ id: 'sensor.outdoor_temperature', model: 'temperature' }, { id: 'sensor.train_delay', model: 'delay' },
      { id: 'sensor.chatty_power', model: 'power', kind: 'none' }, { id: 'sensor.rain_total', model: 'rain_total' }], states: true, reset_calls: true });
    const tile = (entity: string, window: string, extra: Record<string, unknown> = {}) => ({ type: 'history', entity, window, cs: 2, ...extra });
    const screens = [...cfg.screens,
      { id: 'hist_here', app, title: 'History', widgets: [tile('sensor.outdoor_temperature', '24h'), tile('sensor.train_delay', '6h', { agg: 'max' }), tile('sensor.chatty_power', '6h')] },
      // #292: a nowcast list in an attribute (from the entity mirror) and weather.get_forecasts (call_service, return_response)
      { id: 'hist_ahead', app, title: 'Ahead', widgets: [tile('binary_sensor.rain_expected', '2h', { attribute: 'forecast', value: 'precipitation', bucket: '10m', agg: 'max' }), tile('weather.home', '24h')] },
      { id: 'hist_there', app: other, title: 'History 2', widgets: [tile('sensor.rain_total', '24h', { agg: 'change' })] }];
    await quietMinute();
    const put = await http(base, 'PUT', '/api/v1/config', { token: rw, body: JSON.stringify({ version: 1, ...(cfg.apps ? { apps: cfg.apps } : {}), screens }), type: 'application/json' });
    try {
      expect(put.status, put.text).toBe(200);
      type H = { key: string; active: boolean; state: string; source: string; bytes: number; points: number };
      const of = (q: any, e: string): H | undefined => (q?.history as H[] | undefined)?.find((h) => h.key.startsWith(e + '|'));
      const q1 = await until(qemu, (q) => ['sensor.outdoor_temperature', 'sensor.train_delay', 'sensor.chatty_power', 'binary_sensor.rain_expected', 'weather.home']
        .every((e) => of(q, e) && of(q, e)!.state !== 'loading'), 180_000);
      expect(of(q1, 'binary_sensor.rain_expected'), JSON.stringify(q1.history)).toMatchObject({ active: true, state: 'ok', source: 'attribute' });
      expect(of(q1, 'binary_sensor.rain_expected')!.points).toBeGreaterThanOrEqual(40);
      expect(of(q1, 'weather.home')).toMatchObject({ active: true, state: 'ok', source: 'forecast', points: 48 });
      expect(of(q1, 'sensor.outdoor_temperature'), JSON.stringify(q1.history)).toMatchObject({ active: true, state: 'ok', source: 'statistics' });
      expect(of(q1, 'sensor.train_delay')).toMatchObject({ active: true, state: 'ok', source: 'history' });
      expect(of(q1, 'sensor.chatty_power')).toMatchObject({ active: true, state: 'tooMany' });
      expect(of(q1, 'sensor.chatty_power')!.bytes).toBeGreaterThan(512 * 1024);
      expect(of(q1, 'sensor.rain_total')).toMatchObject({ active: false, state: 'loading' });
      const calls = (await fakeCtl('history')).calls as { type: string; ids: string[]; period?: string; rows: number; bytes: number }[];
      const asked = (type: string, id: string) => calls.filter((c) => c.type === type && c.ids.includes(id));
      expect(asked('recorder/statistics_during_period', 'sensor.outdoor_temperature').length).toBeGreaterThanOrEqual(1);
      expect(asked('history/history_during_period', 'sensor.train_delay').length).toBeGreaterThanOrEqual(1);
      expect(asked('history/history_during_period', 'sensor.chatty_power')).toHaveLength(1);
      expect(calls.filter((c) => c.ids.includes('sensor.rain_total'))).toEqual([]);   // another app's tile: never asked
      // the socket survived the dropped frame: a state change still lands, and the chatty tile is not asked again
      const applied = (await qemu()).entities_applied;
      await fakeCtl('state', { entity_id: 'sensor.home_power', state: '777' });
      await until(qemu, (q) => q.entities_applied > applied, 30_000);
      await new Promise((r) => setTimeout(r, 5000));
      expect(((await fakeCtl('history')).calls as typeof calls).filter((c) => c.type === 'history/history_during_period' && c.ids.includes('sensor.chatty_power'))).toHaveLength(1);
      const q2 = (await qemu())!;
      console.log(`[#269] internal heap ${q0.heap} → ${q2.heap} B, largest ${q0.largest} → ${q2.largest} B; ${JSON.stringify(q2.history)}`);
      expect(q2.largest, 'largest internal block').toBeGreaterThan(Math.min(q0.largest, 16384) - 4096);
    } finally {
      const pre = await refreshCounts();
      expect((await http(base, 'PUT', '/api/v1/config', { token: rw, body: original, type: 'application/yaml' })).status).toBe(200);
      await fullLanded(pre);
      await fakeCtl('history', { entities: [{ id: 'sensor.outdoor_temperature', model: 'temperature' }, { id: 'sensor.rain_rate', model: 'rain_rate' },
        { id: 'sensor.rain_total', model: 'rain_total' }, { id: 'sensor.train_delay', model: 'delay' }], reset_calls: true });
    }
  });
  it('settings `entities` maps a logical id onto any HA entity (core/entity_map)', async () => {
    const put = await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ entities: { 'sensor.living_temperature': 'sensor.contract_thermo', 'sensor.battery_power': '-sensor.contract_batt' } }), type: 'application/json' });
    expect(put.status, put.text).toBe(200);
    expect(put.json.entities).toMatchObject({ 'sensor.living_temperature': 'sensor.contract_thermo', 'sensor.battery_power': '-sensor.contract_batt' });
    expect((await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ entities: { 'sensor.nope': 'sensor.x' } }), type: 'application/json' })).status).toBe(422);
    expect((await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ entities: { 'sensor.solar_power': 'not an id' } }), type: 'application/json' })).status).toBe(422);
    const g = await until(() => http(base, 'GET', '/api/v1/settings', { token: rw }), (r) => /sensor\.contract_thermo/.test(r.json.entity_sources?.['sensor.living_temperature'] || ''), 30_000);
    expect(g.json.entity_sources['sensor.battery_power']).toMatch(/^-sensor\.contract_batt .*override/);
    const del = await http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ entities: { 'sensor.living_temperature': null, 'sensor.battery_power': '' } }), type: 'application/json' });
    expect(del.json.entities).toEqual({});
  });
  // #149: a Frank Energie price sensor (192 quarter-hours in `prices` + 96 in `prices_today`, ~26 KB of attributes)
  // mapped as the price source took the internal low-water to ~1.2 KB on the real test display.
  it('a price source with a large `prices` attribute: hourly prices parsed, internal low-water stays ≥ 32 KB', async () => {
    const status = () => http(base, 'GET', '/api/v1/status', { token: rw });
    await until(status, (r) => r.json.home_assistant === 'linked', 60_000);
    const id = 'sensor.frank_energie_prices_current_electricity_price_all_in';
    const made = await fakeCtl('price-sensor', { entity_id: id, days: 2 });
    expect(made.entries).toBe(192); expect(made.bytes).toBeGreaterThan(20_000);
    const before = (await status()).json.heap_min_free;
    const put = (entities: object) => http(base, 'PUT', '/api/v1/settings', { token: rw, body: JSON.stringify({ entities }), type: 'application/json' });
    try {
      expect((await put({ 'sensor.energy_prices': id })).status).toBe(200);
      await until(() => http(base, 'GET', '/api/v1/settings', { token: rw }), (r) => (r.json.entity_sources?.['sensor.energy_prices'] || '').startsWith(id), 30_000);
      const q0 = (await http(base, 'GET', '/__qemu/state')).json;
      for (let i = 0; i < 4; i++) { await fakeCtl('price-sensor', { entity_id: id, days: 2 }); await sleep(3000); }   // HA sends the whole attribute set again on every change
      const q1 = await until(() => http(base, 'GET', '/__qemu/state').then((r) => r.json), (x: any) => x.entities_applied > q0.entities_applied, 30_000);
      expect(q1.entities_applied).toBeGreaterThan(q0.entities_applied);
      const s = await status();
      expect(s.json.home_assistant).toBe('linked');
      // base: 67 → 38.5 KB on the demo house (a ~16 KB DOM per event in internal RAM); now ~1.6 KB. Over https a
      // health report's second TLS session in this window costs another ~11 KB (#123).
      expect(before - s.json.heap_min_free, `internal low-water ${before} → ${s.json.heap_min_free} B`).toBeLessThanOrEqual(16384);
      expect(s.json.heap_min_free).toBeGreaterThanOrEqual(Math.min(32768, before));
    } finally { await put({ 'sensor.energy_prices': null }); }
  });
  // #274: HA 2025.12+ stores the grid source flat (stat_energy_from / _to, entity_energy_price, stat_rate); the display
  // read only flow_from / flow_to, so grid import / export, usage and the price entity were missing.
  it('#274: a flat grid source (HA 2025.12+) gives the price, grid power and the import / export meters', async () => {
    const status = () => http(base, 'GET', '/api/v1/status', { token: rw });
    const linked = () => until(status, (r) => r.json.home_assistant === 'linked', 60_000);
    await linked();
    const stats = (x: any) => (x.calls as { type: string; ids: string[] }[]).find((c) => c.type === 'recorder/statistics_during_period' && c.ids.includes('sensor.flat_grid_import'));
    try {
      expect((await fakeCtl('energy-prefs', { variant: 'flat-grid' })).energy_sources[0].flow_from).toBeUndefined();
      await fakeCtl('drop-ws', {});
      const g = await until(() => http(base, 'GET', '/api/v1/settings', { token: rw }), (r) => r.json.entity_sources?.['sensor.energy_prices'] === 'sensor.flat_grid_price (energy)', 60_000);
      expect(g.json.entity_sources['sensor.grid_power']).toBe('sensor.flat_grid_power (energy)');
      const h = await until(() => fakeCtl('history'), (x: any) => !!stats(x), 30_000);
      expect(stats(h)!.ids).toEqual(expect.arrayContaining(['sensor.flat_grid_import', 'sensor.flat_grid_export']));
    } finally {
      await fakeCtl('energy-prefs', { variant: 'house' });
      await fakeCtl('drop-ws', {});
      await linked();
    }
  });
  // #149: once the link dropped during a low-memory episode it stayed offline until a manual restart. Hold internal
  // RAM below the TLS guard, drop the WebSocket, let go: the client must relink on its own.
  // #160: a series of config PUTs of a real-sized house (10 screens, lights in 10 rooms, 9 zones) took the internal
  // low-water to ~1.4 KB and the largest block 31.7 → 8 KB on the real test display.
  it('#160: 20 PUTs of a 10-screen config: internal low-water ≥ 32 KB, largest block ≥ 20 KB, HA stays linked', async () => {
    const status = () => http(base, 'GET', '/api/v1/status', { token: rw });
    await until(status, (r) => r.json.home_assistant === 'linked', 60_000);
    const original = (await http(base, 'GET', '/api/v1/config', { token: rw })).text;
    const rooms = 'living_room kitchen hallway toilet bedroom kids_room guest_room bathroom office attic';
    const zones = 'climate.living_room climate.kitchen climate.bathroom climate.bedroom climate.playroom climate.attic climate.hallway climate.office climate.guest_room';
    const stats = ['living_temperature', 'solar_power', 'home_power', 'grid_power', 'energy_today', 'grid_import_today', 'grid_export_today', 'solar_today', 'battery_power'];
    const yaml = (i: number) => {
      const scr = (id: string, app: string, title: string, w: string[]) => `  - id: ${id}\n    app: ${app}\n    title: ${title}\n    widgets:\n` + w.map((x) => '      - ' + x + '\n').join('');
      const st = (k: number) => `{type: stat, entity: sensor.${stats[k % stats.length]}}`;
      return 'version: 1\nscreens:\n' +
        scr('overview', 'home', 'Home ' + i, ['{type: clock, cs: 2}', '{type: price}', st(0), st(1), st(2), '{type: gauge}', st(3)]) +
        scr('prices', 'home', 'Energy prices', ['{type: price}', st(4), st(5), st(6), '{type: bars, series: prices, cs: 4}']) +
        scr('energy', 'home', 'Energy', [st(4), st(5), st(6), st(2), '{type: bars, series: usage, cs: 4}']) +
        scr('solar', 'home', 'Solar & battery', [st(1), st(7), '{type: gauge}', st(8), '{type: bars, series: solar, cs: 4}']) +
        scr('lights', 'house', 'Lights', [`{type: lightList, areas: ${rooms}, cs: 4, rs: 2}`]) +
        scr('climate', 'house', 'Heating', [`{type: zoneList, entities: ${zones}, cs: 4, rs: 2}`]) +
        scr('downstairs', 'house', 'Downstairs', [`{type: lightList, areas: living_room kitchen hallway toilet, cs: 4}`, st(0), st(2)]) +
        scr('upstairs', 'house', 'Upstairs', [`{type: lightList, areas: bedroom kids_room guest_room bathroom office attic, cs: 4}`, st(0)]) +
        scr('morning', 'home', 'Morning', ['{type: clock, cs: 2}', '{type: price}', st(0), st(1), st(2), st(3)]) +
        scr('evening', 'home', 'Evening', ['{type: clock, cs: 2}', st(2), st(4), '{type: bars, series: usage, cs: 4}']);
    };
    const settled = () => until(() => http(base, 'GET', '/__qemu/state').then((r) => r.json), (x: any) => !x.busy, 60_000);
    const s0 = (await status()).json;
    try {
      for (let i = 0; i < 20; i++) {
        const put = await http(base, 'PUT', '/api/v1/config', { token: rw, body: yaml(i), type: 'application/yaml' });
        expect(put.status, put.text).toBe(200); expect(put.json.screens).toBe(10);
        await settled();
      }
      const s = await until(status, (r) => r.json.heap_largest_block >= 20480, 15_000);
      const msg = `internal low-water ${s0.heap_min_free} → ${s.json.heap_min_free} B, largest ${s0.heap_largest_block} → ${s.json.heap_largest_block} B`;
      expect(s.json.home_assistant, msg).toBe('linked');
      // base, QEMU large example house: low-water 72.6 → 46.9 KB over these PUTs (real test display: 18.9 → 1.4 KB, largest block
      // 31.7 → 8 KB): parse, YAML text and Config copies in internal RAM. Now ~2 KB, most of it the redraw.
      expect(s0.heap_min_free - s.json.heap_min_free, msg).toBeLessThanOrEqual(12288);
      expect(s.json.heap_min_free, msg).toBeGreaterThanOrEqual(Math.min(32768, s0.heap_min_free));
      expect(s.json.heap_largest_block, msg).toBeGreaterThanOrEqual(20480);
    } finally {
      expect((await http(base, 'PUT', '/api/v1/config', { token: rw, body: original, type: 'application/yaml' })).status).toBe(200);
      await settled();
    }
  }, 300_000);
  it('HA link drops during a forced low-memory episode and relinks by itself once the heap is back', async () => {
    const status = () => http(base, 'GET', '/api/v1/status', { token: rw });
    await until(status, (r) => r.json.home_assistant === 'linked', 60_000);
    const s0 = await fakeCtl('state');
    const hog = async (free: number) => (await http(base, 'POST', '/__qemu/heap-hog?free=' + free)).json;
    try {
      const h = await hog(24_000);
      expect(h.free).toBeLessThan(32_000);
      await fakeCtl('drop-ws', {});
      await until(status, (r) => r.json.home_assistant === 'offline', 30_000);
      await sleep(HA_TLS ? 20_000 : 5_000);   // TLS: reconnects refused by the heap guard meanwhile
    } finally { await hog(0); }
    await until(status, (r) => r.json.home_assistant === 'linked', 120_000);
    expect((await fakeCtl('state')).sessions).toBeGreaterThan(s0.sessions);
  });
  it('DELETE /ha unlinks (key revoked at HA); POST /ha/token links again with a long-lived token', async () => {
    const before = await fakeCtl('state');
    expect((await http(base, 'DELETE', '/api/v1/ha', { cookie: session })).status).toBe(204);
    const cs = await until(() => http(base, 'GET', '/api/v1/console/state'), (r) => r.json.home_assistant.linked === false);
    expect(cs.json.session.signed_in).toBe(false);
    await until(() => fakeCtl('state'), (x: any) => x.refresh_tokens < before.refresh_tokens, 30_000);   // revoked at HA
    expect((await http(base, 'GET', '/api/v1/tokens', { cookie: session })).status).toBe(401);       // sessions ended
    expect((await http(base, 'POST', '/api/v1/ha/token', { body: JSON.stringify({ url: FAKE_HA_DEVICE, token: 'nope' }), type: 'application/json' })).status).toBe(401);
    const { token } = await fakeCtl('llat', { name: 'user', admin: true });
    const r = await http(base, 'POST', '/api/v1/ha/token', { body: JSON.stringify({ url: FAKE_HA_DEVICE, token }), type: 'application/json' });
    expect(r.status, r.text).toBe(200); expect(r.json).toEqual({ status: 'linked', user: 'user' });
    session = cookieOf(r.headers); expect(session).toBeTruthy();
    await until(() => http(base, 'GET', '/api/v1/status', { token: rw }), (x) => x.json.home_assistant === 'linked', 60_000);
    expect((await http(base, 'GET', '/api/v1/tokens', { cookie: session })).status).toBe(200);
  });
  it('429 + Retry-After after 5 failed token attempts (last: locks this client out for 60 s)', async () => {
    let last: Res | null = null;
    for (let i = 0; i < 6; i++) last = await http(base, 'GET', '/api/v1/status', { token: 'x4_wrong' + i });
    expect(last!.status).toBe(429); expect(last!.headers.get('retry-after')).toBe('60');
  });
});
