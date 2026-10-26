// The device as a Home Assistant client — what the firmware does (docs ARCHITECTURE §2/§3):
// OAuth2 authorization code + PKCE (S256), refresh, revoke, and the WebSocket API.
// Works against the fake HA (./fake-ha.ts) and a real Home Assistant.
import { createHash, randomBytes } from 'node:crypto';
import { templateEventFinal } from '../src/core/seed.ts';

const b64url = (b: Buffer): string => b.toString('base64url');
export const randomToken = (bytes = 24): string => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

export class HaHttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code; this.name = 'HaHttpError'; }
}

export function authorizeUrl(haUrl: string, p: { clientId: string; redirectUri: string; state: string; verifier: string }): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state,
    code_challenge: pkceChallenge(p.verifier), code_challenge_method: 'S256',
  });
  return haUrl.replace(/\/$/, '') + '/auth/authorize?' + q.toString();
}

export type TokenResponse = { access_token: string; expires_in: number; token_type: string; refresh_token?: string };

async function tokenRequest(haUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(haUrl.replace(/\/$/, '') + '/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  } catch (e) {
    throw new HaHttpError(503, 'unreachable', 'Home Assistant not reachable: ' + (e as Error).message);
  }
  const text = await res.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new HaHttpError(res.status, body?.error || 'http_' + res.status, body?.error_description || body?.error || text.slice(0, 200));
  return body as TokenResponse;
}

export const exchangeCode = (haUrl: string, code: string, clientId: string, verifier: string) =>
  tokenRequest(haUrl, { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier });

export const refreshAccess = (haUrl: string, refreshToken: string, clientId: string) =>
  tokenRequest(haUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });

export async function revokeToken(haUrl: string, refreshToken: string): Promise<void> {
  try {
    await fetch(haUrl.replace(/\/$/, '') + '/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }).toString() });
  } catch { /* unlink still deletes the key locally */ }
}

/** One authenticated WebSocket session (HA WebSocket API: auth_required → auth → auth_ok, then id'd commands). */
export class HaSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void }>();
  private subs = new Map<number, (ev: any) => void>();
  onClose: (reason: string) => void = () => {};
  haVersion = '';

  /** Resolves after auth_ok; rejects with code 'auth_invalid' or 'unreachable'. */
  connect(haUrl: string, accessToken: string, timeoutMs = 8000): Promise<void> {
    const url = haUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/api/websocket';
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (code: string, msg: string) => { if (!settled) { settled = true; reject(new HaHttpError(code === 'auth_invalid' ? 401 : 503, code, msg)); } };
      const t = setTimeout(() => { fail('unreachable', 'WebSocket timeout'); this.close(); }, timeoutMs);
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { clearTimeout(t); fail('unreachable', (e as Error).message); return; }
      this.ws = ws;
      ws.onerror = () => { clearTimeout(t); fail('unreachable', 'WebSocket error'); };
      ws.onclose = () => {
        clearTimeout(t); fail('unreachable', 'WebSocket closed');
        for (const p of this.pending.values()) p.ko(new Error('connection closed'));
        this.pending.clear(); this.subs.clear();
        if (settled) this.onClose('closed');
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'auth_required') { this.haVersion = msg.ha_version || ''; ws.send(JSON.stringify({ type: 'auth', access_token: accessToken })); return; }
        if (msg.type === 'auth_ok') { clearTimeout(t); settled = true; resolve(); return; }
        if (msg.type === 'auth_invalid') { clearTimeout(t); fail('auth_invalid', msg.message || 'auth_invalid'); ws.close(); return; }
        if (msg.type === 'result') {
          const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
          if (msg.success) p.ok(msg.result); else p.ko(new Error((msg.error && msg.error.message) || 'command failed'));
          return;
        }
        if (msg.type === 'event') { const f = this.subs.get(msg.id); if (f) f(msg.event); }
      };
    });
  }

  command<T = any>(payload: Record<string, unknown>): Promise<T> {
    const ws = this.ws; if (!ws || ws.readyState !== 1) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise<T>((ok, ko) => { this.pending.set(id, { ok, ko }); ws.send(JSON.stringify({ id, ...payload })); });
  }

  /** subscribe_entities (compressed state stream: a = added, c = changed (+/-), r = removed). */
  async subscribeEntities(entityIds: string[] | null, onEvent: (ev: any) => void): Promise<void> {
    const ws = this.ws; if (!ws || ws.readyState !== 1) throw new Error('not connected');
    const id = this.nextId++;
    this.subs.set(id, onEvent);
    await new Promise<void>((ok, ko) => {
      this.pending.set(id, { ok: () => ok(), ko });
      ws.send(JSON.stringify({ id, type: 'subscribe_entities', ...(entityIds ? { entity_ids: entityIds } : {}) }));
    });
  }

  /**
   * render_template: the first rendered result (string), then unsubscribe (one-shot, like the firmware). With
   * report_errors HA sends {error, level} events: WARNING ones (e.g. an undefined attribute, #58) come before the
   * result and are passed to onWarning; an ERROR one means no result.
   */
  async renderTemplate(template: string, timeoutMs = 8000, onWarning?: (msg: string) => void): Promise<string> {
    const ws = this.ws; if (!ws || ws.readyState !== 1) throw new Error('not connected');
    const id = this.nextId++;
    return new Promise<string>((ok, ko) => {
      const t = setTimeout(() => { this.subs.delete(id); ko(new Error('render_template timeout')); }, timeoutMs);
      this.subs.set(id, (ev) => {
        if (!templateEventFinal(ev.result !== undefined, ev.level ?? null)) { onWarning?.(String(ev.error)); return; }
        clearTimeout(t); this.subs.delete(id);
        void this.command({ type: 'unsubscribe_events', subscription: id }).catch(() => {});
        if (ev.result === undefined) { ko(new Error(String(ev.error ?? 'no result'))); return; }
        ok(typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result));
      });
      this.pending.set(id, { ok: () => {}, ko: (e) => { clearTimeout(t); this.subs.delete(id); ko(e); } });
      ws.send(JSON.stringify({ id, type: 'render_template', template, report_errors: true }));
    });
  }

  close() { const ws = this.ws; this.ws = null; if (ws && ws.readyState <= 1) ws.close(); }
}
