// HTTP surface of the simulated display, as the firmware serves it:
//   /api/v1/*        REST API (spec/openapi.yaml), bearer token or console session cookie
//   /auth/start      302 to Home Assistant's authorize page (GET twin of POST /api/v1/auth/ha/start)
//   /auth/callback   HA OAuth redirect target → session cookie → 302 to the console
//   /openapi.yaml    spec/openapi.yaml (no auth)
//   /*               the web console from flash (dist-device-ui, gzip, SPA fallback incl. /setup)
//   /__sim/*         simulator only (not on the device): display state + controls
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { toYaml, validateYaml, DEFAULT_APPS, entityGaps, type Config } from '../src/core/config.ts';
import { NETWORKS, HOST, SIM_IP } from '../src/core/data.ts';
import type { StoredToken } from '../src/core/auth.ts';
import { logsQueryOf } from '../src/core/logs.ts';
import { mergeSettings, PRESETS, presetState, verifyImage, type DeviceSim, type Preset } from './device.ts';
import { readBuffer } from './fake-ha.ts';
import { parseMultipart, sha256, type Manifest } from './ota.ts';
import { previewPng } from './png.ts';
import { INPUT_SPEC_ERROR, parseInputSpec } from '../src/core/inputSpec.ts';

// GET /status heap fields: fixed, healthy-looking numbers (the firmware reports internal RAM; TLS is skipped below a
// 20 KB largest block or 64 KB free, core/net_policy.h). Nothing in the simulator fragments.
const SIM_HEAP = { free_heap: 182344, free_psram: 7864320, heap_largest_block: 110592, heap_min_free: 141020 };
const OPENAPI = join(import.meta.dirname, '..', '..', 'spec', 'openapi.yaml');

type Json = Record<string, unknown> | unknown[] | null;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

type StaticFile = { body: Buffer; gz: Buffer; type: string; etag: string };
/** Load the console like the firmware's LittleFS image: every file pre-gzipped. */
export function loadStatic(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  if (!existsSync(dir)) return files;
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full, prefix + name + '/'); continue; }
      if (name.endsWith('.gz')) continue;
      const body = readFileSync(full);
      files.set('/' + prefix + name, { body, gz: gzipSync(body, { level: 9 }), type: TYPES[extname(name)] || 'application/octet-stream', etag: '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"' });
    }
  };
  walk(dir, '');
  return files;
}

const wireToken = (t: StoredToken) => ({ id: t.id, name: t.name, scope: t.scope === 'rw' ? 'write' : 'read', created: t.created, last_used: t.last === 'never' ? null : t.last, masked: t.masked });
const cookies = (req: IncomingMessage): Record<string, string> =>
  Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

export type HandlerOptions = { uiDir: string; log?: (m: string) => void; simRoutes?: boolean; haUrlForPreset?: string };

export function createDeviceHandler(sim: DeviceSim, o: HandlerOptions) {
  let ui = loadStatic(o.uiDir);
  const log = o.log || (() => {});

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url || '/', 'http://' + (req.headers.host || HOST));
    const method = req.method || 'GET';
    const send = (code: number, body?: Json | string | Buffer, headers: Record<string, string | string[]> = {}) => {
      if (code === 204 || body === undefined) { res.writeHead(code, headers); res.end(); return; }
      const isJson = !(typeof body === 'string' || Buffer.isBuffer(body));
      res.writeHead(code, { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(isJson ? JSON.stringify(body) : body);
    };
    const err = (code: number, error: string) => send(code, { error });
    // Deep sleep: the radio is off, nothing answers (only the simulator's own /__sim routes).
    if (sim.power.asleep && !u.pathname.startsWith('/__sim/')) { log('ASLEEP ' + method + ' ' + u.pathname + ' · no answer'); req.socket.destroy(); return; }
    try {
      if (u.pathname.startsWith('/api/v1/')) { sim.power.lastApi = Date.now(); await api(u.pathname.slice(7), u, req, res, send, err); log('API ' + method + ' ' + u.pathname + ' · ' + res.statusCode); return; }
      const linkCode = u.pathname === '/link' ? u.searchParams.get('p') : null;
      if ((u.pathname === '/auth/start' || linkCode !== null) && method === 'GET') {
        if (linkCode !== null && !sim.usePairing(linkCode)) return send(400, htmlPage('Code expired', 'This pairing code is not valid any more. Use the QR code or code shown on the display now.'), { 'Content-Type': 'text/html; charset=utf-8' });
        const ha = u.searchParams.get('ha'); if (ha) { const e = sim.setHaUrl(ha, false); if (e) return err(e.status, e.error); }
        if (!(await sim.haReachable())) return send(503, { error: 'Home Assistant not found on the network', need: 'ha_url' });
        return send(302, undefined, { Location: sim.startSignIn(String(req.headers.host), u.searchParams.get('return_to') || '/') });
      }
      if (u.pathname === '/auth/callback' && method === 'GET') {
        const r = await sim.finishSignIn(u.searchParams);
        if (r.error) return send(r.status, htmlPage('Sign-in failed', r.error), { 'Content-Type': 'text/html; charset=utf-8' });
        const h: Record<string, string> = { Location: r.location! };
        if (r.session) h['Set-Cookie'] = 'x4_session=' + r.session + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200';
        return send(302, undefined, h);
      }
      if (u.pathname.startsWith('/__sim/') && o.simRoutes !== false) return await simRoutes(u, req, send, err);
      if (method !== 'GET' && method !== 'HEAD') return err(405, 'method not allowed');
      // The REST API description, like the firmware's LittleFS copy of spec/openapi.yaml (no auth).
      if (u.pathname === '/openapi.yaml') return send(200, readFileSync(OPENAPI), { 'Content-Type': 'application/yaml; charset=utf-8' });
      if (!ui.size) ui = loadStatic(o.uiDir);
      let f = ui.get(u.pathname === '/' ? '/index.html' : u.pathname);
      // SPA fallback: /setup, /link, /screens, … all load the console (files with an extension must exist).
      if (!f && !extname(u.pathname)) f = ui.get('/index.html');
      if (!f) return send(404, 'Not found');
      if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, { ETag: f.etag }); res.end(); return; }
      const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      const body = gz ? f.gz : f.body;
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': String(body.length), 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      res.end(method === 'HEAD' ? undefined : body);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 413) return err(413, 'payload too large');
      log('ERROR ' + method + ' ' + u.pathname + ' · ' + ((e as Error).stack || e));
      if (!res.headersSent) err(500, 'internal error');
    }
  };

  async function api(path: string, u: URL, req: IncomingMessage, res: ServerResponse, send: (c: number, b?: Json | string | Buffer, h?: Record<string, string | string[]>) => void, err: (c: number, m: string) => void) {
    const method = req.method || 'GET';
    const sid = cookies(req).x4_session || null;
    const session = sim.session(sid);
    const authz = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(\S+)$/i.exec(authz)?.[1] || (authz ? '' : null);
    const ip = req.socket.remoteAddress || '?';

    // CSRF: a cookie-authenticated write must name this display in Origin (or, without Origin, Referer).
    // Bearer-token writes are not checked: a browser never attaches the token by itself.
    const sameOrigin = (): boolean => {
      const want = 'http://' + String(req.headers.host || '');
      const origin = req.headers.origin; if (origin) return origin === want;
      const ref = String(req.headers.referer || ''); return ref === want || ref.startsWith(want + '/');
    };
    const csrfOk = (): boolean => {
      if (method === 'GET' || method === 'HEAD' || sameOrigin()) return true;
      err(403, 'cross-origin request refused'); return false;
    };
    const ADMIN = 'Home Assistant admin required';
    /** Bearer token (scope) or console session (admin: full access, otherwise read). Sends 401/403/429 and returns false when denied. */
    const need = (level: 'read' | 'write'): boolean => {
      if (bearer === null && session) { if (level === 'write' && !session.admin) { err(403, ADMIN); return false; } return csrfOk(); }
      const now = Date.now(); const fails = (sim.authFailures.get(ip) || []).filter((t) => t > now - 60_000);
      if (fails.length >= 5) { send(429, { error: 'too many failed attempts — wait a minute' }, { 'Retry-After': '60' }); return false; }
      if (bearer === null && sid) { err(401, 'session expired, sign in again'); return false; }   // firmware Auth::check
      const e = sim.checkToken(bearer || null, level);
      if (!e) return true;
      if (e.code === 401 && bearer) { fails.push(now); sim.authFailures.set(ip, fails); } // only presented-but-wrong tokens count
      err(e.code, e.error); return false;
    };
    /** Session-only endpoints (tokens, unlink, factory reset, setup after linking): an HA admin's session. */
    const needSession = (): boolean => {
      if (!session) { err(401, 'sign in with Home Assistant first (console session required)'); return false; }
      if (!session.admin) { err(403, ADMIN); return false; }
      return csrfOk();
    };
    const setupOrSession = (): boolean => (sim.setupOpen ? true : needSession());
    const json = async <T>(limit = 64 * 1024): Promise<T | undefined> => { const b = (await readBuffer(req, limit)).toString('utf8'); if (!b.trim()) return {} as T; try { return JSON.parse(b) as T; } catch { err(400, 'invalid JSON'); return undefined; } };
    const bad = () => err(405, 'method not allowed');
    const wantsJson = /application\/json/.test(String(req.headers.accept || ''));

    /** PUT /config and /config/validate body → screens or a 422 "line N: message". */
    const readConfig = async (): Promise<Config | undefined> => {
      const ct = String(req.headers['content-type'] || '');
      if (/application\/x-www-form-urlencoded/i.test(ct)) { err(415, 'send Content-Type application/yaml or application/json (curl: -H "Content-Type: application/yaml")'); return; }
      let text = (await readBuffer(req, 64 * 1024)).toString('utf8');
      if (/json/.test(ct)) {
        let j: any; try { j = JSON.parse(text); } catch { err(400, 'invalid JSON'); return; }
        const screens = Array.isArray(j) ? j : j && j.screens;
        if (!Array.isArray(screens)) { send(422, { error: 'line 1: No screens found', line: 1, message: 'No screens found' }); return; }
        if (j && !Array.isArray(j) && j.version !== undefined && j.version !== 1) { send(422, { error: 'line 2: Only version 1 is supported', line: 2, message: 'Only version 1 is supported' }); return; }
        const apps = j && !Array.isArray(j) && Array.isArray(j.apps) ? j.apps.map((a: any) => ({ id: String(a.id), title: String(a.title ?? a.id) })) : DEFAULT_APPS;
        text = toYaml({ apps, screens: screens.map((s: any) => ({ id: String(s.id), app: String(s.app || apps[0]?.id || 'home'), title: String(s.title ?? s.id), widgets: Array.isArray(s.widgets) ? s.widgets : [] })) });
      }
      const r = validateYaml(text);
      if (!r.ok) { send(422, { error: 'line ' + r.line + ': ' + r.message, line: r.line, message: r.message }); return; }
      return r.config;
    };

    switch (true) {
      case path === '/status': {
        if (method !== 'GET') return bad(); if (!need('read')) return;
        return send(200, { name: sim.p.name, firmware: sim.p.ota.fw, battery: sim.battery, battery_mv: sim.batteryMv, wifi: sim.p.wifi.connected || '', home_assistant: sim.haStatus(), screens: sim.p.screens.length, language: sim.p.language ?? null, currency: sim.p.ha.linked ? sim.p.currency ?? null : null, hostname: HOST, ...SIM_HEAP, uptime_s: Math.floor((Date.now() - sim.bootAt) / 1000), power: sim.powerStatus(), refreshes: sim.refreshStatus(), ha_report: sim.reportStatus(), panel: 'ok' });
      }
      case path === '/config': {
        if (method === 'GET') {
          if (!need('read')) return;
          if (wantsJson) return send(200, { version: 1, apps: sim.p.apps, screens: sim.p.screens });
          return send(200, toYaml({ apps: sim.p.apps, screens: sim.p.screens }), { 'Content-Type': 'application/yaml; charset=utf-8' });
        }
        if (method !== 'PUT') return bad(); if (!need('write')) return;
        const cfg = await readConfig(); if (!cfg) return;
        sim.applyConfig(cfg, bearer ? 'API token' : 'web console');
        return send(200, { status: 'applied', screens: cfg.screens.length });
      }
      case path === '/config/validate': {
        if (method !== 'POST') return bad(); if (!need('read')) return;
        const cfg = await readConfig(); if (!cfg) return;
        return send(200, { status: 'valid', screens: cfg.screens.length, widgets: cfg.screens.reduce((n, sc) => n + sc.widgets.length, 0) });
      }
      case /^\/screens\/[^/]+\/preview\.png$/.test(path): {
        if (method !== 'GET') return bad(); if (!need('read')) return;
        const id = decodeURIComponent(path.split('/')[2]);
        const sc = sim.p.screens.find((s) => s.id === id); if (!sc) return err(404, 'unknown screen “' + id + '”');
        return send(200, previewPng(sc), { 'Content-Type': 'image/png' });
      }
      case path === '/debug/input': {   // #214
        if (method !== 'POST') return bad(); if (!need('write')) return;
        if (!sim.p.settings.display.debugInput) return err(403, 'remote input is off');
        const spec = parseInputSpec(u.searchParams); if (!spec) return err(400, INPUT_SPEC_ERROR);
        sim.remoteInput(spec); return send(204);
      }
      case path === '/debug/framebuffer.png': {   // #214: the layout of the screen shown (png.ts)
        if (method !== 'GET') return bad(); if (!need('read')) return;
        const sc = sim.shown.find((s) => s.id === sim.screenId()); if (!sc) return err(503, 'no frame yet');
        return send(200, previewPng(sc), { 'Content-Type': 'image/png' });
      }
      case /^\/screens\/[^/]+\/values$/.test(path): {
        if (method !== 'GET') return bad(); if (!need('read')) return;
        const id = decodeURIComponent(path.split('/')[2]);
        const sc = sim.p.screens.find((s) => s.id === id); if (!sc) return err(404, 'unknown screen “' + id + '”');
        return send(200, { ready: true, values: sim.tileValues(sc) });
      }
      case path === '/display/refresh': {
        if (method !== 'POST') return bad(); if (!need('write')) return;
        sim.fullRefresh('API refresh', 'full'); return send(204);
      }
      case path === '/ota': {
        if (method === 'GET') { if (!need('read')) return; return send(200, sim.otaState()); }
        if (method !== 'POST') return bad(); if (!need('write')) return;
        const e = sim.otaInstall(); if (e) return err(409, e);
        return send(202, { status: 'updating', version: sim.display.progress?.version });
      }
      case path === '/ota/check': {
        if (method !== 'POST') return bad(); if (!need('write')) return;
        const e = sim.otaCheck(); if (e) return err(409, e);
        return send(202, { status: 'checking' });
      }
      case path === '/ota/upload': {
        if (method !== 'POST') return bad(); if (!need('write')) return;
        if (sim.battery < 30) return err(409, 'Battery at ' + sim.battery + '% — charge to 30% first');
        if (sim.otaBusy) return err(409, 'An update is already running');
        const ct = String(req.headers['content-type'] || '');
        const body = await readBuffer(req, 8 * 1024 * 1024);
        let img: Buffer | null = null; let manifest: Partial<Manifest> | null = null;
        if (/multipart\/form-data/i.test(ct)) {
          const parts = parseMultipart(body, ct);
          const fw = parts.find((p) => p.name === 'firmware') || parts.find((p) => p.filename && !/manifest/i.test(p.filename));
          const mf = parts.find((p) => p.name === 'manifest');
          img = fw ? fw.data : null;
          if (mf) { try { manifest = JSON.parse(mf.data.toString('utf8')); } catch { return err(400, 'manifest.json is not valid JSON'); } }
        } else if (body.length) img = body;
        const qsha = u.searchParams.get('sha256') || (req.headers['x-sha256'] as string | undefined);
        if (!manifest && qsha) manifest = { sha256: qsha, version: u.searchParams.get('version') || undefined };
        if (!manifest && sim.otaRun.avail) manifest = sim.otaRun.avail.manifest;
        if (!img || !img.length) return err(400, 'firmware.bin missing (multipart field "firmware" or an application/octet-stream body)');
        if (!manifest || !manifest.sha256) return err(400, 'manifest.json missing (multipart field "manifest", ?sha256=…, or check for an update first)');
        const m: Manifest = { version: String(manifest.version || 'unknown'), sha256: String(manifest.sha256), size: Number(manifest.size || 0), notes: manifest.notes || [] };
        const bad2 = verifyImage(img, m);
        if (bad2) { sim.log('OTA upload rejected · ' + bad2 + ' · nothing changed'); return err(422, bad2 + ' — nothing changed'); }
        sim.log('OTA upload ' + img.length + ' bytes · SHA-256 OK');
        res.on('finish', () => sim.rebootInto(m));
        return send(202, { status: 'rebooting', version: m.version, sha256: sha256(img), size: img.length });
      }

      // ---- web console (x-console) ----
      case path === '/console/state': {
        if (method !== 'GET') return bad();
        const p = sim.p; const signedIn = !!session;
        // Once linked, the HA address and account are for a signed-in console only (setup still needs them).
        const showHa = signedIn || !p.ha.linked;
        return send(200, {
          name: p.name, firmware: p.ota.fw, battery: sim.battery, ip: p.wifi.connected ? SIM_IP : null, hostname: HOST,
          setup: p.setup, softap: p.setup === 'wifi', wifi: p.wifi,
          networks: NETWORKS.map(({ ssid, rssi, secure }) => ({ ssid, rssi, secure })),
          home_assistant: { linked: p.ha.linked, revoked: p.ha.revoked, server: showHa ? p.ha.url : '', user: showHa ? p.ha.user : '', discovered: showHa && sim.discovered ? [sim.discovered] : [] },
          offline: sim.offline, language: p.language ?? null, session: { signed_in: signedIn, user: session ? session.user : '', admin: !!session?.admin },
          entity_gaps: signedIn && p.ha.linked ? entityGaps(p.screens, (id) => sim.ha.entities.get(id)?.s) : {},
          apps: signedIn ? p.apps : [], screens: signedIn ? p.screens : [], config_rev: p.configRev, install_id: p.installId,
          seed_pending: !p.screensSaved,
          tokens: session?.admin ? p.tokens.map(wireToken) : [],
        });
      }
      case path === '/auth/ha/start': {
        if (method !== 'POST') return bad();
        const b = await json<{ return_to?: string; ha_url?: string }>(); if (!b) return;
        if (sim.p.setup === 'wifi') return err(409, 'Join your Wi-Fi first: Home Assistant can’t be reached from the setup hotspot.');
        // Not linked: check the address (typed, else remembered / discovered) answers as Home Assistant (#54).
        if (!sim.p.ha.linked) {
          const input = String(b.ha_url || sim.p.ha.url || '');
          if (!input) return send(503, { error: 'Home Assistant not found on this network. Enter its address.', need: 'ha_url' });
          const r = await sim.resolveHa(input);
          if ('error' in r && r.status === 429) return send(429, { error: r.error }, { 'Retry-After': '1' });
          if ('error' in r) return send(r.status, { error: r.error, need: 'ha_url' });
        }
        return send(200, { authorize_url: sim.startSignIn(String(req.headers.host), b.return_to || '/') });
      }
      case path === '/session/logout': {
        if (method !== 'POST') return bad();
        if (sid) sim.sessions.delete(sid);
        return send(204, undefined, { 'Set-Cookie': 'x4_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      }
      case path === '/wifi': {
        if (method === 'GET') { if (!setupOrSession()) return; return send(200, { state: sim.wifiRun.state, connected: sim.p.wifi.connected, saved: sim.p.wifi.saved, ...(sim.wifiRun.error ? { error: sim.wifiRun.error } : {}) }); }
        if (method !== 'POST') return bad(); if (!setupOrSession()) return;
        const b = await json<{ ssid?: string; password?: string }>(); if (!b) return;
        if (!b.ssid) return err(400, 'ssid is required');
        const e = sim.wifiJoin(b.ssid, b.password); if (e) return err(400, e);
        return send(202, { state: 'connecting', connected: sim.p.wifi.connected, saved: sim.p.wifi.saved });
      }
      case path === '/wifi/scan': {
        if (method !== 'POST') return bad(); if (!setupOrSession()) return;
        await new Promise((r) => setTimeout(r, sim.delays.scanMs));
        return send(200, NETWORKS.map(({ ssid, rssi, secure }) => ({ ssid, rssi, secure })).sort((a, b) => b.rssi - a.rssi));
      }
      case path === '/ha': {
        if (method !== 'DELETE') return bad(); if (!needSession()) return;
        await sim.unlink(); return send(204, undefined, { 'Set-Cookie': 'x4_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      }
      case path === '/setup/finish': {
        if (method !== 'POST') return bad(); if (!needSession()) return;
        const was = sim.p.setup; sim.p.setup = null; sim.save();
        sim.fullRefresh(was ? 'Setup complete' : 'Home'); return send(204);
      }
      case path === '/tokens': {
        if (!needSession()) return;
        if (method === 'GET') return send(200, sim.p.tokens.map(wireToken));
        if (method !== 'POST') return bad();
        const b = await json<{ name?: string; scope?: string }>(); if (!b) return;
        if (b.scope !== 'read' && b.scope !== 'write') return err(400, 'scope must be "read" or "write"');
        const { tok, secret } = sim.createToken(String(b.name || ''), b.scope === 'write' ? 'rw' : 'ro');
        return send(201, { ...wireToken(tok), token: secret });
      }
      case /^\/tokens\/[^/]+$/.test(path): {
        if (method !== 'DELETE') return bad(); if (!needSession()) return;
        return sim.revokeToken(decodeURIComponent(path.slice(8))) ? send(204) : err(404, 'unknown token');
      }

      // ---- firmware extensions (x-firmware) ----
      case path === '/settings': {
        if (method === 'GET') { if (!need('read')) return; return send(200, sim.settingsView()); }
        if (method !== 'PUT') return bad(); if (!need('write')) return;
        const b = await json<unknown>(); if (b === undefined) return;
        const next = mergeSettings(sim.p.settings, b); if (typeof next === 'string') return err(422, next);
        const prev = sim.p.settings; const nightOrClock = next.display.clock !== prev.display.clock;
        sim.p.settings = next; sim.p.name = next.name; sim.p.ota.channel = next.ota_channel;
        if (next.display.otaAuto) sim.p.ota.auto = next.display.otaAuto;   // Settings › Updates › Automatic (#159)
        sim.save();
        const lookChanged = (['style', 'typeface', 'surface'] as const).some((k) => next.display[k] !== prev.display[k]);
        if (lookChanged) sim.fullRefresh('display style');   // a new look is one full refresh, never a region diff
        else if (nightOrClock) sim.dataChanged('settings');
        if (JSON.stringify(next.entities || {}) !== JSON.stringify(prev.entities || {})) sim.entitiesChanged();
        return send(200, sim.settingsView());
      }
      case path === '/ha/entities': {
        if (method !== 'GET') return bad(); if (!need('read')) return;
        if (!sim.p.ha.linked) return err(409, 'link Home Assistant first');
        return send(200, sim.haEntities());
      }
      case path === '/ha/token': {
        if (method !== 'POST') return bad(); if (!setupOrSession()) return;
        const b = await json<{ token?: string; url?: string }>(); if (!b) return;
        if (!b.token) return err(400, 'token is required');
        const r = await sim.linkWithToken(b.token, b.url); if (r.error) return err(r.status, r.error);
        const h: Record<string, string> = {};
        h['Set-Cookie'] = 'x4_session=' + sim.newSession(r.user!, !!r.admin) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200';
        return send(200, { status: 'linked', user: r.user }, h);
      }
      case path === '/ha/url': {
        if (method !== 'POST') return bad(); if (!setupOrSession()) return;
        const b = await json<{ url?: string }>(); if (!b) return;
        const e = sim.setHaUrl(String(b.url || ''), true); if (e) return err(e.status, e.error);
        return send(200, { url: sim.p.ha.url });
      }
      case path === '/ha/discover': {
        if (method !== 'POST') return bad(); if (!setupOrSession()) return;
        return send(202, { status: 'searching' });
      }
      case path === '/logs': {   // #200 (x-firmware: net/log.cpp)
        if (method !== 'GET') return bad(); if (!need('read')) return;
        const g = (k: string) => u.searchParams.get(k);
        const q = logsQueryOf({ since: g('since'), level: g('level'), tag: g('tag'), limit: g('limit') });
        if (typeof q === 'string') return err(422, q);
        const boot = g('boot');
        if (boot && boot !== 'current' && boot !== 'previous') return err(422, 'boot must be current or previous');
        return send(200, sim.logsGet(q, boot === 'previous'));
      }
      case path === '/diagnostics': {
        if (method === 'GET') { if (!need('read')) return; return send(200, sim.diagnostics()); }
        if (method !== 'DELETE') return bad(); if (!need('write')) return;
        sim.diagnosticsClear(); return send(204);
      }
      case path === '/seed': {   // #89
        if (method !== 'GET' && method !== 'DELETE') return bad();
        if (!need(method === 'GET' ? 'read' : 'write')) return;
        if (!sim.p.seed) return err(404, 'no seed report');
        if (method === 'GET') return send(200, sim.p.seed);
        sim.p.seed.dismissed = true; sim.save(); return send(204);
      }
      case path === '/diagnostics/coredump': {
        if (method !== 'GET') return bad(); if (!need('write')) return;   // write: the image holds RAM contents
        const img = sim.coredumpImage(); if (!img) return err(404, 'no core dump stored');
        return send(200, img, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="coredump.elf"' });
      }
      case path === '/device/restart': {
        if (method !== 'POST') return bad(); if (!need('write')) return;
        res.on('finish', () => sim.restart('API restart'));
        return send(202, { status: 'restarting' });
      }
      case path === '/device/sleep': {   // #178: deep sleep now (power measurements)
        if (method !== 'POST') return bad(); if (!need('write')) return;
        const b = await json<{ seconds?: unknown }>(); if (!b) return;
        const c = sim.sleepNow(b.seconds ?? null);
        if (c.status !== 202) return err(c.status, c.error);
        const secs = b.seconds as number;
        res.on('finish', () => sim.enterSleep(Date.now() + secs * 1000, 'api sleep'));
        return send(202, { status: 'sleeping', seconds: secs });
      }
      case path === '/device/factory-reset': {
        if (method !== 'POST') return bad(); if (!needSession()) return;
        res.on('finish', () => void sim.factoryReset());
        return send(202, { status: 'resetting' }, { 'Set-Cookie': 'x4_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      }
      default: return err(404, 'not found');
    }
  }

  async function simRoutes(u: URL, req: IncomingMessage, send: (c: number, b?: Json) => void, err: (c: number, m: string) => void) {
    if (u.pathname === '/__sim/state' && req.method === 'GET') return send(200, sim.simState());
    if (u.pathname === '/__sim/control' && req.method === 'POST') {
      let b: any; try { b = JSON.parse((await readBuffer(req)).toString('utf8') || '{}'); } catch { return err(400, 'invalid JSON'); }
      if (b.preset) {
        if (!PRESETS.includes(b.preset)) return err(400, 'preset must be one of ' + PRESETS.join(', '));
        sim.ha.socket?.close(); sim.ha.socket = null; sim.ha.connected = false; sim.ha.access = null; sim.ha.entities.clear();
        sim.p = presetState(b.preset as Preset, sim.p.ha.url, b.preset === 'installed' ? sim.presetLink() : null); sim.sessions.clear(); sim.otaRun = { status: 'idle', avail: null, lastCheck: null, message: '' };
        sim.wifiRun = { state: 'idle' }; sim.save(); sim.boot('preset ' + b.preset); void sim.connectHa();
      }
      if (typeof b.battery === 'number') sim.battery = b.battery;
      if (typeof b.battery_mv === 'number' || b.battery_mv === null) sim.batteryMv = b.battery_mv;
      if (typeof b.usb === 'boolean') sim.setUsb(b.usb);
      if (b.wake === 'timer' || b.wake === 'button') sim.wake(b.wake);   // end a deep sleep now (#178 tests)
      if (b.api_idle) sim.power.lastApi = null;   // as if no API request since boot (skips the 2-min quiet period)
      if (b.wake) sim.wake('power key');
      if (b.sleep) { const why = sim.sleep(); if (why) return err(409, 'stays awake: ' + why); }
      if (typeof b.ota_repo === 'string') { sim.otaRepo = b.ota_repo; sim.otaRun = { status: 'idle', avail: null, lastCheck: null, message: '' }; }   // '' = a build with update checks off
      if (b.ota_fail) { if (!['ok', 'hash', 'boot'].includes(b.ota_fail)) return err(400, 'ota_fail must be ok, hash or boot'); sim.failMode = b.ota_fail; }
      if (b.screen && !sim.goTo(String(b.screen))) return err(404, 'unknown screen');
      if (typeof b.tap === 'number') { const why = await sim.tapTile(b.tap).catch((e: Error) => e.message); if (why) return err(409, why); }
      if (b.crash) { if (!['panic', 'task_wdt', 'brownout'].includes(b.crash)) return err(400, 'crash must be panic, task_wdt or brownout'); sim.crash(b.crash); }
      return send(200, sim.simState());
    }
    return err(404, 'not found');
  }
}

function htmlPage(title: string, text: string): string {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>' +
    '<body style="font:16px system-ui;padding:40px;max-width:520px"><h1>' + title + '</h1><p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p><p><a href="/">Back to the display</a></p>';
}
