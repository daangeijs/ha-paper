// npm run device-sim -- [flags]   (Node ≥ 23.6 runs this TypeScript directly; no runtime dependencies)
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { PRESETS, type Preset } from './device.ts';
import { startSimulator } from './index.ts';
import { HOUSES, type House } from './fake-ha.ts';

const HELP = `HA Paper device simulator — the on-device web console + REST API (spec/openapi.yaml) on your laptop.

  npm run device-sim -- [options]

  --port <n>              device HTTP port (default 8080)
  --host <addr>           bind address (default 0.0.0.0)
  --state <file>          persist NVS/LittleFS state to a JSON file (loaded at start when it exists)
  --state-preset <p>      first-install | never-linked | installed (default: installed, or the --state file)
  --ha-url <url>          Home Assistant to sign in with, e.g. http://homeassistant.local:8123 (real HA)
  --fake-ha               run the built-in fake Home Assistant (default when --ha-url is not given)
  --fake-ha-port <n>      fake HA port (default 8123)
  --ha-tick <ms>          fake HA live-data interval (default 5000, 0 = off)
  --house <h>             fake HA data: demo | stranger | big | dutch | dutch-energy (default demo; stranger = someone else's HA, eink-ha-os#23; big = +1200 entities, eink-ha-os#57; dutch = SolarEdge, P1, Anker, tado, eink-ha-os#82)
  --releases-file <json>  mock GitHub releases for OTA (see server/ota.ts)
  --battery <pct>         simulated battery level (default 76; < 30 blocks OTA)
  --quiet                 no event log
  -h, --help
`;

const { values: a } = parseArgs({
  options: {
    port: { type: 'string' }, host: { type: 'string' }, state: { type: 'string' }, 'state-preset': { type: 'string' },
    'ha-url': { type: 'string' }, 'fake-ha': { type: 'boolean' }, 'fake-ha-port': { type: 'string' }, 'ha-tick': { type: 'string' }, house: { type: 'string' },
    'releases-file': { type: 'string' }, battery: { type: 'string' }, quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});
if (a.help) { console.log(HELP); process.exit(0); }
const preset = a['state-preset'] as Preset | undefined;
if (preset && !PRESETS.includes(preset)) { console.error('--state-preset must be one of ' + PRESETS.join(', ')); process.exit(2); }
if (a.house && !HOUSES.includes(a.house as House)) { console.error('--house must be one of ' + HOUSES.join(', ')); process.exit(2); }

const t0 = Date.now();
const log = a.quiet ? () => {} : (m: string) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(7) + 's  ' + m);
const run = await startSimulator({
  port: a.port ? Number(a.port) : 8080, host: a.host,
  haUrl: a['ha-url'], fakeHa: !!a['fake-ha'] || !a['ha-url'], fakeHaPort: a['fake-ha-port'] ? Number(a['fake-ha-port']) : 8123,
  haTickMs: a['ha-tick'] ? Number(a['ha-tick']) : 5000, house: a.house as House | undefined,
  preset, stateFile: a.state ? resolve(a.state) : null, releasesFile: a['releases-file'] ? resolve(a['releases-file']) : null,
  battery: a.battery ? Number(a.battery) : undefined, log,
});
console.log(`
  HA Paper device simulator
  Web console   ${run.url}/            (setup wizard: ${run.url}/setup)
  REST API      ${run.url}/api/v1/      (spec/openapi.yaml)
  Sim state     ${run.url}/__sim/state
  Home Assist.  ${run.haUrl}${run.fakeHa ? '   (fake HA: any user/password; tick ' + (a['ha-tick'] || 5000) + ' ms)' : '   (real HA)'}
  Preset        ${preset || (a.state ? 'from ' + a.state + ' (or installed)' : 'installed')}
`);
const stop = async () => { await run.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
