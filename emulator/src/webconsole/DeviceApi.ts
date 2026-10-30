// The only way the web console talks to the display.
//  - emulator: src/emulator/emulatorApi.ts (in-memory, against the emulated device)
//  - real device: src/webconsole/httpApi.ts (fetch against /api/v1, see spec/openapi.yaml)
import type { AppDef, Config, Screen } from '../core/config.ts';
import type { Scope } from '../core/auth.ts';
import type { HaEntity } from '../core/data.ts';
import type { ListCount } from '../core/paging.ts';
import type { DeviceSettings, SettingsPatch } from '../core/settings.ts';
import type { Diagnostics } from '../core/diag.ts';
import type { LogsResponse } from '../core/logs.ts';
import type { ReportStatus } from '../core/haReport.ts';
import type { SeedReport } from '../core/seed.ts';
import type { OtaErr } from '../core/otaStatus.ts';

/** GET /api/v1/seed (eink-ha-os#89): what the first-link seed filled and dropped. */
export type SeedReportView = SeedReport & { dismissed: boolean };

/** GET /api/v1/ha/entities: HA entities the widgets can show (ready: false while the device is still asking HA). */
/** `areas`: HA's areas in registry order (eink-ha-os#127, lightList picker); absent from older firmware. `lists` (eink-ha-os#134): climate /
 *  lights in HA vs what an unpicked zoneList / lightList shows under the display's subscription cap. */
export type EntityList = { ready: boolean; entities: HaEntity[]; areas?: { id: string; name: string }[]; lists?: EntityLists };
/** `entities` (eink-ha-os#150): entities HA has in the list's domains vs rows sent (at most 800); absent from older firmware. */
export type EntityLists = { climate: ListCount; lights: ListCount; entities?: ListCount };

/** GET /api/v1/screens/{id}/values (eink-ha-os#122). */
export type ScreenValues = { ready: boolean; values: string[] };

export type NetworkInfo = { ssid: string; rssi: number; secure: boolean };
export type TokenInfo = { id: string; name: string; scope: Scope; created: string; last: string; masked: string };

/** Everything the console renders about the device. HTTP: GET /api/v1/console/state (spec/openapi.yaml). */
export type DeviceSnapshot = {
  name: string;
  firmware: string;
  battery: number;
  ip: string | null;
  /** mDNS name, "ha-paper-XXXX.local" (XXXX = last 4 hex digits of the Wi-Fi MAC). */
  hostname: string;
  /** First-install step the display is on: 'wifi' (connect on the display / SoftAP), 'web' (finish in the browser), null = set up. */
  setup: 'wifi' | 'web' | null;
  /** The browser reached the device through its setup hotspot (SoftAP "HA-Paper-Setup", 192.168.4.1). */
  softAp: boolean;
  wifi: { connected: string | null; saved: string[] };
  networks: NetworkInfo[];
  /** server: the HA address in use (typed or found). discovered: what mDNS found (eink-ha-os#54: "Found on your network" only then). */
  ha: { linked: boolean; revoked: boolean; server: string; user: string; discovered: string[] };
  offline: boolean;
  /** Tile entities Home Assistant has no value for right now (eink-ha-os#86): id → 'unavailable' | 'unknown'. Signed in only. */
  entityGaps: Record<string, 'unavailable' | 'unknown'>;
  /** Home Assistant's language as the display learned it (get_config, eink-ha-os#98); null = not linked or not known yet.
   *  The console follows it while linked, else the browser's language. */
  language: 'en' | 'nl' | null;
  /** Browser session created by "Sign in with Home Assistant". admin false = view-only (HA user who is not an admin). */
  session: { signedIn: boolean; user: string; admin: boolean };
  /** Categories of screens (the display's app switcher), in order. */
  apps: AppDef[];
  screens: Screen[];
  /** Increments whenever a new config is applied (any source) → the console drops its draft. */
  configRev: number;
  /** Changes on factory reset → the console forgets local state. */
  installId: string;
  /** Only while signed in. */
  tokens: TokenInfo[];
};

/** Thrown by getState() when the display can't be reached (not on the network yet). */
export class DeviceUnreachableError extends Error {
  constructor(msg = 'This site can’t be reached') { super(msg); this.name = 'DeviceUnreachableError'; }
}

/** Errors carry the HTTP status + body text (e.g. 422 "line 14: Unknown entity …"). */
export class ApiError extends Error {
  status: number;
  /** Seconds from a Retry-After header (503 busy). */
  retryAfter?: number;
  constructor(status: number, msg: string, retryAfter?: number) { super(msg); this.status = status; this.name = 'ApiError'; this.retryAfter = retryAfter; }
}

export interface DeviceApi {
  getState(): Promise<DeviceSnapshot>;
  /** Called when device state may have changed (emulator: every state change; HTTP: polling). Returns unsubscribe. */
  subscribe(onChange: () => void): () => void;

  // ---- setup (no session needed while the device is in setup) ----
  /** POST /api/v1/wifi {ssid,password}; resolves when connected, rejects ApiError(401, 'Wrong password…'). */
  wifiConnect(ssid: string, password: string): Promise<void>;
  wifiScan(): Promise<NetworkInfo[]>;

  // ---- Home Assistant sign-in (links the display if needed AND creates the browser session) ----
  /** Emulator: mock OAuth round-trip. HTTP: POST /api/v1/auth/ha/start {ha_url} → navigate to authorize_url.
   *  haUrl: address typed on the link page. Rejects ApiError(422/502/503) when it is not a reachable Home Assistant. */
  signInWithHa(source: string, haUrl?: string): Promise<void>;
  signOut(): Promise<void>;
  haUnlink(): Promise<void>;
  /** Setup wizard "Open the configurator" (only reachable once setup is done). */
  finishSetup(): Promise<void>;

  // ---- config ----
  /** PUT /api/v1/config (YAML). Rejects ApiError(422) with "line N: message". */
  putConfig(config: Config, source: string): Promise<{ screens: number }>;
  /** POST /api/v1/config/validate. */
  validateConfig(yaml: string): Promise<{ ok: true } | { ok: false; error: string }>;

  /** GET /api/v1/screens/{id}/values (eink-ha-os#122): each tile's main value as the display formats it, in widget order
   *  ('' = no single value). ready: false while the display has not formatted this screen yet (ask again shortly). */
  screenValues(id: string): Promise<ScreenValues>;
  /** GET /api/v1/screens/{id}/preview.png (eink-ha-os#168, eink-ha-os#189): the screen as the panel draws it, 800 × 480. Rejects
   *  ApiError(503) with retryAfter while the display is busy. Absent = this device can't draw one (emulator). */
  screenPreview?(id: string): Promise<Blob>;

  // ---- Home Assistant entities (entity picker) ----
  listEntities(): Promise<EntityList>;

  // ---- display settings (GET/PUT /api/v1/settings) ----
  getSettings(): Promise<DeviceSettings>;
  /** Rejects ApiError(422) with the reason. */
  putSettings(patch: SettingsPatch): Promise<DeviceSettings>;

  // ---- API tokens ----
  createToken(name: string, scope: Scope): Promise<{ token: TokenInfo; secret: string }>;
  revokeToken(id: string): Promise<void>;

  // ---- diagnostics (GET/DELETE /api/v1/diagnostics) ----
  getDiagnostics(): Promise<Diagnostics>;
  /** GET /api/v1/status `ha_report` (eink-ha-os#32). */
  getHaReport(): Promise<ReportStatus>;
  clearDiagnostics(): Promise<void>;
  /** GET /api/v1/logs (eink-ha-os#200): lines after `since`; previous = the boot before this one. */
  getLogs(since: number, previous: boolean): Promise<LogsResponse>;

  // ---- seed report (GET/DELETE /api/v1/seed, eink-ha-os#89) ----
  /** null = no seed ran on this display (404). */
  getSeedReport(): Promise<SeedReportView | null>;
  dismissSeedReport(): Promise<void>;

  // ---- OTA ----
  /** GET /api/v1/ota (eink-ha-os#250: the web console's Updates card). */
  getOta(): Promise<OtaView>;
  otaCheck(): Promise<void>;
  otaInstall(): Promise<void>;

  /** Browser reload of the current page (emulator: logged). */
  reload(): Promise<void>;
  /** Browser-side diagnostics (emulator: event log; device SPA: console.debug). */
  trace(msg: string, kind?: 'warn' | 'ha'): void;
}

/** GET /api/v1/ota (spec/openapi.yaml OtaState), the fields the console reads. */
export type OtaView = {
  installed: string; channel: 'stable' | 'beta'; status: string;
  available: { version: string; size_mb?: number; notes?: string[] } | null;
  last_check: string | null; message: string;
  /** eink-ha-os#250: why the last check failed; null = it did not (or an install failed: message says why) */
  error?: OtaErr | null;
  /** "" = update checks off in this build */
  repo?: string;
};
