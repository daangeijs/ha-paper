// Device API tokens (ARCHITECTURE §4): issued by the device, shown once, only a hash is stored.
// Errors: 401 missing / invalid / revoked token, 403 read-only token used for a write.

export type Scope = 'ro' | 'rw';
export type StoredToken = { id: string; name: string; scope: Scope; created: string; last: string; hash: string; masked: string };
export type AuthError = { code: 401 | 403; error: string };

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const newTokenSecret = (rand: () => number = Math.random): string => 'x4_' + Array.from({ length: 26 }, () => ALPHABET[Math.floor(rand() * 31)]).join('');
export const maskToken = (secret: string): string => secret.slice(0, 6) + '…' + secret.slice(-4);

/** Emulator stand-in for SHA-256 (the firmware must use SHA-256 + constant-time compare). */
export function hashToken(secret: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < secret.length; i++) { const c = secret.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Hash function used for StoredToken.hash. The emulator uses hashToken; the device simulator (and firmware) SHA-256. */
export type TokenHash = (secret: string) => string;

/** null = allowed. `presented` is the bearer secret (or null when the header is missing). */
export function authorize(tokens: StoredToken[], presented: string | null, need: 'read' | 'write', hash: TokenHash = hashToken): AuthError | null {
  if (!presented) return { code: 401, error: 'missing token' };
  const h = hash(presented);
  const live = tokens.find((k) => k.hash === h);
  if (!live) return { code: 401, error: 'invalid or revoked token' };
  if (need === 'write' && live.scope !== 'rw') return { code: 403, error: 'token is read-only' };
  return null;
}
export const findToken = (tokens: StoredToken[], presented: string | null, hash: TokenHash = hashToken): StoredToken | undefined =>
  presented ? tokens.find((k) => k.hash === hash(presented)) : undefined;
