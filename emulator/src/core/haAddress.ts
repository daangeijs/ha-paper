// Home Assistant address typed on the link page (eink-ha-os#54): normalise, probe, pick the URL or say what's wrong.
// Firmware: core/ha_address.cpp. Vectors: spec/test-vectors/ha-address.json.

export type HaAddress = { url: string; alt: string; typed: boolean } | { error: string };
/** One GET <url>/auth/providers without following redirects. status ≤ 0 = no answer (refused, DNS, timeout, TLS). */
export type ProbeAnswer = { status: number; body?: string; location?: string };
export type HaResolved = { url: string } | { status: number; error: string };

export const HA_PROBE_PATH = '/auth/providers';
export const HA_DEFAULT_PORT = 8123;
/** One probe at a time; the next may start this long after the last one ended (eink-ha-os#75). Else 429. */
export const HA_PROBE_COOLDOWN_MS = 1000;
export const HA_PROBE_BUSY = 'The display is still checking an address. Try again in a moment.';

const NOT_ADDRESS = 'That is not an address. Try homeassistant.local:8123.';
const NOT_HERE = 'Home Assistant can’t be at that address (loopback or link-local). Try homeassistant.local:8123.';

/** lwip / inet_aton IPv4: 1–4 parts, each decimal, 0x hex or 0 octal ("127.1", "0x7f.0.0.1", "2130706433") → the
 *  first two bytes. null = not an IPv4 address (then it is a name). */
function ipv4(h: string): [number, number] | null {
  const parts = h.split('.');
  if (parts.length > 4) return null;
  let addr = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], m = /^0x([0-9a-f]*)$/i.exec(p);
    const v = m ? (m[1] ? parseInt(m[1], 16) : 0) : /^0[0-7]*$/.test(p) ? parseInt(p, 8) : /^[1-9][0-9]*$/.test(p) ? Number(p) : NaN;
    const last = i === parts.length - 1, room = last ? 2 ** (8 * (4 - i)) : 256;
    if (!(v < room)) return null;
    addr += last ? v : v * 2 ** (8 * (3 - i));
  }
  return [Math.floor(addr / 2 ** 24), Math.floor(addr / 2 ** 16) % 256];
}

/** "[…]" IPv6 → 8 groups (with ::, a trailing dotted IPv4). null = not one. */
function ipv6(h: string): number[] | null {
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    const ps = s.split(':');
    for (let i = 0; i < ps.length; i++) {
      if (i === ps.length - 1 && ps[i].includes('.')) {
        const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ps[i]) ? ps[i].split('.').map(Number) : null;
        if (!v4 || v4.some((b) => b > 255)) return null;
        out.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(ps[i])) out.push(parseInt(ps[i], 16));
      else return null;
    }
    return out;
  };
  const a = groups(halves[0]), b = halves.length === 2 ? groups(halves[1]) : [];
  if (!a || !b) return null;
  if (halves.length === 1) return a.length === 8 ? a : null;
  return a.length + b.length <= 7 ? [...a, ...Array(8 - a.length - b.length).fill(0), ...b] : null;
}

/** Loopback (127/8, 0/8, ::1, ::, localhost) or link-local (169.254/16, fe80::/10): never Home Assistant for the display. */
export function isLocalOnlyHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('[')) {
    const g = ipv6(h.slice(1, -1));
    if (!g) return false;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true;   // ::1, ::
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isLocalOnlyHost((g[6] >> 8) + '.' + (g[6] & 255) + '.0.0');   // ::ffff:a.b.c.d
    return false;
  }
  const b = ipv4(h);
  return !!b && (b[0] === 127 || b[0] === 0 || (b[0] === 169 && b[1] === 254));
}

/**
 * "homeassistant.local:8123", "https://ha.example.com/lovelace/0", "192.168.1.5" → base URL + the other scheme to try.
 * LAN addresses are fine; loopback and link-local are refused (eink-ha-os#75). allowHost: the device-sim's own fake HA on localhost.
 * The other scheme keeps the port only when it is HA's own 8123 (HA serves http or https there); any other typed port
 * belongs to the typed scheme (a proxy), so the other scheme is tried on its default port (eink-ha-os#75).
 */
export function parseHaAddress(input: string, allowHost?: string): HaAddress {
  let s = input.trim();
  if (!s) return { error: 'Enter the Home Assistant address.' };
  let scheme = '';
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return { error: 'Use an http or https address, like homeassistant.local:8123.' };
    s = s.slice(m[0].length);
  }
  s = s.replace(/[/?#].*$/, '');
  const hp = /^([a-z0-9._-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i.exec(s);
  if (!hp) return { error: NOT_ADDRESS };
  const host = hp[1].toLowerCase();
  const port = hp[2] === undefined ? 0 : Number(hp[2]);
  if (hp[2] !== undefined && (port < 1 || port > 65535)) return { error: NOT_ADDRESS };
  if (host !== allowHost && isLocalOnlyHost(host)) return { error: NOT_HERE };
  const other = (sch: string) => (sch === 'http' ? 'https' : 'http');
  const origin = (sch: string, p: number) => sch + '://' + host + (p && p !== (sch === 'https' ? 443 : 80) ? ':' + p : '');
  const altPort = port === HA_DEFAULT_PORT ? port : 0;
  if (scheme) return { url: origin(scheme, port), alt: origin(other(scheme), altPort), typed: true };
  return { url: origin('http', port || HA_DEFAULT_PORT), alt: origin('https', altPort), typed: false };
}

/** HA answers /auth/providers with {"providers":[…]} (2023.12+) or a bare list of {name,id,type}. */
export function isHaProviders(body: string): boolean {
  let j: unknown; try { j = JSON.parse(body); } catch { return false; }
  const list = Array.isArray(j) ? j : j && typeof j === 'object' ? (j as { providers?: unknown }).providers : undefined;
  return Array.isArray(list) && list.length > 0 && list.every((p) => !!p && typeof p === 'object' && typeof (p as { type?: unknown }).type === 'string');
}

/** scheme://host[:port] of an absolute Location header (default port dropped), '' otherwise. */
export function originOf(location: string): string {
  const m = /^(https?):\/\/([^/?#]+)/i.exec(location.trim());
  if (!m) return '';
  const scheme = m[1].toLowerCase();
  return scheme + '://' + m[2].toLowerCase().replace(scheme === 'https' ? /:443$/ : /:80$/, '');
}

const ok = (a: ProbeAnswer) => a.status === 200 && isHaProviders(a.body || '');

/**
 * Pick the HA base URL. Probes the address as typed; if that isn't HA, tries the other scheme, or instead the
 * redirect target when it is the https upgrade of the same host and port (eink-ha-os#75: any other redirect is refused).
 * No scheme typed, or http typed and HA answers on https: use the working one. https typed and HA only answers on
 * plain http: say so (no silent downgrade). 422 = not an address / not Home Assistant / wrong scheme / redirects
 * elsewhere, 502 = no answer. Probed bodies are never echoed.
 */
export async function resolveHaAddress(input: string, probe: (url: string) => Promise<ProbeAnswer>, allowHost?: string): Promise<HaResolved> {
  const a = parseHaAddress(input, allowHost);
  if ('error' in a) return { status: 422, error: a.error };
  const first = await probe(a.url);
  if (ok(first)) return { url: a.url };
  const redirect = first.status >= 300 && first.status < 400;
  const moved = redirect ? originOf(first.location || '') : '';
  const upgrade = a.url.startsWith('http://') && moved === 'https://' + a.url.slice('http://'.length);
  const next = upgrade ? moved : a.alt;
  const second = await probe(next);
  if (ok(second)) {
    if (a.typed && next.startsWith('http://') && a.url.startsWith('https://')) return { status: 422, error: 'Home Assistant answers at ' + next + ', not over https. Use that address.' };
    return { url: next };
  }
  if (first.status <= 0) return { status: 502, error: 'The display can’t reach ' + a.url + '. Check the address and that Home Assistant is running.' };
  if (moved && !upgrade && moved !== a.url) return { status: 422, error: a.url + ' redirects to another address. Enter the Home Assistant address itself.' };
  return { status: 422, error: a.url + ' answers, but it is not Home Assistant.' };
}
