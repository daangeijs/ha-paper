// Sign a real display (or the QEMU firmware) in through the standalone fake HA, like a user in the browser would.
export {};
//   node scripts/device-signin.ts [device=http://127.0.0.1:8080] [fakeHa=http://127.0.0.1:8123] [haAsSeenByDevice=http://10.0.2.2:8123]
// Prints the x4_session cookie (export X4_SESSION=…). The first sign-in also links the display (OAuth2 + PKCE).
const [device = 'http://127.0.0.1:8080', ha = 'http://127.0.0.1:8123', haDevice = 'http://10.0.2.2:8123'] = process.argv.slice(2);
const toLocal = (u: string) => (u.startsWith(haDevice) ? ha + u.slice(haDevice.length) : u);
const start = await fetch(device + '/api/v1/auth/ha/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ return_to: '/', ha_url: haDevice }) });
if (start.status !== 200) { console.error('auth/ha/start →', start.status, await start.text()); process.exit(1); }
const auth = new URL((await start.json()).authorize_url);
const form = new URLSearchParams(auth.searchParams); form.set('username', process.env.X4_HA_USER || 'user'); form.set('password', 'x'); form.set('admin', '1');
const login = await fetch(toLocal(auth.origin) + '/auth/authorize', { method: 'POST', body: form, redirect: 'manual' });
const cb = new URL(login.headers.get('location') || '');
const res = await fetch(device + cb.pathname + cb.search, { redirect: 'manual' });
const cookie = (res.headers.getSetCookie().find((c) => c.startsWith('x4_session=')) || '').match(/^x4_session=([^;]*)/)?.[1];
if (res.status !== 302 || !cookie) { console.error('callback →', res.status, await res.text()); process.exit(1); }
console.log(cookie);
