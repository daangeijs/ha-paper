// Guest Wi-Fi tile (eink-ha-os#329) through the display: 2×2, 2×1, 1-wide, both looks, a password from HA, the console fields.
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Emulator, type EmuState } from './Emulator.tsx';
import { fieldDecode } from '../core/guestWifi.ts';
import { setGuestField } from '../webconsole/guestEdit.ts';

const W = [
  { type: 'guestWifi', ssid: 'Harbor Guest', password: 'tea%2C please', cs: 2, rs: 2 },
  { type: 'guestWifi', ssid: 'Harbor Guest', password_entity: 'input_text.guest_pw', cs: 2 },
  { type: 'guestWifi' },
];
function at(look: 'classic' | 'geist', pw: string | undefined, lang: 'en' | 'nl' = 'en') {
  const e = new Emulator({});
  const base = e.state;
  (e as any).state = { ...base, mode: 'main', setup: null, offline: false, haLang: lang, wifi: { ...base.wifi, connected: 'HomeNet' }, ha: { ...base.ha, linked: true },
    ent: { ...base.ent, ...(pw === undefined ? {} : { 'input_text.guest_pw': pw }) },
    screens: [{ id: 'guest', app: 'home', title: 'Guest', widgets: W }, ...base.screens.filter((s) => s.app === 'settings')], idx: 0, sub: 0,
    cfg: { ...base.cfg, ...(look === 'classic' ? { style: 'classic' } : { style: 'sleek', typeface: look }) } as EmuState['cfg'] };
  const h = renderToString(e.render());
  return { h: h.slice(h.indexOf('data-x4-screen')), vals: e.tileValues('guest')! };
}

describe('guest Wi-Fi tile renders (eink-ha-os#329)', () => {
  for (const look of ['classic', 'geist'] as const) it(look + ': QR + name + password; a missing HA password waits', () => {
    const r = at(look, 'otter-42');
    expect(r.h.match(/aria-label="QR code"/g)!.length).toBe(2);
    expect(r.h).toContain('Harbor Guest'); expect(r.h).toContain('tea, please'); expect(r.h).toContain('otter-42');
    expect(r.h).toContain('Enter the network in the browser');
    expect(r.vals.slice(0, 3)).toEqual(['Harbor Guest', 'Harbor Guest', '—']);   // the name, never the password
    const wait = at(look, 'unavailable', 'nl');
    expect(wait.h.match(/aria-label="QR code"/g)!.length).toBe(1);
    expect(wait.h).toContain('Geen wachtwoord van Home Assistant');
  });
});

describe('guest Wi-Fi console fields (eink-ha-os#329)', () => {
  it('encodes name and password, drops defaults', () => {
    let ws = setGuestField([{ type: 'guestWifi', cs: 2, rs: 2 }], 0, 'ssid', 'Cafe, Upstairs');
    ws = setGuestField(ws, 0, 'password', '00042');
    ws = setGuestField(ws, 0, 'security', 'WEP');
    ws = setGuestField(ws, 0, 'hidden', 'true');
    ws = setGuestField(ws, 0, 'password_entity', 'input_text.Guest pw!');
    expect(ws[0]).toEqual({ type: 'guestWifi', cs: 2, rs: 2, ssid: 'Cafe%2C Upstairs', password: '%300042', security: 'WEP', hidden: 'true', password_entity: 'input_text.uestpw' });
    expect(fieldDecode(ws[0].password)).toBe('00042');
    ws = setGuestField(ws, 0, 'security', 'WPA'); ws = setGuestField(ws, 0, 'hidden', ''); ws = setGuestField(ws, 0, 'password', '');
    expect(ws[0]).toEqual({ type: 'guestWifi', cs: 2, rs: 2, ssid: 'Cafe%2C Upstairs', password_entity: 'input_text.uestpw' });
  });
});
