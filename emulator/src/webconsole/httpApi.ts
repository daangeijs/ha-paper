// DeviceApi over HTTP, for the on-device web console (served from flash at http://ha-paper-XXXX.local/).
// Endpoints: spec/openapi.yaml (original design API + the console endpoints marked "x-console").
// Auth: the HttpOnly session cookie set by /auth/callback after "Sign in with Home Assistant".
import type { ReportStatus } from '../core/haReport.ts';
import { toYaml, DEFAULT_APPS, type AppDef, type Config, type Screen } from '../core/config.ts';
import type { DeviceSettings, SettingsPatch } from '../core/settings.ts';
import type { Diagnostics } from '../core/diag.ts';
import type { LogsResponse } from '../core/logs.ts';
import type { Scope } from '../core/auth.ts';
import { tr } from '../core/strings.ts';
import { ApiError, DeviceUnreachableError, type DeviceApi, type DeviceSnapshot, type EntityList, type NetworkInfo, type OtaView, type ScreenValues, type SeedReportView, type TokenInfo } from './DeviceApi.ts';

type WireToken = { id: string; name: string; scope: 'read' | 'write'; created: string; last_used: string | null; masked: string };
type WireState = {
  name: string; firmware: string; battery: number; ip: string | null; hostname?: string;
  setup: 'wifi' | 'web' | null; softap: boolean;
  wifi: { connected: string | null; saved: string[] }; networks: NetworkInfo[];
  home_assistant: { linked: boolean; revoked: boolean; server: string; user: string; discovered?: string[] };
  offline: boolean; entity_gaps?: Record<string, 'unavailable' | 'unknown'>; language?: 'en' | 'nl' | null; session: { signed_in: boolean; user: string; admin?: boolean };
  apps?: AppDef[]; screens: Screen[]; config_rev: number; install_id: string; tokens: WireToken[];
};
type WireWifi = { state: 'idle' | 'connecting' | 'connected' | 'failed'; connected: string | null; error?: string };

const toToken = (t: WireToken): TokenInfo => ({ id: t.id, name: t.name, scope: t.scope === 'write' ? 'rw' : 'ro', created: t.created, last: t.last_used || 'never', masked: t.masked });
/** The console only authenticates with its session cookie: a 401 without one means it ran out (12 h) or the display restarted. */
export const SESSION_ENDED = 'Your session expired. Sign in again.';
/** POST /auth/ha/start probes the typed address on the display first (eink-ha-os#54); a dead or stalled server must not leave
 *  the button on "Waiting for Home Assistant…" (eink-ha-os#79). The display gives up on its own in ~15 s per address. */
export const HA_NO_ANSWER = tr('en', 'haNoAnswer');   // the console shows it in its own language (useConsole)
export const HA_START_TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createHttpApi(base = '/api/v1', opts: { fetch?: typeof fetch; pollMs?: number; nav?: (url: string) => void; haStartTimeoutMs?: number } = {}): DeviceApi {
  const f = opts.fetch || ((...a: Parameters<typeof fetch>) => fetch(...a));
  const nav = opts.nav || ((url: string) => { location.assign(url); });

  async function req<T>(method: string, path: string, body?: unknown, type = 'application/json', timeout?: { ms: number; message: string }): Promise<T> {
    let res: Response;
    const ctl = timeout ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout!.ms) : undefined;
    try {
      res = await f(base + path, {
        method, credentials: 'same-origin', signal: ctl?.signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': type },
        body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : String(body),
      });
    } catch {
      if (ctl?.signal.aborted) throw new ApiError(504, timeout!.message);
      throw new DeviceUnreachableError();
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status === 401 && /^(missing token|session expired)/.test(data?.error ?? '')) throw new ApiError(401, SESSION_ENDED);
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText || 'HTTP ' + res.status, Number(res.headers.get('Retry-After')) || undefined);
    return data as T;
  }

  return {
    async getState(): Promise<DeviceSnapshot> {
      const s = await req<WireState>('GET', '/console/state');
      return {
        name: s.name, firmware: s.firmware, battery: s.battery, ip: s.ip, hostname: s.hostname || location.host, setup: s.setup, softAp: s.softap,
        wifi: s.wifi, networks: s.networks, ha: { ...s.home_assistant, discovered: s.home_assistant.discovered || [] }, offline: s.offline, entityGaps: s.entity_gaps || {}, language: s.language ?? null,
        session: { signedIn: s.session.signed_in, user: s.session.user, admin: !!s.session.admin }, apps: s.apps && s.apps.length ? s.apps : DEFAULT_APPS, screens: s.screens || [],
        configRev: s.config_rev, installId: s.install_id, tokens: (s.tokens || []).map(toToken),
      };
    },
    subscribe(onChange) {
      const t = setInterval(onChange, opts.pollMs ?? 3000);
      const vis = () => { if (document.visibilityState === 'visible') onChange(); };
      document.addEventListener('visibilitychange', vis);
      return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
    },

    async wifiConnect(ssid, password) {
      await req('POST', '/wifi', { ssid, password });
      // Joining takes a few seconds; the page may drop for a moment while the device switches networks.
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        let w: WireWifi;
        try { w = await req<WireWifi>('GET', '/wifi'); } catch (e) { if (e instanceof DeviceUnreachableError) continue; throw e; }
        if (w.state === 'connected') return;
        if (w.state === 'failed') throw new ApiError(401, w.error || 'Wrong password. Try again.');
      }
      throw new ApiError(504, 'The display did not join the network. Try again.');
    },
    wifiScan: () => req<NetworkInfo[]>('POST', '/wifi/scan'),

    async signInWithHa(_src, haUrl) {
      const r = await req<{ authorize_url: string }>('POST', '/auth/ha/start', { return_to: location.pathname, ...(haUrl ? { ha_url: haUrl } : {}) },
        'application/json', { ms: opts.haStartTimeoutMs ?? HA_START_TIMEOUT_MS, message: HA_NO_ANSWER });
      nav(r.authorize_url);
      return new Promise<void>(() => { /* the page navigates to Home Assistant */ });
    },
    signOut: () => req('POST', '/session/logout'),
    haUnlink: () => req('DELETE', '/ha'),
    finishSetup: () => req('POST', '/setup/finish'),

    async putConfig(config: Config) {
      const r = await req<{ status: string; screens: number }>('PUT', '/config', toYaml(config), 'application/yaml');
      return { screens: r.screens };
    },
    screenValues: (id: string) => req<ScreenValues>('GET', '/screens/' + encodeURIComponent(id) + '/values'),
    async screenPreview(id: string) {
      let res: Response;
      try { res = await f(base + '/screens/' + encodeURIComponent(id) + '/preview.png', { credentials: 'same-origin', headers: { Accept: 'image/png' } }); }
      catch { throw new DeviceUnreachableError(); }
      if (res.ok) return res.blob();
      let data: any = null; try { data = JSON.parse(await res.text()); } catch { /* not JSON */ }
      if (res.status === 401 && /^(missing token|session expired)/.test(data?.error ?? '')) throw new ApiError(401, SESSION_ENDED);
      throw new ApiError(res.status, data?.error || res.statusText || 'HTTP ' + res.status, Number(res.headers.get('Retry-After')) || undefined);
    },
    listEntities: () => req<EntityList>('GET', '/ha/entities'),
    getSettings: () => req<DeviceSettings>('GET', '/settings'),
    putSettings: (patch: SettingsPatch) => req<DeviceSettings>('PUT', '/settings', patch),
    async validateConfig(yaml) {
      try { await req('POST', '/config/validate', yaml, 'application/yaml'); return { ok: true }; }
      catch (e) { if (e instanceof ApiError && e.status === 422) return { ok: false, error: e.message }; throw e; }
    },

    async createToken(name: string, scope: Scope) {
      const r = await req<WireToken & { token: string }>('POST', '/tokens', { name, scope: scope === 'rw' ? 'write' : 'read' });
      return { token: toToken(r), secret: r.token };
    },
    revokeToken: (id) => req('DELETE', '/tokens/' + encodeURIComponent(id)),

    getDiagnostics: () => req<Diagnostics>('GET', '/diagnostics'),
    getHaReport: async () => (await req<{ ha_report: ReportStatus }>('GET', '/status')).ha_report,
    clearDiagnostics: () => req('DELETE', '/diagnostics'),
    getLogs: (since, previous) => req<LogsResponse>('GET', '/logs?limit=1000' + (since ? '&since=' + since : '') + (previous ? '&boot=previous' : '')),
    async getSeedReport() {
      try { return await req<SeedReportView>('GET', '/seed'); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
    },
    dismissSeedReport: () => req('DELETE', '/seed'),

    getOta: () => req<OtaView>('GET', '/ota'),
    otaCheck: () => req('POST', '/ota/check'),
    otaInstall: () => req('POST', '/ota'),

    async reload() { location.reload(); },
    trace(msg, kind) { (kind === 'warn' ? console.warn : console.debug)('[x4]', msg); },
  };
}
