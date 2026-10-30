// Web console: the guest Wi-Fi tile's fields (#329). Pure. ssid / password are stored fieldEncode'd (core/guestWifi.ts)
// so commas, braces and digits-only passwords survive screens.yaml; defaults (WPA, not hidden) are left out.
import { fieldEncode, GUEST_SECURITY } from '../core/guestWifi.ts';
import type { Widget } from '../core/config.ts';

export type GuestKey = 'ssid' | 'password' | 'security' | 'hidden' | 'password_entity';

export function setGuestField(ws: Widget[], i: number, k: GuestKey, v: string): Widget[] {
  const out = ws.map((x) => ({ ...x })); const w = out[i];
  let val: string | undefined;
  if (k === 'ssid' || k === 'password') val = v ? fieldEncode(v.replace(/[\r\n]/g, '')) : undefined;
  else if (k === 'security') val = GUEST_SECURITY.includes(v) && v !== 'WPA' ? v : undefined;
  else if (k === 'hidden') val = v === 'true' ? 'true' : undefined;
  else val = v.replace(/[^a-z0-9_.]/g, '') || undefined;
  if (val === undefined) delete w[k]; else w[k] = val;
  return out;
}
