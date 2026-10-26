// Boots the device simulator (and optionally the fake Home Assistant) in one process.
// Used by the CLI (./main.ts) and the contract tests (./contract.test.ts).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { DeviceSim, type Delays, type Preset } from './device.ts';
import { FakeHa, type House } from './fake-ha.ts';
import { createDeviceHandler } from './http.ts';
import { defaultReleases, loadReleases } from './ota.ts';

export const EMULATOR_DIR = fileURLToPath(new URL('..', import.meta.url));
export const UI_DIR = fileURLToPath(new URL('../dist-device-ui', import.meta.url));

export type SimOptions = {
  port?: number; host?: string;
  /** Home Assistant to sign in with. Omit (or fakeHa: true) for the built-in fake HA. */
  haUrl?: string; fakeHa?: boolean; fakeHaPort?: number; haTickMs?: number; house?: House;
  preset?: Preset; stateFile?: string | null; releasesFile?: string | null; battery?: number;
  delays?: Partial<Delays>; uiDir?: string; buildUi?: boolean; log?: (m: string) => void;
};

export type RunningSim = { url: string; haUrl: string; sim: DeviceSim; fakeHa: FakeHa | null; server: Server; close(): Promise<void> };

/** Build dist-device-ui/ when it is missing (npm run build:device-ui). */
export function ensureUi(uiDir = UI_DIR, log: (m: string) => void = console.log) {
  if (existsSync(uiDir + '/index.html')) return;
  log('dist-device-ui/ missing → npm run build:device-ui');
  execSync('npm run build:device-ui', { cwd: EMULATOR_DIR, stdio: 'inherit' });
}

export async function startSimulator(o: SimOptions = {}): Promise<RunningSim> {
  const log = o.log || (() => {});
  const uiDir = o.uiDir || UI_DIR;
  if (o.buildUi !== false) ensureUi(uiDir, log);

  let fakeHa: FakeHa | null = null; let haUrl = o.haUrl || '';
  if (o.fakeHa || !haUrl) {
    fakeHa = new FakeHa({ port: o.fakeHaPort ?? 8123, tickMs: o.haTickMs, house: o.house, log });
    haUrl = await fakeHa.listen();
  }

  let handler: ReturnType<typeof createDeviceHandler> | null = null;
  const server = createServer((req, res) => { if (handler) void handler(req, res); else { res.statusCode = 503; res.end(); } });
  await new Promise<void>((r) => server.listen(o.port ?? 8080, o.host ?? '0.0.0.0', r));
  const port = (server.address() as AddressInfo).port;
  const url = 'http://localhost:' + port;

  const sim = new DeviceSim({
    haUrl, preset: o.preset, stateFile: o.stateFile, battery: o.battery, delays: o.delays, log,
    releases: o.releasesFile ? loadReleases(o.releasesFile) : defaultReleases(),
    presetLink: fakeHa ? () => ({ refreshToken: fakeHa!.issueRefreshToken('X4 display', url + '/'), clientId: url + '/', user: 'X4 display' }) : undefined,
  });
  // A restarted fake HA does not know the key saved in --state yet: let it accept it (a real HA would still have it).
  const saved = sim.p.ha;
  if (fakeHa && saved.linked && !saved.revoked && saved.refreshToken && saved.clientId) fakeHa.adoptRefreshToken(saved.refreshToken, saved.clientId, saved.user || 'X4 display');
  handler = createDeviceHandler(sim, { uiDir, log });

  return {
    url, haUrl, sim, fakeHa, server,
    async close() {
      sim.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      if (fakeHa) await fakeHa.close();
    },
  };
}
