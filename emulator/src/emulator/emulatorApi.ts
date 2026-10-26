// In-memory DeviceApi: the web console talks to the emulated device exactly like the real
// SPA talks to /api/v1 (see ../webconsole/httpApi.ts). Emulator-only behaviour (mock HA OAuth,
// mock Wi-Fi join, browser "reload" log lines) lives here, behind the interface.
import type { DeviceApi } from '../webconsole/DeviceApi.ts';
import { ApiError, DeviceUnreachableError } from '../webconsole/DeviceApi.ts';
import { validateYaml, toYaml } from '../core/config.ts';
import { HA_ENTITIES, HOST, FW_INSTALLED, REPO, ROOMS } from '../core/data.ts';
import { listCounts } from '../core/paging.ts';
import { bootsJson, diagClear, diagPush, diagTouch, lastCrash, type DiagRing } from '../core/diag.ts';
import { BATT_ZERO, battHistory, battStep } from '../core/battery.ts';
import { powerDecision } from '../core/power.ts';
import { logRing, logsQuery, LOG_LIMIT_MAX, LOG_TAIL_CAP } from '../core/logs.ts';
import type { Emulator } from './Emulator.tsx';

// Calls that are real requests to the display: refused while it deep-sleeps (Wi-Fi off), and each one keeps it
// awake for 2 min (src/core/power.ts). getState is also refused (snapshot() throws) but, like the console's own
// polling, does not count as use.
const REQUESTS = ['wifiConnect', 'wifiScan', 'signInWithHa', 'signOut', 'haUnlink', 'finishSetup', 'putConfig', 'listEntities',
  'getSettings', 'putSettings', 'validateConfig', 'createToken', 'revokeToken', 'getOta', 'otaCheck', 'otaInstall', 'getDiagnostics', 'clearDiagnostics', 'getHaReport', 'getSeedReport', 'dismissSeedReport', 'screenValues', 'getLogs'] as const;

export function createEmulatorApi(emu: Emulator): DeviceApi {
  const api = makeApi(emu);
  for (const k of REQUESTS) {
    const f = api[k] as (...a: unknown[]) => Promise<unknown>;
    (api as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
      if (emu.state.asleep) return Promise.reject(new DeviceUnreachableError());
      emu.lastApi = Date.now();
      return f(...a);
    };
  }
  return api;
}

function makeApi(emu: Emulator): DeviceApi {
  // The emulated display never crashes: one power-on boot, the device-sim's figures for heap and panel.
  const bootAt = Date.now();
  let ring: DiagRing = diagPush([], 'POWERON', FW_INSTALLED, null);
  let batt = BATT_ZERO;   // #231: sampled when the console asks (the device samples every 5 min in its power loop)
  return {
    async getState() { return emu.snapshot(); },
    subscribe(fn) { emu.listeners.add(fn); return () => { emu.listeners.delete(fn); }; },

    wifiConnect: (ssid) => emu.webWifiConnect(ssid),
    async wifiScan() { return emu.snapshot().networks; },

    signInWithHa: (src, haUrl) => emu.webHaSignIn(src, haUrl),
    async signOut() { emu.webSignOut(); },
    async haUnlink() { emu.webHaUnlink(); },
    async finishSetup() { emu.webFinish(); },

    async putConfig(config, source) {
      // Same path as PUT /api/v1/config: validate the YAML first, 422 on error.
      const r = validateYaml(toYaml(config));
      if (!r.ok) throw new ApiError(422, 'line ' + r.line + ': ' + r.message);
      emu.pushConfig(r.config, source);
      return { screens: r.config.screens.length };
    },
    async screenValues(id) {
      const v = emu.tileValues(id); if (v === null) throw new ApiError(404, 'unknown screen “' + id + '”');
      return { ready: true, values: v };
    },
    async listEntities() {
      if (!emu.state.ha.linked) return { ready: false, entities: [] };
      const st = emu.entityStates();
      const n = (d: string) => HA_ENTITIES.filter((e) => e.id.startsWith(d + '.')).length;
      return { ready: true, entities: HA_ENTITIES.map((e) => ({ ...e, state: st[e.id] ?? '' })), areas: ROOMS.map(([id, name]) => ({ id, name })), lists: { ...listCounts(n('climate'), n('light')), entities: { total: HA_ENTITIES.length, shown: HA_ENTITIES.length } } };
    },
    async getSettings() { return emu.settings(); },
    async putSettings(patch) {
      const r = emu.putSettings(patch);
      if (typeof r === 'string') throw new ApiError(422, r);
      return r;
    },
    async validateConfig(yaml) {
      const r = validateYaml(yaml);
      return r.ok ? { ok: true } : { ok: false, error: 'line ' + r.line + ': ' + r.message };
    },

    async createToken(name, scope) { return emu.createToken(name, scope); },
    async revokeToken(id) { emu.revokeToken(id); },

    async getDiagnostics() {
      const up = Math.floor((Date.now() - bootAt) / 1000);
      ring = diagTouch(ring, up, 141_020, Math.floor(Date.now() / 1000));
      const st = emu.state, chg = st.usb && emu.battery < 100;
      batt = battStep(batt, { ms: Date.now() - bootAt, epoch: Math.floor(Date.now() / 1000), pct: emu.battery, mv: null, chg, usb: st.usb, power: powerDecision(emu.powerInputs(st)).reason, rssi: st.wifi.connected ? -58 : null }).s;
      return { firmware: FW_INSTALLED, uptime_s: up, reset_reason: 'POWERON', boots: bootsJson(ring), last_crash: lastCrash(ring), last_wdt: null,
        heap: { free_internal: 182_344, min_free_internal: 141_020, largest_free_internal: 110_592, free_psram: 7_864_320, low_point: null },
        panel: { controller: 'UC8179', source: 'probe', verdict: 'ultrachip', promoted: true, ver: '00 00 01 FF FF', flg: 0, nvs_screen_type: 1, failed: false, failure: null },
        coredump: null, touch_recoveries: 0, deep_sleep: { armed: emu.armLeft === 0, boots_left: emu.armLeft, armed_by: emu.armLeft === 0 ? 'boots' : null }, battery: battHistory(batt),
        power_trail: { before_boot: null, lines: [] },
        web: { open: 1, served: 0, refused_503: 0, last_request_age_s: null },   // #227: the emulator has no HTTP server
        mdns: { up: !!st.wifi.connected, restarts: 0, last_restart_reason: null },
        wifi: { rssi: st.wifi.connected ? -58 : null, bssid: st.wifi.connected ? '3fa2' : null, idle_checks: 0, idle_reconnects: 0 } };
    },
    // the emulator's event log is the device log; it never reboots, so the previous boot is empty
    async getLogs(since, previous) { return previous ? logsQuery(logRing(LOG_TAIL_CAP), {}, 'previous') : logsQuery(emu.logs, { since, limit: LOG_LIMIT_MAX }); },
    async clearDiagnostics() { ring = diagClear(ring); emu.log('WEB diagnostics cleared'); },
    // The browser emulator starts from the demo screens and never seeds (the device-sim does, server/device.ts).
    async getSeedReport() { return null; },
    async dismissSeedReport() { throw new ApiError(404, 'no seed report'); },
    // The emulator has no real HA: a linked, enabled display reads as reporting since boot.
    async getHaReport() {
      const enabled = emu.state.cfg.haReport;
      return { enabled, state: !enabled ? 'off' : emu.state.ha.linked ? 'ok' : 'waiting', last_push_epoch: enabled && emu.state.ha.linked ? Math.floor(bootAt / 1000) : null };
    },

    async getOta() {
      const o = emu.state.ota;
      return { installed: o.fw, channel: o.channel, status: o.status, available: o.avail ? { version: o.avail.version, size_mb: o.avail.size, notes: o.avail.notes } : null,
        last_check: o.lastCheck ? o.lastCheck.toISOString() : null, message: o.msg, error: o.err, repo: REPO };
    },
    async otaCheck() { emu.checkUpdate('WEB'); },
    async otaInstall() { emu.install(); },

    async reload() {
      const c = emu.state.wifi.connected;
      emu.log('BROWSER reload ' + HOST + ' · ' + (c ? 'ok' : 'not found (display not on Wi-Fi yet)'), c ? undefined : 'warn');
    },
    trace(msg, kind) { emu.log(msg, kind); },
  };
}
