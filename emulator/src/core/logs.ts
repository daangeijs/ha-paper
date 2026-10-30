// Device log ring (GET /api/v1/logs, eink-ha-os#200). The behaviour spec for firmware/src/core/log_ring.cpp: every LOG_* line
// goes into a byte-budgeted ring (64 KB in PSRAM on the device) and into a 2 KB tail in RTC memory that survives a
// soft reset, panic or watchdog reset (`boot=previous`). A line costs 16 header bytes + tag + message (UTF-8); the
// oldest lines go when the budget is full. Messages are redacted before they are stored or printed.
// Vectors: spec/test-vectors/logs.json (scripts/gen-vectors.ts).

export const LOG_CAP = 65536;
export const LOG_TAIL_CAP = 2048;
export const LOG_HDR = 16;
export const LOG_TAG_MAX = 15;
export const LOG_MSG_MAX = 239;
export const LOG_LIMIT = 300;
export const LOG_LIMIT_MAX = 1000;

export type LogLevel = 'E' | 'W' | 'I';
export type LogLine = { seq: number; ms: number; epoch: number | null; level: LogLevel; tag: string; msg: string };
export type LogRing = { cap: number; used: number; next: number; lines: LogLine[] };
export type LogsResponse = { boot: 'current' | 'previous'; seq: number; first: number; dropped: boolean; more: boolean; lines: LogLine[] };
export type LogsQuery = { since?: number; level?: LogLevel; tags?: string[]; limit?: number };

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s).length;

export const logRing = (cap = LOG_CAP): LogRing => ({ cap, used: 0, next: 1, lines: [] });
const lineBytes = (l: LogLine) => LOG_HDR + bytes(l.tag) + bytes(l.msg);

/** Cut to `max` UTF-8 bytes without splitting a character. */
export function cutUtf8(s: string, max: number): string {
  const b = enc.encode(s);
  if (b.length <= max) return s;
  let n = max;
  while (n > 0 && (b[n] & 0xc0) === 0x80) n--;
  return dec.decode(b.subarray(0, n));
}

const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
const isAlnum = (c: string | undefined) => !!c && /^[0-9A-Za-z]$/.test(c);
const SEP = ' \t:="\'';
const DELIM = ' \t\r\n,;&"\'<>(){}[]';
const KEYS = ['password', 'passwd', 'secret', 'token', 'bearer', 'cookie', 'session'];
const JWT = /^[A-Za-z0-9_.-]$/;

/** Mask what looks like a secret: `<key><sep><value>` where key is one of KEYS (case-insensitive, anywhere in a word)
 *  and sep holds ':' or '=' (for "bearer" spaces do), a JWT (eyJ + 8 or more [A-Za-z0-9_.-]), an x4 API token (x4_ +
 *  20 or more alnum) and a run of 32 or more hex digits (HA refresh token, OAuth code, hashes). Value → "***". */
export function redact(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  outer: while (i < n) {
    const low = s.slice(i, i + 8).replace(/[A-Z]/g, (c) => c.toLowerCase());
    for (const k of KEYS) {
      if (!low.startsWith(k)) continue;
      let j = i + k.length;
      let sep = '';
      while (j < n && SEP.includes(s[j])) sep += s[j++];
      const ok = k === 'bearer' ? sep.length > 0 : sep.includes(':') || sep.includes('=');
      let v = j;
      while (v < n && !DELIM.includes(s[v])) v++;
      if (ok && v > j) { out += s.slice(i, j) + '***'; i = v; continue outer; }
    }
    const wordStart = !isAlnum(s[i - 1]);
    if (wordStart && s.startsWith('eyJ', i)) {
      let j = i + 3;
      while (j < n && JWT.test(s[j])) j++;
      if (j - i - 3 >= 8) { out += 'eyJ***'; i = j; continue; }
    }
    if (wordStart && s.startsWith('x4_', i)) {
      let j = i + 3;
      while (j < n && isAlnum(s[j])) j++;
      if (j - i - 3 >= 20) { out += 'x4_***'; i = j; continue; }
    }
    if (wordStart && isHex(s[i])) {
      let j = i;
      while (j < n && isHex(s[j])) j++;
      if (j - i >= 32 && !isAlnum(s[j])) { out += '***'; i = j; continue; }
      out += s.slice(i, j); i = j; continue;
    }
    out += s[i++];
  }
  return out;
}

/** One line in: redacted, tag and message cut, oldest lines dropped until it fits. `epoch` 0 = clock not set. */
export function logPush(r: LogRing, ms: number, epoch: number, level: LogLevel, tag: string, msg: string): LogRing {
  const l: LogLine = { seq: r.next, ms: ms >>> 0, epoch: epoch > 0 ? epoch : null, level, tag: cutUtf8(tag, LOG_TAG_MAX), msg: cutUtf8(redact(msg), LOG_MSG_MAX) };
  const size = lineBytes(l);
  const lines = [...r.lines];
  let used = r.used;
  while (lines.length && used + size > r.cap) used -= lineBytes(lines.shift() as LogLine);
  return { cap: r.cap, used: used + size, next: r.next + 1, lines: [...lines, l] };
}

/** The newest lines that fit in `cap` bytes: what the RTC tail holds when the device resets. */
export function logTail(r: LogRing, cap = LOG_TAIL_CAP): LogRing {
  const keep: LogLine[] = [];
  let used = 0;
  for (let i = r.lines.length - 1; i >= 0; i--) {
    const b = lineBytes(r.lines[i]);
    if (used + b > cap) break;
    used += b; keep.unshift(r.lines[i]);
  }
  return { cap, used, next: r.next, lines: keep };
}

const RANK: Record<LogLevel, number> = { E: 0, W: 1, I: 2 };

/** ?since=&level=&tag=&limit= → query, or an error text for 422. level: E | W | I (that level and worse); tag: comma
 *  list, case-insensitive; limit 1–1000 (default 300). */
export function logsQueryOf(p: { since?: string | null; level?: string | null; tag?: string | null; limit?: string | null }): LogsQuery | string {
  const q: LogsQuery = {};
  const int = (v: string) => (/^\d{1,10}$/.test(v) ? Number(v) : -1);
  if (p.since != null && p.since !== '') { const v = int(p.since); if (v < 0 || v > 0xffffffff) return 'since must be a line number'; q.since = v; }
  if (p.level != null && p.level !== '') { const v = p.level.toUpperCase(); if (v !== 'E' && v !== 'W' && v !== 'I') return 'level must be E, W or I'; q.level = v; }
  if (p.tag != null && p.tag !== '') q.tags = p.tag.split(',').map((t) => t.trim().toUpperCase()).filter((t) => t);
  if (p.limit != null && p.limit !== '') { const v = int(p.limit); if (v < 1 || v > LOG_LIMIT_MAX) return 'limit must be 1 to ' + LOG_LIMIT_MAX; q.limit = v; }
  return q;
}

/** GET /logs: lines after `since` that pass the filters, oldest first, at most `limit`. Poll with since = seq.
 *  seq = the last line looked at (the newest line when not cut by limit); first = the oldest line still held;
 *  dropped = lines after `since` were already overwritten; more = cut by limit. */
export function logsQuery(r: LogRing, q: LogsQuery = {}, boot: 'current' | 'previous' = 'current'): LogsResponse {
  const since = q.since ?? 0, limit = q.limit ?? LOG_LIMIT, tags = q.tags?.map((t) => t.toUpperCase());
  const first = r.lines.length ? r.lines[0].seq : r.next;
  const out: LogLine[] = [];
  let seq = r.next - 1, more = false;
  for (let i = 0; i < r.lines.length; i++) {
    const l = r.lines[i];
    if (l.seq <= since) continue;
    if (q.level && RANK[l.level] > RANK[q.level]) continue;
    if (tags?.length && !tags.includes(l.tag.toUpperCase())) continue;
    out.push(l);
    if (out.length >= limit) { seq = l.seq; more = i < r.lines.length - 1; break; }
  }
  return { boot, seq, first, dropped: since > 0 && since + 1 < first, more, lines: out };
}

/** One line as text (download, `make logs`): "  1234.567 I [TAG] message". */
export const logText = (l: LogLine) => (l.ms / 1000).toFixed(3).padStart(10) + ' ' + l.level + ' [' + l.tag + '] ' + l.msg;

/** device-sim log strings ("EPD full (boot)") → tag + message: a leading uppercase word is the tag, else SIM. */
export function logSplit(s: string): { tag: string; msg: string } {
  const m = /^([A-Z][A-Z0-9_]{1,14}) (.*)$/s.exec(s);
  return m ? { tag: m[1], msg: m[2] } : { tag: 'SIM', msg: s };
}
