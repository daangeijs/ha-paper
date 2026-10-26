// npm run fake-ha -- [--port 8123] [--host 0.0.0.0] [--tick 5000] [--house demo|stranger|big|dutch|dutch-energy|real] [--quiet]
//                    [--tls-port 8124 [--tls-cert ha.pem --tls-key ha.key]]
// The device simulator's fake Home Assistant on its own, for testing the REAL firmware (QEMU `make qemu-contract`,
// or a display on the LAN): OAuth2 + PKCE login page, /auth/token, /auth/revoke, /api/websocket, /__fake/* control.
// --tls-port: the same HA over https as well, by default with sim/qemu/tls's test certificate (only x4qemu trusts it).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FakeHa, HOUSES, type House } from './fake-ha.ts';

const TLS_DIR = join(import.meta.dirname, '..', '..', 'sim', 'qemu', 'tls');
const { values: a } = parseArgs({ options: { port: { type: 'string' }, host: { type: 'string' }, tick: { type: 'string' }, house: { type: 'string' }, quiet: { type: 'boolean' }, 'tls-port': { type: 'string' }, 'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (a.help) { console.log('npm run fake-ha -- [--port 8123] [--host 0.0.0.0] [--tick ms, 0 = off] [--house demo|stranger|big|dutch|dutch-energy|real] [--quiet] [--tls-port 8124 [--tls-cert pem --tls-key pem]]'); process.exit(0); }
if (a.house && !HOUSES.includes(a.house as House)) { console.error('--house must be one of ' + HOUSES.join(', ')); process.exit(2); }
const t0 = Date.now();
const log = a.quiet ? () => {} : (m: string) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(7) + 's  ' + m);
const ha = new FakeHa({ port: a.port ? Number(a.port) : 8123, host: a.host || '0.0.0.0', tickMs: a.tick ? Number(a.tick) : 5000, house: a.house as House | undefined, log });
const url = await ha.listen();
console.log(`fake Home Assistant on ${url} (any user/password; control: ${url}/__fake/state)`);
if (a['tls-port']) {
  const tlsUrl = await ha.listenTls(Number(a['tls-port']), { cert: readFileSync(a['tls-cert'] || join(TLS_DIR, 'ha.pem')), key: readFileSync(a['tls-key'] || join(TLS_DIR, 'ha.key')) });
  console.log(`  and over https on ${tlsUrl}`);
}
const stop = async () => { await ha.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
