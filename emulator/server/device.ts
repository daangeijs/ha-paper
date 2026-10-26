// The simulated display: everything the firmware keeps in NVS/LittleFS (persisted), in RAM (sessions, pending
// sign-ins, HA connection) and on the panel (refresh counters). The HTTP layer (./http.ts) only maps requests onto this.
// Logic shared with the emulator comes from src/core (config parser/validator, tokens, refresh policy, region diff, mock data).
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { seedAnswerOk, seedPlan, SEED_TEMPLATE, type HaSnapshot, type SeedReport } from '../src/core/seed.ts';
import { defaultConfig, withSettings, SETUP_SCREENS, DEFAULT_APPS, toYaml, validateYaml, listOf, sceneAction, type AppDef, type Config, type Screen, type Widget } from '../src/core/config.ts';
import { newTokenSecret, maskToken, authorize, findToken, type Scope, type StoredToken, type AuthError } from '../src/core/auth.ts';
import { NETWORKS, FW_INSTALLED, ENT, HOST, SIM_IP } from '../src/core/data.ts';
import { fmtNum, hm, kw, newer, numFormat, numFormatOf, setNumFormat, statSource } from '../src/core/format.ts';
import { currency, currencySymbol, ianaToPosix, money, setCurrency, tzFor, DEFAULT_TZ } from '../src/core/locale.ts';
import { entityListAnswer } from '../src/core/entityList.ts';
import { gridFlows, rateOf } from '../src/core/energyPrefs.ts';
import type { InputSpec } from '../src/core/inputSpec.ts';
import { displayError, nameError, settingsPutError, TZ_ERROR, type DisplaySettings } from '../src/core/settings.ts';
import { LOGICAL, formatSource, isLogicalId, mergeEntities, splitRef, type EntityOverrides } from '../src/core/entityMap.ts';
import { decidePartial, decideNav } from '../src/core/refresh.ts';
import { listCounts, type ListCount } from '../src/core/paging.ts';
import { langOf, tr, type Lang } from '../src/core/strings.ts';
import { CPU_MHZ, powerDecision, powerSource, sleepNowCheck, type PowerDecision, type PowerInputs, type SleepNowCheck } from '../src/core/power.ts';
import { sleptSeconds, tallySleep, tallyWake, TALLY_ZERO, type WakeTally } from '../src/core/glance.ts';
import { LOG_TAIL_CAP, logPush, logRing, logSplit, logsQuery, logTail, type LogRing, type LogsQuery } from '../src/core/logs.ts';
import { changedRegions, serializeRegion, type RegionMap } from '../src/core/regions.ts';
import { attrSamples, bucketize, chartSpan, fromHistoryRows, fromSamples, fromStatistics, historyError, historyFallbackOk, historySpec, statsPeriod, statsType, type HistorySpec, type Point, type Series, type StatRow } from '../src/core/history.ts';
import { chartKey, historyChart, type HistState } from '../src/core/historyChart.ts';
import { parseHaAddress, resolveHaAddress, HA_PROBE_PATH, HA_PROBE_COOLDOWN_MS, HA_PROBE_BUSY, type HaResolved, type ProbeAnswer } from '../src/core/haAddress.ts';
import { authorizeUrl, exchangeCode, HaHttpError, HaSocket, randomToken, refreshAccess, revokeToken } from './ha-client.ts';
import { latestFor, sha256, type Manifest, type SimRelease } from './ota.ts';
import type { OtaErr } from '../src/core/otaStatus.ts';
import { BATT_ZERO, battHistory, battStep, type BattState } from '../src/core/battery.ts';
import { bootsJson, diagClear, diagPush, diagTouch, lastCrash, type DiagRing } from '../src/core/diag.ts';
import { DEVICE_SCHEMA, SETTINGS_SCHEMA, migrate, schemaStatus } from '../src/core/migrate.ts';
import { reportDue, reportStates, type ReportLast, type ReportPhase, type ReportStatus } from '../src/core/haReport.ts';

export type Preset = 'first-install' | 'never-linked' | 'installed';
export const PRESETS: Preset[] = ['first-install', 'never-linked', 'installed'];

/** Tokens are stored as SHA-256 (hex) of the secret, as the firmware must (ARCHITECTURE §4). */
export const tokenHash = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const rand = () => randomInt(0, 2 ** 32) / 2 ** 32;

/** What the firmware keeps in NVS / LittleFS (and what --state <file> stores). */
export type Persisted = {
  name: string; installId: string; configRev: number; apps: AppDef[]; screens: Screen[]; setup: 'wifi' | 'web' | null;
  /** /screens.yaml exists (firmware userdata). false = the first HA link seeds the screens from HA (#23, src/core/seed.ts). */
  screensSaved?: boolean;
  wifi: { connected: string | null; saved: string[] };
  ha: { linked: boolean; revoked: boolean; server: string; user: string; refreshToken: string | null; clientId: string | null; url: string;
    /** POST /ha/token fallback: a long-lived access token instead of OAuth (x-firmware). */
    longLived?: string | null };
  tokens: StoredToken[];
  settings: Settings;
  ota: { fw: string; channel: 'stable' | 'beta'; auto: 'off' | 'notify' | 'night'; prev: string | null };
  /** GET /diagnostics (x-firmware): boot ring (RTC memory + LittleFS /diag.json) and the coredump partition. Survives factory reset. */
  diag?: { ring: DiagRing; coredump: SimCoredump | null };
  /** GET /seed (x-firmware, #89): the first-link seed report, LittleFS /seed.json. Gone after a factory reset. */
  seed?: SeedReport & { dismissed: boolean };
  /** HA's language from get_config (#98), firmware userdata /lang. null/absent = unlinked or not known (English). */
  language?: Lang | null;
  /** HA user profile number_format (frontend/get_user_data "language", #110), firmware userdata /numfmt. null/absent =
   *  not set or not known: the language decides (core/format.ts numFormatOf). */
  numberFormat?: string | null;
  /** HA's get_config `currency` (#147), firmware userdata /currency; null/absent = unlinked or not known (€). */
  currency?: string | null;
  /** HA's get_config `time_zone` as last applied (#147), firmware userdata /tz_ha; a zone the display does not know is
   *  ignored. Kept on unlink: the clock stays right. */
  tzHa?: string | null;
  /** Schema versions (src/core/migrate.ts): `device` = NVS x4dev/schema, `settings` = /settings.json `schema`. Missing = 0. */
  schema?: { device: number; settings: number };
};

/** Summary of the simulated ELF core dump (esp_core_dump_get_summary on the device). */
export type SimCoredump = { task: string; pc: string; backtrace: string[]; backtrace_corrupted: boolean; exc_cause: number; exc_vaddr: string; panic: string | null; elf_sha256: string; size: number };
export type SimCrash = 'panic' | 'task_wdt' | 'brownout';
/** One row of GET /api/v1/ha/entities. */
type HaListed = { id: string; name: string; unit: string; state: string; area?: string };
/** Where a history tile's series came from (#267, #283). */
type HistFrom = 'statistics' | 'history' | 'attribute' | 'forecast' | '';
type HaArea = { id: string; name: string };
type HaLists = { climate: ListCount; lights: ListCount; entities?: ListCount };
const SIM_PANIC = 'assert failed: xQueueSemaphoreTake queue.c:1709 (pxQueue->uxItemSize == 0)';
/** Fixed simulated heap figures (bytes); the firmware reports heap_caps_* values. */
const SIM_HEAP = { free_internal: 182_344, min_free_internal: 141_020, largest_free_internal: 110_592, free_psram: 7_864_320 };
/** GET /diagnostics heap.low_point (#198): what the firmware records at its last internal-heap low point. */
const SIM_LOW_POINT = { min_free_internal: 141_020, min_dma: 139_812, min_8bit_int: 141_020, uptime_s: 42, where: 'tls handshake', ws: true, tls_slots: 2, ha_report: false, ota: false, web_open: 1, last_path: '/api/v1/console/state', rssi: -58 };   // = GET /status (http.ts)

/** GET/PUT /settings (x-firmware): SPEC §8 display settings + OTA channel, time zone, name, logical id overrides
 * (`entities`, firmware NVS x4dev/entities; GET adds the read-only `entity_sources`, see DeviceSim.settingsView()). */
export type Settings = {
  display: DisplaySettings;
  ota_channel: 'stable' | 'beta'; tz: string; name: string;
  entities?: EntityOverrides;
};
export const DEFAULT_SETTINGS = (): Settings => ({
  display: { brightness: 0, warmth: 40, lightTimeout: 60, night: '23-07', returnHome: '5', standby: 'never', clock: '24', intervalSec: 30, fullEvery: 8, cleanEvery: 30, style: 'classic', typeface: 'archivo', surface: 'dither', haReport: true, powerSave: 'glance', wakeEvery: 15, liveMin: 3, debugInput: false },
  ota_channel: 'stable', tz: '', name: 'HA Paper',
});
/** Merge a partial settings object; returns an error message (422) or null. */
export function mergeSettings(cur: Settings, patch: any): Settings | string {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'expected a JSON object';
  const ke = settingsPutError(patch); if (ke) return ke;
  const d = { ...cur.display, ...(patch.display || {}) };
  const de = displayError(d); if (de) return de;
  const next: Settings = { display: d, ota_channel: patch.ota_channel ?? cur.ota_channel, tz: patch.tz ?? cur.tz, name: patch.name ?? cur.name, entities: cur.entities || {} };
  if (next.ota_channel !== 'stable' && next.ota_channel !== 'beta') return 'ota_channel must be stable or beta';
  if (typeof next.tz !== 'string') return TZ_ERROR;
  const ne = nameError(next.name); if (ne) return ne;
  if (patch.entities != null) { const e = mergeEntities(next.entities || {}, patch.entities); if (typeof e === 'string') return e; next.entities = e; }
  return next;
}

/** Token timestamps: device local time "YYYY-MM-DD HH:MM". */
export const stamp = (d = new Date()): string => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm(d);

export type Delays = { wifiMs: number; scanMs: number; otaCheckMs: number; otaStepMs: number; rebootMs: number; haRetryMs: number };
export const DEFAULT_DELAYS: Delays = { wifiMs: 2000, scanMs: 1500, otaCheckMs: 1400, otaStepMs: 400, rebootMs: 2000, haRetryMs: 2000 };

/** firmware/src/net/ota.h kOtaChecksOffMsg: X4_OTA_REPO left at the placeholder (no GitHub checks; upload still works). */
export const OTA_CHECKS_OFF_MSG = 'Update checks are off in this build. Install new firmware by upload (POST /api/v1/ota/upload).';
/** firmware net/ota.cpp: GET /ota message of a failed check, by `error` (#250) */
export const OTA_CHECK_MSG: Record<OtaErr, string> = { memory: 'Not enough memory right now — try again in a minute', network: 'GitHub not reachable (HTTP -1)',
  busy: 'GitHub not reachable (HTTP 403)', none: 'No releases published yet', other: 'GitHub not reachable (HTTP 502)' };
export const SIM_OTA_REPO = 'daangeijs/ha-paper (simulated)';

export type DeviceOptions = {
  haUrl: string; preset?: Preset; stateFile?: string | null; battery?: number; releases: SimRelease[];
  /** Release repository compiled into the build (firmware X4_OTA_REPO); '' = update checks off (a fork's "[YOU]" build, QEMU). */
  otaRepo?: string;
  delays?: Partial<Delays>; log?: (m: string) => void;
  /** Refresh token + client_id to start the 'installed' preset with (the fake HA issues one up front). */
  presetLink?: () => PresetLink | null;
  /** Connect to HA at boot when linked (default true). */
  connectHa?: boolean;
};

export type PresetLink = { refreshToken: string; clientId: string; user: string };
export type DisplayEvent = { t: string; kind: 'full' | 'clean' | 'fast' | 'partial' | 'skip'; reason: string; regions?: string[] };

const newInstallId = () => randomBytes(4).toString('hex');

export function presetState(p: Preset, haUrl: string, link?: PresetLink | null): Persisted {
  const server = new URL(haUrl).host;
  const base: Persisted = {
    name: 'HA Paper', installId: newInstallId(), configRev: 1, ...defaultConfig(), screensSaved: false, setup: null,
    wifi: { connected: 'HomeNet', saved: ['HomeNet'] },
    ha: { linked: false, revoked: false, server, user: '', refreshToken: null, clientId: null, url: haUrl },
    tokens: [], ota: { fw: FW_INSTALLED, channel: 'stable', auto: 'notify', prev: null }, settings: DEFAULT_SETTINGS(),
    schema: { device: DEVICE_SCHEMA, settings: SETTINGS_SCHEMA },
  };
  if (p === 'first-install') return { ...base, setup: 'wifi', wifi: { connected: null, saved: [] } };
  // 'installed' = the demo: the demo screens against the demo fake HA, as if saved long ago.
  if (p === 'installed') return { ...base, screensSaved: true, ha: { ...base.ha, linked: true, user: link?.user || 'X4 display', refreshToken: link?.refreshToken || null, clientId: link?.clientId || null } };
  return base;
}

/** Boot migration, = firmware Storage::migrate(): the state file stands in for NVS (`schema.device`) and /settings.json
 * (`settings.display` + `schema.settings`). Older: upgrade step by step; newer (OTA rollback): read, leave the numbers. */
export function migrateState(p: Persisted, log: (m: string) => void = () => {}): void {
  const s = p.schema ?? { device: 0, settings: 0 };
  const dev = schemaStatus(s.device, DEVICE_SCHEMA);
  if (dev === 'upgrade') s.device = DEVICE_SCHEMA;   // no device steps yet: 0 → 1 only stamps
  const m = migrate({ ...p.settings.display, schema: s.settings });
  if (m.status === 'upgrade' && m.doc) {
    const { schema, ...display } = m.doc;
    p.settings.display = display as DisplaySettings;
    s.settings = schema as number;
  }
  p.schema = s;
  log(`STORE schema device ${s.device} (${dev}) · settings ${m.version} (${m.status})`);
}

export class DeviceSim {
  p: Persisted;
  battery: number;
  /** GET /status battery_mv (#73, CW2017 VCELL); null = not read. 3950 matches the firmware's QEMU stub. */
  batteryMv: number | null = 3950;
  /** GET /diagnostics web (#227): finished HTTP responses (http.ts) and when the last one finished. */
  web = { served: 0, lastAt: 0 };
  failMode: 'ok' | 'hash' | 'boot' = 'ok';
  releases: SimRelease[];
  otaRepo: string;
  delays: Delays;
  log: (m: string) => void;
  stateFile: string | null;
  presetLink: () => PresetLink | null;

  // RAM
  bootAt = Date.now();
  /** Log ring of this boot and the tail of the previous one (firmware net/log.cpp: PSRAM + RTC memory, #200). */
  logs: LogRing = logRing();
  logsPrev: LogRing = logRing(LOG_TAIL_CAP);
  /** esp_reset_reason() of the running boot. */
  resetReason = 'POWERON';
  sessions = new Map<string, { user: string; admin: boolean; exp: number }>();
  /** mDNS `_home-assistant._tcp` answer: the simulator's HA from the command line. */
  discovered = '';
  /** Its own fake HA may sit on localhost; any other loopback / link-local address is refused like on the device. */
  haLocal = '';
  /** One HA address probe at a time, then HA_PROBE_COOLDOWN_MS (#75). */
  probe = { busy: false, endMs: -Infinity };
  pending = new Map<string, { verifier: string; returnTo: string; clientId: string; redirectUri: string; exp: number }>();
  wifiRun: { state: 'idle' | 'connecting' | 'connected' | 'failed'; error?: string } = { state: 'idle' };
  otaRun: { status: string; avail: SimRelease | null; lastCheck: Date | null; message: string; error?: OtaErr | null } = { status: 'idle', avail: null, lastCheck: null, message: '' };
  /** __sim/control ota_check_fail (#250): the next checks fail like this ('ok' = they work) */
  checkFail: 'ok' | OtaErr = 'ok';
  /** POST /ota/upload is receiving an image (firmware otaUploadBegin … End/Abort); version '' = not known (#237). */
  upload: { version: string } | null = null;
  ha: { socket: HaSocket | null; access: string | null; accessExp: number; connected: boolean; entities: Map<string, { s: string; a: Record<string, any> }>; lastEvent: string | null; version: string; retry?: ReturnType<typeof setTimeout>; retryMs: number; areas: number;
    /** logical id → HA entity from the Energy dashboard (a small subset of firmware core/entity_map; no device discovery, no statistics) */
    alias: Record<string, string> } =
    { socket: null, access: null, accessExp: 0, connected: false, entities: new Map(), lastEvent: null, version: '', retryMs: 0, areas: 0, alias: {} };
  /** Device health → HA states (#32, firmware net/ha_report). GET /status `ha_report` = reportStatus(). */
  report = { last: null as ReportLast | null, force: true, on: true, busy: false, status: 'waiting' as ReportPhase, pushedAt: 0, lastFullAt: 0, retried: false };
  private reportT: ReturnType<typeof setInterval> | null = null;
  /** GET /diagnostics battery (#231): PSRAM on the device, so a reset or deep-sleep wake starts it over. */
  batt: BattState = BATT_ZERO;
  display = { mode: 'main' as 'main' | 'boot' | 'updating', idx: 0, full: 0, clean: 0, fast: 0, partial: 0, skipped: 0, sinceFull: 0, navSinceClean: 0, regions: {} as RegionMap, events: [] as DisplayEvent[], progress: null as null | { version: string; pct: number; step: string } };
  authFailures = new Map<string, number[]>();
  /** Power (ROBUSTNESS_PLAN Phase 3): USB plugged (= external power, charging below 100 %), deep sleep, last API request. */
  power = { usb: false, asleep: null as null | { wakeAt: number }, lastApi: null as number | null, wakeT: null as null | ReturnType<typeof setTimeout>, sleptAt: 0, plannedWake: 0 };
  /** Wake counters since power-on (#178, firmware RTC glance::Tally). The simulator runs no glance wakes: redraws,
   *  failedWakes and lastWake stay 0 / null; wakes, asleep / awake time and refreshes count. */
  tally: WakeTally = TALLY_ZERO;
  /** display counters when the running boot began (GET /status refreshes.boot). */
  bootRefresh = { full: 0, partial: 0, fast: 0, clean: 0 };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(o: DeviceOptions) {
    this.delays = { ...DEFAULT_DELAYS, ...(o.delays || {}) };
    const sink = o.log || (() => {});
    // every line also goes into the log ring (GET /logs, #200), like the firmware's LOG_* lines
    this.log = (m: string) => {
      const { tag, msg } = logSplit(m);
      const level = tag === 'CRASH' ? 'E' : /\b(failed|refused|rejected|unreachable)\b/i.test(msg) ? 'W' : 'I';
      this.logs = logPush(this.logs, Date.now() - this.bootAt, Math.floor(Date.now() / 1000), level, tag, msg);
      sink(m);
    };
    this.battery = o.battery ?? 76;
    this.releases = o.releases;
    this.otaRepo = o.otaRepo ?? SIM_OTA_REPO;
    this.stateFile = o.stateFile || null;
    this.presetLink = o.presetLink || (() => null);
    const fromFile = this.stateFile && !o.preset && existsSync(this.stateFile) ? (JSON.parse(readFileSync(this.stateFile, 'utf8')) as Persisted) : null;
    if (fromFile && !fromFile.settings) fromFile.settings = DEFAULT_SETTINGS();
    if (fromFile) migrateState(fromFile, this.log);
    // State files from before display styles: fill in the new display fields with their defaults.
    if (fromFile) fromFile.settings.display = { ...DEFAULT_SETTINGS().display, ...fromFile.settings.display };
    if (fromFile) {   // older state files: no apps, legacy {type: light} widgets → re-read like the firmware does at boot
      const r = validateYaml(toYaml({ apps: fromFile.apps || DEFAULT_APPS, screens: fromFile.screens }));
      if (r.ok) { fromFile.apps = r.config.apps; fromFile.screens = r.config.screens; } else fromFile.apps = fromFile.apps || DEFAULT_APPS.map((a) => ({ ...a }));
    }
    if (fromFile && fromFile.screensSaved === undefined) fromFile.screensSaved = true;   // state files from before #23
    this.p = fromFile || presetState(o.preset || 'installed', o.haUrl, (o.preset || 'installed') === 'installed' ? this.presetLink() : null);
    // The HA URL comes from the command line (firmware: mDNS discovery `_home-assistant._tcp`).
    this.p.ha.url = o.haUrl; this.p.ha.server = new URL(o.haUrl).host; this.discovered = new URL(o.haUrl).origin; this.haLocal = new URL(o.haUrl).hostname;
    this.log('DEVICE ' + (fromFile ? 'state loaded from ' + this.stateFile : 'preset ' + (o.preset || 'installed')) + ' · fw ' + this.p.ota.fw + ' · HA ' + this.p.ha.url);
    if (!this.p.diag) this.p.diag = { ring: [], coredump: null };
    this.p.diag.ring = diagPush(this.p.diag.ring, 'POWERON', this.p.ota.fw, null);
    this.save();
    this.boot('power on');
    if (o.connectHa !== false) void this.connectHa();
    this.reportT = setInterval(() => { this.battTick(); void this.reportTick(); if (Date.now() - this.histAt >= DeviceSim.HIST_EVERY_MS) void this.fetchHistory('every 10 min'); }, 5000);
  }

  close() {
    this.closed = true;
    if (this.reportT) clearInterval(this.reportT);
    if (this.power.wakeT) clearTimeout(this.power.wakeT);
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.ha.retry);
    this.ha.socket?.close(); this.ha.socket = null;
  }
  later(fn: () => void, ms: number) { const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) fn(); }, ms); this.timers.add(t); }
  save() { if (this.stateFile) writeFileSync(this.stateFile, JSON.stringify(this.p, null, 2)); }

  // ------------------------------------------------------------------ display
  /** What the display runs: the saved screens, then the built-in Settings pages (#159). display.idx indexes this. */
  get shown(): Screen[] { return withSettings({ apps: this.p.apps, screens: this.p.screens }).screens; }
  screenId(): string {
    if (this.display.mode === 'updating') return 'ota_progress';
    if (this.display.mode === 'boot') return 'boot';
    if (this.p.setup) return SETUP_SCREENS[this.p.setup].id;
    return (this.shown[this.display.idx] || this.shown[0] || { id: '' }).id;
  }
  private fmtEntity(id: string): string {
    if (!this.p.ha.linked || this.p.ha.revoked) return '—';
    const m = this.mapOf()[id];
    const e = (m ? this.ha.entities.get(m.ha) : undefined) || this.ha.entities.get(id); if (!e) return '—';
    const src = statSource(m?.ha || id, e.s, e.a); if (src.state === undefined) return '—';   // climate / weather: a temperature (#161)
    const n = (m?.negate ? -1 : 1) * Number(src.state); const u = src.unit;
    if (Number.isNaN(n) || src.state === '') return src.state;
    if (u === 'W') { const k = kw(n); return k.v + ' ' + k.u; }
    return /^[€$£]|^[A-Z]{3}\//.test(u) ? money(n, this.sym()) : n.toFixed(1) + (u ? ' ' + u : '');   // a price: HA's currency (#147)
  }
  /** GET /screens/{id}/values (#122): one value per tile, like Emulator.tileValues but on the sim's HA states
   *  (stat / gauge / switch / thermo / price / clock, zoneList / lightList counts; '' for the rest). */
  tileValues(sc: Screen): string[] {
    const nf = numFormat(); setNumFormat(numFormatOf(this.p.numberFormat, this.p.language ?? 'en'));
    const lg = langOf(this.p.language ?? 'en');
    try {
      return sc.widgets.map((w) => {
        const id = typeof w.entity === 'string' ? w.entity : '';
        const e = id ? this.ha.entities.get(this.mapOf()[id]?.ha || id) : undefined;
        if (e && (e.s === 'unavailable' || e.s === 'unknown') && !ENT[id]) return tr(lg, e.s === 'unavailable' ? 'gapUnavailable' : 'gapUnknown');
        if (w.type === 'clock') return hm(new Date());
        if (w.type === 'stat') return this.fmtEntity(id);
        if (w.type === 'gauge') { const g = this.ha.entities.get(id || 'sensor.home_battery_soc'); const n = g ? Number(g.s) : NaN;
          return Number.isNaN(n) || g!.s === '' ? '—' : Math.round(Math.max(0, Math.min(100, n))) + '%'; }
        if (w.type === 'switch') return !e ? '—' : e.s === 'on' ? tr(lg, 'on') : e.s === 'off' ? tr(lg, 'off') : '—';
        if (w.type === 'thermo') { const z = this.ha.entities.get('climate.' + w.zone); const c = z?.a.current_temperature;
          return c == null ? '—' : fmtNum(Number(c), '°C') + '°'; }
        if (w.type === 'price') { const v = this.fmtEntity(this.mapOf()['sensor.energy_prices']?.ha || 'sensor.electricity_price'); const c = this.sym(); return v.startsWith(c) ? c + ' ' + v.slice(c.length).trimStart() : v; }
        if (w.type === 'zoneList' || w.type === 'lightList') {   // #161: a count, like the tile's header (entity picks only; areas = all)
          const rows = [...this.ha.entities.entries()].filter(([k]) => k.startsWith(w.type === 'zoneList' ? 'climate.' : 'light.'));
          const ids = listOf(w, 'entities'); const shown = ids.length && !listOf(w, 'areas').length ? rows.filter(([k]) => ids.includes(k)) : rows;
          if (!shown.length) return '—';
          if (w.type === 'lightList') return tr(lg, 'lightsOnOf', shown.filter(([, v]) => v.s === 'on').length, shown.length);
          return tr(lg, 'nOfHeating', shown.filter(([, v]) => Number(v.a.temperature) > Number(v.a.current_temperature) + 0.05).length, shown.length);
        }
        return '';
      });
    } finally { setNumFormat(nf); }
  }
  /** Text of each visible region (core/regions.ts): what the firmware would hash to decide what to redraw. */
  regions(): RegionMap {
    const nf = numFormat(); setNumFormat(numFormatOf(this.p.numberFormat, this.p.language ?? 'en'));   // per device (#110)
    const cur = currency(); setCurrency(this.sym());   // and currency (#147)
    try { return this.regionsNow(); } finally { setNumFormat(nf); setCurrency(cur); }
  }
  private regionsNow(): RegionMap {
    const out: RegionMap = { bar: serializeRegion({ wifi: this.p.wifi.connected, ha: this.haStatus() }) };
    if (this.display.mode !== 'main' || this.p.setup) return out;
    const sc = this.shown[this.display.idx]; if (!sc) return out;
    const ent = (prefix: string) => [...this.ha.entities.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, v.s, v.a.current_temperature ?? null, v.a.temperature ?? null, v.a.brightness ?? null]);
    // #127: an entities-only pick narrows the hashed view; an area pick keeps every light (a superset only redraws more)
    const picked = (w: Widget, rows: ReturnType<typeof ent>) => { const ids = listOf(w, 'entities'); return ids.length && !listOf(w, 'areas').length ? rows.filter((r) => ids.includes(r[0] as string)) : rows; };
    sc.widgets.forEach((w, i) => {
      let view: unknown = w.type;
      if (w.type === 'stat') view = { label: w.label || ENT[w.entity as string]?.label || this.ha.entities.get(w.entity as string)?.a.friendly_name, v: this.fmtEntity(w.entity as string) };
      else if (w.type === 'switch') view = { label: w.label, s: this.ha.entities.get(w.entity as string)?.s ?? '—', b: this.ha.entities.get(w.entity as string)?.a.brightness ?? null };
      else if (w.type === 'zoneList' || w.type === 'thermo') view = picked(w, ent(w.type === 'thermo' ? 'climate.' + w.zone : 'climate.')).map((r) => [r[0], r[2] == null ? '—' : Number(r[2]).toFixed(1), r[3]]);
      else if (w.type === 'lightList') view = picked(w, ent('light.')).map((r) => [r[0], r[1]]);
      else if (w.type === 'gauge') view = this.fmtEntity(typeof w.entity === 'string' ? w.entity : 'sensor.home_battery_soc');
      else if (w.type === 'price') view = this.fmtEntity(this.mapOf()['sensor.energy_prices']?.ha || 'sensor.electricity_price');
      else if (w.type === 'history') view = { label: w.label, v: this.fmtEntity(String(w.entity)), chart: this.histView(w) };
      out['t' + i] = serializeRegion(view);
    });
    return out;
  }
  event(kind: DisplayEvent['kind'], reason: string, regions?: string[]) {
    this.display.events.push({ t: new Date().toISOString(), kind, reason, ...(regions ? { regions } : {}) });
    if (this.display.events.length > 50) this.display.events.shift();
    this.log('EPD ' + (kind === 'skip' ? 'no redraw' : kind) + ' (' + reason + (regions ? ' · ' + regions.length + ' region' + (regions.length === 1 ? '' : 's') : '') + ')');
  }
  /** Panel-wide refresh with a flash (#197): a clean (one short flash) for everything the display does itself, the
   *  multi-flash full only for POST /display/refresh. `full` counts both, `clean` the cleans. */
  fullRefresh(reason: string, kind: 'clean' | 'full' = 'clean') {
    this.display.full++; if (kind === 'clean') this.display.clean++;
    this.display.sinceFull = 0; this.display.navSinceClean = 0; this.display.regions = this.regions(); this.report.lastFullAt = Date.now();
    this.event(kind, reason);
  }
  /** Navigation (#197): a fast whole-frame refresh without a flash, every 10th one a clean (core decideNav). */
  navRefresh(reason: string) {
    const d = decideNav({ navSinceClean: this.display.navSinceClean, sinceFull: this.display.sinceFull, clockKnown: true });
    if (d.kind === 'clean') { this.fullRefresh(reason + ' · ' + d.reason); return; }
    this.display.fast++; this.display.navSinceClean = d.navSinceClean; this.display.sinceFull = d.sinceFull; this.display.regions = this.regions();
    this.event('fast', reason);
  }
  /** New data / state: redraw only regions whose text changed; nothing changed → no refresh at all. */
  dataChanged(reason: string) {
    const next = this.regions(); const changed = changedRegions(this.display.regions, next);
    this.display.regions = next;
    if (!changed.length) { this.display.skipped++; this.event('skip', reason + ' · nothing visible changed'); return; }
    const d = decidePartial({ reason, sleeping: false, night: false, sinceFull: this.display.sinceFull, clockKnown: true });
    if (d.kind === 'clean') { this.fullRefresh(reason + ' · ' + d.reason); return; }
    if (d.kind === 'skip') { this.display.skipped++; this.event('skip', reason + ' · ' + d.why); return; }
    this.display.partial++; this.display.sinceFull = d.sinceFull; this.event('partial', reason, changed);
  }
  boot(msg: string) {
    this.display.mode = 'boot'; this.fullRefresh('boot · ' + msg);
    this.display.mode = 'main';
    const home = this.shown.findIndex((s) => s.id === 'overview'); this.display.idx = Math.max(0, home);
    this.fullRefresh(this.p.setup ? 'setup: ' + this.p.setup : 'home');
  }
  goTo(id: string): boolean {
    const i = this.shown.findIndex((s) => s.id === id); if (i < 0) return false;
    this.display.idx = i; this.navRefresh('screen ' + id); this.histAppCheck(); return true;
  }
  /** POST /debug/input (#214): keys and swipes page within the app shown (wrapping), Home goes to the first screen;
   *  taps and Power are logged only (the browser emulator acts them out). */
  remoteInput(s: InputSpec) {
    this.log('INPUT remote ' + (s.kind === 'tap' ? 'tap=' + s.x + ',' + s.y : s.kind === 'key' ? 'key=' + s.key : 'swipe=' + s.dir));
    const step = s.kind === 'swipe' ? -s.dir : s.kind === 'key' && s.key !== 'power' && s.key !== 'home' ? (s.key === 'next' ? 1 : -1) : 0;
    if (s.kind === 'key' && s.key === 'home') { this.goTo(this.shown[0]?.id ?? ''); return; }
    if (!step) return;
    const cur = this.shown[this.display.idx]; if (!cur) return;
    const page = this.shown.filter((x) => x.app === cur.app);
    const next = page[(page.indexOf(cur) + step + page.length) % page.length];
    if (next && next !== cur) this.goTo(next.id);
  }
  /** __sim/control {tap: n}: touch tile n of the screen shown. Only scene tiles act in the simulator (#146): the
   *  firmware's call (core sceneAction → call_service with service_data). Error text, or null when sent. */
  async tapTile(n: number): Promise<string | null> {
    const w = (this.shown[this.display.idx] || { widgets: [] }).widgets[n];
    if (!w) return 'no tile ' + n + ' on this screen';
    if (w.type !== 'scene') return 'tile ' + n + ' is a ' + w.type + ' tile; the simulator only taps scene tiles';
    const sock = this.ha.socket; if (!sock || !this.ha.connected) return 'offline';
    const a = sceneAction(w);
    this.log('TOUCH scene · ' + a.domain + '.' + a.service + ' ' + JSON.stringify(a.data));
    await sock.command({ type: 'call_service', domain: a.domain, service: a.service, service_data: a.data });
    return null;
  }

  // ------------------------------------------------------------------ status
  haStatus(): 'linked' | 'not linked' | 'revoked' | 'offline' {
    if (this.p.ha.revoked) return 'revoked';
    if (!this.p.ha.linked) return 'not linked';
    return this.ha.connected ? 'linked' : 'offline';
  }
  get offline(): boolean { return !this.p.wifi.connected || this.haStatus() === 'offline'; }
  /** Endpoints marked setup-open work without auth during first install (setup step or never linked). */
  get setupOpen(): boolean { return this.p.setup !== null || !this.p.ha.linked; }

  // ------------------------------------------------------------------ auth (API tokens + console session)
  /** admin false = view-only session: a Home Assistant user who is not an admin (read scope, issue #22). */
  session(id: string | null): { user: string; admin: boolean } | null {
    if (!id) return null; const s = this.sessions.get(id);
    if (!s || s.exp < Date.now()) { if (s) this.sessions.delete(id); return null; }
    return s;
  }
  checkToken(presented: string | null, need: 'read' | 'write'): AuthError | null {
    const e = authorize(this.p.tokens, presented, need, tokenHash);
    const live = e ? undefined : findToken(this.p.tokens, presented, tokenHash);
    if (live) { live.last = stamp(); this.save(); }
    return e;
  }
  createToken(name: string, scope: Scope) {
    const secret = newTokenSecret(rand);
    const nm = (name || 'Token').trim().slice(0, 40) || 'Token';
    const tok: StoredToken = { id: 'tok_' + randomBytes(4).toString('hex'), name: nm, scope, created: stamp(), last: 'never', hash: tokenHash(secret), masked: maskToken(secret) };
    this.p.tokens.push(tok); this.save();
    this.log('API token "' + nm + '" created (' + (scope === 'rw' ? 'read & write' : 'read only') + ') · only its SHA-256 is stored');
    return { tok, secret };
  }
  revokeToken(id: string): boolean {
    const k = this.p.tokens.find((t) => t.id === id); if (!k) return false;
    this.p.tokens = this.p.tokens.filter((t) => t.id !== id); this.save();
    this.log('API token "' + k.name + '" revoked'); return true;
  }

  // ------------------------------------------------------------------ config
  applyConfig(cfg: Config, src: string) {
    const screens = cfg.screens;
    const curId = (this.shown[this.display.idx] || { id: '' }).id;
    const wantedBefore = JSON.stringify(this.wantedEntities());
    this.p.apps = cfg.apps; this.p.screens = screens; this.p.configRev++; this.p.screensSaved = true;
    this.display.idx = Math.max(0, this.shown.findIndex((s) => s.id === curId));
    this.save();
    this.fullRefresh('new config');
    this.log('CONFIG applied · ' + screens.length + ' screens · ' + src);
    if (JSON.stringify(this.wantedEntities()) !== wantedBefore) void this.resubscribe();
    else void this.fetchHistory('config');
  }

  // ------------------------------------------------------------------ history tiles (#267)
  /** Per tile (histKey): the fetched series, or why there is none. Only the current app's tiles are fetched (Daan,
   *  #264); a tile not fetched yet draws its frame ('loading'). Refetched on connect, a config change, a new app and
   *  every 10 min. The firmware's live append between fetches (#269) is not simulated. */
  hist = new Map<string, { state: HistState; series: Series | null; at: number; source: HistFrom; bytes: number }>();
  private histBusy = false; private histAgain = false; private histApp = ''; private histAt = 0;
  static readonly HIST_EVERY_MS = 10 * 60_000;
  /** The firmware's WS frame cap (WsClient kMaxMessage): a bigger history answer = "Too many changes". */
  static readonly HIST_FRAME_CAP = 512 * 1024;
  private histKey = (s: HistorySpec) => [s.entity, s.windowMs, s.bucketMs, s.agg, ...(s.source ? [s.aheadMs, s.source.attribute, s.source.value, s.source.time, s.source.forecast ?? ''] : [])].join('|');
  /** UTC offset (minutes) of HA's time zone at `t` (the sim's own zone when HA has not said). */
  private tzMinutes(t: number): number {
    const zone = this.p.tzHa;
    if (!zone) return -new Date(t).getTimezoneOffset();
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
      return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000) / 60_000);
    } catch { return -new Date(t).getTimezoneOffset(); }
  }
  /** Valid history tiles on the screens of the app shown. */
  private histSpecs(): HistorySpec[] {
    const cur = this.shown[this.display.idx]; if (!cur) return [];
    const out = new Map<string, HistorySpec>();
    for (const sc of this.p.screens) if (sc.app === cur.app) for (const w of sc.widgets)
      if (w.type === 'history' && typeof w.entity === 'string' && !historyError(w)) { const sp = historySpec(w); out.set(this.histKey(sp), sp); }
    return [...out.values()];
  }
  /** A screen change into another app fetches that app's history tiles. */
  private histAppCheck() {
    const app = (this.shown[this.display.idx] || { app: '' }).app;
    if (app !== this.histApp) void this.fetchHistory('app ' + app);
  }
  /** Statistics first (one call per period + type, every id), history rows in 6 h slices for ids without statistics,
   *  one request at a time; then one redraw of what changed. */
  async fetchHistory(reason: string): Promise<void> {
    const sock = this.ha.socket;
    if (!sock || !this.ha.connected || this.closed) return;
    if (this.histBusy) { this.histAgain = true; return; }
    this.histApp = (this.shown[this.display.idx] || { app: '' }).app; this.histAt = Date.now();
    const specs = this.histSpecs(); if (!specs.length) return;
    this.histBusy = true;
    const now = Date.now(), tz = this.tzMinutes(now), iso = (t: number) => new Date(t).toISOString();
    const done = new Set<string>();
    const put = (sp: HistorySpec, v: { state: HistState; series: Series | null; source: HistFrom; bytes: number }) => { this.hist.set(this.histKey(sp), { ...v, at: now }); done.add(this.histKey(sp)); };
    try {
      // #283: attribute series from one get_states, weather forecasts from weather.get_forecasts (return_response).
      // The firmware does not read these yet (firmware/deviations/283-attribute-series.md).
      const attrSpecs = specs.filter((sp) => sp.source?.kind === 'attribute');
      const states = attrSpecs.length ? await sock.command<{ entity_id: string; attributes: Record<string, unknown> }[]>({ type: 'get_states' }).catch(() => null) : null;
      for (const sp of attrSpecs) {
        const e = states?.find((x) => x.entity_id === sp.entity), raw = e?.attributes[sp.source!.attribute];
        put(sp, { state: 'ok', series: fromSamples(attrSamples(raw, sp.source!, sp.bucketMs, now, tz), sp, now, tz), source: 'attribute', bytes: raw === undefined ? 0 : JSON.stringify(raw).length });
      }
      for (const sp of specs.filter((x) => x.source?.kind === 'forecast')) {
        const res = await sock.command<{ response?: Record<string, { forecast?: unknown[] }> }>({ type: 'call_service', domain: 'weather', service: 'get_forecasts',
          service_data: { type: sp.source!.forecast }, target: { entity_id: sp.entity }, return_response: true }).catch(() => null);
        const list = res?.response?.[sp.entity]?.forecast;
        put(sp, { state: 'ok', series: fromSamples(attrSamples(list, sp.source!, sp.bucketMs, now, tz), sp, now, tz), source: 'forecast', bytes: list ? JSON.stringify(list).length : 0 });
      }
      const groups = new Map<string, HistorySpec[]>();
      for (const sp of specs) { if (sp.source) continue; const per = statsPeriod(sp.bucketMs); if (per) { const k = per + '|' + statsType(sp.agg); groups.set(k, [...(groups.get(k) || []), sp]); } }
      for (const [k, g] of groups) {
        const [period, type] = k.split('|');
        const start = Math.min(...g.map((sp) => chartSpan(sp, now, tz).start));
        const res = await sock.command<Record<string, StatRow[]>>({ type: 'recorder/statistics_during_period', start_time: iso(start), statistic_ids: [...new Set(g.map((sp) => sp.entity))], period, types: [type] }).catch(() => null);
        const bytes = res ? JSON.stringify(res).length : 0;
        for (const sp of g) { const rows = res?.[sp.entity]; if (rows?.length) put(sp, { state: 'ok', series: fromStatistics(rows, sp, now, tz), source: 'statistics', bytes }); }
      }
      for (const sp of specs) {
        if (done.has(this.histKey(sp))) continue;
        if (!historyFallbackOk(sp)) { put(sp, { state: 'needsStats', series: null, source: '', bytes: 0 }); continue; }
        const { start } = chartSpan(sp, now, tz); const pts: Point[] = []; let bytes = 0, over = false;
        for (let a = start; a < now && !over; a += 6 * 3600_000) {
          const res = await sock.command<Record<string, { s: string; lu: number }[]>>({ type: 'history/history_during_period', start_time: iso(a), end_time: iso(Math.min(a + 6 * 3600_000, now)),
            entity_ids: [sp.entity], minimal_response: true, no_attributes: true, significant_changes_only: false }).catch(() => null);
          const n = res ? JSON.stringify(res).length : 0; bytes += n;
          if (n > DeviceSim.HIST_FRAME_CAP) over = true; else if (res?.[sp.entity]) pts.push(...fromHistoryRows(res[sp.entity]));
        }
        put(sp, over ? { state: 'tooMany', series: null, source: 'history', bytes } : { state: 'ok', series: bucketize(pts, sp, now, tz), source: 'history', bytes });
      }
      this.log('HISTORY ' + reason + ' · ' + specs.map((sp) => { const h = this.hist.get(this.histKey(sp)); return sp.entity + ' ' + (h?.source || '-') + ' ' + h?.state + ' ' + (h?.bytes ?? 0) + ' B'; }).join(', '));
    } finally { this.histBusy = false; }
    this.dataChanged('history');
    if (this.histAgain) { this.histAgain = false; void this.fetchHistory('again'); }
  }
  /** The redraw key of a history tile (historyChart geometry + values, never the formatted text). */
  private histView(w: Widget): string {
    if (historyError(w) || typeof w.entity !== 'string') return 'invalid';
    const sp = historySpec(w); const h = this.hist.get(this.histKey(sp)); const now = h?.at ?? Date.now(), tz = this.tzMinutes(now);
    const lg = langOf(this.p.language ?? 'en');
    const c = historyChart(sp, h?.series ?? null, h?.state ?? 'loading', now, tz, lg, (v) => fmtNum(v, ''));
    return chartKey(c, h?.series?.values ?? []);
  }
  /** History tiles of the app shown, for __sim/state (like the firmware's /console/state history block, #269). */
  histState() {
    return this.histSpecs().map((sp) => { const h = this.hist.get(this.histKey(sp));
      return { entity: sp.entity, window_ms: sp.windowMs, bucket_ms: sp.bucketMs, agg: sp.agg, state: h?.state ?? 'loading', source: h?.source ?? '', buckets: h?.series?.values.length ?? 0,
        filled: h?.series?.values.filter((v) => v !== null).length ?? 0, bytes: h?.bytes ?? 0, fetched_at: h ? new Date(h.at).toISOString() : null }; });
  }

  // ------------------------------------------------------------------ Wi-Fi
  /** null = accepted (poll wifiRun), else an error message for 400. */
  wifiJoin(ssid: string, password: string | undefined): string | null {
    const net = NETWORKS.find((n) => n.ssid === ssid);
    const pw = password || '';
    if (net?.secure !== false && !this.p.wifi.saved.includes(ssid) && pw.length < 8) return 'Wi-Fi passwords have at least 8 characters.';
    if (pw.length > 63) return 'Wi-Fi passwords have at most 63 characters.';
    this.wifiRun = { state: 'connecting' };
    this.log('WIFI joining ' + ssid);
    this.later(() => {
      if (!net) { this.wifiRun = { state: 'failed', error: 'Network not found. Move closer or pick another one.' }; return; }
      if (net.failsWith) { this.wifiRun = { state: 'failed', error: 'Wrong password. Try again.' }; this.log('WIFI auth failed · ' + ssid); return; }
      const wasSetup = this.p.setup === 'wifi';
      this.p.wifi = { connected: ssid, saved: this.p.wifi.saved.includes(ssid) ? this.p.wifi.saved : [...this.p.wifi.saved, ssid] };
      if (wasSetup) this.p.setup = 'web';
      this.wifiRun = { state: 'connected' }; this.save();
      this.log('WIFI connected · ' + ssid + (wasSetup ? ' · SoftAP off · continue at ' + HOST + ' or ' + SIM_IP : ''));
      if (wasSetup) this.fullRefresh('setup: browser'); else this.dataChanged('wifi');
      void this.connectHa();
    }, this.delays.wifiMs);
    return null;
  }

  // ------------------------------------------------------------------ Home Assistant sign-in (OAuth2 + PKCE)
  async haReachable(): Promise<boolean> {
    try { const r = await fetch(this.p.ha.url.replace(/\/$/, '') + '/', { signal: AbortSignal.timeout(3000) }); await r.arrayBuffer(); return true; } catch { return false; }
  }
  /** GET <url>/auth/providers, no redirects followed (firmware: net/web_server.cpp probeHa). */
  async probeHa(url: string): Promise<ProbeAnswer> {
    try {
      const r = await fetch(url + HA_PROBE_PATH, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      return { status: r.status, body: (await r.text()).slice(0, 4096), location: r.headers.get('location') || '' };
    } catch { return { status: -1 }; }
  }
  /** Link page address (#54): typed, or the remembered / discovered one. Remembered only once it is Home Assistant. */
  async resolveHa(input: string): Promise<HaResolved> {
    const a = parseHaAddress(input, this.haLocal);
    if ('error' in a) return { status: 422, error: a.error };   // not an address: no probe, no cooldown
    if (this.probe.busy || Date.now() - this.probe.endMs < HA_PROBE_COOLDOWN_MS) return { status: 429, error: HA_PROBE_BUSY };
    this.probe.busy = true;
    let r: HaResolved;
    try { r = await resolveHaAddress(input, (u) => this.probeHa(u), this.haLocal); } finally { this.probe = { busy: false, endMs: Date.now() }; }
    if ('url' in r) { const e = this.setHaUrl(r.url, false); if (e) return e; } else this.log('HA address ' + input + ' · ' + r.status + ' ' + r.error);
    return r;
  }
  startSignIn(host: string, returnTo: string): string {
    const clientId = 'http://' + host + '/', redirectUri = 'http://' + host + '/auth/callback';
    const state = randomToken(18), verifier = randomToken(32);
    for (const [k, v] of this.pending) if (v.exp < Date.now()) this.pending.delete(k);
    while (this.pending.size >= 8) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(state, { verifier, returnTo: safeReturn(returnTo), clientId, redirectUri, exp: Date.now() + 10 * 60_000 });
    const url = authorizeUrl(this.p.ha.url, { clientId, redirectUri, state, verifier });
    this.log('AUTH start · 302 ' + this.p.ha.url + '/auth/authorize (client_id ' + clientId + ', PKCE S256)');
    return url;
  }
  /** GET /auth/callback. Returns where to send the browser and the session to set (null = none). */
  async finishSignIn(q: URLSearchParams): Promise<{ status: number; location?: string; session?: string; error?: string }> {
    const st = q.get('state') || ''; const pend = this.pending.get(st);
    if (!pend || pend.exp < Date.now()) { this.log('AUTH callback rejected · unknown state'); return { status: 400, error: 'This sign-in link is not valid (state mismatch or expired). Start the sign-in again.' }; }
    this.pending.delete(st);
    if (q.get('error')) return { status: 302, location: withParam(pend.returnTo, 'signin', 'denied') };
    const code = q.get('code'); if (!code) return { status: 400, error: 'Home Assistant did not send a code.' };
    let tok; try { tok = await exchangeCode(this.p.ha.url, code, pend.clientId, pend.verifier); }
    catch (e) { const m = (e as Error).message; this.log('AUTH code exchange failed · ' + m); return { status: 502, error: 'Home Assistant refused the sign-in: ' + m }; }
    const sock = new HaSocket(); let me: { name: string; is_admin: boolean };
    try { await sock.connect(this.p.ha.url, tok.access_token); me = await sock.command({ type: 'auth/current_user' }); }
    catch (e) { sock.close(); return { status: 502, error: 'Could not read the Home Assistant user: ' + (e as Error).message }; }
    const linking = !this.p.ha.linked || this.p.ha.revoked;
    if (linking && tok.refresh_token) {
      this.ha.socket?.close(); clearTimeout(this.ha.retry);
      this.p.ha = { ...this.p.ha, linked: true, revoked: false, user: me.name, refreshToken: tok.refresh_token, clientId: pend.clientId, longLived: null, server: new URL(this.p.ha.url).host };
      const wasSetup = this.p.setup !== null; this.p.setup = null; this.save();
      this.log('HA code → refresh token stored (display linked as "' + me.name + '")');
      this.display.idx = Math.max(0, this.shown.findIndex((s) => s.id === 'overview'));
      this.fullRefresh(wasSetup ? 'welcome · live data' : 'linked · live data');
      this.ha.access = tok.access_token; this.ha.accessExp = Date.now() + tok.expires_in * 1000;
      void this.attach(sock);
    } else {
      sock.close();
      if (tok.refresh_token) void revokeToken(this.p.ha.url, tok.refresh_token); // display keeps its own key
    }
    return { status: 302, location: pend.returnTo, session: this.newSession(me.name, me.is_admin) };
  }
  /** Every HA user gets a session; only an HA admin may change the display (others: read scope). */
  newSession(user: string, admin: boolean): string {
    const sid = randomToken(24); this.sessions.set(sid, { user, admin, exp: Date.now() + 12 * 3600_000 });
    this.log('WEB session for "' + user + '" (' + (admin ? 'Home Assistant admin' : 'not a Home Assistant admin · view only') + ') · cookie HttpOnly, 12 h');
    return sid;
  }
  async unlink() {
    const rt = this.p.ha.refreshToken;
    this.ha.socket?.close(); this.ha.socket = null; clearTimeout(this.ha.retry); this.ha.connected = false; this.ha.entities.clear();
    if (rt) await revokeToken(this.p.ha.url, rt);
    this.p.ha = { ...this.p.ha, linked: false, revoked: false, refreshToken: null, clientId: null, longLived: null };
    this.p.language = null;   // English on the display, the browser's language in the console (#98)
    this.p.numberFormat = null;
    this.p.currency = null;   // € again (#147); the HA time zone stays
    this.report = { ...this.report, last: null, force: true, status: 'waiting', pushedAt: 0, retried: false };   // the next link starts over (#44)
    this.sessions.clear(); this.save();
    this.log('HA unlinked · POST /auth/revoke · key deleted · console sessions ended');
    this.fullRefresh('not linked');
  }

  /** POST /ha/token (x-firmware): link with a long-lived access token instead of OAuth. */
  async linkWithToken(token: string, url?: string): Promise<{ status: number; error?: string; user?: string; admin?: boolean }> {
    if (url) { const e = this.setHaUrl(url, true); if (e) return { status: e.status, error: e.error }; }
    const sock = new HaSocket(); let me: { name: string; is_admin: boolean };
    try { await sock.connect(this.p.ha.url, token); me = await sock.command({ type: 'auth/current_user' }); }
    catch (e) { sock.close(); return e instanceof HaHttpError && e.code === 'auth_invalid' ? { status: 401, error: 'Home Assistant rejected the token' } : { status: 502, error: 'Home Assistant not reachable' }; }
    if (this.p.ha.refreshToken) void revokeToken(this.p.ha.url, this.p.ha.refreshToken);
    this.ha.socket?.close(); this.ha.socket = null; clearTimeout(this.ha.retry);
    this.p.ha = { ...this.p.ha, linked: true, revoked: false, user: me.name, refreshToken: null, clientId: null, longLived: token };
    const wasSetup = this.p.setup !== null; this.p.setup = null; this.save();
    this.ha.access = token; this.ha.accessExp = Number.MAX_SAFE_INTEGER;
    this.log('HA linked with a long-lived token (user "' + me.name + '")');
    this.fullRefresh(wasSetup ? 'welcome · live data' : 'linked · live data');
    void this.attach(sock);
    return { status: 200, user: me.name, admin: me.is_admin };
  }
  /** POST /ha/url, /auth/start?ha=, /auth/ha/start {ha_url}: manual HA address (ignored / 409 once linked). */
  setHaUrl(url: string, strict: boolean): { status: number; error: string } | null {
    if (this.p.ha.linked && !this.p.ha.revoked) return strict ? { status: 409, error: 'Already linked to ' + this.p.ha.url + ' — unlink first' } : null;
    const a = parseHaAddress(url, this.haLocal); if ('error' in a) return { status: 422, error: a.error };
    this.p.ha.url = a.url; this.p.ha.server = new URL(a.url).host; this.save();
    this.log('HA address set to ' + a.url);
    return null;
  }
  /** Pairing code shown on the display's link card (GET /link?p=CODE): 4 chars, single use, 10 min. */
  pairing: { code: string; exp: number } | null = null;
  pairingCode(): string | null {
    if (this.p.ha.linked && !this.p.ha.revoked) return null;
    if (!this.pairing || this.pairing.exp < Date.now()) {
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      this.pairing = { code: Array.from({ length: 4 }, () => A[randomInt(0, A.length)]).join(''), exp: Date.now() + 10 * 60_000 };
    }
    return this.pairing.code;
  }
  usePairing(code: string): boolean {
    const ok = !!this.pairing && this.pairing.exp > Date.now() && code.toUpperCase() === this.pairing.code;
    if (ok) this.pairing = null;
    return ok;
  }
  /** POST /device/restart: RAM survives only what NVS holds (sessions and pending sign-ins are kept in the simulator). */
  restart(why = 'restart') {
    this.log('RESTART (' + why + ')');
    this.diagReset('SW', null);
    this.ha.socket?.close(); this.ha.socket = null; this.ha.connected = false; this.ha.access = null; this.ha.entities.clear();
    this.display.mode = 'boot'; this.fullRefresh('boot · ' + why);
    this.later(() => { this.boot(why); void this.connectHa(); }, this.delays.rebootMs);
  }
  /** POST /device/factory-reset: revoke the HA key, erase everything, back to first install. */
  async factoryReset() {
    const h = this.p.ha;
    if (h.refreshToken) await revokeToken(h.url, h.refreshToken);
    this.ha.socket?.close(); this.ha.socket = null; this.ha.connected = false; this.ha.access = null; this.ha.entities.clear();
    const diag = this.p.diag;   // /diag.json and the coredump partition are not HA Paper settings
    this.p = presetState('first-install', h.url); this.p.diag = diag; this.sessions.clear(); this.pending.clear();
    this.otaRun = { status: 'idle', avail: null, lastCheck: null, message: '' }; this.wifiRun = { state: 'idle' };
    this.save(); this.log('FACTORY RESET · Wi-Fi, HA key, tokens, settings and screens erased');
    this.restart('factory reset');
  }

  // ------------------------------------------------------------------ Home Assistant connection (WebSocket)
  private retry() {
    if (this.closed) return;
    this.ha.retryMs = Math.min(30_000, this.ha.retryMs ? this.ha.retryMs * 2 : this.delays.haRetryMs);
    clearTimeout(this.ha.retry); this.ha.retry = setTimeout(() => void this.connectHa(), this.ha.retryMs);
  }
  async connectHa(): Promise<void> {
    const h = this.p.ha;
    if (this.closed || !h.linked || h.revoked || !this.p.wifi.connected || this.ha.socket) return;
    if (h.longLived) { this.ha.access = h.longLived; this.ha.accessExp = Number.MAX_SAFE_INTEGER; }
    else if (!h.refreshToken || !h.clientId) { this.markRevoked('no key stored'); return; }
    if (!h.longLived && (!this.ha.access || this.ha.accessExp < Date.now() + 60_000)) {
      try { const t = await refreshAccess(h.url, h.refreshToken!, h.clientId!); this.ha.access = t.access_token; this.ha.accessExp = Date.now() + t.expires_in * 1000; }
      catch (e) {
        if (e instanceof HaHttpError && (e.code === 'invalid_grant' || e.status === 400 || e.status === 401 || e.status === 403)) { this.markRevoked(e.message); return; }
        this.log('HA unreachable · ' + (e as Error).message + ' · retry'); this.retry(); return;
      }
    }
    const sock = new HaSocket();
    try { await sock.connect(h.url, this.ha.access!); }
    catch (e) {
      sock.close();
      if (e instanceof HaHttpError && e.code === 'auth_invalid') { if (h.longLived) { this.markRevoked('long-lived token rejected'); return; } this.ha.access = null; }
      this.log('HA WebSocket failed · ' + (e as Error).message + ' · retry'); this.retry(); return;
    }
    await this.attach(sock);
  }
  private markRevoked(why: string) {
    this.p.ha.revoked = true; this.ha.access = null; this.save();
    this.log('HA refresh → invalid_grant (' + why + ') · state "Key revoked" · re-link needed');
    this.fullRefresh('key revoked');
  }
  /** get_config `language` → the display's (#98): one full refresh when it changes, = firmware HaClient::setLanguage. */
  private setLanguage(haLang: string | undefined) {
    const lang = langOf(haLang);
    if (this.p.language === lang) return;
    this.p.language = lang; this.save();
    this.log('HA language ' + lang + ' (Home Assistant: ' + (haLang ?? '?') + ')');
    this.fullRefresh('language');
  }
  /** The display's price currency symbol (#147). */
  sym(): string { return currencySymbol(this.p.ha.linked ? this.p.currency : null); }
  /** get_config `time_zone` + `currency` (#147), = firmware HaClient::setLocale: a known zone is the clock's unless the
   *  `tz` setting overrides it; an unknown one keeps the current zone (logged once). A new currency is one full refresh. */
  private setLocale(zone: string | undefined, cur: string | undefined) {
    if (zone && zone !== this.p.tzHa) {
      if (ianaToPosix(zone)) { this.p.tzHa = zone; this.save(); this.log('HA time zone ' + zone + ' → ' + this.tzActive()); }
      else if (zone !== this.tzUnknown) { this.tzUnknown = zone; this.log('HA time zone ' + zone + ' unknown · keeping ' + this.tzActive()); }
    }
    const c = cur || null;
    if ((this.p.currency ?? null) === c) return;
    this.p.currency = c; this.save();
    this.log('HA currency ' + (c ?? 'unset') + ' → ' + this.sym());
    this.fullRefresh('currency');
  }
  private tzUnknown = '';
  /** The POSIX TZ the clock uses: override, else HA's zone, else Europe/Amsterdam (core/locale.ts tzFor). */
  tzActive(): string { return tzFor(this.p.settings.tz || '', this.p.tzHa || '') ?? DEFAULT_TZ; }
  /** Profile number_format → the display's (#110): one full refresh when it changes, = firmware HaClient::setNumberFormat.
   *  An HA without the frontend command, or a profile that never saved it, keeps the language's format. */
  private setNumberFormat(v: unknown) {
    const nf = typeof v === 'string' ? v : null;
    if ((this.p.numberFormat ?? null) === nf) return;
    const lang = this.p.language ?? 'en'; const was = numFormatOf(this.p.numberFormat, lang);
    this.p.numberFormat = nf; this.save();
    this.log('HA number format ' + (nf ?? 'unset') + ' → ' + numFormatOf(nf, lang));
    if (numFormatOf(nf, lang) !== was) this.fullRefresh('number format');
  }
  /** Use an authenticated socket as the display's HA link: read prefs/areas, subscribe to what the config shows. */
  private async attach(sock: HaSocket) {
    if (this.closed) { sock.close(); return; }
    this.ha.socket = sock; this.ha.retryMs = 0; this.ha.version = sock.haVersion;
    sock.onClose = () => {
      if (this.ha.socket !== sock) return;
      this.ha.socket = null; this.ha.connected = false; this.log('HA connection lost · retry');
      this.dataChanged('HA offline'); this.retry();
    };
    try {
      const conf = await sock.command<{ language?: string; time_zone?: string; currency?: string }>({ type: 'get_config' }).catch(() => null);
      this.setLanguage(conf?.language);
      if (conf) this.setLocale(conf.time_zone, conf.currency);
      const prof = await sock.command<{ value?: { number_format?: string } | null }>({ type: 'frontend/get_user_data', key: 'language' }).catch(() => null);
      if (prof) this.setNumberFormat(prof.value?.number_format);
      const prefs = await sock.command({ type: 'energy/get_prefs' }).catch(() => null);
      const areas = await sock.command<unknown[]>({ type: 'config/area_registry/list' }).catch(() => []);
      this.ha.areas = areas.length;
      this.ha.alias = aliasesOf(prefs);
      this.log('HA connected (' + (sock.haVersion || '?') + ') · energy prefs ' + (prefs ? 'read' : 'missing') + ' · ' + areas.length + ' areas');
      if (!this.p.screensSaved) await this.seed(sock, prefs);
      this.ha.connected = true;
      this.report.force = true; this.report.retried = false; if (this.report.status === 'not_admin') this.report.status = 'waiting';
      void this.reportTick();
      await this.subscribe(sock);
      void this.fetchHistory('connected');
    } catch (e) { this.log('HA setup failed · ' + (e as Error).message); sock.close(); }
  }
  /**
   * First link without saved screens: build them from what this HA has (src/core/seed.ts) and save them. A failed or
   * unparseable template answer saves nothing (#58): the default screens stay, seed_pending stays true and the next
   * HA connection tries again.
   */
  private async seed(sock: HaSocket, prefs: unknown) {
    let snap: HaSnapshot;
    try {
      const text = await sock.renderTemplate(SEED_TEMPLATE, 8000, (w) => this.log('HA seed template warning · ' + w));
      if (!seedAnswerOk(text)) throw new Error('answer is not a JSON object');
      snap = JSON.parse(text);
    } catch (e) { this.log('HA seed template failed · ' + (e as Error).message + ' · not saved, retry on the next connection'); return; }
    // live = logical ids with a mapped source; the firmware takes them from EntityAdapter::sources()
    const plan = seedPlan({ ...snap, energy: prefs as HaSnapshot['energy'], live: Object.keys(this.mapOf()) });
    const r = validateYaml(toYaml(plan.config));
    if (!r.ok) { this.log('SEED produced an invalid config (line ' + r.line + ': ' + r.message + ') · keeping the default'); return; }
    this.p.apps = r.config.apps; this.p.screens = r.config.screens; this.p.configRev++; this.p.screensSaved = true;
    this.p.seed = { ...plan.report, dismissed: false };
    this.log('SEED report · ' + plan.report.filled + ' of ' + plan.report.total + ' tiles filled');
    this.display.idx = Math.max(0, this.shown.findIndex((s) => s.id === 'overview'));
    this.save();
    this.log('SEED screens from HA · ' + r.config.screens.map((s) => s.id).join(', '));
    this.fullRefresh('screens from Home Assistant');
  }
  /** Logical id → HA entity: settings `entities` overrides, then the Energy dashboard (aliasesOf). Identity is the fallback in fmtEntity. */
  mapOf(): Record<string, { ha: string; negate: boolean; why: 'override' | 'energy' }> {
    const out: Record<string, { ha: string; negate: boolean; why: 'override' | 'energy' }> = {};
    for (const [k, v] of Object.entries(this.ha.alias)) out[k] = { ha: v, negate: false, why: 'energy' };
    for (const [k, v] of Object.entries(this.p.settings.entities || {})) out[k] = { ...splitRef(v), why: 'override' };
    return out;
  }
  /** GET /settings `entity_sources`, formatted like HaClient::publishSources(). The firmware negates the Energy
   * dashboard's battery power (HA: + = discharging); the simulator reports that sign but does not apply it. */
  entitySources(): Record<string, string> {
    const out: Record<string, string> = {};
    const map = this.mapOf();
    for (const id of new Set([...LOGICAL.map((l) => l.id), ...Object.keys(map)])) {
      const m = map[id];
      if (m) out[id] = formatSource({ ha: m.ha, minus: '', negate: m.why === 'energy' ? id === 'sensor.battery_power' : m.negate, why: m.why });
      else if (isLogicalId(id) && this.ha.entities.has(id)) out[id] = formatSource({ ha: id, minus: '', negate: false, why: 'identity' });
    }
    return out;
  }
  settingsView(): Settings & { tz_ha: string; tz_active: string; entity_sources: Record<string, string> } {
    return { ...this.p.settings, display: { ...this.p.settings.display, otaAuto: this.p.ota.auto }, tz: this.p.settings.tz || '', tz_ha: this.p.tzHa || '', tz_active: this.tzActive(),
      entities: { ...(this.p.settings.entities || {}) }, entity_sources: this.entitySources() };
  }
  /** PUT /settings changed `entities`: subscribe to the new HA entities and redraw (firmware: HaClient::setEntityOverrides). */
  entitiesChanged() {
    this.log('SETTINGS entities ' + JSON.stringify(this.p.settings.entities || {}));
    if (this.ha.socket && this.ha.connected) void this.resubscribe();
    else this.dataChanged('entities');
  }
  /** Entities referenced by the active config (ARCHITECTURE §3: subscribe only to those). */
  wantedEntities(): string[] | null {
    const ids = new Set<string>(); let lists = false; const map = this.mapOf();
    for (const sc of this.p.screens) for (const w of sc.widgets) {
      if ((w.type === 'stat' || w.type === 'switch' || w.type === 'scene' || w.type === 'history') && typeof w.entity === 'string') ids.add(w.entity);
      if (w.type === 'gauge') ids.add(typeof w.entity === 'string' ? w.entity : 'sensor.home_battery_soc');
      if (w.type === 'price') ids.add(map['sensor.energy_prices']?.ha || 'sensor.electricity_price');
      if (w.type === 'thermo' && w.zone) ids.add('climate.' + w.zone);   // no zone yet (#148): nothing to watch
      if (w.type === 'zoneList' || w.type === 'lightList' || w.type === 'scene') lists = true;
    }
    for (const id of [...ids]) if (map[id]) ids.add(map[id].ha);
    return lists ? null : [...ids]; // lists need every climate.* / light.* → unfiltered subscription
  }
  private async subscribe(sock: HaSocket) {
    let first = true;
    await sock.subscribeEntities(this.wantedEntities(), (ev) => {
      if (this.ha.socket !== sock) return;
      for (const [id, v] of Object.entries<any>(ev.a || {})) this.ha.entities.set(id, { s: v.s, a: v.a || {} });
      for (const [id, v] of Object.entries<any>(ev.c || {})) { const cur = this.ha.entities.get(id) || { s: '', a: {} }; const plus = v['+'] || {}; this.ha.entities.set(id, { s: plus.s ?? cur.s, a: { ...cur.a, ...(plus.a || {}) } }); }
      for (const id of ev.r || []) this.ha.entities.delete(id);
      this.ha.lastEvent = new Date().toISOString();
      this.dataChanged(first ? 'HA connected' : 'HA update'); first = false;
    });
  }
  private async resubscribe() {
    const s = this.ha.socket; if (!s) return;
    this.ha.socket = null; s.close(); this.ha.entities.clear(); this.ha.connected = false;
    await this.connectHa();
  }

  // ------------------------------------------------------------------ entity picker
  private entityList: { at: number; entities: HaListed[]; areas: HaArea[]; lists: HaLists } | null = null;
  private entityFetch: Promise<void> | null = null;
  /** GET /api/v1/ha/entities: cached list (60 s); the first call starts the fetch and answers ready: false.
   *  `state`: HA's state when the list was read (#84: the console's picker shows it next to the name). `area` and
   *  `areas` (#127): the entity's area (its own, else its device's: #88) and HA's areas, for the lightList / zoneList picker (+ climate).
   *  `lists` (#134): climate / lights in HA and what an unpicked list shows under the firmware's subscription cap (the
   *  device-sim subscribes to all of them; the counts follow the firmware). */
  haEntities(): { ready: boolean; entities: HaListed[]; areas: HaArea[]; lists?: HaLists } {
    const fresh = this.entityList && Date.now() - this.entityList.at < 60000;
    const sock = this.ha.socket;
    if (!fresh && sock && !this.entityFetch) {
      this.entityFetch = Promise.all([
        sock.command<{ entity_id: string; state: string; attributes: Record<string, any> }[]>({ type: 'get_states' }),
        sock.command<{ entity_id: string; area_id: string | null; device_id?: string | null }[]>({ type: 'config/entity_registry/list' }),
        sock.command<{ area_id: string; name: string }[]>({ type: 'config/area_registry/list' }),
        sock.command<{ id: string; area_id: string | null }[]>({ type: 'config/device_registry/list' }).catch(() => []),
      ]).then(([all, reg, areas, devices]) => {
          // like HA's area_id() (the firmware's template): the entity's own area, else its device's (#88)
          const devArea = new Map(devices.map((d) => [d.id, d.area_id]));
          const areaOf = new Map(reg.map((r) => [r.entity_id, r.area_id ?? (r.device_id ? devArea.get(r.device_id) : null)]));
          const n = (d: string) => all.filter((e) => e.entity_id.startsWith(d + '.')).length;
          const list = entityListAnswer(all, (id) => areaOf.get(id) ?? '');   // the firmware's template rule (#150)
          this.entityList = { at: Date.now(), areas: areas.map((a) => ({ id: a.area_id, name: a.name })),
            lists: { ...listCounts(n('climate'), n('light')), entities: { total: list.t, shown: list.e.length } },
            entities: list.e.map(([id, name, unit, state, area]) => ({ id, name, unit, state, ...(area ? { area } : {}) })) };
        }, (e) => { this.log('HA get_states failed · ' + (e as Error).message); })
        .finally(() => { this.entityFetch = null; });
    }
    return this.entityList ? { ready: true, entities: this.entityList.entities, areas: this.entityList.areas, lists: this.entityList.lists }
      : { ready: false, entities: [], areas: [] };
  }

  // ------------------------------------------------------------------ OTA
  otaState() {
    const a = this.otaRun.avail; const up = this.upload;
    return {
      installed: this.p.ota.fw, channel: this.p.ota.channel, auto: this.otaRepo ? this.p.ota.auto : 'off', status: this.otaRun.status,
      available: up ? (up.version ? { version: up.version, size_mb: 0, notes: [] } : null)
        : a ? { version: a.manifest.version, size_mb: Math.round((a.manifest.size / 1048576) * 100) / 100, notes: a.manifest.notes } : null,
      last_check: this.otaRun.lastCheck ? this.otaRun.lastCheck.toISOString() : null, message: this.otaRun.message || (this.otaRepo ? '' : OTA_CHECKS_OFF_MSG),
      error: this.otaRun.status === 'error' ? this.otaRun.error ?? null : null,
      progress: this.display.progress ? this.display.progress.pct : this.otaRun.status === 'updated' ? 100 : 0, repo: this.otaRepo,
    };
  }
  otaCheck(): string | null {
    if (!this.p.wifi.connected) { this.otaRun = { ...this.otaRun, status: 'error', message: 'No network — try again later', error: 'network' }; return 'No network — try again later'; }
    if (this.otaRun.status === 'checking') return null;
    if (!this.otaRepo) return null;   // firmware: 202, nothing to check; GET /ota stays idle with the checks-off message
    this.p.ota.channel = this.p.settings.ota_channel;
    const url = this.p.ota.channel === 'beta' ? 'releases?per_page=5' : 'releases/latest';
    this.log('OTA GET api.github.com/repos/…/' + url + ' (simulated)');
    this.otaRun = { ...this.otaRun, status: 'checking', message: '', error: null };
    this.later(() => {
      // firmware net/ota.cpp: a refused handshake (memory) stamps no last_check; any GitHub answer does
      if (this.checkFail !== 'ok') { const e = this.checkFail; this.otaRun = { ...this.otaRun, status: 'error', message: OTA_CHECK_MSG[e], error: e, lastCheck: e === 'memory' ? this.otaRun.lastCheck : new Date() }; this.log('OTA check failed · ' + OTA_CHECK_MSG[e]); return; }
      const r = latestFor(this.releases, this.p.ota.channel);
      const has = !!r && newer(r.manifest.version, this.p.ota.fw);
      this.otaRun = { status: has ? 'available' : 'uptodate', avail: has ? r : null, lastCheck: new Date(), message: '' };
      this.log(has ? 'OTA v' + r!.manifest.version + ' available' : 'OTA up to date');
    }, this.delays.otaCheckMs);
    return null;
  }
  /** POST /ota. null = started, else 409 message. */
  otaInstall(): string | null {
    const rel = this.otaRun.avail;
    if (!this.otaRepo) return OTA_CHECKS_OFF_MSG;   // nothing to install from; upload instead
    if (this.otaBusy) return 'An update is already running';
    if (!rel) return 'Already up to date';
    if (this.battery < 30) { const m = 'Battery at ' + this.battery + '% — charge to 30% first'; this.otaRun = { ...this.otaRun, status: 'blocked', message: m }; return m; }
    if (!this.p.wifi.connected) return 'No network';
    this.display.mode = 'updating'; this.display.progress = { version: rel.manifest.version, pct: 0, step: 'Downloading firmware.bin' };
    this.otaRun = { ...this.otaRun, status: 'downloading', message: '' };
    this.fullRefresh('update screen');
    this.log('OTA start · firmware.bin v' + rel.manifest.version + ' → ota_1 (streamed)');
    this.later(() => {
      this.display.progress!.pct = 50; this.dataChanged('progress 50%');
      this.later(() => {
        this.display.progress = { ...this.display.progress!, pct: 100, step: 'Checking SHA-256' };
        this.otaRun = { ...this.otaRun, status: 'installing' };
        let img = rel.image(); if (this.failMode === 'hash') img = Buffer.concat([img, Buffer.from('corrupted')]);
        const err = verifyImage(img, rel.manifest);
        if (err) {
          this.log('OTA abort · ' + err + ' · ota_1 discarded');
          this.display.mode = 'main'; this.display.progress = null; this.fullRefresh('update failed');
          this.otaRun = { ...this.otaRun, status: 'error', message: 'Download was corrupted — nothing changed. Try again.' };
          return;
        }
        this.rebootInto(rel.manifest);
      }, this.delays.otaStepMs);
    }, this.delays.otaStepMs);
    return null;
  }
  /** An upload started (firmware: first body byte): the install face, "Updating to" + the version only when known. */
  uploadStart(version: string) {
    this.upload = { version }; this.otaRun = { ...this.otaRun, status: 'installing', avail: null, message: '' };
    this.display.mode = 'updating'; this.display.progress = { version, pct: 0, step: 'Checking SHA-256' };
    this.fullRefresh('update screen');
    this.log('OTA upload start · ' + (version ? 'v' + version : 'local file, version unknown'));
  }
  /** The manifest part arrived after the upload started (firmware: handleUpload, manifest.json final). */
  uploadVersion(version: string) {
    if (!this.upload || !version || version === this.upload.version) return;
    this.upload = { version }; this.display.progress = { ...this.display.progress!, version }; this.dataChanged('update version');
  }
  /** 4xx after the upload started: nothing changed, back to the dashboard, no target version left behind. */
  uploadFailed(msg: string) {
    if (!this.upload) return;
    this.upload = null; this.otaRun = { ...this.otaRun, status: 'error', message: msg };
    this.display.mode = 'main'; this.display.progress = null; this.fullRefresh('update failed');
  }
  get otaBusy(): boolean { return ['downloading', 'installing', 'verifying'].includes(this.otaRun.status); }
  /** After a verified image (download or upload): set boot partition, restart, health check (or roll back). */
  rebootInto(m: Manifest) {
    const prev = this.p.ota.fw; this.upload = null;
    this.log('esp_ota_set_boot_partition(ota_1) · RESTART into v' + m.version + ' (pending verify)');
    this.p.ota = { ...this.p.ota, fw: m.version, prev }; this.otaRun = { ...this.otaRun, status: 'verifying', message: '' };
    this.diagReset('SW', null); this.save();
    this.display.mode = 'boot'; this.display.progress = null; this.fullRefresh('boot · v' + m.version);
    this.ha.socket?.close(); this.ha.socket = null; this.ha.connected = false;
    this.later(() => {
      if (this.failMode === 'boot') {
        this.p.ota = { ...this.p.ota, fw: prev }; this.diagReset('SW', null); this.save();
        this.log('v' + m.version + ' failed health check · bootloader rolls back to v' + prev);
        this.otaRun = { ...this.otaRun, status: 'error', message: 'v' + m.version + ' did not start — restored v' + prev + ' automatically' };
        this.boot('Update failed — back on v' + prev);
      } else {
        this.log('health check passed · esp_ota_mark_app_valid_cancel_rollback()');
        this.otaRun = { status: 'updated', avail: null, lastCheck: new Date(), message: '' };
        this.boot('Updated to v' + m.version);
      }
      void this.connectHa();
    }, this.delays.rebootMs);
  }

  // ------------------------------------------------------------------ diagnostics (x-firmware, firmware/src/net/diag.cpp)
  private diagState() { if (!this.p.diag) this.p.diag = { ring: [], coredump: null }; return this.p.diag; }
  /** The running boot ends (reset reason of the next one): last uptime into the ring, then the new boot in front. */
  diagReset(reason: string, panic: string | null) {
    const d = this.diagState();
    d.ring = diagTouch(d.ring, Math.floor((Date.now() - this.bootAt) / 1000), SIM_HEAP.min_free_internal, Math.floor(Date.now() / 1000));
    d.ring = diagPush(d.ring, reason, this.p.ota.fw, panic);
    this.logsPrev = logTail(this.logs); this.logs = logRing();
    this.bootAt = Date.now(); this.batt = BATT_ZERO; this.resetReason = reason; this.bootRefresh = { full: this.display.full, partial: this.display.partial, fast: this.display.fast, clean: this.display.clean };
  }
  /** POST /__sim/control {crash}: what a panic / task watchdog / brownout leaves behind, then the reboot. */
  crash(kind: SimCrash) {
    const reason = kind === 'panic' ? 'PANIC' : kind === 'task_wdt' ? 'TASK_WDT' : 'BROWNOUT';
    const panic = kind === 'panic' ? SIM_PANIC : kind === 'task_wdt' ? 'Task watchdog got triggered.' : null;
    this.log('CRASH (' + reason + ')' + (panic ? ' · ' + panic : ''));
    if (kind !== 'brownout') this.diagState().coredump = { task: kind === 'panic' ? 'loopTask' : 'IDLE0', pc: '0x4201a3c4', backtrace: ['0x4201a3c4', '0x42009f10', '0x4200b7e2', '0x40381a5d'], backtrace_corrupted: false, exc_cause: kind === 'panic' ? 0 : 1, exc_vaddr: '0x00000000', panic, elf_sha256: 'a3f1c2d4e5b60718', size: 9472 };
    this.ha.socket?.close(); this.ha.socket = null; this.ha.connected = false; this.ha.access = null; this.ha.entities.clear();
    this.diagReset(reason, panic); this.save();
    this.display.mode = 'boot'; this.fullRefresh('boot · ' + reason);
    this.later(() => { this.boot(reason); void this.connectHa(); }, this.delays.rebootMs);
  }
  /** GET /diagnostics */
  diagnostics() {
    const d = this.diagState();
    const ring = diagTouch(d.ring, Math.floor((Date.now() - this.bootAt) / 1000), SIM_HEAP.min_free_internal, Math.floor(Date.now() / 1000));
    const rssi = NETWORKS.find((n) => n.ssid === this.p.wifi.connected)?.rssi ?? null;
    return {
      firmware: this.p.ota.fw, uptime_s: Math.floor((Date.now() - this.bootAt) / 1000), reset_reason: this.resetReason,
      boots: bootsJson(ring), last_crash: lastCrash(ring), last_wdt: null, heap: { ...SIM_HEAP, low_point: SIM_LOW_POINT },
      panel: { controller: 'UC8179', source: 'probe', verdict: 'ultrachip', promoted: true, ver: '00 00 01 FF FF', flg: 0, nvs_screen_type: 1, failed: false, failure: null },
      coredump: d.coredump, touch_recoveries: 0, deep_sleep: { armed: true, boots_left: 0, armed_by: 'boots' }, battery: battHistory(this.battTick()),
      power_trail: { before_boot: null, lines: ['awake'] },   // #225: a fresh device marks itself awake on /power.txt
      // #227 inbound path; served counts finished responses (http.ts), this request is still open
      web: { open: 1, served: this.web.served, refused_503: 0, last_request_age_s: this.web.lastAt ? Math.floor((Date.now() - this.web.lastAt) / 1000) : null },
      mdns: { up: !!this.p.wifi.connected, restarts: 0, last_restart_reason: null },
      wifi: { rssi, bssid: rssi === null ? null : '3fa2', idle_checks: 0, idle_reconnects: 0 },
    };
  }
  /** GET /logs (x-firmware, #200) */
  logsGet(q: LogsQuery, previous: boolean) { return previous ? logsQuery(this.logsPrev, q, 'previous') : logsQuery(this.logs, q); }
  /** DELETE /diagnostics */
  diagnosticsClear() {
    const d = this.diagState();
    d.ring = diagClear(d.ring); d.coredump = null; this.save();
  }
  /** GET /diagnostics/coredump: a small ELF-shaped blob (the device streams the coredump partition). */
  coredumpImage(): Buffer | null {
    const c = this.diagState().coredump; if (!c) return null;
    const b = Buffer.alloc(c.size); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]).copy(b, 0); Buffer.from(c.task + '\0' + (c.panic || '')).copy(b, 64);
    return b;
  }
  // ------------------------------------------------------------------ power
  /** GET /status `power` (3.0 instrumentation). The firmware reports getCpuFrequencyMhz() / esp_wifi_get_ps() as cpuMhz /
   *  wifiPs, and in `applied` what the power rules set (#177). An OTA holds Wi-Fi power save off (net/health.cpp). */
  powerStatus() {
    const charging = this.power.usb && this.battery < 100;
    const d = this.powerCheck();
    const held = this.otaBusy;
    const applied = { cpuMhz: CPU_MHZ[d.cpuProfile], wifiPs: d.wifiPs, psOffHeld: held };
    const t = this.tally;
    return { source: powerSource(charging, this.power.usb), charging, cpuMhz: applied.cpuMhz, wifiPs: held ? 'none' : d.wifiPs, applied, mode: 'awake', nextWakeEpoch: null,
      wakes: t.wakes, redraws: t.redraws, failedWakes: t.failedWakes, awakeS: Math.floor((t.awakeMs + Date.now() - this.bootAt) / 1000), asleepS: t.asleepS, lastWake: t.last };
  }
  /** GET /status `refreshes` (#178): since power-on (boots that ended in deep sleep + this one) and this boot. */
  refreshStatus() {
    const b = this.bootRefresh, d = this.display;
    const boot = { full: d.full - b.full, partial: d.partial - b.partial, fast: d.fast - b.fast, clean: d.clean - b.clean };
    return { full: this.tally.fullRefreshes + boot.full, partial: this.tally.partialRefreshes + boot.partial, boot };
  }
  /** The shared power rules, as with power saving "Standby + night" and the standby face on. */
  powerCheck(now = new Date()): PowerDecision { return powerDecision(this.powerInputs(now)); }
  powerInputs(now = new Date()): PowerInputs {
    const auto = this.p.ota.auto;
    return {
      nowEpoch: Math.floor(now.getTime() / 1000), localSec: now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(),
      powerSave: 'standby', wakeEvery: 15, night: this.p.settings.display.night, peeking: false, standby: true,
      charging: this.power.usb && this.battery < 100, usb: this.power.usb, chargedAgoMin: null, voltage: this.batteryMv === null ? null : this.batteryMv / 1000, battery: this.battery,
      otaPendingVerify: this.otaRun.status === 'verifying', otaBusy: this.otaBusy, otaAuto: auto, otaDue: !!this.otaRun.avail && auto === 'night',
      setup: this.p.setup !== null, msSinceApi: this.power.lastApi === null ? null : Date.now() - this.power.lastApi,
    };
  }
  /** __sim/control {sleep: true}: deep sleep if the rules allow it (null), else the reason it stays awake. */
  sleep(): string | null {
    const d = this.powerCheck(); if (!d.deepSleepNow) return d.reason;
    this.enterSleep(d.wakeAtEpoch === null ? 0 : d.wakeAtEpoch * 1000, d.reason);
    return null;
  }
  /** POST /api/v1/device/sleep {"seconds": N} (#178): checked now; 202 → deep sleep once the answer is out. */
  sleepNow(seconds: unknown): SleepNowCheck {
    const c = sleepNowCheck(seconds, this.powerInputs());
    if (c.status === 202) this.log('POWER sleep requested · ' + String(seconds) + ' s');
    return c;
  }
  enterSleep(wakeAt: number, why: string) {
    this.tally = tallySleep(this.tally, Date.now() - this.bootAt, this.display.full - this.bootRefresh.full, this.display.partial - this.bootRefresh.partial);
    this.power.sleptAt = Math.floor(Date.now() / 1000); this.power.plannedWake = Math.floor(wakeAt / 1000);
    this.power.asleep = { wakeAt };
    this.log('POWER deep sleep (' + why + ') · ' + (wakeAt ? 'timer wake ' + new Date(wakeAt).toISOString() : 'button/charger wake only') + ' · API refused until then');
    if (wakeAt) this.power.wakeT = setTimeout(() => this.wake('timer'), Math.max(0, wakeAt - Date.now()));
  }
  /** Timer, power key or charger: a deep-sleep wake is a reset (boot screen, then home). */
  wake(src: string) {
    if (!this.power.asleep || this.closed) return;
    if (this.power.wakeT) clearTimeout(this.power.wakeT);
    this.power.asleep = null; this.power.wakeT = null; this.power.lastApi = null;
    this.tally = tallyWake(this.tally, sleptSeconds(this.power.sleptAt, this.power.plannedWake, Math.floor(Date.now() / 1000)));
    this.log('POWER wake · ' + src); this.diagReset('DEEPSLEEP', null); this.boot('wake · ' + src);
  }
  /** Battery sample / [BATT] log line (firmware net/power.cpp, core/battery.ts), every power-loop pass. */
  battTick(): BattState {
    if (this.closed || this.power.asleep) return this.batt;
    const charging = this.power.usb && this.battery < 100;
    const r = battStep(this.batt, { ms: Date.now() - this.bootAt, epoch: Math.floor(Date.now() / 1000), pct: this.battery, mv: this.batteryMv, chg: charging, usb: this.power.usb,
      power: this.powerCheck().reason, rssi: NETWORKS.find((n) => n.ssid === this.p.wifi.connected)?.rssi ?? null });
    if (r.log) this.log('BATT ' + r.log);
    this.batt = r.s;
    return r.s;
  }
  setUsb(on: boolean) { this.power.usb = on; this.log('POWER USB ' + (on ? 'plugged' : 'unplugged')); if (on) this.wake('charger'); }

  // ------------------------------------------------------------------ simulator view
  /** Push device health to HA (firmware net/ha_report.cpp haReportLoop): due per core/haReport, one POST per entity. */
  async reportTick(): Promise<void> {
    const on = this.p.settings.display.haReport !== false;
    if (on && !this.report.on) { this.report.force = true; this.report.status = 'waiting'; }
    if (!on) this.report.status = 'off';
    this.report.on = on;
    const access = this.ha.access;
    if (!on || this.closed || this.report.busy || this.report.status === 'not_admin' || !this.ha.connected || !access) return;
    const charging = this.power.usb && this.battery < 100;
    const now = Date.now();
    if (!reportDue(this.report.last, this.report.force, now, this.battery, charging)) return;
    const states = reportStates({
      hostname: HOST, name: this.p.name, battery: this.battery, charging, usb: this.power.usb,
      rssi: NETWORKS.find((n) => n.ssid === this.p.wifi.connected)?.rssi ?? null, firmware: this.p.ota.fw, resetReason: this.resetReason,
      lastFullEpoch: this.report.lastFullAt ? Math.floor(this.report.lastFullAt / 1000) : null, bootEpoch: Math.floor(this.bootAt / 1000),
    });
    this.report.busy = true;
    let status: number | string = 0;
    try {
      for (const st of states) {
        const r = await fetch(this.p.ha.url.replace(/\/$/, '') + '/api/states/' + st.entity_id, { method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: st.state, attributes: st.attributes }), signal: AbortSignal.timeout(8000) });
        await r.arrayBuffer(); status = r.status;
        if (!r.ok) break;
      }
    } catch (e) { status = (e as Error).message; }
    this.report.busy = false;
    const ok = status === 200 || status === 201;
    if (ok) { this.report.last = { atMs: now, battery: this.battery, charging }; this.report.force = false; this.report.retried = false; this.report.status = 'ok'; this.report.pushedAt = now; this.log('HA report · ' + states.length + ' states'); return; }
    // failed: try again after the minimum gap, without counting the values as reported; no HTTP answer → one early retry (#123)
    const retry = typeof status === 'string' && !this.report.retried;
    this.report.retried ||= retry;
    this.report.last = { atMs: now, battery: this.report.last?.battery ?? this.battery, charging: this.report.last?.charging ?? charging, retry };
    this.report.force = true;
    this.report.status = status === 401 || status === 403 ? 'not_admin' : 'error';
    this.log('HA report · ' + (this.report.status === 'not_admin' ? 'HA ' + status + ': the linked HA user is not an administrator · stopped until the next connect' : 'failed (' + status + ') · retry'));
  }
  reportStatus(): ReportStatus {
    const enabled = this.p.settings.display.haReport !== false;
    const state: ReportPhase = !enabled ? 'off' : this.report.on ? this.report.status : 'waiting';
    return { enabled, state, last_push_epoch: this.report.pushedAt ? Math.floor(this.report.pushedAt / 1000) : null };
  }
  simState() {
    return {
      screen: this.screenId(), apps: withSettings({ apps: this.p.apps, screens: [] }).apps.map((a) => a.id), mode: this.display.mode, setup: this.p.setup, progress: this.display.progress,
      refreshes: { full: this.display.full, clean: this.display.clean, fast: this.display.fast, partial: this.display.partial, skipped: this.display.skipped, since_full: this.display.sinceFull },
      last_refresh: this.display.events[this.display.events.length - 1] || null, events: this.display.events.slice(-20),
      regions: this.display.regions, history: this.histState(),
      ha: { url: this.p.ha.url, status: this.haStatus(), linked: this.p.ha.linked, revoked: this.p.ha.revoked, connected: this.ha.connected, user: this.p.ha.user,
        client_id: this.p.ha.clientId, entities: this.ha.entities.size, areas: this.ha.areas, last_event: this.ha.lastEvent, version: this.ha.version, report: this.reportStatus().state },
      wifi: { ...this.p.wifi, run: this.wifiRun }, ota: this.otaState(), battery: this.battery, fail_mode: this.failMode,
      sessions: this.sessions.size, tokens: this.p.tokens.map((t) => ({ id: t.id, name: t.name, scope: t.scope, hash: t.hash, masked: t.masked })),
      config_rev: this.p.configRev, install_id: this.p.installId, state_file: this.stateFile, pairing_code: this.pairingCode(), settings: this.p.settings,
      power: { usb: this.power.usb, asleep: this.power.asleep ? { wake_at: this.power.asleep.wakeAt ? new Date(this.power.asleep.wakeAt).toISOString() : null } : null, decision: this.powerCheck() },
    };
  }
}

/** null when the image matches manifest.json (size + SHA-256). */
export function verifyImage(img: Buffer, m: Manifest): string | null {
  if (m.size && img.length !== m.size) return 'size ' + img.length + ' does not match manifest.json (' + m.size + ')';
  if (sha256(img) !== String(m.sha256).toLowerCase()) return 'SHA-256 does not match manifest.json';
  return null;
}

const safeReturn = (p: string): string => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') ? p : '/');
const withParam = (path: string, k: string, v: string): string => path + (path.includes('?') ? '&' : '?') + k + '=' + v;

/**
 * Logical ids (firmware core/entities.h) the Energy dashboard maps onto HA entities: power sensors named in the prefs
 * (stat_rate / power[] / power_config.stat_rate) and the price entity. Home use = grid when the grid is the only source.
 * Sign handling and the device / statistics paths of firmware core/entity_map.cpp are not simulated.
 */
export function aliasesOf(prefs: any): Record<string, string> {
  const out: Record<string, string> = {};
  const kinds = new Set<string>();
  for (const s of Array.isArray(prefs?.energy_sources) ? prefs.energy_sources : []) {
    kinds.add(s?.type);
    const logical = ({ solar: 'sensor.solar_power', grid: 'sensor.grid_power', battery: 'sensor.battery_power' } as Record<string, string>)[s?.type];
    const r = s && typeof s === 'object' ? rateOf(s) : ''; if (logical && r && !out[logical]) out[logical] = r;
    if (s?.type === 'grid') { const p = gridFlows(s).price; if (p && !out['sensor.energy_prices']) out['sensor.energy_prices'] = p; }
  }
  if (out['sensor.grid_power'] && kinds.size === 1 && kinds.has('grid')) out['sensor.home_power'] = out['sensor.grid_power'];
  return out;
}
