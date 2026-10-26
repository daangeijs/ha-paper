import { describe, it, expect } from 'vitest';
import { createHttpApi, HA_NO_ANSWER, SESSION_ENDED } from './httpApi.ts';

const answer = (status: number, body: object) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('httpApi errors (#44)', () => {
  it('a 401 for a missing or expired session says to sign in again', async () => {
    for (const error of ['missing token', 'session expired, sign in again'])
      await expect(createHttpApi('/api/v1', { fetch: answer(401, { error }) }).getSettings()).rejects.toMatchObject({ status: 401, message: SESSION_ENDED });
  });
  it('other errors pass through', async () => {
    await expect(createHttpApi('/api/v1', { fetch: answer(403, { error: 'Home Assistant admin required' }) }).getSettings()).rejects.toMatchObject({ status: 403, message: 'Home Assistant admin required' });
  });
});

describe('sign-in start timeout (#79)', () => {
  (globalThis as { location?: unknown }).location ??= { pathname: '/link' };
  it('a display that never answers POST /auth/ha/start ends in a message, not an endless wait', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const api = createHttpApi('/api/v1', { fetch: hang, haStartTimeoutMs: 30, nav: () => {} });
    await expect(api.signInWithHa('test', 'ha.example:8123')).rejects.toMatchObject({ status: 504, message: HA_NO_ANSWER });
  });
  it('an answer in time navigates to Home Assistant', async () => {
    let went = '';
    const api = createHttpApi('/api/v1', { fetch: answer(200, { authorize_url: 'http://ha:8123/auth/authorize?x=1' }), haStartTimeoutMs: 50, nav: (u) => { went = u; } });
    void api.signInWithHa('test', 'ha:8123');
    await new Promise((r) => setTimeout(r, 100));   // past the timeout: an answer in time is not turned into an error
    expect(went).toBe('http://ha:8123/auth/authorize?x=1');
  });
});
