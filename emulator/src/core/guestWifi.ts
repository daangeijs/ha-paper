// Guest Wi-Fi tile (eink-ha-os#329): a QR code that joins the guest network, with the name and password in large type. Pure;
// firmware core/guest_wifi.cpp must match spec/test-vectors/guest-wifi.json. The QR comes from Nayuki's qrcodegen
// (./qrcodegen.ts; the firmware vendors the same library's C version): byte mode, ECC M, version 1–6, mask chosen by
// the library. Never log the payload or the password.
import { Ecc, QrCode, QrSegment } from './qrcodegen.ts';

export const GUEST_SECURITY = ['WPA', 'WEP', 'nopass'];
/** Where a rotating password can come from (`password_entity`, its state is the password). */
export const GUEST_PW_DOMAINS = ['input_text', 'text', 'sensor'];
export const GUEST_QR_MAX_VERSION = 6;
/** Quiet zone around the code, in modules (white; the tile's own padding counts). */
export const GUEST_QUIET = 4;

/** WIFI: payload field: a backslash before \ ; , : " (ZXing's MECARD-style escaping). */
export const wifiEscape = (s: string): string => s.replace(/[\\;,:"]/g, '\\$&');

/** `WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:true;;` (no P for nopass, H only when hidden). */
export function guestPayload(ssid: string, password: string, security: string, hidden: boolean): string {
  return 'WIFI:T:' + security + ';S:' + wifiEscape(ssid) + ';' + (security === 'nopass' ? '' : 'P:' + wifiEscape(password) + ';') + (hidden ? 'H:true;' : '') + ';';
}

const utf8 = new TextEncoder();
const hex = (b: number) => '%' + b.toString(16).toUpperCase().padStart(2, '0');
const pctBytes = (ch: string) => Array.from(utf8.encode(ch), hex).join('');

/** `ssid` / `password` in screens.yaml: the widget flow map splits on "," and trims, digits-only values become numbers.
 *  So "%" "," "{" "}" and control characters are written as %XX (UTF-8 bytes), as are whitespace at either end and the
 *  first digit of a digits-only value. Everything else stays readable. */
export function fieldEncode(v: string): string {
  const cs = Array.from(v);
  let out = cs.map((ch, k) => {
    const c = ch.codePointAt(0)!;
    const edge = (k === 0 || k === cs.length - 1) && /\s/.test(ch);
    return edge || c < 0x20 || c === 0x7f || '%,{}'.includes(ch) ? pctBytes(ch) : ch;
  }).join('');
  if (/^\d+$/.test(out)) out = hex(out.charCodeAt(0)) + out.slice(1);
  return out;
}

/** fieldEncode undone: %XX (two hex digits) → that byte (%00 dropped), the bytes read as UTF-8; anything else as written. */
export function fieldDecode(v: unknown): string {
  if (v === undefined || v === null) return '';
  const src = utf8.encode(String(v)); const out: number[] = [];
  const hv = (b: number) => (b >= 48 && b <= 57 ? b - 48 : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1);
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 37 && i + 2 < src.length && hv(src[i + 1]) >= 0 && hv(src[i + 2]) >= 0) { const b = hv(src[i + 1]) * 16 + hv(src[i + 2]); if (b) out.push(b); i += 2; }
    else out.push(src[i]);
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

/** Config checks (spec/SCHEMA.md "guestWifi"); '' = fine. */
export function guestError(w: Record<string, unknown>): string {
  if (w.security !== undefined && !GUEST_SECURITY.includes(String(w.security))) return 'guestWifi: security must be WPA, WEP or nopass';
  if (w.hidden !== undefined && w.hidden !== 'true' && w.hidden !== 'false') return 'guestWifi: hidden must be true or false';
  return '';
}

export type GuestStatus = 'ok' | 'pick' | 'wait' | 'long';
export type GuestView = {
  status: GuestStatus;   // ok: QR; pick: no network (or password) set yet; wait: password_entity has no value; long: no QR fits
  ssid: string;
  password: string;      // '' for nopass and while waiting
  open: boolean;         // security nopass
  payload: string;       // '' unless ok / long
};

/** What the tile shows. `pwState` = the password entity's state (undefined = not in HA). */
export function guestView(w: Record<string, unknown>, pwState: string | undefined): GuestView {
  const ssid = fieldDecode(w.ssid);
  const sec = GUEST_SECURITY.includes(String(w.security)) ? String(w.security) : 'WPA';
  const open = sec === 'nopass';
  const ent = typeof w.password_entity === 'string' ? w.password_entity : '';
  const live = pwState !== undefined && pwState !== '' && pwState !== 'unavailable' && pwState !== 'unknown';
  const password = open ? '' : ent ? (live ? pwState! : '') : fieldDecode(w.password);
  const v: GuestView = { status: 'ok', ssid, password, open, payload: '' };
  if (!ssid || (!open && !ent && !password)) return { ...v, status: 'pick' };
  if (!open && ent && !live) return { ...v, status: 'wait' };
  v.payload = guestPayload(ssid, password, sec, w.hidden === 'true');
  if (!guestQr(v.payload)) v.status = 'long';
  return v;
}

/** The QR modules (rows of 0/1, 1 = dark) of `text` at ECC M, version 1–6; null = too long. */
export function guestQr(text: string): number[][] | null {
  let q: QrCode;
  try { q = QrCode.encodeSegments(QrSegment.makeSegments(text), Ecc.MEDIUM, 1, GUEST_QR_MAX_VERSION, -1, false); }
  catch { return null; }
  return Array.from({ length: q.size }, (_, y) => Array.from({ length: q.size }, (_, x) => (q.getModule(x, y) ? 1 : 0)));
}

/** Text block: caption (16 px, 18 high) + value (bold 28, 34 high), twice, 2 px apart. */
export const GUEST_TEXT_H = 108;
export const GUEST_ROW = { caption: 0, value: 18, next: 54 };

export type GuestLayout = {
  kind: 'stack' | 'side' | 'qr';   // QR above the text (2×2) / QR left, text right (2×1, 4 wide) / QR only (1 wide)
  zone: { x: number; y: number; s: number };   // the square the code and its quiet zone live in
  px: number;                                  // px per module (0: no code)
  qx: number; qy: number;                      // the code's top-left (modules start here)
  text: { x: number; y: number; w: number } | null;   // the two rows (caption + value, 54 px each)
};
/** Tile-relative geometry of a w × h tile (outer rect, 2 px border inside), `n` modules per side (0 = no code). */
export function guestLayout(w: number, h: number, cs: number, rs: number, n: number): GuestLayout {
  const B = 2;
  const kind = cs < 2 ? 'qr' : rs >= 2 && cs < 4 ? 'stack' : 'side';
  let zone: GuestLayout['zone']; let text: GuestLayout['text'] = null;
  if (kind === 'stack') {
    const ty = h - 10 - GUEST_TEXT_H;
    const s = Math.min(w - 2 * B, ty - B);
    zone = { x: Math.floor((w - s) / 2), y: B, s };
    text = { x: 14, y: ty, w: w - 28 };
  } else if (kind === 'side') {
    zone = { x: B, y: B, s: h - 2 * B };
    const tx = zone.x + zone.s;
    text = { x: tx, y: Math.floor((h - GUEST_TEXT_H) / 2), w: w - 14 - tx };
  } else {
    const s = Math.min(w, h) - 2 * B;
    zone = { x: Math.floor((w - s) / 2), y: Math.floor((h - s) / 2), s };
  }
  const px = n > 0 ? Math.floor(zone.s / (n + 2 * GUEST_QUIET)) : 0;
  const off = Math.floor((zone.s - px * n) / 2);
  return { kind, zone, px, qx: zone.x + off, qy: zone.y + off, text };
}
