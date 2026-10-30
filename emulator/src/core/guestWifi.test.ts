// Guest Wi-Fi tile (eink-ha-os#329): payload escaping, the screens.yaml field codec, states, QR capacity, layout.
import { describe, expect, it } from 'vitest';
import { fieldDecode, fieldEncode, guestError, guestLayout, guestPayload, guestQr, guestView, wifiEscape } from './guestWifi.ts';
import { parseYaml, toYaml } from './config.ts';

describe('guest Wi-Fi payload (eink-ha-os#329)', () => {
  it('escapes \\ ; , : " in the name and password', () => {
    expect(wifiEscape('a\\b;c,d:e"f')).toBe('a\\\\b\\;c\\,d\\:e\\"f');
    expect(guestPayload('Cafe Guest', 'p;a:ss', 'WPA', false)).toBe('WIFI:T:WPA;S:Cafe Guest;P:p\\;a\\:ss;;');
    expect(guestPayload('Lobby', 'x', 'nopass', true)).toBe('WIFI:T:nopass;S:Lobby;H:true;;');
    expect(guestPayload('Old', 'abcde', 'WEP', true)).toBe('WIFI:T:WEP;S:Old;P:abcde;H:true;;');
  });
  it('field codec survives the flow map', () => {
    for (const v of ['plain', 'with, comma', ' lead', 'trail ', '100%', '{brace}', '00123456', '12345678', 'ümlaut wifi', 'a:b#c"d', 'tab\tin']) {
      const e = fieldEncode(v);
      expect(fieldDecode(e)).toBe(v);
      const y = 'version: 1\nscreens:\n  - id: a\n    title: A\n    widgets:\n      - {type: guestWifi, ssid: ' + e + ', password: ' + e + ', cs: 2, rs: 2}\n';
      const w = parseYaml(y).screens[0].widgets[0];
      expect(fieldDecode(w.ssid)).toBe(v); expect(fieldDecode(w.password)).toBe(v);
      expect(parseYaml(toYaml(parseYaml(y))).screens[0].widgets[0]).toEqual(w);
    }
    expect(fieldEncode('00123456')).toBe('%300123456');
    expect(fieldEncode('with, comma')).toBe('with%2C comma');
    expect(fieldDecode('%zz%4')).toBe('%zz%4');
  });
  it('states: pick, wait, ok, long', () => {
    expect(guestView({}, undefined).status).toBe('pick');
    expect(guestView({ ssid: 'Guest' }, undefined).status).toBe('pick');
    expect(guestView({ ssid: 'Guest', security: 'nopass' }, undefined)).toMatchObject({ status: 'ok', open: true, payload: 'WIFI:T:nopass;S:Guest;;' });
    expect(guestView({ ssid: 'Guest', password: 'old', password_entity: 'input_text.pw' }, 'unavailable')).toMatchObject({ status: 'wait', password: '' });
    expect(guestView({ ssid: 'Guest', password: 'old', password_entity: 'input_text.pw' }, 'new-one')).toMatchObject({ status: 'ok', password: 'new-one' });
    expect(guestView({ ssid: 'Guest', password: 'x'.repeat(80) }, undefined).status).toBe('ok');
    expect(guestView({ ssid: 'Guest', password: 'x'.repeat(90) }, undefined).status).toBe('long');
  });
  it('QR: version 1–6 at ECC M, byte mode', () => {
    expect(guestQr('WIFI:T:WPA;S:Guest;P:welcome;;')!.length).toBe(29);   // 30 bytes: version 3
    expect(guestQr('x'.repeat(106))!.length).toBe(41);                    // version 6 holds 106 bytes
    expect(guestQr('x'.repeat(107))).toBeNull();
  });
  it('config rules', () => {
    expect(guestError({ security: 'WPA3' })).toMatch(/security/);
    expect(guestError({ hidden: 'yes' })).toMatch(/hidden/);
    const y = (f: string) => 'version: 1\nscreens:\n  - id: a\n    title: A\n    widgets:\n      - {type: guestWifi, ' + f + '}\n';
    expect(() => parseYaml(y('password_entity: light.x'))).toThrow(/password_entity/);
    expect(() => parseYaml(y('password_entity: input_text.guest_pw, hidden: true, security: WEP'))).not.toThrow();
  });
  it('layout: whole px per module, a 4-module quiet zone, text clear of the code', () => {
    const st = guestLayout(380, 394, 2, 2, 29);
    expect(st).toMatchObject({ kind: 'stack', px: 7, zone: { s: 274 } });
    expect(st.qy - st.zone.y).toBeGreaterThanOrEqual(4 * st.px);
    expect(st.qy + 29 * st.px + 4 * st.px).toBeLessThanOrEqual(st.text!.y);
    const side = guestLayout(380, 191, 2, 1, 29);
    expect(side).toMatchObject({ kind: 'side', px: 5 });
    expect(side.qx + 29 * side.px + 4 * side.px).toBeLessThanOrEqual(side.text!.x);
    expect(guestLayout(184, 191, 1, 1, 41)).toMatchObject({ kind: 'qr', px: 3, text: null });
  });
});
