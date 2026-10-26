// The emulator: a line-for-line port of `class Component extends DCLogic` in
// the original design handoff Main.dc.html (removed 2026-10-16, see commit c7393ae) (DCLogic ≈ React class component:
// state / setState / componentDidMount / componentDidUpdate / renderVals()).
//
// Differences from the original are listed in ../../DEVIATIONS.md. The biggest one: the web console no
// longer reads this component's state directly; it talks to the device through `DeviceApi`
// (src/webconsole/DeviceApi.ts), implemented here by ./emulatorApi.ts.
import { Component } from 'react';
import {
  PAPER, INK, PRICES, USAGE, SOLAR, ZONE_LIST, ZONE_NAME, ROOMS, ROOM_NAME, LIGHT_LIST, LIGHT, CHEAP, MODE_ICON, NETWORKS, KB, REPO, HOST, SIM_IP, ICON, FW_INSTALLED, INITIAL_RELEASES, ENT, APP, SETTINGS, SETTING_CFG, EXTRA_ENTITIES, HA_ENTITIES, type HaData, type Derived, type Release,
} from '../core/data.ts';
import { currency, currencySymbol, money, setCurrency, tzFor, DEFAULT_TZ } from '../core/locale.ts';
import { pad, kw, fmtNum, fmtValue, entityGap, hhmm, isNightHour, semver, newer, barsFor, hm, numFormat, numFormatOf, presetHasAway, setNumFormat } from '../core/format.ts';
import { defaultScreens, withSettings, userConfig, SETTINGS_APP, SETUP_SCREENS, toYaml, parseYaml, cellsUsed, gridLayout, DEFAULT_APPS, GAUGE_DEFAULT_ENTITY, domainOf, entityGaps, zoneLabel, sceneAction, type AppDef, type Config, type Screen, type Widget } from '../core/config.ts';
import { cfgToDisplay, displayToCfg, displayError, nameError, settingsPutError, LOOK_KEYS, DEFAULT_POWER, type Cfg, type DeviceSettings, type OtaAutoMode, type OtaChannel, type SettingsPatch } from '../core/settings.ts';
import { DEMO_ROUTES, DELAY_SETS, TRAVEL, demoTravelScreen } from './demoTravel.ts';
import { LOGICAL, formatSource, mergeEntities, splitRef, type EntityOverrides } from '../core/entityMap.ts';
import { batteryLabel, powerDecision, type OtaAuto, type PowerInputs } from '../core/power.ts';
import { glanceStep, liveNow, snapshotDiff, snapshotOf, BOOT_HOLD_LIVE_MIN, type Snapshot } from '../core/glance.ts';
import { recoveryInit, recoveryOffer, recoveryStep, RESET_HOLD_MS, RESET_CONFIRM_MS, RESTART_HOLD_MS, POWER_OFF_HOLD_MS, CRASH_LOOP_BOOTS, KEY_POWER, KEY_RIGHT, KEY_LEFT, KEY_OTHER, type RecoveryState, type RecoveryAction } from '../core/recovery.ts';
import { attrSamples, bucketize, bucketStart, dayLowHigh, fromSamples, historySpec } from '../core/history.ts';
import { demoForecast, demoHistory, historyChart, historyTile } from '../core/historyChart.ts';
import { skin, lookOf, LOOKS, SK_FONTS, SURF, type Look } from '../core/skin.ts';
import { sevOf, badge, carEta } from '../core/severity.ts';
import { serializeRegion, changedRegions, type RegionMap } from '../core/regions.ts';
import { otaLine, type OtaErr } from '../core/otaStatus.ts';
import { subPages, flatPages, rects, PER_COL, PER_PAGE, lightGroupsOf, layoutGroups, listPages, pickLights, pickZones, type Rect } from '../core/paging.ts';
import { bwAfter, SCREEN_W, TRACK, HATCH } from '../core/panel.ts';
import { ambientDue, chromeFor, nightStale, AMBIENT_MS, type Chrome } from '../core/ambient.ts';
import { DEFAULT_LIGHT_TIMEOUT, frontlightPct, lightTimedOut, lightWakeConsumes } from '../core/frontlight.ts';
import { decidePartial, decideNav, minuteKeys, cleanDue, nextCleanMin, DEFAULT_CLEAN_EVERY, PowerHold } from '../core/refresh.ts';
import { KeyedDebouncer, nextSetpoint, TADO_DEBOUNCE_MS } from '../core/debounce.ts';
import { parseHaAddress } from '../core/haAddress.ts';
import { dateLine, langOf, tr, type Lang, type StrKey } from '../core/strings.ts';
import { authorize, findToken, hashToken, maskToken, newTokenSecret, type Scope, type StoredToken } from '../core/auth.ts';
import { DeviceUnreachableError, ApiError, type DeviceApi, type DeviceSnapshot, type TokenInfo } from '../webconsole/DeviceApi.ts';
import { createEmulatorApi } from './emulatorApi.ts';
import { logPush, logRing, logSplit, type LogRing } from '../core/logs.ts';
import { Device } from '../components/Device.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { SidePanel } from '../components/SidePanel.tsx';
import { WebConsole } from '../webconsole/WebConsole.tsx';

const LIGHT_GROUPS = lightGroupsOf(ROOMS, LIGHT_LIST);
/** The sim HA's get_config (#147): time_zone, and the currencies the side panel steps through. */
const SIM_HA_TZ = 'Europe/Amsterdam';
const SIM_CURRENCIES = ['EUR', 'USD', 'GBP', 'SEK'];
// App switcher icon for categories the user made (built-in apps keep their own icon).
const GENERIC_APP_ICON = 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z';
const ENT_NAME: Record<string, string> = Object.fromEntries(HA_ENTITIES.map((e) => [e.id, e.name]));
const ENT_UNIT: Record<string, string> = Object.fromEntries(HA_ENTITIES.map((e) => [e.id, e.unit]));
const ENT_DP: Record<string, number | undefined> = Object.fromEntries(EXTRA_ENTITIES.map((e) => [e.id, e.dp]));
const LOCAL = ['clock', 'setting', 'ota', 'wifi', 'ha', 'about', 'info', 'setupWeb'];
/** GET /ota message for a failed check (firmware net/ota.cpp; device-sim server/device.ts). */
const SIM_CHECK_MSG: Record<OtaErr, string> = { memory: 'Not enough memory right now — try again in a minute', network: 'GitHub not reachable (HTTP -1)', busy: 'GitHub not reachable (HTTP 403)', none: 'No releases published yet', other: 'GitHub not reachable (HTTP 502)' };
/** The showcase adds its demo Travel screen (mock timetables, demoTravel.ts) after Heating; real defaults have none (#145). */
const withDemoTravel = (screens: Screen[]): Screen[] => { const i = screens.findIndex((x) => x.id === 'climate') + 1; return [...screens.slice(0, i), demoTravelScreen(), ...screens.slice(i)]; };
const isLookKey = (k: string) => (LOOK_KEYS as readonly string[]).includes(k);
/** Awake at least this long after a boot / wake / key press before the power rules may deep-sleep (emulator pacing). */
const AWAKE_MIN_MS = 5000;
const MDNS_HA = 'homeassistant.local:8123';

type Menu = false | 'apps' | 'pages';
type LogLine = { t: string; msg: string; c: string };
type TermLine = { t: string; c: string };

export type EmuState = {
  mode: 'boot' | 'main' | 'updating' | 'onboard' | 'off'; sleeping: boolean; idx: number; sub: number; menu: Menu;
  /** Deep sleep (power saving, src/core/power.ts): the panel keeps its last image, Wi-Fi and the API are off. `sleeping` is the standby face. */
  asleep: { wakeAt: number | null; clock: string; wasStandby: boolean; glance?: boolean } | null;
  /** Simulation › USB plugged: external power (charging below 100 %). */
  usb: boolean;
  apps: AppDef[]; screens: Screen[]; cfg: Cfg; name: string;
  /** settings `entities` (core/entityMap.ts). Stored and reported only: the mock HA already has every logical id. */
  entities: EntityOverrides; setup: 'wifi' | 'web' | null;
  ha: { linked: boolean; revoked: boolean; view: 'status' | 'link'; server: string; user: string; stage: number; pair: string; running: boolean };
  onboard: { step: number } | null; resetArm: boolean; bootAt: Date;
  /** Hardware-key factory reset / crash-loop offer (src/core/recovery.ts, issue #21). */
  recovery: RecoveryState;
  /** Device-side state of the web console (session cookie, API token hashes, config revision). */
  session: { signedIn: boolean }; tokens: StoredToken[]; configRev: number; installId: string;
  /** Laptop: terminal lines, downloaded file, exported token, and the secrets the user copied when they were shown once. */
  term: { lines: TermLine[]; file: string | null; exported: string | null; known: Record<string, string> };
  simHour: number | null; haLang: Lang; haCurrency: string; tz: string; render: 'gray4' | 'mono' | 'none'; paused: boolean; offline: boolean; zoneCount: number; away: boolean; showRegions: boolean;
  /** Panel preview (#25): areas a partial refresh left B/W on the panel since the last full refresh. */
  panelPreview: boolean; bw: Rect[];
  pending: Record<string, true>; lastUpdate: Date | null; peekUntil: number;
  /** Ambient idle mode (#27): chrome hidden after 60 s without input. `nightSnap.at`: "HH:MM" only when the data was stale. */
  /** Front light timed out (#220, core/frontlight.ts); the next key/tap only turns it back on. */
  lightOut: boolean;
  ambient: boolean; nightSnap: { inside: string; batt: string; cheap: string; at: string } | null; dirty: string[];
  bootMsg: string;
  ota: { fw: string; channel: 'stable' | 'beta'; auto: string; status: string; lastCheck: Date | null; avail: Release | null; msg: string; err: OtaErr | null; pendingVerify: boolean; prev: string | null };
  releases: Record<'stable' | 'beta', Release>; failMode: 'ok' | 'hash' | 'boot'; checkFail: 'ok' | OtaErr; upd: { version: string; pct: number; step: string } | null; travel: string;
  wifi: { connected: string | null; saved: string[]; view: 'list' | 'pw' | 'connecting' | 'phone'; target: string; pw: string; show: boolean; kb: string; msg: string; lastScan: Date | null; scanning: boolean };
  flash: string | null; fullCount: number; partialCount: number; fastCount: number; sinceFull: number; navSinceClean: number;
  now: Date; log: LogLine[]; customN: number;
  d: HaData;
  /** Mock state of the extra HA entities (EXTRA_ENTITIES: outdoor sensors, switches, …). */
  ent: Record<string, string>;
};

export type EmulatorProps = { osName?: string; deviceBattery?: number; bodyColor?: 'Black' | 'White'; initial?: 'firstInstall' | 'installed'; look?: Look; lang?: string };

const newInstallId = () => Math.random().toString(36).slice(2, 10);

export class Emulator extends Component<EmulatorProps, EmuState> {
  timers: ReturnType<typeof setTimeout>[] = [];
  powerHold = new PowerHold();   // power deadband (#85): tiles keep the last shown value inside it
  debounce = new KeyedDebouncer();
  lastMinute = -1; prevNight: boolean | undefined = undefined; lastInput = Date.now(); idleHomed = false;
  /** Epoch minute of the last full refresh: the scheduled clean (#26) runs at the first :00/:30 ≥ 30 min after it. */
  lastFullMin = Math.floor(Date.now() / 60000);
  /** Last web console / API request that reached the display (null = none since boot). */
  lastApi: number | null = null;
  /** The device log behind GET /logs (#200): every log() line, like the firmware's LOG_* ring. */
  logs: LogRing = logRing();
  private logsAt = Date.now();
  /** Glance (#10): what the firmware keeps in RTC memory across deep sleep. */
  rtc: { snap: Snapshot | null; fails: number; drawnOffline: boolean; drawnAt: number } = { snap: null, fails: 0, drawnOffline: false, drawnAt: 0 };
  /** A key held through the boot screen keeps it live until then (first-boot safety, #10). */
  holdLiveUntil = 0;
  /** First-boot safety (#10): confirmed boots this image still needs before it may deep-sleep. The emulator plays an
   *  installed display (armed); set it to see the "not armed" rule. */
  armLeft = 0;
  swipe: { x: number; y: number; t: number } | null = null; swallowClick = false;
  clockT?: ReturnType<typeof setInterval>; tickT?: ReturnType<typeof setInterval>; dirtyT?: ReturnType<typeof setTimeout>;
  listeners = new Set<() => void>();
  api: DeviceApi;

  constructor(props: EmulatorProps) {
    super(props);
    const zones: HaData['zones'] = {}; ZONE_LIST.forEach((z) => { zones[z.id] = { cur: z.cur, set: z.set }; });
    const lights: HaData['lights'] = {}; LIGHT_LIST.forEach((l) => { lights[l.id] = { on: l.on, b: l.b }; });
    this.state = {
      mode: 'boot', sleeping: false, asleep: null, usb: false, idx: 0, sub: 0, menu: false,
      ...withSettings({ apps: DEFAULT_APPS.map((a) => ({ ...a })), screens: withDemoTravel(defaultScreens()) }), name: 'Living room display', entities: {},
      cfg: { brightness: 0, warmth: 40, lightTimeout: DEFAULT_LIGHT_TIMEOUT, night: '23-07', fullEvery: 8, cleanEvery: DEFAULT_CLEAN_EVERY, interval: 30, returnHome: 5, standby: 0, clock: '24', style: 'classic', typeface: 'archivo', surface: 'dither', haReport: true, ...DEFAULT_POWER },
      setup: null,
      ha: { linked: false, revoked: false, view: 'status', server: MDNS_HA, user: 'X4 display', stage: 0, pair: '4F7K', running: false },
      onboard: null, resetArm: false, bootAt: new Date(), recovery: recoveryInit(),
      session: { signedIn: false }, tokens: [], configRev: 1, installId: newInstallId(),
      term: { lines: [{ t: 'Last login: Tue Oct 13 on ttys001', c: '#8d8a83' }, { t: '$ export X4=http://' + HOST, c: '#d9d6ce' }], file: null, exported: null, known: {} },
      simHour: null, haLang: langOf(props.lang), haCurrency: 'EUR', tz: '', render: 'gray4', paused: false, offline: false, zoneCount: 10, away: false, showRegions: true, panelPreview: true, bw: [],
      pending: {}, lastUpdate: null, peekUntil: 0, lightOut: false, ambient: false, nightSnap: null, dirty: [],
      bootMsg: 'Connecting to Home Assistant…',
      ota: { fw: FW_INSTALLED, channel: 'stable', auto: 'notify', status: 'idle', lastCheck: null, avail: null, msg: '', err: null, pendingVerify: false, prev: null },
      releases: JSON.parse(JSON.stringify(INITIAL_RELEASES)), failMode: 'ok', checkFail: 'ok', upd: null, travel: 'mixed',
      wifi: { connected: null, saved: [], view: 'list', target: '', pw: '', show: false, kb: 'lower', msg: '', lastScan: null, scanning: false },
      flash: null, fullCount: 0, partialCount: 0, fastCount: 0, sinceFull: 0, navSinceClean: 0,
      now: new Date(), log: [], customN: 0,
      d: { solar: 0, home: 420, batt: 0, grid: 420, soc: 64, zones, lights },
      ent: Object.fromEntries(EXTRA_ENTITIES.map((e) => [e.id, e.state])),
    };
    if (props.look && props.look !== 'classic') this.state = { ...this.state, cfg: { ...this.state.cfg, style: 'sleek', typeface: props.look } };
    this.api = createEmulatorApi(this);
  }

  get battery(): number { return this.props.deviceBattery ?? 76; }
  get osName(): string { return this.props.osName ?? 'HA Paper'; }

  componentDidMount() {
    if (this.props.initial === 'installed') this.installedSim(); else this.boot();
    this.clockT = setInterval(() => {
      const now = new Date(); this.setState({ now });
      this.idleCheck();
      this.powerTick();
      if (now.getMinutes() !== this.lastMinute) {
        if (this.lastMinute !== -1 && this.state.mode === 'main' && !this.state.asleep && cleanDue({ sinceFull: this.state.sinceFull, lastFullMin: this.lastFullMin, nowMin: Math.floor(now.getTime() / 60000), everyMin: this.state.cfg.cleanEvery, night: this.nightActive(this.state) })) this.fullRefresh('clean screen');
        else if (this.lastMinute !== -1 && this.state.mode === 'main' && !this.state.asleep) this.partialRefresh('clock', minuteKeys(this.keysOfType('clock'), this.hourOf(this.state) === 0 && now.getMinutes() === 0).filter((k) => k !== 'time' || this.chromeOf(this.state).clock));
        this.lastMinute = now.getMinutes();
      }
    }, 1000);
    this.startTick();
  }
  componentDidUpdate() {
    this.listeners.forEach((f) => f());
    const s = this.state; if (s.mode !== 'main') { this.prevNight = undefined; return; }
    const n = this.nightActive(s);
    if (this.prevNight !== undefined && n !== this.prevNight) {
      if (n) {
        const d = this.derive(s.d, s);
        this.setState({ menu: false, nightSnap: { inside: fmtNum(d.zones.living.cur, '°C') + '°', batt: Math.round(d.soc) + '%', cheap: pad(CHEAP) + ':00–' + pad(CHEAP + 3) + ':00', at: this.staleAt(s) } });
        this.fullRefresh('night face');
        this.log('NIGHT on · frontlight off · data redraws paused · clock only');
      } else this.log('NIGHT paused · dashboard visible');
    }
    this.prevNight = n;
  }
  componentWillUnmount() { clearInterval(this.clockT); clearInterval(this.tickT); clearTimeout(this.dirtyT); this.timers.forEach(clearTimeout); this.debounce.clear(); }

  later(fn: () => void, ms: number) { this.timers.push(setTimeout(fn, ms)); }
  hourOf(s: EmuState) { return s.simHour == null ? s.now.getHours() : s.simHour; }
  hour() { return this.hourOf(this.state); }
  hm(dt: Date) { return hm(dt); }
  nightHour(s: EmuState) { return isNightHour(this.hourOf(s), s.cfg.night); }
  nightActive(s: EmuState) { return this.nightHour(s) && !(s.peekUntil > s.now.getTime()) && !s.sleeping; }

  input() { this.lastInput = Date.now(); this.idleHomed = false; if (this.state.lightOut) this.setState({ lightOut: false }); }
  idleCheck() {
    const s = this.state; if (s.mode !== 'main' || s.sleeping || s.asleep) return;
    const idleMs = Date.now() - this.lastInput, idleMin = idleMs / 60000;
    if (!s.lightOut && !s.setup && lightTimedOut(idleMs, s.cfg.lightTimeout)) { this.setState({ lightOut: true }); this.log('IDLE ' + s.cfg.lightTimeout + ' s → front light off'); }
    if (s.cfg.standby && idleMin >= s.cfg.standby) { this.setState({ sleeping: true, menu: false }); this.fullRefresh('standby'); this.log('IDLE ' + s.cfg.standby + ' min → standby'); return; }
    const amb = !s.ambient && ambientDue({ idleMs, menu: !!s.menu, setup: !!s.setup }) && !this.nightActive(s);
    const home = s.screens.findIndex((x) => x.id === 'overview');
    if (s.cfg.returnHome && idleMin >= s.cfg.returnHome && !this.idleHomed && home >= 0 && (s.idx !== home || s.sub !== 0 || s.menu)) {
      this.idleHomed = true; if (amb) this.setState({ ambient: true }); this.goTo(home, 'IDLE ' + s.cfg.returnHome + ' min');
      return;
    }
    if (amb) { this.setState({ ambient: true }); this.partialRefresh('ambient', ['bar']); this.log('IDLE ' + AMBIENT_MS / 1000 + ' s → ambient · pager, battery, app label hidden'); }
    else if (s.ambient && idleMs < AMBIENT_MS && !this.nightActive(s)) { this.setState({ ambient: false }); this.partialRefresh('chrome', ['bar']); }
  }
  /** Top-bar parts shown now (core/ambient.ts): a page with a clock tile drops the bar clock in ambient. */
  chromeOf(s: EmuState): Chrome {
    const sc = s.setup ? null : s.screens[s.idx];
    const clockTile = !!sc && (sc.widgets.some((w) => w.type === 'clock') || (!s.ha.linked && !s.ha.revoked && sc.id === 'overview'));
    const c = chromeFor(s.ambient, this.battery, clockTile);
    return s.setup ? { ...c, pager: false } : c;   // setup: "Step N of 2" in the title instead (#183)
  }
  /** Ambient / light timeout (#220): the first touch or key (not Power) brings the chrome back and the light on, and does
   *  nothing else. True when it took the input. */
  wakeChrome(src: string): boolean {
    const s = this.state;
    if (s.mode !== 'main' || s.asleep || s.recovery.phase === 'confirm') return false;
    const night = this.nightActive(s);
    const light = lightWakeConsumes({ brightness: s.cfg.brightness, standby: s.sleeping, night, lightOut: s.lightOut, power: false });
    const chrome = s.ambient && !s.sleeping && !night;
    if (!light && !chrome) return false;
    this.setState({ ambient: false, lightOut: false });
    if (chrome) this.partialRefresh('chrome', ['bar']);
    this.log(src + (light ? ' → light on' : ' → chrome back') + ' (input consumed)');
    return true;
  }
  /** Night face: the time of the last data, only when it is stale (> 30 min); '' otherwise. */
  staleAt(s: EmuState): string { return s.lastUpdate && nightStale(s.now.getTime(), s.lastUpdate.getTime()) ? hm(s.lastUpdate) : ''; }

  // ---------- Power saving (ROBUSTNESS_PLAN Phase 3, src/core/power.ts) ----------
  powerInputs(s: EmuState, now = Date.now()): PowerInputs {
    const d = new Date(now);
    const auto = (['off', 'notify', 'night'].includes(s.ota.auto) ? s.ota.auto : 'notify') as OtaAuto;
    return {
      nowEpoch: Math.floor(now / 1000), localSec: this.hourOf(s) * 3600 + d.getMinutes() * 60 + d.getSeconds(),
      powerSave: s.cfg.powerSave, wakeEvery: s.cfg.wakeEvery, night: s.cfg.night, peeking: s.peekUntil > now, standby: s.sleeping,
      charging: s.usb && this.battery < 100, usb: s.usb, chargedAgoMin: null, voltage: null, battery: this.battery,
      otaPendingVerify: s.ota.pendingVerify, otaBusy: s.mode === 'updating', otaAuto: auto, otaDue: !!s.ota.avail && auto === 'night',
      setup: !!s.setup, msSinceApi: this.lastApi === null ? null : now - this.lastApi,
      live: this.liveNow(now), glanceFails: this.rtc.fails, armBootsLeft: this.armLeft,
    };
  }
  /** Live mode (glance): a key press / touch within `liveMin` minutes, or a key held through the boot screen. */
  liveNow(now = Date.now()): boolean { return liveNow(now - this.lastInput, this.state.cfg.liveMin) || now < this.holdLiveUntil; }
  /** Clock tiles of a state: the time alone never wakes the panel in glance. */
  clockKeys(s: EmuState): string[] { const sc = s.screens[s.idx]; return sc && !s.setup && !s.menu ? sc.widgets.map((w, i) => (w.type === 'clock' ? 't' + i : '')).filter(Boolean) : []; }
  glanceSnap(s: EmuState): Snapshot { return snapshotOf(this.regions(s)); }
  /** Glance timer wake (core/glance.ts): Wi-Fi + one fetch of the visible entities, compare with the RTC snapshot,
   *  full refresh only when a visible value changed, then sleep again. No boot screen; touch stays off. */
  glanceWake() {
    const s = this.state; const a = s.asleep; if (!a) return;
    const now = Date.now();
    const ok = !!s.wifi.connected && s.ha.linked && !s.ha.revoked && !s.paused;
    let next = s; let changed: string[] = [];
    if (ok) { next = { ...s, ...this.dataPatch(s) }; changed = snapshotDiff(this.rtc.snap, this.glanceSnap(next), this.clockKeys(next)); }
    const g = glanceStep({ ok, changed, hadSnapshot: this.rtc.snap !== null, fails: this.rtc.fails, drawnOffline: this.rtc.drawnOffline, minSinceDraw: (now - this.rtc.drawnAt) / 60000 });
    this.rtc = { ...this.rtc, fails: g.fails, drawnOffline: g.drawnOffline };
    this.log('TIMER → glance wake · ' + (ok ? (changed.length ? changed.length + ' region(s) changed' : 'values unchanged') : 'Home Assistant unreachable (' + g.fails + ' in a row)') + ' · ' + g.reason);
    if (g.redraw) {
      const patch: Partial<EmuState> = ok ? { d: next.d, lastUpdate: new Date(), offline: false } : { offline: true };
      this.setState({ ...patch, asleep: { ...a, clock: this.clockText(s) } } as EmuState);
      this.fullRefresh('glance: ' + g.reason);
      this.rtc = { ...this.rtc, snap: this.glanceSnap({ ...s, ...patch } as EmuState), drawnAt: now };
    } else this.log('glance · no refresh');
    this.glanceSleep(true);
  }
  /** Back to sleep after a glance wake (or into it from live mode). */
  glanceSleep(fromWake: boolean) {
    const s = this.state; const now = Date.now();
    const d = powerDecision(this.powerInputs(s, now));
    if (!d.deepSleepNow) { this.setState({ asleep: null }); this.log('POWER stays awake (' + d.reason + ')'); return; }
    const wakeAt = d.wakeAtEpoch === null ? null : d.wakeAtEpoch * 1000;
    if (!fromWake) { this.rtc = { ...this.rtc, snap: this.glanceSnap(s), drawnAt: now }; }
    this.setState({ asleep: { wakeAt, clock: s.asleep?.clock ?? this.clockText(s), wasStandby: s.sleeping, glance: d.reason === 'glance' }, menu: false });
    this.log('POWER deep sleep (' + d.reason + ') · ' + (wakeAt ? 'timer wake ' + hm(new Date(wakeAt)) : 'Power key or charger only') + ' · panel keeps the dashboard');
  }
  powerTick() {
    const s = this.state; const now = Date.now();
    if (s.asleep) { if (s.asleep.wakeAt !== null && now >= s.asleep.wakeAt) { if (s.asleep.glance) this.glanceWake(); else this.wakeUp('TIMER'); } return; }
    if (s.mode !== 'main' || now - this.lastInput < AWAKE_MIN_MS) return;
    const d = powerDecision(this.powerInputs(s, now));
    if (!d.deepSleepNow) return;
    if (d.reason === 'glance') { this.glanceSleep(false); return; }
    const wakeAt = d.wakeAtEpoch === null ? null : d.wakeAtEpoch * 1000;
    this.setState({ asleep: { wakeAt, clock: this.clockText(s), wasStandby: s.sleeping }, menu: false });
    this.fullRefresh('asleep');
    this.log('POWER deep sleep (' + d.reason + ') · ' + (wakeAt ? 'timer wake ' + hm(new Date(wakeAt)) : 'Power key or charger only') + ' · Wi-Fi off, API unreachable');
  }
  /** Timer, Power / Right key or charger. A deep-sleep wake is a reset: boot screen, Wi-Fi + HA, full refresh. */
  wakeUp(src: string) {
    const a = this.state.asleep; if (!a) return;
    this.setState({ asleep: null });
    this.log(src + ' → wake from deep sleep (reset)');
    this.boot(this.tt('connecting'), () => { if (src === 'TIMER' && a.wasStandby) { this.setState({ sleeping: true }); this.fullRefresh('standby'); } });
  }
  /** Touch can't wake (rail off in deep sleep), nor Left / Home (not wake sources). True = the input was swallowed. */
  asleepIgnores(src: string): boolean {
    if (!this.state.asleep) return false;
    this.log(src + ' ignored · asleep (only Power, Right or the charger wake it)'); return true;
  }
  clockText(s: EmuState) { const h = this.hourOf(s); return (s.cfg.clock === '12' ? String(h % 12 || 12) : pad(h)) + ':' + pad(s.now.getMinutes()); }
  setUsb(on: boolean) {
    this.setState({ usb: on }); this.log('SIM USB ' + (on ? 'plugged · external power' : 'unplugged · on battery'));
    if (on) this.wakeUp('CHARGER');
  }

  // ---------- Web console, device side (called through DeviceApi, see ./emulatorApi.ts) ----------
  /** HA state of every entity the picker lists (GET /ha/entities `state`, #84): mock sensors in their HA unit (W, kWh). */
  entityStates(): Record<string, string> {
    const s = this.state; const d = this.derive(s.d, s); const out: Record<string, string> = { ...s.ent };
    const nf = numFormat(); setNumFormat('point');   // HA states carry a decimal point, whatever the display shows (#110)
    try { Object.keys(ENT).forEach((id) => { const r = ENT[id].get(d); out[id] = r.u === 'kW' ? String(Math.round(Number(r.v) * 1000)) : String(r.v); }); } finally { setNumFormat(nf); }
    out[GAUGE_DEFAULT_ENTITY] = String(Math.round(d.soc));
    LIGHT_LIST.forEach((l) => { out['light.' + l.id] = s.d.lights[l.id].on ? 'on' : 'off'; });
    ZONE_LIST.forEach((z) => { out['climate.' + z.id] = String(d.zones[z.id].cur); });   // the list shows a climate's temperature (#161)
    return out;
  }
  /** GET /screens/{id}/values (#122, console Values view): each tile's main value as the display draws it, in widget
   *  order; '' = no single value (lists, charts, settings: the console keeps the name). null = unknown id. */
  tileValues(id: string): string[] | null {
    const s = this.state; const sc = s.screens.find((x) => x.id === id); if (!sc) return null;
    const d = this.derive(s.d, s); const h = this.hourOf(s); const min = s.simHour == null ? s.now.getMinutes() : 0;
    const clock = (s.cfg.clock === '12' ? String(h % 12 || 12) : pad(h)) + ':' + pad(min);
    const lg = this.lang(s);
    return sc.widgets.map((w, i) => {
      if (w.type === 'clock') return clock;
      if (w.type === 'zoneList') {   // #161: "3 of 9 heating" / "4 of 9 lights on" instead of ''
        const zs = pickZones(ZONE_LIST.slice(0, s.zoneCount), w);
        return zs.length ? tr(lg, 'nOfHeating', zs.filter((z) => d.zones[z.id].set > d.zones[z.id].cur + 0.05).length, zs.length) : '—';
      }
      if (w.type === 'lightList') {
        const ids = pickLights(LIGHT_GROUPS, w).flatMap((g) => g.ids);
        return ids.length ? tr(lg, 'lightsOnOf', ids.filter((id) => d.lights[id].on).length, ids.length) : '—';
      }
      if (!['stat', 'price', 'gauge', 'thermo', 'switch'].includes(w.type)) return '';
      // an HA entity with no value: the word, not "—" (#86); logical ids and the light list have their own sources
      const id = typeof w.entity === 'string' ? w.entity : '';
      const st = id && !ENT[id] && id !== GAUGE_DEFAULT_ENTITY && !(domainOf(id) === 'light' && LIGHT[id.slice(6)]) ? s.ent[id] : undefined;
      if (st === 'unavailable' || st === 'unknown') return tr(lg, st === 'unavailable' ? 'gapUnavailable' : 'gapUnknown');
      const v = this.vm(w, d, s, i);
      if (w.type === 'stat') return v.value === '—' || !v.unit ? String(v.value) : v.value + ' ' + v.unit;
      if (w.type === 'price') return currency() + ' ' + v.value;
      if (w.type === 'gauge') return v.value === '—' ? '—' : v.pct + '%';
      if (w.type === 'thermo') return v.value + '°';
      return String(v.value);   // switch: On / Off / 40% (dimmable light) / —
    });
  }

  /** What GET /api/v1/console/state returns. Throws while the browser can't reach the display. */
  snapshot(): DeviceSnapshot {
    const s = this.state;
    // Before Wi-Fi the display is not on the home network: the browser can't reach it (unless a phone joined its setup hotspot).
    if (s.mode === 'boot' && !s.wifi.connected) throw new DeviceUnreachableError();
    if (s.asleep) throw new DeviceUnreachableError();   // deep sleep: Wi-Fi off
    if (s.mode === 'off') throw new DeviceUnreachableError();   // turned off (#258)
    if (s.setup === 'wifi' && s.wifi.view !== 'phone') throw new DeviceUnreachableError();
    const tok = (k: StoredToken): TokenInfo => ({ id: k.id, name: k.name, scope: k.scope, created: k.created, last: k.last, masked: k.masked });
    return {
      name: s.name, firmware: s.ota.fw, battery: this.battery, ip: s.wifi.connected ? '192.168.1.42' : null, hostname: HOST,
      setup: s.setup, softAp: s.setup === 'wifi' && s.wifi.view === 'phone',
      wifi: { connected: s.wifi.connected, saved: s.wifi.saved },
      networks: NETWORKS.map(({ ssid, rssi, secure }) => ({ ssid, rssi, secure })),
      // Once linked, the HA address and account are for a signed-in console only (issue #37).
      // mDNS (mocked) always finds homeassistant.local:8123; an address typed on the link page is "Home Assistant at …" (#54).
      language: s.ha.linked || s.ha.revoked ? s.haLang : null,
      ha: { linked: s.ha.linked, revoked: s.ha.revoked, ...(s.session.signedIn || !s.ha.linked ? { server: s.ha.server, user: s.ha.user, discovered: [MDNS_HA] } : { server: '', user: '', discovered: [] }) },
      offline: s.offline, session: { signedIn: s.session.signedIn, user: s.session.signedIn ? s.ha.user : '', admin: true },
      entityGaps: s.session.signedIn && s.ha.linked ? entityGaps(s.screens, (id) => s.ent[id]) : {},
      ...userConfig({ apps: s.apps, screens: s.screens }), configRev: s.configRev, installId: s.installId,
      tokens: s.session.signedIn ? s.tokens.map(tok) : [],
    };
  }
  webWifiConnect(ssid: string): Promise<void> {
    const net: Partial<(typeof NETWORKS)[number]> = NETWORKS.find((n) => n.ssid === ssid) || {};
    this.log('WEB POST /api/v1/wifi {"ssid":"' + ssid + '"} · device tries to join', 'ha');
    return new Promise((resolve, reject) => this.later(() => {
      if (net.failsWith) { this.log('WIFI auth failed · ' + ssid, 'warn'); reject(new ApiError(401, 'Wrong password. Try again.')); return; }
      const st = this.state;
      this.setState({ wifi: { ...st.wifi, connected: ssid, saved: st.wifi.saved.includes(ssid) ? st.wifi.saved : [...st.wifi.saved, ssid], view: 'list' },
        offline: !st.ha.linked, setup: st.setup === 'wifi' ? 'web' : st.setup });
      this.log('WIFI connected · ' + ssid + (st.setup === 'wifi' ? ' · SoftAP off · your phone rejoins your home Wi-Fi; continue at ' + HOST : ''), 'ha');
      if (st.setup === 'wifi') this.fullRefresh('setup: browser'); else this.partialRefresh('wifi', ['bar']);
      resolve();
    }, 1600));
  }
  webHaSignIn(src: string, haUrl?: string): Promise<void> {
    if (haUrl && !this.state.ha.linked) {   // no network in the browser emulator: only the address rules, no probe
      const a = parseHaAddress(haUrl);
      if ('error' in a) { this.log('WEB POST /api/v1/auth/ha/start · 422 ' + a.error, 'warn'); return Promise.reject(new ApiError(422, a.error)); }
      this.setState((st) => ({ ha: { ...st.ha, server: a.url.replace(/^http:\/\//, '') } }));
    }
    const st = this.state;
    this.log('WEB ' + src + ' → 302 http://' + st.ha.server + '/auth/authorize?client_id=http://' + HOST + '/&redirect_uri=http://' + HOST + '/auth/callback', 'ha');
    return new Promise((resolve) => this.later(() => {
      const s2 = this.state; const linking = !s2.ha.linked;
      const home = Math.max(0, s2.screens.findIndex((x) => x.id === 'overview'));
      this.setState({ ha: { ...s2.ha, linked: true, revoked: false, view: 'status' }, offline: !s2.wifi.connected,
        setup: null, idx: s2.setup ? home : s2.idx, sub: s2.setup ? 0 : s2.sub, session: { signedIn: true } });
      if (linking) this.log('HA code → key stored on device (display linked) · same sign-in opens a web session', 'ha');
      this.log('WEB session for "' + s2.ha.user + '" (Home Assistant admin) · cookie HttpOnly, 12 h', 'ha');
      if (s2.setup) this.log('SETUP done · energy from Energy dashboard, ' + s2.zoneCount + ' tado rooms, ' + LIGHT_LIST.length + ' lights, 4 routes', 'ha');
      if (linking || s2.setup) { this.fullRefresh(s2.setup ? 'welcome · live data' : 'linked · live data'); setTimeout(() => this.tick(false), 0); }
      resolve();
    }, 1800));
  }
  webFinish() { this.setState({ onboard: null, offline: false, session: { signedIn: true } }); this.boot('Setup complete'); this.log('WEB setup finished → configurator'); }
  webSignOut() { this.setState({ session: { signedIn: false } }); this.log('WEB signed out'); }
  webHaUnlink() { this.log('WEB unlink Home Assistant · key deleted from the display', 'warn'); this.setState((st) => ({ ha: { ...st.ha, linked: false, revoked: false }, offline: true, session: { signedIn: false } })); this.fullRefresh('not linked'); }
  createToken(name: string, scope: Scope): { token: TokenInfo; secret: string } {
    const sec = newTokenSecret();
    const nm = (name || 'Token').trim() || 'Token';
    const tok: StoredToken = { id: 'tok_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name: nm, scope, created: hm(new Date()), last: 'never', hash: hashToken(sec), masked: maskToken(sec) };
    // The user copies the secret to the laptop (that's what the terminal's `export X4_TOKEN=…` uses).
    this.setState((st) => ({ tokens: [...st.tokens, tok], term: { ...st.term, known: { ...st.term.known, [tok.hash]: sec } } }));
    this.log('API token "' + nm + '" created (' + (scope === 'rw' ? 'read & write' : 'read only') + ') · only its hash is stored');
    const { hash: _h, ...info } = tok;
    return { token: info, secret: sec };
  }
  revokeToken(id: string) {
    const k = this.state.tokens.find((x) => x.id === id); if (!k) return;
    this.setState((st) => ({ tokens: st.tokens.filter((x) => x.id !== id) }));
    this.log('API token "' + k.name + '" revoked', 'warn');
  }

  pushConfig(cfg: Config, src: string) {
    const s = this.state; const curId = (s.screens[s.idx] || {}).id; const dev = withSettings(cfg); const screens = dev.screens;
    const idx = Math.max(0, screens.findIndex((x) => x.id === curId));
    this.setState((st) => ({ apps: dev.apps, screens, idx, sub: 0, menu: false, configRev: st.configRev + 1 }));
    this.fullRefresh('new config');
    this.log('API PUT /api/v1/config · 200 · ' + cfg.screens.length + ' screens · ' + src, 'ha');
  }

  /** GET /api/v1/settings (display part + name). */
  settings(display = cfgToDisplay(this.state.cfg), name = this.state.name, entities = this.state.entities, ota: { auto: string; channel: OtaChannel } = this.state.ota, tz = this.state.tz): DeviceSettings {
    // Mock HA: every logical id exists under its own name (identity) unless overridden.
    const src: Record<string, string> = {};
    for (const l of LOGICAL) {
      const o = entities[l.id];
      if (o) { const r = splitRef(o); src[l.id] = formatSource({ ha: r.ha, minus: '', negate: r.negate, why: 'override' }); }
      else if (this.state.ha.linked) src[l.id] = formatSource({ ha: l.id, minus: '', negate: false, why: 'identity' });
    }
    // tz (#147): the sim HA is in Europe/Amsterdam; the browser draws the clock in its own zone either way
    return { display: { ...display, otaAuto: ota.auto as OtaAutoMode }, name, ota_channel: ota.channel, tz, tz_ha: SIM_HA_TZ, tz_active: tzFor(tz, SIM_HA_TZ) ?? DEFAULT_TZ,
      entities: { ...entities }, entity_sources: src };
  }
  /** PUT /api/v1/settings: same rules as the device; applied like the device's own Settings tiles. */
  putSettings(patch: SettingsPatch): DeviceSettings | string {
    if (!patch || typeof patch !== 'object') return 'expected a JSON object';
    const ke = settingsPutError(patch as Record<string, unknown>); if (ke) return ke;
    if (patch.ota_channel !== undefined && patch.ota_channel !== 'stable' && patch.ota_channel !== 'beta') return 'ota_channel must be stable or beta';
    const display = { ...cfgToDisplay(this.state.cfg), ...(patch.display || {}) };
    const name = patch.name ?? this.state.name;
    const err = displayError(display) || nameError(name); if (err) return err;
    const entities = patch.entities === undefined ? this.state.entities : mergeEntities(this.state.entities, patch.entities);
    if (typeof entities === 'string') return entities;
    const old = this.state.cfg; const cfg: Cfg = { ...old, ...displayToCfg(display) };
    const changed = (Object.keys(cfg) as (keyof Cfg)[]).filter((k) => cfg[k] !== old[k]);
    if (changed.length) {
      this.log('WEB PUT /api/v1/settings · ' + changed.map((k) => k + '=' + cfg[k]).join(', '), 'ha');
      // A new look is one full refresh; everything else goes through the region diff as before.
      if (changed.some(isLookKey)) { this.setState({ cfg }); this.fullRefresh('display style'); } else this.commit({ cfg }, 'setting');
    }
    if (name !== this.state.name) this.setState({ name });
    // Settings › Updates (#159): the same state the device's Updates page steps
    const o = this.state.ota; const auto = display.otaAuto ?? o.auto; const channel = patch.ota_channel ?? o.channel;
    if (auto !== o.auto || channel !== o.channel) {
      this.log('WEB PUT /api/v1/settings · ota ' + channel + ' / ' + auto, 'ha');
      this.setOta(channel !== o.channel ? { channel, auto, status: 'idle', avail: null, msg: '', err: null } : { auto }, channel !== o.channel ? 'channel' : 'setting');
    }
    if (patch.entities !== undefined) {
      this.log('WEB PUT /api/v1/settings · entities ' + (Object.entries(patch.entities).map(([k, v]) => k + '=' + (v || '(auto)')).join(', ') || '{}'), 'ha');
      this.setState({ entities });
    }
    const tz = patch.tz ?? this.state.tz;
    if (tz !== this.state.tz) { this.log('WEB PUT /api/v1/settings · tz ' + (tz || '(Home Assistant)'), 'ha'); this.setState({ tz }); }
    if (cfg.interval !== old.interval) setTimeout(() => this.startTick(), 0);
    return this.settings(display, name, entities, { auto, channel }, tz);
  }

  // ---------- Laptop CLI ----------
  termVm(s: EmuState) {
    const T = s.term; const hasTok = s.tokens.length > 0;
    const c = (label: string, cmd: string, hi?: boolean) => ({ label, bg: hi ? '#2f3a2f' : 'transparent', fg: hi ? '#cfe8cf' : '#d9d6ce', run: () => this.termRun(cmd) });
    return { lines: T.lines, cmds: [c('export X4_TOKEN=…', 'export', hasTok && !T.exported), c('curl …/status', 'status'), c('curl …/config -o screens.yaml', 'get', !!T.exported && !T.file), c('vim screens.yaml', 'edit', !!T.file), c('curl -X PUT …/config', 'put', !!T.file), c('clear', 'clear')] };
  }
  term(lines: TermLine[], patch?: Partial<EmuState['term']>) {
    const t = this.state.term; const all = [...t.lines, ...lines].slice(-14);
    this.setState({ term: { ...t, ...(patch || {}), lines: all } });
  }
  termRun(cmd: string) {
    const s = this.state; const T = s.term; const toks = s.tokens;
    const live = findToken(toks, T.exported);
    const auth = (need: 'read' | 'write') => { const e = authorize(toks, T.exported, need); return e ? { code: e.code, body: JSON.stringify({ error: e.error }) } : null; };
    const used = () => { if (live) this.setState((st) => ({ tokens: st.tokens.map((k) => (k.id === live.id ? { ...k, last: hm(new Date()) } : k)) })); };
    const P = (t: string) => ({ t: '$ ' + t, c: '#d9d6ce' }), O = (t: string) => ({ t, c: '#a9d1a9' }), E = (t: string) => ({ t, c: '#e5a58f' });
    if (cmd === 'export') {
      const k = toks[toks.length - 1]; if (!k) { this.term([P('export X4_TOKEN=…'), E('No token yet: create one in the web console › Advanced › API')]); return; }
      const secret = T.known[k.hash];
      this.term([P('export X4_TOKEN=' + secret.slice(0, 10) + '…')], { exported: secret }); return;
    }
    if (cmd === 'status') {
      const line = 'curl -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/status'; const a = auth('read');
      if (a || !live) { this.term([P(line), E('HTTP ' + a!.code + ' ' + a!.body)]); this.log('API GET /api/v1/status · ' + a!.code, 'warn'); return; }
      used(); this.log('API GET /api/v1/status · 200 · token "' + live.name + '"', 'ha');
      this.term([P(line), O('{"name":"Living room display","firmware":"' + s.ota.fw + '","battery":' + this.battery + ',"wifi":"' + (s.wifi.connected || '') + '","home_assistant":"' + (s.ha.linked ? 'linked' : 'not linked') + '","screens":' + s.screens.length + '}')]); return;
    }
    if (cmd === 'get') {
      const line = 'curl -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/config -o screens.yaml'; const a = auth('read');
      if (a || !live) { this.term([P(line), E('HTTP ' + a!.code + ' ' + a!.body)]); return; }
      used(); const y = toYaml(userConfig({ apps: s.apps, screens: s.screens })); this.log('API GET /api/v1/config · 200 · token "' + live.name + '"', 'ha');
      this.term([P(line), O('saved screens.yaml · ' + y.split('\n').length + ' lines, ' + s.screens.length + ' screens')], { file: y }); return;
    }
    if (cmd === 'edit') {
      if (!T.file) { this.term([P('vim screens.yaml'), E('screens.yaml: no such file (download it first)')]); return; }
      const cfg = parseYaml(T.file); const sc = cfg.screens;
      if (sc.find((x) => x.id === 'morning')) { this.term([P('vim screens.yaml'), O('screens.yaml already has a “Morning” screen')]); return; }
      const at = Math.max(0, sc.findIndex((x) => x.id === 'overview')) + 1;
      sc.splice(at, 0, { id: 'morning', app: cfg.apps[0].id, title: 'Morning', widgets: [{ type: 'clock', cs: 2 }, { type: 'price' }, { type: 'stat', entity: 'sensor.living_temperature' }, { type: 'route', route: 'arn_nm', cs: 2 }, { type: 'route', route: 'car', cs: 2 }] });
      this.term([P('vim screens.yaml'), O('edited: + screen “Morning” (clock, price, inside temp, train, car)')], { file: toYaml(cfg) }); return;
    }
    if (cmd === 'put') {
      const line = 'curl -X PUT -H "Authorization: Bearer $X4_TOKEN" -H "Content-Type: application/yaml" --data-binary @screens.yaml $X4/api/v1/config';
      if (!T.file) { this.term([P(line), E('curl: (26) Failed to open/read local data from file')]); return; }
      const a = auth('write'); if (a || !live) { this.term([P(line), E('HTTP ' + a!.code + ' ' + a!.body)]); this.log('API PUT /api/v1/config · ' + a!.code, 'warn'); return; }
      let sc: Config; try { sc = parseYaml(T.file); } catch (err: any) { this.term([P(line), E('HTTP 422 {"error":"line ' + err.line + ': ' + err.msg + '"}')]); return; }
      used(); this.term([P(line), O('HTTP 200 {"status":"applied","screens":' + sc.screens.length + '}')]);
      this.pushConfig(sc, 'token "' + live.name + '" from 192.168.1.23'); return;
    }
    if (cmd === 'clear') { this.setState({ term: { ...T, lines: [] } }); }
  }

  // QR → phone → HA sign-in → one-time code → key. Shared by the Home link card and Settings › Home Assistant.
  runHaLink() {
    const ha = this.state.ha; if (ha.running) return;
    const L = (m: string) => this.log(m, 'ha');
    const step = (n: number, fn: () => void) => { this.setState({ ha: { ...this.state.ha, stage: n } }); this.partialRefresh('link step', ['t0', 't1']); fn(); };
    this.setState({ ha: { ...ha, running: true, stage: 0 } });
    this.later(() => step(1, () => L('Phone GET /link?p=' + ha.pair + ' · pairing code ok')), 1000);
    this.later(() => step(2, () => { L('mDNS _home-assistant._tcp → http://' + ha.server); L('Phone 302 → /auth/authorize?client_id=http://' + HOST + '/&redirect_uri=http://' + HOST + '/auth/callback&state=9c1e…'); }), 2400);
    this.later(() => step(3, () => { L('302 → ' + HOST + '/auth/callback?code=•••&state=9c1e… · state ok'); L('POST /auth/token grant_type=authorization_code → access_token (30 min) + refresh_token'); }), 4400);
    this.later(() => {
      step(4, () => L('refresh_token saved in encrypted storage · WebSocket auth_ok as "' + ha.user + '"'));
      this.later(() => {
        this.setState({ ha: { ...this.state.ha, view: 'status', linked: true, revoked: false, running: false, stage: 0 }, offline: !this.state.wifi.connected });
        this.fullRefresh('linked · live data'); setTimeout(() => this.tick(false), 0);
      }, 900);
    }, 5800);
  }

  // ---------- Hardware-key factory reset (src/core/recovery.ts, issue #21) ----------
  /** One key sample. True when the reset screen took it (it never reaches nav/power/touch). */
  recoveryKeys(keys: number, src: string): boolean {
    if (this.state.recovery.phase !== 'confirm') return false;
    const now = Date.now();
    let r = recoveryStep(this.state.recovery, now, keys);
    if (r.action === 'none') r = recoveryStep(r.state, now, 0);   // a click: press, then release
    this.log(src + ' · reset screen');
    this.recoveryDone(r.state, r.action);
    return true;
  }
  recoveryDone(state: RecoveryState, action: RecoveryAction) {
    this.setState({ recovery: state });
    if (action === 'show') {
      this.log('RESET screen · Right erases, any other key cancels, ' + RESET_CONFIRM_MS / 1000 + ' s timeout', 'warn');
      this.fullRefresh('factory reset?');
      const since = state.since;
      this.later(() => { const s = this.state.recovery; if (s.phase === 'confirm' && s.since === since) { const r = recoveryStep(s, since + RESET_CONFIRM_MS, 0); this.recoveryDone(r.state, r.action); } }, RESET_CONFIRM_MS);
    } else if (action === 'reset') { this.log('BTN_NEXT confirms · FACTORY RESET', 'warn'); this.factoryReset(); }
    else if (action === 'restart') { this.log('BTN_POWER+BTN_PREV ' + RESTART_HOLD_MS / 1000 + ' s · restart', 'warn'); this.boot(this.tt('bootRestarting')); }
    else if (action === 'cancel' || action === 'timeout') { this.log('RESET screen ' + (action === 'timeout' ? 'timed out' : 'cancelled')); this.fullRefresh('reset cancelled'); }
  }
  /** Simulation: Power + Right held for 5 s, then both released (the device samples the keys every ~20 ms). */
  holdResetSim() {
    const t = Date.now();
    this.log('BTN_POWER + BTN_NEXT held ' + RESET_HOLD_MS / 1000 + ' s, released');
    let r = recoveryStep(this.state.recovery, t - RESET_HOLD_MS, KEY_POWER | KEY_RIGHT);
    r = recoveryStep(r.state, t, KEY_POWER | KEY_RIGHT);
    if (r.action !== 'show') { this.log('combo ignored', 'warn'); this.setState({ recovery: r.state }); return; }
    this.recoveryDone(recoveryStep(r.state, t, 0).state, 'show');
  }
  /** Simulation: Power + Left held for 5 s (issue #226) → "Restarting…" → boot, same as Settings › Restart. */
  holdRestartSim() {
    const t = Date.now();
    let r = recoveryStep(this.state.recovery, t - RESTART_HOLD_MS, KEY_POWER | KEY_LEFT);
    r = recoveryStep(r.state, t, KEY_POWER | KEY_LEFT);
    if (r.action !== 'restart') { this.log('combo ignored', 'warn'); this.setState({ recovery: r.state }); return; }
    this.recoveryDone(recoveryStep(r.state, t, 0).state, 'restart');
  }
  /** Simulation: Power alone held 2 s (#258) → "Turned off" face, then off. Power turns it on again (a boot). */
  holdPowerSim() {
    const t = Date.now();
    if (this.state.mode === 'updating') { this.log('BTN_POWER held · ignored while updating', 'warn'); return; }
    let r = recoveryStep(this.state.recovery, t - POWER_OFF_HOLD_MS - 1, 0);   // Power was up before the hold
    r = recoveryStep(r.state, t - POWER_OFF_HOLD_MS, KEY_POWER);
    r = recoveryStep(r.state, t, KEY_POWER);
    if (r.action !== 'off') { this.log('hold ignored', 'warn'); this.setState({ recovery: r.state }); return; }
    this.setState({ recovery: recoveryStep(r.state, t, 0).state });
    this.powerOff();
  }
  powerOff() {
    this.log('BTN_POWER held ' + POWER_OFF_HOLD_MS / 1000 + ' s · turned off', 'warn');
    this.setState({ mode: 'off', sleeping: false, asleep: null, menu: false, ambient: false });
    this.fullRefresh('turned off');
    this.log('POWER off by Power hold · latch released (Wi-Fi and the API are gone; the panel keeps the face)');
  }
  /** Simulation: the boot ring shows ≥ 3 crash resets in a row → reboot straight into the reset screen. */
  crashLoopSim() {
    this.log('SIM crash loop · boot ring PANIC ×' + CRASH_LOOP_BOOTS + ' → reset screen offered at boot', 'warn');
    this.boot();
    this.recoveryDone(recoveryOffer(Date.now()), 'show');
  }

  // Factory reset → first-run setup
  factoryReset() {
    this.log('FACTORY RESET · NVS erased (Wi-Fi, Home Assistant token, settings)', 'warn');
    this.setState((st) => ({ sleeping: false, asleep: null, menu: false, offline: true, resetArm: false, onboard: null,
      wifi: { ...st.wifi, connected: null, saved: [], view: 'list', pw: '', msg: '' }, ha: { ...st.ha, linked: false, revoked: false, view: 'status', stage: 0, running: false },
      session: { signedIn: false }, tokens: [], entities: {}, installId: newInstallId() }));
    this.boot(tr(this.lang(this.state), 'starting'));
    this.log('SoftAP "HA-Paper-Setup" up · captive portal at 192.168.4.1');
  }
  /** Simulation › Installed: already on Wi-Fi "HomeNet", HA linked, console signed in → boots straight to Home. */
  installedSim() {
    this.log('SIM installed · Wi-Fi HomeNet · Home Assistant linked · web console signed in', 'warn');
    this.setState((st) => ({ sleeping: false, asleep: null, menu: false, offline: false, resetArm: false, onboard: null, setup: null,
      wifi: { ...st.wifi, connected: 'HomeNet', saved: st.wifi.saved.includes('HomeNet') ? st.wifi.saved : [...st.wifi.saved, 'HomeNet'], view: 'list', pw: '', msg: '' },
      ha: { ...st.ha, linked: true, revoked: false, view: 'status', stage: 0, running: false },
      session: { signedIn: true } }));
    this.boot(this.tt('connectingHa'));
  }
  onboardSim() {
    if (!this.state.onboard || this.state.onboard.step > 0) return;
    const step = (n: number, fn: () => void, ms: number) => this.later(() => { this.setState({ onboard: { step: n } }); this.partialRefresh('setup step'); fn(); }, ms);
    step(1, () => { this.setState({ wifi: { ...this.state.wifi, connected: 'HomeNet', saved: ['HomeNet'] } }); this.log('Phone → Wi-Fi HomeNet · device joined, SoftAP off', 'ha'); }, 1200);
    step(2, () => { this.setState({ ha: { ...this.state.ha, linked: true } }); this.log('mDNS found homeassistant.local · phone signed in · refresh token stored', 'ha'); }, 2600);
    step(3, () => { this.log('energy/get_prefs → solar, battery, grid sensors · tado zones · light areas · travel sensors', 'ha'); }, 4000);
    this.later(() => { this.setState({ onboard: null, offline: false }); this.boot('Setup complete'); }, 5200);
  }

  log(msg: string, kind?: 'ha' | 'eink' | 'warn') {
    if (/^(BTN_|KEY_|TOUCH|SWIPE)/.test(msg)) this.input();
    const n = new Date();
    const sp = logSplit(msg);
    this.logs = logPush(this.logs, n.getTime() - this.logsAt, Math.floor(n.getTime() / 1000), kind === 'warn' ? 'W' : 'I', sp.tag, sp.msg);
    const c = kind === 'ha' ? '#9fd0a8' : kind === 'eink' ? '#c9b98f' : kind === 'warn' ? '#e5a58f' : '#d9d6ce';
    this.setState((s) => ({ log: [{ t: hm(n) + ':' + pad(n.getSeconds()), msg, c }, ...s.log].slice(0, 80) }));
  }

  // ---------- e-ink ----------
  /** Clean (#197): one short flash, both RAM planes rewritten; grays back. Resets the scheduled and the nav clean. */
  fullRefresh(reason?: string) {
    this.lastFullMin = Math.floor(Date.now() / 60000);
    this.setState((s) => ({ flash: INK, fullCount: s.fullCount + 1, sinceFull: 0, navSinceClean: 0, dirty: [], bw: bwAfter(s.bw, { kind: 'full' }) }));
    this.later(() => this.setState({ flash: PAPER }), 140);
    this.later(() => this.setState({ flash: null }), 280);
    this.log('EPD clean refresh' + (reason ? ' (' + reason + ')' : ''), 'eink');
  }
  /** Navigation (#197): whole-frame fast refresh without a flash, B/W only (#212); every NAV_CLEAN-th one is a clean. */
  navRefresh(reason: string) {
    const s = this.state;
    const dec = decideNav({ navSinceClean: s.navSinceClean, sinceFull: s.sinceFull, clockKnown: true });
    if (dec.kind === 'clean') { this.fullRefresh(reason + ' · ' + dec.reason); return; }
    this.setState((st) => ({ fastCount: st.fastCount + 1, navSinceClean: dec.navSinceClean, sinceFull: dec.sinceFull, dirty: [], bw: bwAfter(st.bw, { kind: 'fast' }) }));
    this.log('EPD fast refresh (' + reason + ')', 'eink');
  }
  partialRefresh(reason: string, keys?: string[]) {
    const dec = decidePartial({ reason, sleeping: this.state.sleeping, night: this.nightActive(this.state), sinceFull: this.state.sinceFull, clockKnown: true });
    if (dec.kind === 'skip') { if (dec.why === 'night') this.log('night · redraw skipped (' + reason + ')'); return; }
    if (dec.kind === 'clean') { this.fullRefresh(dec.reason); return; }
    const since = dec.sinceFull;
    const k = keys || [];
    this.setState((s) => ({ partialCount: s.partialCount + 1, sinceFull: since, dirty: k }),
      () => { const rects = k.length ? this.dirtyRects() : []; this.setState((s) => ({ bw: bwAfter(s.bw, { kind: 'partial', rects }) })); });
    clearTimeout(this.dirtyT); this.dirtyT = setTimeout(() => this.setState({ dirty: [] }), 750);
    this.log('EPD partial (' + reason + (k.length ? ' · ' + k.length + ' region' + (k.length > 1 ? 's' : '') : '') + ')', 'eink');
  }
  /** Screen-px rects of the regions marked dirty right now (their `.dirty` markers, rendered even when hidden). */
  dirtyRects(): Rect[] {
    if (typeof document === 'undefined') return [];
    const scr = document.querySelector<HTMLElement>('[data-x4-screen]'); if (!scr) return [];
    const o = scr.getBoundingClientRect(); const k = SCREEN_W / (o.width || SCREEN_W);
    return [...scr.querySelectorAll<HTMLElement>('.dirty')].map((el) => { const r = el.getBoundingClientRect();
      return { x: Math.round((r.left - o.left) * k), y: Math.round((r.top - o.top) * k), w: Math.round(r.width * k), h: Math.round(r.height * k) }; });
  }
  keysOfType(type: string) { const sc = this.state.screens[this.state.idx]; return sc ? sc.widgets.map((w, i) => (w.type === type ? 't' + i : null)).filter((x): x is string => !!x) : []; }

  // Every redraw region on the current page: a tile, or for lists the header + each row.
  regions(s: EmuState): RegionMap {
    const out: RegionMap = {}; const sc = s.setup ? SETUP_SCREENS[s.setup] : s.screens[s.idx]; if (!sc || s.menu) return out;
    const d = this.derive(s.d, s);
    sc.widgets.forEach((w, i) => {
      const v = this.vm(w, d, s, i);
      if (v.isZoneList || v.isLightList) { out['h' + i] = v.summary; v.rows.forEach((r: any) => { if (r.key) out[r.key] = serializeRegion(r); }); }
      else if (v.isOta) { const { status, ...tile } = v; out['t' + i] = serializeRegion(tile); out['s' + i] = serializeRegion(status); }
      else out['t' + i] = serializeRegion(v);
    });
    return out;
  }
  // Apply a state change and redraw only the regions whose content changed.
  commit(patch: Partial<EmuState>, reason: string, quiet?: boolean) {
    const s = this.state; const next = { ...s, ...patch };
    const keys = changedRegions(this.regions(s), this.regions(next));
    this.setState(patch as EmuState);
    if (keys.length) this.partialRefresh(reason, keys);
    else if (!quiet) this.log(reason + ' · nothing visible changed · no redraw');
  }

  boot(msg?: string, then?: () => void) {
    this.input();
    this.setState({ mode: 'boot', sleeping: false, menu: false, peekUntil: 0, ambient: false, bootAt: new Date(), bootMsg: msg || tr(this.lang(this.state), this.state.wifi.connected && this.state.ha.linked ? 'connectingHa' : 'starting') });
    this.fullRefresh('boot');
    this.log('BOOT ' + this.osName + ' v' + this.state.ota.fw + ' · ws://[HA-HOST]:8123/api/websocket (mock)');
    this.later(() => {
      const st = this.state;
      // First install: no Wi-Fi → connect on the display; Wi-Fi but no Home Assistant → finish in the browser.
      const setup = !st.wifi.connected ? 'wifi' : !st.ha.linked && !st.ha.revoked ? 'web' : null;
      this.setState({ mode: 'main', idx: 0, sub: 0, setup, offline: setup ? true : st.offline }); this.tick(true);
      if (setup === 'wifi') { this.fullRefresh('setup: Wi-Fi'); this.log('SETUP no saved Wi-Fi · scan + SoftAP "HA-Paper-Setup" as fallback'); }
      else if (setup === 'web') { this.fullRefresh('setup: browser'); this.log('SETUP on ' + st.wifi.connected + ' · waiting for sign-in at http://' + HOST); }
      else { this.fullRefresh('home'); this.log('HA connected · subscribed to ' + (Object.keys(ENT).length + st.zoneCount + LIGHT_LIST.length) + ' entities', 'ha'); }
      if (then) then();
    }, 1600);
  }

  // ---------- Wi-Fi ----------
  setWifi(patch: Partial<EmuState['wifi']>, reason?: string) { this.commit({ wifi: { ...this.state.wifi, ...patch } }, reason || 'wifi', true); }
  wifiConnect(ssid: string, pw: string) {
    const net: Partial<(typeof NETWORKS)[number]> = NETWORKS.find((n) => n.ssid === ssid) || {};
    if (net.secure && pw.length < 8) { this.setWifi({ msg: this.tt('pwMin8') }, 'field'); return; }
    this.setState({ wifi: { ...this.state.wifi, view: 'connecting', target: ssid, msg: '' } }); this.navRefresh('wifi connecting');
    this.log('WIFI esp_wifi_connect("' + ssid + '")', 'ha');
    this.later(() => {
      if (net.failsWith) {
        this.log('WIFI auth failed · ' + ssid, 'warn');
        this.setState({ wifi: { ...this.state.wifi, view: 'pw', pw: '', msg: net.failsWith } }); this.fullRefresh('wifi password');
        return;
      }
      const saved = this.state.wifi.saved.includes(ssid) ? this.state.wifi.saved : [...this.state.wifi.saved, ssid];
      const inSetup = this.state.setup === 'wifi';
      this.setState({ wifi: { ...this.state.wifi, view: 'list', connected: ssid, saved, pw: '', msg: '' }, offline: !this.state.ha.linked, setup: inSetup ? 'web' : this.state.setup });
      this.fullRefresh(inSetup ? 'setup: browser' : 'wifi connected'); this.log('WIFI connected · ' + ssid + ' · credentials saved to NVS · mDNS ' + HOST + ' → 192.168.1.42', 'ha');
      if (inSetup) this.log('SETUP step 2 · open http://' + HOST + ' on your home network');
      setTimeout(() => this.tick(false), 0);
    }, 2200);
  }
  keyPress(ch: string) {
    const w = this.state.wifi;
    if (ch === 'BACK') return this.setWifi({ pw: w.pw.slice(0, -1), msg: '' }, 'field');
    if (ch === 'SHIFT') return this.setWifi({ kb: w.kb === 'upper' ? 'lower' : 'upper' }, 'keyboard');
    if (ch === 'NUMS') return this.setWifi({ kb: w.kb === 'nums' ? 'lower' : 'nums' }, 'keyboard');
    if (ch === 'OK') return this.wifiConnect(w.target, w.pw);
    if (w.pw.length >= 63) return;
    this.setWifi({ pw: w.pw + (ch === 'SPACE' ? ' ' : ch), msg: '', kb: w.kb === 'upper' ? 'lower' : w.kb }, 'field');
  }

  // ---------- OTA from GitHub Releases ----------
  setOta(patch: Partial<EmuState['ota']>, reason?: string) { this.commit({ ota: { ...this.state.ota, ...patch } }, reason || 'update status', true); }
  checkUpdate(src?: string) {
    const s = this.state; if (s.ota.status === 'checking') return;
    if (s.offline) { this.setOta({ status: 'error', err: 'network', msg: 'No network — try again later' }); this.log('OTA check failed · offline', 'warn'); return; }
    const url = s.ota.channel === 'beta' ? 'https://api.github.com/repos/' + REPO + '/releases?per_page=5' : 'https://api.github.com/repos/' + REPO + '/releases/latest';
    this.log((src || 'TOUCH') + ' → GET ' + url, 'ha');
    this.setOta({ status: 'checking', err: null, msg: '' });
    this.later(() => {
      const st = this.state; const rel = st.releases[st.ota.channel];
      // SIM "Next check" (#250): what the firmware maps a failed GitHub request to (core/otaStatus.ts otaErrOf)
      if (st.checkFail !== 'ok') { this.setOta({ status: 'error', err: st.checkFail, msg: SIM_CHECK_MSG[st.checkFail] }); this.log('OTA check failed · ' + SIM_CHECK_MSG[st.checkFail], 'warn'); return; }
      const has = newer(rel.version, st.ota.fw);
      this.setOta({ status: has ? 'available' : 'uptodate', avail: has ? { ...rel } : null, lastCheck: new Date(), msg: '', err: null });
      this.log(has ? 'OTA · v' + rel.version + ' available (' + rel.size + ' MB, firmware.bin + manifest.json)' : 'OTA · up to date (latest ' + rel.version + ')', 'ha');
    }, 1400);
  }
  install() {
    const s = this.state; const rel = s.ota.avail; if (!rel) return;
    const batt = this.battery;
    if (batt < 30) { this.setOta({ status: 'blocked', msg: this.tt('otaLowBatteryMsg', batt) }); this.log('OTA blocked · battery ' + batt + '% < 30%', 'warn'); return; }
    if (s.offline) { this.setOta({ status: 'error', msg: this.tt('noNetwork') }); return; }
    this.setState({ mode: 'updating', upd: { version: rel.version, pct: 0, step: this.tt('updDownloading') }, menu: false });
    this.fullRefresh('update screen');
    this.log('OTA start · GET github.com/' + REPO + '/releases/download/v' + rel.version + '/firmware.bin → ota_1 (streamed, not buffered)', 'ha');
    let pct = 0;
    const step = () => {
      pct += 10;
      this.setState((st) => ({ upd: { ...st.upd!, pct }, partialCount: st.partialCount + 1 }));
      if (pct % 50 === 0) this.log('EPD partial (progress ' + pct + '%)', 'eink');
      if (pct < 100) { this.later(step, 380); return; }
      this.setState((st) => ({ upd: { ...st.upd!, step: this.tt('updChecking') } }));
      this.later(() => {
        if (this.state.failMode === 'hash') {
          this.log('OTA abort · SHA-256 does not match manifest.json · ota_1 discarded', 'warn');
          this.setState({ mode: 'main', upd: null }); this.fullRefresh('update failed');
          this.setOta({ status: 'error', msg: this.tt('otaCorrupt') });
          return;
        }
        this.setState((st) => ({ upd: { ...st.upd!, step: this.tt('updWriting') } }));
        this.log('esp_ota_end() OK · esp_ota_set_boot_partition(ota_1)', 'ha');
        this.later(() => {
          this.setState((st) => ({ upd: { ...st.upd!, step: this.tt('updRestarting') } }));
          this.later(() => this.rebootInto(rel), 700);
        }, 900);
      }, 900);
    };
    this.later(step, 380);
  }
  rebootInto(rel: Release) {
    const prev = this.state.ota.fw;
    this.setState({ upd: null, ota: { ...this.state.ota, fw: rel.version, prev, pendingVerify: true, status: 'verifying' } });
    this.log('RESTART into v' + rel.version + ' · state ESP_OTA_IMG_PENDING_VERIFY', 'warn');
    if (this.state.failMode === 'boot') {
      this.setState({ mode: 'boot', bootMsg: this.tt('bootStartingV', rel.version) }); this.fullRefresh('boot');
      this.later(() => {
        this.log('v' + rel.version + ' failed health check (crashed before HA connect) · bootloader rolls back to v' + prev, 'warn');
        this.setState({ ota: { ...this.state.ota, fw: prev, pendingVerify: false } });
        this.boot(this.tt('bootUpdateFailed', prev), () => this.setOta({ status: 'error', avail: { ...rel }, msg: this.tt('otaRolledBack', rel.version, prev) }));
      }, 2200);
      return;
    }
    this.boot(this.tt('otaUpdatedTo', rel.version), () => {
      this.log('health check passed · esp_ota_mark_app_valid_cancel_rollback()', 'ha');
      this.setOta({ status: 'updated', avail: null, pendingVerify: false, msg: '', lastCheck: new Date() });
    });
  }
  startTick() { clearInterval(this.tickT); this.tickT = setInterval(() => this.tick(false), this.state.cfg.interval * 1000); }

  derive(raw: HaData, s: EmuState): Derived {
    const h = this.hourOf(s);
    const frac = s.simHour == null ? s.now.getMinutes() / 60 : 0;
    const usedToday = USAGE.slice(0, h).reduce((a, b) => a + b, 0) + USAGE[h] * frac;
    const solarToday = SOLAR.slice(0, h).reduce((a, b) => a + b, 0) + SOLAR[h] * frac;
    const ids = ZONE_LIST.slice(0, s.zoneCount).map((z) => z.id);
    const heatingCount = ids.filter((id) => raw.zones[id].set > raw.zones[id].cur + 0.05).length;
    const ph = this.powerHold;
    return { ...raw, solar: ph.hold('solar', raw.solar), home: ph.hold('home', raw.home), grid: ph.hold('grid', raw.grid), batt: ph.hold('batt', raw.batt),
      usedToday, solarToday, heatingCount,
      exportToday: Math.max(0, solarToday - usedToday * 0.55) * 0.4, importToday: Math.max(0, usedToday - solarToday * 0.6) };
  }

  tick(force: boolean) {
    const s = this.state;
    if (s.asleep || (!force && (s.paused || s.offline || s.mode !== 'main'))) return;
    const patch = this.dataPatch(s);
    if (force || s.sleeping) { this.setState(patch); return; }
    if (this.nightActive(s)) { this.setState(patch); this.log('HA update · night · not drawn'); return; }
    this.commit(patch, 'HA update');
  }
  /** The next mock HA sample (one live tick, or the one fetch of a glance wake). */
  dataPatch(s: EmuState): Pick<EmuState, 'd' | 'lastUpdate'> {
    const h = this.hourOf(s), m = s.now.getMinutes();
    const sun = Math.max(0, Math.sin(((h + m / 60 - 8) / 10.5) * Math.PI));
    const solar = Math.round(sun * 3400 * (0.75 + Math.random() * 0.25));
    const home = Math.round(USAGE[h] * 1000 * (0.8 + Math.random() * 0.4));
    const d = s.d; let batt = 0;
    const surplus = solar - home;
    if (surplus > 0 && d.soc < 100) batt = Math.min(surplus, 2500);
    else if (surplus < 0 && d.soc > 10) batt = -Math.min(-surplus, 2500);
    const grid = home - solar + batt;
    const soc = Math.max(0, Math.min(100, d.soc + batt * 0.0004));
    const zones: HaData['zones'] = {};
    Object.keys(d.zones).forEach((k) => { const z = d.zones[k]; const heat = z.set > z.cur; zones[k] = { ...z, cur: +(z.cur + (heat ? Math.min(0.1, z.set - z.cur) : Math.max(-0.02, z.set - z.cur))).toFixed(2) }; });
    return { d: { ...d, solar, home, batt, grid, soc, zones }, lastUpdate: new Date() };
  }

  // ---------- navigation: one linear sequence of pages ----------
  subPages(sc: Screen, s: EmuState) { return subPages(sc, (w) => listPages(w, ZONE_LIST.slice(0, s.zoneCount), LIGHT_GROUPS)); }
  appOf(s: EmuState) { const sc = s.screens[s.idx]; return (sc && sc.app) || (s.apps[0] || { id: 'home' }).id; }
  appDef(s: EmuState, id: string) { return s.apps.find((a) => a.id === id) || { id, title: id }; }
  // pages of the CURRENT app only, in order
  flat(s: EmuState) { return flatPages(s.screens, this.appOf(s), (sc) => this.subPages(sc, s)); }
  openApp(id: string, src: string) {
    const i = this.state.screens.findIndex((x) => x.app === id); if (i < 0) { this.log(src + ' → app ' + this.appDef(this.state, id).title + ' has no screens yet'); return; }
    this.setState({ idx: i, sub: 0, menu: false }); this.navRefresh('app switch'); this.log(src + ' → app ' + this.appDef(this.state, id).title);
  }
  setMenu(m: 'apps' | 'pages', src: string) {
    if (this.state.sleeping || this.state.mode !== 'main') return;
    if (this.state.setup) { this.log(src + ' · finish setup first'); return; }
    const next = this.state.menu === m ? false : m;
    this.setState({ menu: next }); this.navRefresh(next ? (next === 'apps' ? 'app switcher' : 'page overview') : 'close overview');
    this.log(src + ' → ' + (next ? (next === 'apps' ? 'app switcher' : 'page overview') : 'close'));
  }
  curSub(s: EmuState) { const sc = s.screens[s.idx]; return sc ? Math.min(s.sub, this.subPages(sc, s) - 1) : 0; }

  goTo(i: number, src: string) {
    const n = this.state.screens.length; const idx = ((i % n) + n) % n;
    this.setState({ idx, sub: 0, menu: false });
    this.navRefresh('screen change');
    this.log(src + ' → ' + this.state.screens[idx].title);
  }
  nav(dir: number, src: string) {
    const s = this.state;
    if (s.asleep) { if (src === 'BTN_NEXT') this.wakeUp(src); else this.asleepIgnores(src); return; }
    if (s.setup && s.mode === 'main') { this.log(src + ' · finish setup first'); return; }
    if (s.mode === 'boot' && src === 'BTN_NEXT') { this.holdLiveUntil = Date.now() + BOOT_HOLD_LIVE_MIN * 60_000; this.log(src + ' held at boot → live for ' + BOOT_HOLD_LIVE_MIN + ' min, no deep sleep'); return; }
    if (s.mode !== 'main') { this.log(src + ' ignored (' + s.mode + ')', 'warn'); return; }
    if (s.sleeping) { this.wake(src); return; }
    if (this.nightActive(s)) { this.doPeek(src); return; }
    const f = this.flat(s); const sub = this.curSub(s);
    let pos = f.findIndex(([i, p]) => i === s.idx && p === sub); if (pos < 0) pos = 0;
    const [idx, p] = f[(pos + dir + f.length) % f.length];
    const title = s.screens[idx].title + (this.subPages(s.screens[idx], s) > 1 ? ' ' + (p + 1) + '/' + this.subPages(s.screens[idx], s) : '');
    this.setState({ idx, sub: p, menu: false });
    if (idx === s.idx && !s.menu) this.partialRefresh('page turn', ['page']); else this.navRefresh('screen change');
    this.log(src + ' → ' + title);
  }
  home(src: string) {
    const s = this.state;
    if (this.asleepIgnores(src)) return;
    if (s.sleeping) { this.wake(src); return; }
    if (s.mode !== 'main') return;
    if (s.setup) { this.log(src + ' · finish setup first'); return; }
    if (this.nightActive(s)) { this.doPeek(src); return; }
    const first = s.screens.findIndex((x) => x.app === (s.apps[0] || { id: 'home' }).id);
    if (s.idx === first && s.sub === 0 && !s.menu) { this.setMenu('apps', src + ' on Home'); return; }
    this.goTo(Math.max(0, first), src);
  }
  doPeek(src: string) {
    this.setState({ peekUntil: Date.now() + 60000, idx: 0, sub: 0, menu: false, ambient: false });
    this.fullRefresh('wake from night'); this.log(src + ' → dashboard for 60 s, then back to night face');
  }
  wake(src: string) { this.setState({ sleeping: false, ambient: false }); this.fullRefresh('wake'); this.log(src + ' → wake'); }
  power() {
    if (this.state.mode === 'off') { this.log('BTN_POWER → power on'); this.boot(); return; }
    if (this.state.asleep) { this.wakeUp('BTN_POWER'); return; }
    if (this.state.mode !== 'main') return;
    if (this.state.sleeping) { this.wake('BTN_POWER'); return; }
    this.setState({ sleeping: true, menu: false, ambient: false }); this.fullRefresh('standby'); this.log('BTN_POWER → standby (frontlight off, clock-only updates)');
  }

  // ---------- HA service calls (mock) ----------
  setZone(k: string, delta: number) {
    if (this.state.offline) { this.log('climate.' + k + ' not sent — offline', 'warn'); return; }
    const d = this.state.d; const z = d.zones[k]; if (!z) return;
    const set = nextSetpoint(z.set, delta);
    this.commit({ d: { ...d, zones: { ...d.zones, [k]: { ...z, set } } }, pending: { ...this.state.pending, [k]: true } }, 'setpoint');
    this.debounce.schedule(k, TADO_DEBOUNCE_MS, () => {
      const v = this.state.d.zones[k].set;
      this.log('climate.set_temperature climate.' + k + ' temperature=' + v.toFixed(1), 'ha');
      this.later(() => { const p = { ...this.state.pending }; delete p[k]; this.log('ack climate.' + k + ' · tado confirmed', 'ha'); this.commit({ pending: p }, 'ack', true); }, 900);
    });
  }
  setLights(changes: Record<string, Partial<{ on: boolean; b: number }>>, call: string) {
    if (this.state.offline) { this.log(call + ' not sent — offline', 'warn'); return; }
    const d = this.state.d; const lights = { ...d.lights };
    Object.keys(changes).forEach((id) => { lights[id] = { ...lights[id], ...changes[id] }; });
    this.log(call, 'ha');
    this.commit({ d: { ...d, lights } }, 'lights');
  }
  toggleEntity(id: string) {
    const st = this.state.ent[id]; if (st == null) { this.log('TOUCH ' + id + ' · unknown to Home Assistant', 'warn'); return; }
    const on = st !== 'on';
    this.log(domainOf(id) + '.' + (on ? 'turn_on' : 'turn_off') + ' ' + id, 'ha');
    this.commit({ ent: { ...this.state.ent, [id]: on ? 'on' : 'off' } }, 'switch');
  }
  toggleLight(id: string) { const l = this.state.d.lights[id]; this.setLights({ [id]: { on: !l.on } }, 'light.' + (l.on ? 'turn_off' : 'turn_on') + ' light.' + id); }
  dimLight(id: string, step: number) { const l = this.state.d.lights[id]; const b = Math.max(10, Math.min(100, l.b + step)); this.setLights({ [id]: { on: true, b } }, 'light.turn_on light.' + id + ' brightness_pct=' + b); }
  /** A room header's All on / All off: the lights the tile shows in that room (#127: a pick may show only some). */
  roomLights(room: string, ids: string[]) {
    const anyOn = ids.some((id) => this.state.d.lights[id].on);
    const ch: Record<string, { on: boolean }> = {}; ids.forEach((id) => { ch[id] = { on: !anyOn }; });
    const all = ids.length === LIGHT_LIST.filter((l) => l.room === room).length;
    this.setLights(ch, 'light.' + (anyOn ? 'turn_off' : 'turn_on') + (all ? ' area_id=' + room : ' entity_id=' + ids.map((id) => 'light.' + id).join(',')));
  }
  /** Scene tile with an entity (#146): scene.turn_on / script.turn_on; nothing on the panel changes. */
  runScene(w: Widget) {
    const a = sceneAction(w);
    if (this.state.offline) { this.log('TOUCH ' + a.data.entity_id + ' · not sent, offline', 'warn'); return; }
    this.log(a.domain + '.' + a.service + ' ' + a.data.entity_id, 'ha');
  }
  allOff() { const ch: Record<string, { on: boolean }> = {}; LIGHT_LIST.forEach((l) => { ch[l.id] = { on: false }; }); this.setLights(ch, 'light.turn_off entity_id=all'); }
  /** Simulation › Display style. Same effect as the style + typeface settings: one full refresh. */
  setLook(look: Look) {
    const cfg = look === 'classic' ? { ...this.state.cfg, style: 'classic' as const } : { ...this.state.cfg, style: 'sleek' as const, typeface: look };
    this.setState({ cfg });
    this.log('SIM display style → ' + (look === 'classic' ? 'Classic' : 'Sleek · ' + LOOKS.find(([k]) => k === look)![1]));
    this.fullRefresh('style');
  }
  look(s: EmuState): Look { return lookOf(s.cfg.style, s.cfg.typeface); }
  /** Display language (#98): HA's get_config `language` while linked (the firmware clears it on unlink), else English. */
  lang(s: EmuState): Lang { return s.ha.linked || s.ha.revoked ? s.haLang : 'en'; }
  /** Price currency (#147): HA's get_config `currency` while linked, else €. */
  cur(s: EmuState): string { return currencySymbol(s.ha.linked || s.ha.revoked ? s.haCurrency : null); }
  /** A display text in the current language (messages kept in state: boot line, OTA, Wi-Fi field). */
  tt(k: StrKey, ...a: (string | number)[]): string { return tr(this.lang(this.state), k, ...a); }
  setCfg(key: keyof Cfg, dir: number) {
    const def = SETTINGS[key]; const cur = this.state.cfg[key]; let v: any;
    if (def.steps) { const i = def.steps.indexOf(cur as string | number); v = def.steps[Math.max(0, Math.min(def.steps.length - 1, i + dir))]; }
    else v = Math.max(def.min!, Math.min(def.max!, (cur as number) + dir * def.step!));
    if (v === cur) return;
    this.log('SET ' + key + ' = ' + v);
    if (isLookKey(key)) { this.setState({ cfg: { ...this.state.cfg, [key]: v } }); this.fullRefresh('display style'); return; }
    this.commit({ cfg: { ...this.state.cfg, [key]: v } }, 'setting');
    if (key === 'interval') setTimeout(() => this.startTick(), 0);
  }

  // View model of one tile. Returns plain data + callbacks (callbacks are stripped before region hashing).
  vm(w: any, d: Derived, s?: EmuState, i = 0): any {
    s = s || this.state; const S = s;
    const lg = this.lang(s); const tx = (k: StrKey, ...a: (string | number)[]) => tr(lg, k, ...a);
    const gapText = (g: 'unavailable' | 'unknown') => tx(g === 'unavailable' ? 'gapUnavailable' : 'gapUnknown');
    setNumFormat(numFormatOf(null, lg));   // #110: the sim HA has no profile number_format, so the language decides
    setCurrency(this.cur(s));
    const dirty = (k: string) => S.dirty.indexOf(k) >= 0;   // markers always render; hidden by CSS when !showRegions
    const pageDirty = dirty('page');
    const base = { border: '2px solid #111', isGhost: false, isLinkCard: false, cs: w.cs || 1, rs: w.rs || 1, dirty: dirty('t' + i) || pageDirty, isStat: false, isClock: false, isPrice: false, isGauge: false, isBars: false, isThermo: false, isZoneList: false, isLightList: false, isLight: false, isScene: false, isSetting: false, isInfo: false, isOta: false, isRoute: false, isWifi: false, isHa: false, isAbout: false, isSetupWeb: false, isHistory: false };
    if (w.type === 'setupWeb') {
      const ssid = s.wifi.connected || tx('swYourWifi');
      return { ...base, isSetupWeb: true, ssid, connected: tx('swConnected', ssid), title: tx('swTitle'), orIp: tx('swOr', SIM_IP),
        otherWifi: tx('swOtherWifi'), waiting: tx('swWaiting'),
        steps: [
          { n: '1', text: tx('swOpen', HOST) },
          { n: '2', text: tx('signIn') },
          { n: '3', text: tx('stepDone') },
        ],
        changeWifi: () => { this.log('TOUCH use a different Wi-Fi'); this.setState((st) => ({ setup: 'wifi', wifi: { ...st.wifi, connected: null, view: 'list' } })); this.fullRefresh('setup: Wi-Fi'); } };
    }
    const h = this.hourOf(s);
    const sub = this.curSub(s);
    if (w.type === 'ghost') {
      const g = w.of; const ent = g.type === 'stat' || g.type === 'switch' || g.type === 'history' || ((g.type === 'gauge' || g.type === 'route' || g.type === 'scene') && g.entity) ? String(g.entity) : '';
      const gk = ({ price: 'priceNow', gauge: 'homeBattery', bars: 'todayPerHour', zoneList: 'rooms', lightList: 'lights', thermo: 'room', scene: 'scene', route: 'palRoute' } as Record<string, StrKey>)[g.type];
      const label = g.label || (ent ? (ENT[ent] && tx(ENT[ent].lk)) || ENT_NAME[ent] || ent : tx(gk || 'data'));
      return { ...base, isGhost: true, border: '2px dotted #111', label };
    }
    if (w.type === 'linkCard') {
      const ha = s.ha;
      const T = [tx('lnkScan'), tx('lnkFind'), tx('lnkSignIn'), tx('lnkKey')];
      return { ...base, isLinkCard: true, pair: ha.pair,
        stages: T.map((title, k) => { const done = ha.stage > k, cur = ha.stage === k && ha.running;
          return { title, mark: done ? '✓' : String(k + 1), bg: done ? INK : PAPER, fg: done ? PAPER : INK, ring: cur ? '3px solid #111' : done ? '2px solid #111' : '2px solid #111', weight: done || cur ? 700 : 400 }; }),
        simLabel: ha.running ? 'Phone is working…' : 'Simulate phone', simulate: () => this.runHaLink() };
    }
    if (w.type === 'ha') {
      const ha = s.ha; const linked = ha.linked;
      const tickRow = (name: string, src: string, count: string) => ({ name, src, count: linked ? count : '—', dotBg: linked ? INK : PAPER, tick: linked ? PAPER : 'none' });
      const STAGES = [
        [tx('lnkScan'), tx('lnkScanWait'), tx('lnkScanDone')],
        [tx('lnkFind'), tx('lnkFindWait'), tx('lnkFoundAt', ha.server)],
        [tx('lnkSignIn'), tx('lnkSignInWait'), tx('signedInAs', ha.user)],
        [tx('lnkKey'), tx('lnkKeyWait'), tx('lnkKeyDone')],
      ];
      const stages = STAGES.map(([title, todo, done], k) => {
        const isDone = ha.stage > k, cur = ha.stage === k;
        return { title, sub: isDone ? done : todo, mark: isDone ? '✓' : String(k + 1), bg: isDone ? INK : PAPER, fg: isDone ? PAPER : INK,
          ring: cur ? '3px solid #111' : isDone ? '2px solid #111' : '2px solid #111', weight: cur || isDone ? 700 : 400 };
      });
      const L = (msg: string) => this.log(msg, 'ha');
      return { ...base, isHa: true, isStatus: ha.view === 'status', isLink: ha.view === 'link', linked,
        title: tx(ha.revoked ? 'keyRevoked' : !linked ? 'notLinked' : s.offline ? 'haOffline' : 'connected'),
        lines: linked
          ? [{ k: tx('kvServer'), v: ha.server }, { k: tx('kvSignedInAs'), v: ha.user }, { k: tx('kvKey'), v: tx('renewsItself') }, { k: tx('kvConnection'), v: tx(s.offline ? 'offline' : 'connLive') }]
          : ha.revoked
            ? [{ k: tx('kvWhy'), v: tx('removedInHa') }, { k: tx('kvData'), v: tx('lastKnownOnly') }, { k: tx('kvFix'), v: tx('linkPhoneBelow') }]
            : [{ k: tx('kvServer'), v: tx('notSet') }, { k: tx('kvStatus'), v: tx('noLiveData') }],
        hint: ha.revoked ? tx('revokedHint', tx('hostOr', HOST, SIM_IP)) : '',
        uses: [
          tickRow(tx('energy'), tx('useEnergySrc'), tx('nSensors', 6)),
          tickRow(tx('lights'), tx('useLightsSrc'), tx('nLights', LIGHT_LIST.length)),
          tickRow(tx('heating'), tx('useHeatSrc'), tx('nRooms', s.zoneCount)),
          tickRow(tx('travel'), tx('useTravelSrc'), tx('nRoutes', 4)),
        ],
        linkLabel: tx(linked ? 'relinkPhone' : 'linkPhone'), linkBg: linked ? PAPER : INK, linkFg: linked ? INK : PAPER,
        openLink: () => {
          const pair = Array.from({ length: 4 }, () => '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 31)]).join('');
          this.setState({ ha: { ...ha, view: 'link', stage: 0, pair, running: false } }); this.fullRefresh('link');
          this.log('TOUCH link Home Assistant · local setup page http://' + SIM_IP + '/link?p=' + pair + ' (valid 10 min)');
        },
        cancel: () => { this.setState({ ha: { ...ha, view: 'status', stage: 0, running: false } }); this.fullRefresh('home assistant'); this.log('Link cancelled · pairing code discarded'); },
        reconnect: () => { L('TOUCH reconnect → ws://' + ha.server + '/api/websocket'); if (S.wifi.connected) { this.setState({ offline: false }); setTimeout(() => this.tick(false), 0); } },
        unlink: () => { this.log('HA unlinked · POST /auth/revoke · key deleted from device', 'warn'); this.setState({ ha: { ...ha, linked: false, revoked: false }, offline: true }); this.partialRefresh('home assistant', ['t' + i, 'bar']); },
        pair: ha.pair, stages,
        simLabel: ha.running ? 'Phone is working…' : 'Simulate phone',
        simulate: () => this.runHaLink() };
    }
    if (w.type === 'about') {
      const up = Math.max(0, Math.round((s.now.getTime() - (s.bootAt || s.now).getTime()) / 60000));
      const uptime = up < 60 ? up + ' min' : Math.floor(up / 60) + ' h ' + (up % 60) + ' min';
      return { ...base, isAbout: true, name: 'Living room display', model: 'Xteink X4 Pro · ' + this.osName + ' v' + s.ota.fw,
        facts: [
          { k: 'Home Assistant', v: tx(s.ha.linked ? (s.offline ? 'offline' : 'connected') : 'notLinked') },
          { k: tx('stepWifi'), v: s.wifi.connected || tx('notConnected') },
          { k: tx('battery'), v: batteryLabel(this.battery, s.usb && this.battery < 100, s.usb) },
          { k: tx('kvRunningFor'), v: uptime },
          { k: tx('kvStorage'), v: 'microSD 16 GB · 3% used' },
          { k: tx('kvIp'), v: s.wifi.connected ? '192.168.1.42' : '—' },
          { k: tx('kvScreen'), v: tx('redraws', s.fullCount, s.partialCount) },
          { k: tx('kvHardware'), v: 'ESP32-S3 · 800×480 e-ink' },
        ],
        restart: () => { this.log('TOUCH restart', 'warn'); this.boot(this.tt('bootRestarting')); },
        resetLabel: tx(s.resetArm ? 'tapAgain' : 'factoryReset'), resetBg: s.resetArm ? INK : PAPER, resetFg: s.resetArm ? PAPER : INK,
        resetHint: tx(s.resetArm ? 'resetErases' : 'resetStartsSetup'),
        reset: () => {
          if (S.resetArm) { this.factoryReset(); return; }
          this.setState({ resetArm: true }); this.partialRefresh('1 tile', ['t' + i]); this.log('TOUCH factory reset · armed for 5 s');
          this.later(() => { if (this.state.resetArm) { this.setState({ resetArm: false }); this.partialRefresh('1 tile', ['t' + i]); } }, 5000);
        } };
    }
    if (w.type === 'wifi') {
      const wf = s.wifi; const conn = wf.connected && !s.offline ? wf.connected : null;
      const net = NETWORKS.find((n) => n.ssid === conn);
      const nets = NETWORKS.map((n) => {
        const b = barsFor(n.rssi);
        return { ssid: n.ssid, secure: n.secure,
          bars: [0, 1, 2, 3].map((k) => ({ h: 6 + k * 4, c: k < b ? INK : PAPER })),
          tag: n.ssid === conn ? tx('connected') : wf.saved.includes(n.ssid) ? tx('savedTag') : '',
          pick: () => {
            if (n.ssid === conn) return;
            if (!n.secure || wf.saved.includes(n.ssid)) { this.wifiConnect(n.ssid, ''); return; }
            this.setState({ wifi: { ...wf, view: 'pw', target: n.ssid, pw: '', msg: '', kb: 'lower', show: false } }); this.navRefresh('keyboard'); this.log('TOUCH network ' + n.ssid + ' → password');
          } };
      });
      const layout = KB[wf.kb];
      const key = (label: string, val: string, o?: { aria?: string; flex?: number; size?: number; bg?: string; fg?: string }) => ({ label, aria: (o && o.aria) || label, flex: (o && o.flex) || 1, size: (o && o.size) || 20, bg: (o && o.bg) || PAPER, fg: (o && o.fg) || INK, press: () => this.keyPress(val) });
      const kb = [
        { inset: 0, keys: layout[0].split('').map((c) => key(c, c)) },
        { inset: 30, keys: layout[1].split('').map((c) => key(c, c)) },
        { inset: 0, keys: [key('⇧', 'SHIFT', { flex: 1.5, aria: 'Shift', bg: wf.kb === 'upper' ? INK : PAPER, fg: wf.kb === 'upper' ? PAPER : INK }), ...layout[2].split('').map((c) => key(c, c)), key('⌫', 'BACK', { flex: 1.5, aria: 'Delete' })] },
        { inset: 0, keys: [key(wf.kb === 'nums' ? 'abc' : '123', 'NUMS', { flex: 1.5, size: 16, aria: 'Switch keyboard' }), key(tx('keySpace'), 'SPACE', { flex: 5, size: 16, aria: 'Space' }), key(tx('keyConnect'), 'OK', { flex: 2.5, size: 17, bg: INK, fg: PAPER })] },
      ];
      return { ...base, isWifi: true, isList: wf.view === 'list', isPw: wf.view === 'pw', isConnecting: wf.view === 'connecting', isPhone: wf.view === 'phone',
        isConnected: !!conn,
        statusLabel: tx(conn ? 'connected' : 'notConnected'),
        statusTitle: conn || tx('pickNetwork'),
        statusLines: conn
          ? [{ k: tx('kvSignal'), v: tx((['sigWeak', 'sigFair', 'sigGood', 'sigExcellent'] as const)[barsFor(net ? net.rssi : -60) - 1]) }, { k: tx('kvIp'), v: '192.168.1.42' }, { k: 'Home Assistant', v: tx(s.offline ? 'offline' : 'reachable') }]
          : [{ k: tx('kvStatus'), v: tx('offline') }, { k: tx('kvSavedNets'), v: String(wf.saved.length) }],
        nets, scanLabel: tx(wf.scanning ? 'scanning' : 'scan'),
        scan: () => { if (wf.scanning) return; this.setWifi({ scanning: true }, 'scan'); this.log('WIFI esp_wifi_scan_start()'); this.later(() => { this.setWifi({ scanning: false, lastScan: new Date() }, 'scan'); this.log('WIFI scan · ' + NETWORKS.length + ' networks (2.4 GHz)'); }, 1500); },
        disconnect: () => { this.log('WIFI disconnect · ' + conn, 'warn'); this.setState({ wifi: { ...wf, connected: null }, offline: true }); this.partialRefresh('wifi', ['t' + i, 'bar']); },
        openPhone: () => { this.setState({ wifi: { ...wf, view: 'phone' } }); this.fullRefresh('phone setup'); this.log('WIFI start SoftAP "HA-Paper-Setup" + captive portal at 192.168.4.1'); },
        phoneDone: () => { this.log('Captive portal · phone sent credentials for HomeNet'); this.wifiConnect('HomeNet', '••••••••'); },
        steps: [{ n: '1', text: tx('phoneStep1') }, { n: '2', text: tx('phoneStep2') }, { n: '3', text: tx('phoneStep3') }],
        target: wf.target,
        field: wf.pw.length ? (wf.show ? wf.pw : '•'.repeat(wf.pw.length)) : '',
        msg: wf.msg || (wf.pw.length ? tx('nChars', wf.pw.length) : tx('typePw')), msgColor: INK,
        showLabel: tx(wf.show ? 'hide' : 'show'),
        toggleShow: () => this.setWifi({ show: !wf.show }, 'field'),
        cancel: () => { this.setState({ wifi: { ...wf, view: 'list', pw: '', msg: '' } }); this.navRefresh('networks'); },
        kb };
    }
    if (w.type === 'route') {
      const R = DEMO_ROUTES[w.route as string];
      const mode = ['bus', 'car'].includes(w.mode) ? w.mode : 'train';
      if (!R) {   // a user route: the demo has no HA sensor for it → the display's "no data" state
        const title = w.label || (w.entity ? ENT_NAME[w.entity] || w.entity : tx('palRoute'));
        return { ...base, isRoute: true, isCar: false, isTransit: true, icon: MODE_ICON[mode], title, sev: null,
          deps: [{ time: '—', delay: '', deco: 'none', info: '', infoColor: INK, infoWeight: 400 }],
          note: tx(w.entity ? 'noDataYet' : 'routePick'), noteWeight: 400 };
      }
      const lvlSet = TRAVEL[s.travel][w.route] || 1;
      const nowMin = h * 60 + (s.simHour == null ? s.now.getMinutes() : 0);
      if (R.mode === 'car') {
        const eta = carEta(R.typical!, lvlSet); const extra = eta - R.typical!;
        return { ...base, isRoute: true, isCar: true, isTransit: false, icon: MODE_ICON.car, title: w.label || R.title, sev: badge(lvlSet, true),
          eta: String(eta), arrive: hhmm(nowMin + eta), vs: tx('usually', R.typical + ' min') + (extra > 0 ? ' · ' + tx('traffic', extra) : ''),
          note: R.notes[lvlSet - 1], noteWeight: lvlSet >= 3 ? 700 : 400 };
      }
      const times: number[] = [];
      for (let hh = h; hh <= h + 2 && times.length < 3; hh++) R.offsets!.forEach((o) => { const t = hh * 60 + o; if (t > nowMin && times.length < 3) times.push(t); });
      const set = DELAY_SETS[lvlSet - 1];
      const deps = times.map((t, j) => {
        const cancelled = set.c === j; const dl = cancelled ? 0 : set.d[j];
        return { t, cancelled, dl, time: hhmm(t), delay: dl > 0 ? '+' + dl : '', deco: cancelled ? 'line-through' : 'none',
          info: cancelled ? tx('cancelled') : R.info![j % R.info!.length], infoColor: INK, infoWeight: cancelled ? 700 : 400 };
      });
      const lvl = Math.max(1, ...deps.slice(0, 2).map((x) => sevOf(x.dl, x.cancelled)));
      let note = R.notes[lvlSet - 1];
      if (R.mode === 'bus') note = note + ' · ' + tx('perHour', R.offsets!.length);
      return { ...base, isRoute: true, isCar: false, isTransit: true, icon: MODE_ICON[R.mode], title: w.label || R.title, sev: badge(lvl, false), deps,
        note, noteWeight: lvl >= 3 ? 700 : 400 };
    }
    if (w.type === 'ota') {
      const o = s.ota;
      // #250: the status line is its own redraw region (s<i>): Check → "Checking…" → the result is a partial of that block only
      const line = otaLine(lg, { status: o.status, error: o.err, version: o.avail ? o.avail.version : '', checked: o.lastCheck ? hm(o.lastCheck) : '', channel: o.channel, message: o.msg });
      const [statusTitle, statusSub] = o.status === 'updated' ? [tx('otaUpdatedTo', o.fw), tx('otaPrevKept', o.prev ?? '')]
        : o.status === 'verifying' ? [tx('otaVerifying'), tx('otaStartingNew')] : [line.title, line.sub];
      const canInstall = !!o.avail && o.status !== 'checking';
      const pick = (on: boolean) => ({ bg: on ? INK : PAPER, fg: on ? PAPER : INK });
      // #199: a git-describe name ("0.1.0-alpha.6-18-gbf929d4") drops its -g<hash> and steps 46 → 34 px (firmware
      // measures; About keeps the whole name)
      const fwShown = o.fw.length > 14 ? o.fw.replace(/-g[0-9a-f]+$/, '') : o.fw;
      const fwSize = fwShown.length <= 12 ? 46 : fwShown.length <= 17 ? 40 : 34;
      return { ...base, isOta: true, fw: o.fw, fwShown, fwSize, status: { title: statusTitle, sub: statusSub }, statusDirty: dirty('s' + i),
        hasNotes: !!o.avail, notes: o.avail ? o.avail.notes.map((t) => ({ text: t })) : [],
        channels: ([['stable', 'chanStable'], ['beta', 'chanBeta']] as const).map(([k, lk]) => ({ label: tx(lk), ...pick(o.channel === k),
          pick: () => { if (o.channel === k) return; this.log('OTA channel → ' + k); this.setOta({ channel: k, status: 'idle', avail: null, msg: '', err: null }, 'channel'); } })),
        autos: ([['off', 'off'], ['notify', 'autoNotify'], ['night', 'autoNight']] as const).map(([k, lk]) => ({ label: tx(lk), ...pick(o.auto === k),
          pick: () => { this.log('OTA automatic → ' + k); this.setOta({ auto: k }, 'setting'); } })),
        autoHint: tx(o.auto === 'night' ? 'otaHintNight' : o.auto === 'notify' ? 'otaHintNotify' : 'otaHintManual'),
        actionLabel: canInstall ? tx('otaInstallV', o.avail!.version) : tx('otaCheck'),   // steady: "Checking…" is in the status line
        actionBg: canInstall ? INK : PAPER, actionFg: canInstall ? PAPER : INK,
        actionHint: canInstall ? tx('aboutAMinute') + ' · ' + o.avail!.size + ' MB' : '',
        action: () => (canInstall ? this.install() : this.checkUpdate('TOUCH')) };
    }
    if (w.type === 'stat') {
      const e = ENT[w.entity];
      if (e) { const r = e.get(d, lg); return { ...base, isStat: true, label: w.label || tx(e.lk), ikey: e.label, value: r.v, unit: r.u, sub: r.sub }; }
      // Any other HA entity: friendly name, state, unit_of_measurement, display_precision (#85; binary_sensor → On / Off). Not
      // received → "—"; unavailable / unknown in HA → a ring + the reason (#86).
      const z = domainOf(w.entity) === 'climate' ? d.zones[w.entity.slice(8)] : undefined;   // a room's temperature (#161, core/format.ts statSource)
      if (z) return { ...base, isStat: true, label: w.label || ENT_NAME[w.entity] || w.entity, value: fmtNum(z.cur, '°C'), unit: '°C', sub: '' };
      const st = s.ent[w.entity];
      const g = entityGap(st);
      if (g) return { ...base, isStat: true, label: w.label || ENT_NAME[w.entity] || w.entity, value: '', unit: '', sub: gapText(g), gap: true };
      const value = st == null ? '—' : domainOf(w.entity) === 'binary_sensor' ? tx(st === 'on' ? 'on' : 'off') : fmtValue(st, ENT_UNIT[w.entity] || '', ENT_DP[w.entity]);
      return { ...base, isStat: true, label: w.label || ENT_NAME[w.entity] || w.entity, value, unit: st == null ? '' : ENT_UNIT[w.entity] || '', sub: '' };
    }
    if (w.type === 'clock') return { ...base, isClock: true, clockDirty: dirty('k' + i) };
    if (w.type === 'price') {
      const p = PRICES[h]; const sorted = [...PRICES].sort((a, b) => a - b);
      const cheap = p <= sorted[7], dear = p >= sorted[16];
      return { ...base, isPrice: true, label: w.label || tx('price'), sLabel: w.label || tx('powerPrice'), value: fmtNum(p, '', 2), tag: cheap ? 'CHEAP' : dear ? 'HIGH' : 'NORMAL', tagText: tx(cheap ? 'cheap' : dear ? 'high' : 'normal').toUpperCase(), tagBg: dear ? INK : PAPER, tagFg: dear ? PAPER : INK,
        sub: h >= CHEAP && h < CHEAP + 3 ? tx('cheapestNow') : tx('cheapestAt', pad(CHEAP) + '–' + pad(CHEAP + 3) + ' h') };
    }
    if (w.type === 'gauge' && w.entity && w.entity !== GAUGE_DEFAULT_ENTITY) {
      const st = s.ent[w.entity]; const n = st == null ? NaN : parseFloat(st); const pct = isNaN(n) ? 0 : Math.max(0, Math.min(100, Math.round(n)));
      const g = entityGap(st);
      const label = w.label || ENT_NAME[w.entity] || w.entity;
      return { ...base, isGauge: true, label, sLabel: label, value: g ? '' : isNaN(n) ? '—' : fmtNum(n, '%'), pct, sub: g ? gapText(g) : '', gap: !!g };
    }
    if (w.type === 'gauge') {
      const f = kw(d.batt);
      return { ...base, isGauge: true, label: w.label || tx('homeBattery'), sLabel: w.label || tx('battery'), value: fmtNum(d.soc, '%'), pct: Math.round(d.soc),
        sub: d.batt > 30 ? tx('charging', f.v + ' ' + f.u) : d.batt < -30 ? tx('discharging', f.v + ' ' + f.u) : tx('idle') };
    }
    if (w.type === 'bars') {
      const ser = w.series === 'prices' ? PRICES : w.series === 'solar' ? SOLAR : USAGE;
      const max = Math.max(...ser);
      const bars = ser.map((v, j) => {
        let c;
        if (w.series === 'prices') c = j === h ? INK : j >= CHEAP && j < CHEAP + 3 ? HATCH : TRACK;
        else c = j === h ? INK : j < h ? HATCH : TRACK;
        return { h: Math.max(2, Math.round((v / max) * 100)), c, now: j === h };
      });
      const label = w.label || (w.series === 'prices' ? tx('chartPrices', currency()) : tx(w.series === 'solar' ? 'chartSolar' : 'chartUsage'));
      const summary = w.series === 'prices' ? tx('pricesSummary', money(PRICES[h]), pad(CHEAP) + '–' + pad(CHEAP + 3))
        : tx('soFar', fmtNum(w.series === 'solar' ? d.solarToday : d.usedToday, 'kWh'));
      // #260: today's low / high on the drawn (hourly) bars, formatted like the history tile; a caret over the hour now
      const lh = w.series === 'prices' ? dayLowHigh(PRICES, lg) : null;
      return { ...base, isBars: true, label, summary, bars, nowMark: w.series === 'prices', hasLowHigh: !!lh,
        low: lh ? tx('histLow', fmtNum(lh.low.v, '', 2), lh.low.time) : '', high: lh ? tx('histHigh', fmtNum(lh.high.v, '', 2), lh.high.time) : '' };
    }
    if (w.type === 'history') {   // #267: the demo has no recorder, so a daily curve per unit (core demoHistory)
      const id = String(w.entity ?? ''); const spec = historySpec(w); const unit = ENT_UNIT[id] || ''; const dp = ENT_DP[id];
      const t = new Date(s.now); if (s.simHour != null) t.setHours(s.simHour, 0, 0, 0);
      const now = t.getTime(), tz = -t.getTimezoneOffset();
      const st = s.ent[id]; const g = entityGap(st);
      // #283: an attribute / forecast series gets a demo list (core demoForecast) through the real parser
      const src = spec.source, srcUnit = src ? (/precip|rain/i.test(src.value) ? 'mm/h' : /temp/i.test(src.value) ? '°C' : '') : unit;
      const series = src ? fromSamples(g || st == null ? [] : attrSamples(demoForecast(src.value, src.time, src.forecast === 'daily' ? 86_400_000 : src.forecast ? 3_600_000 : 300_000, now, tz, spec.aheadMs ?? 0), src, spec.bucketMs, now, tz), spec, now, tz)
        : bucketize(g || st == null ? [] : demoHistory(id, unit, now - spec.windowMs - spec.bucketMs, now, tz), spec, now, tz);
      const chart = historyChart(spec, series, 'ok', now, tz, lg, (v) => fmtNum(v, srcUnit, src ? 1 : dp));
      const nowV = src ? series.values[Math.round((bucketStart(now, spec.bucketMs, tz) - series.start) / spec.bucketMs)] : null;   // a series' summary: its value now
      return { ...base, isHistory: true, ...historyTile(chart), label: w.label || ENT_NAME[id] || id,
        summary: g ? gapText(g) : st == null ? '—' : src ? (nowV == null ? '—' : fmtNum(nowV, srcUnit, 1) + (srcUnit ? ' ' + srcUnit : '')) : fmtValue(st, unit, dp) + (unit ? ' ' + unit : '') };
    }
    if (w.type === 'thermo') {
      // no zone picked yet / not in HA (#148): "—", the label or "Room", buttons do nothing (core setZone needs a zone)
      const z = w.zone ? d.zones[w.zone] : undefined; const tall = (w.rs || 1) > 1; const heating = !!z && z.set > z.cur + 0.05;
      return { ...base, isThermo: true, label: w.label || ZONE_NAME[w.zone] || w.zone || tx('room'), value: z ? fmtNum(z.cur, '°C') : '—', set: z ? fmtNum(z.set, '°C') : '—', curN: z ? z.cur : 14, setN: z ? z.set : 14, heating, setDeco: s.pending[w.zone] ? 'underline dotted' : 'none',
        bigSize: tall ? 76 : 40, sub: tall && z ? (heating ? tx('heatingTo', fmtNum(z.set, '°C') + '°') : tx('atSetTemp')) : '',
        dec: () => this.setZone(w.zone, -0.5), inc: () => this.setZone(w.zone, 0.5) };
    }
    if (w.type === 'zoneList') {
      const all = pickZones(ZONE_LIST.slice(0, s.zoneCount), w); const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
      const page = Math.min(sub, pages - 1);
      const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
      const rows = slice.map((z) => {
        const zz = d.zones[z.id];
        return { key: 'z:' + z.id, dirty: dirty('z:' + z.id), name: zoneLabel(w, z.id) ?? z.name, cur: fmtNum(zz.cur, '°C'), set: fmtNum(zz.set, '°C'), heating: zz.set > zz.cur + 0.05, setDeco: S.pending[z.id] ? 'underline dotted' : 'none',
          dec: () => this.setZone(z.id, -0.5), inc: () => this.setZone(z.id, 0.5) };
      });
      const heating = all.filter((z) => d.zones[z.id].set > d.zones[z.id].cur + 0.05).length;
      const awayIds = ZONE_LIST.slice(0, s.zoneCount).filter((z) => presetHasAway(z.presets)).map((z) => 'climate.' + z.id);   // #148
      const range = pages > 1 ? tx('roomsRange', (page * PER_PAGE + 1) + '–' + (page * PER_PAGE + slice.length), all.length) : tx('nRooms', all.length);
      return { ...base, isZoneList: true, rows, hdrDirty: dirty('h' + i),
        summary: range + ' · ' + tx('nHeating', heating) + (s.away ? ' · ' + tx('away') : ''),
        awayOk: awayIds.length > 0, awayLabel: tx(s.away ? 'setHome' : 'setAway'),
        toggleAway: () => { const away = !S.away; this.log('climate.set_preset_mode ' + awayIds.join(',') + ' preset_mode=' + (away ? 'away' : 'home'), 'ha'); this.commit({ away }, 'presence'); } };
    }
    if (w.type === 'lightList') {
      const groups = pickLights(LIGHT_GROUPS, w); const pages = layoutGroups(groups); const shown = groups.flatMap((g) => g.ids);
      const page = pages[Math.min(sub, pages.length - 1)] || [];
      const onTotal = shown.filter((id) => d.lights[id].on).length;
      const rows = page.map((it, j) => {
        const rule = j % PER_COL === 0 ? '0' : it.kind === 'h' ? '2px solid #111' : '1px dotted #111';
        if (it.kind === 's') return { isHeader: false, isLight: false, rule: '0' };
        if (it.kind === 'h') {
          const ls = groups.find((g) => g.area === it.room)!.ids; const on = ls.filter((id) => d.lights[id].on).length;
          return { key: 'r:' + it.room + (it.cont ? ':c' : ''), dirty: dirty('r:' + it.room + (it.cont ? ':c' : '')), isHeader: true, isLight: false, rule,
            room: ROOM_NAME[it.room] + (it.cont ? ' (cont.)' : ''), count: tx('onOf', on, ls.length), toggleLabel: tx(on ? 'allOff' : 'allOn'), toggle: () => this.roomLights(it.room, ls) };
        }
        const L = LIGHT[it.id], st = d.lights[it.id];
        return { key: 'l:' + it.id, dirty: dirty('l:' + it.id), isHeader: false, isLight: true, rule, name: L.name, dimmable: L.dim, fixed: !L.dim,
          value: st.on ? (L.dim ? st.b + '%' : tx('on')) : tx('off'), trackBg: st.on ? INK : PAPER, knobBg: PAPER, knobSide: st.on ? 'flex-end' : 'flex-start',
          toggle: () => this.toggleLight(it.id), dec: () => this.dimLight(it.id, -10), inc: () => this.dimLight(it.id, 10) };
      });
      return { ...base, isLightList: true, rows, hdrDirty: dirty('h' + i), summary: tx('lightsOnOf', onTotal, shown.length), allOff: () => this.allOff() };
    }
    if (w.type === 'switch' && domainOf(String(w.entity)) === 'light' && LIGHT[String(w.entity).slice(6)]) {
      const L = LIGHT[String(w.entity).slice(6)]; const st = d.lights[L.id];
      return { ...base, isLight: true, dimmable: true, label: w.label || ROOM_NAME[L.room] + ' · ' + L.name, value: st.on ? (L.dim ? st.b + '%' : tx('on')) : tx('off'),
        trackBg: st.on ? INK : PAPER, knobBg: PAPER, knobSide: st.on ? 'flex-end' : 'flex-start',
        toggle: () => this.toggleLight(L.id), dec: () => this.dimLight(L.id, -10), inc: () => this.dimLight(L.id, 10) };
    }
    if (w.type === 'switch') {   // switch / input_boolean / fan (and lights the mock doesn't know): plain on/off toggle
      const id = String(w.entity); const st = s.ent[id]; const on = st === 'on'; const g = entityGap(st);
      return { ...base, isLight: true, dimmable: false, label: w.label || ENT_NAME[id] || id, value: g ? '' : st == null ? '—' : tx(on ? 'on' : 'off'), gap: !!g, gapText: g ? gapText(g) : '',
        trackBg: on ? INK : PAPER, knobBg: PAPER, knobSide: on ? 'flex-end' : 'flex-start', toggle: () => this.toggleEntity(id), dec: () => {}, inc: () => {} };
    }
    if (w.type === 'scene') {   // #146: a scene / script entity → <domain>.turn_on; none (or scene: all_off) → all lights off
      const id = typeof w.entity === 'string' ? w.entity : '';
      if (id) return { ...base, isScene: true, kind: tx(domainOf(id) === 'script' ? 'script' : 'scene'), label: w.label || ENT_NAME[id] || id, sub: tx('tapToRun'), run: () => this.runScene(w) };
      const on = LIGHT_LIST.filter((l) => d.lights[l.id].on).length;
      return { ...base, isScene: true, kind: tx('scene'), label: w.label || tx('allLightsOff'), sub: tx('lightsOnOf', on, LIGHT_LIST.length), run: () => this.allOff() };
    }
    if (w.type === 'setting') {
      const def = SETTINGS[w.key]; const ck = (SETTING_CFG[w.key] || w.key) as keyof Cfg;
      // a two-row tile also says what the setting does (#190)
      return { ...base, isSetting: true, label: tx(def.lk), value: def.fmt(s.cfg[ck], lg), hint: (w.rs || 1) >= 2 && def.info ? tx(def.info) : '', dec: () => this.setCfg(ck, -1), inc: () => this.setCfg(ck, 1) };
    }
    if (w.type === 'info') {
      return { ...base, isInfo: true, label: 'About', lines: [
        { k: 'Firmware', v: this.osName + ' v' + s.ota.fw },
        { k: 'Home Assistant', v: s.offline ? 'Offline' : '[HA-HOST]:8123 · mock' },
        { k: 'Display', v: s.fastCount + ' fast / ' + s.fullCount + ' clean / ' + s.partialCount + ' partial' },
      ] };
    }
    return { ...base, isStat: true, label: w.type, value: '?', unit: '', sub: tx('unknownWidget') };
  }

  renderVals() {
    const s = this.state, p = this.props;
    const h = this.hour(); const now = s.now;
    const minutes = s.simHour == null ? now.getMinutes() : 0;
    const d = this.derive(s.d, s);
    const sc: Screen = s.setup ? SETUP_SCREENS[s.setup] : s.screens[s.idx] || s.screens[0];
    const pw = sc.widgets;
    const look = this.look(s); const sleek = look !== 'classic'; const font = SK_FONTS[look];
    const ui = this.lang(s); const tx = (k: StrKey, ...a: (string | number)[]) => tr(ui, k, ...a);
    setNumFormat(numFormatOf(null, ui));
    setCurrency(this.cur(s));
    // Not linked (never, not revoked): local-only tiles stay real, the rest become ghosts under one calm card.
    const neverLinked = !s.ha.linked && !s.ha.revoked;
    const needsHa = pw.some((w) => !LOCAL.includes(w.type));
    const NOHA_TEXT: Record<string, StrKey> = { prices: 'noHaPrices', energy: 'noHaEnergy', solar: 'noHaSolar', lights: 'noHaLights', climate: 'noHaClimate', travel: 'noHaTravel' };
    let widgets: any[]; let noHa = { show: false, title: '', text: '', go: () => {} };
    if (neverLinked && sc.id === 'overview') {
      widgets = [this.vm({ type: 'clock', cs: 2, rs: 2 }, d, s, 0), this.vm({ type: 'linkCard', cs: 2, rs: 2 }, d, s, 1)];
    } else if (neverLinked && needsHa) {
      widgets = pw.map((w, i) => (LOCAL.includes(w.type) ? this.vm(w, d, s, i) : this.vm({ type: 'ghost', of: w, cs: w.cs, rs: w.rs }, d, s, i)));
      noHa = { show: true, title: tx('needsHa', sc.title), text: tx(NOHA_TEXT[sc.id] || 'noHaOther'),
        go: () => { const hi = s.screens.findIndex((x) => x.app === SETTINGS_APP.id && x.id === 'ha'); if (hi < 0) return;
          this.setState({ idx: hi, sub: 0, menu: false, ha: { ...s.ha, view: 'link', stage: 0 } }); this.fullRefresh('link'); this.log('TOUCH Link Home Assistant (from ' + sc.title + ')'); } };
    } else {
      widgets = pw.map((w, i) => this.vm(w, d, s, i));
    }
    // Display style: skin AFTER vm(), for rendering only (regions()/commit() never see it).
    widgets = widgets.map((w) => skin(w, look, h, minutes, ui));
    // Pinned tiles (col/row) keep their cell; the rest auto-place, exactly like the firmware grid.
    if (widgets.length === pw.length) {
      const cells = gridLayout(pw);
      widgets = widgets.map((w, i) => (cells[i] ? { ...w, col: cells[i]!.col, row: cells[i]!.row } : null)).filter(Boolean);
    }
    // Deep sleep: the panel keeps the clock it drew last.
    const clock = s.asleep ? s.asleep.clock : (s.cfg.clock === '12' ? String(h % 12 || 12) : pad(h)) + ':' + pad(minutes);
    const dateText = dateLine(ui, now.getDay(), now.getDate(), now.getMonth());
    const nightOn = this.nightActive(s) && s.mode === 'main';
    const peeking = this.nightHour(s) && !nightOn && !s.sleeping;
    const b = frontlightPct({ brightness: s.cfg.brightness, standby: false, night: nightOn, lightOut: s.lightOut && s.mode === 'main' }), wm = s.cfg.warmth / 100;
    const lr = Math.round(214 + 41 * wm), lg = Math.round(228 - 30 * wm), lb = Math.round(255 - 120 * wm);
    const sel = (on: boolean) => ({ bg: on ? '#1d1d1f' : '#fff', fg: on ? '#F6F5F2' : '#1d1d1f' });
    const black = (p.bodyColor ?? 'Black') !== 'White';
    const f = this.flat(s); const sub = this.curSub(s); const nSub = this.subPages(sc, s);
    const pos = Math.max(0, f.findIndex(([i, q]) => i === s.idx && q === sub));
    const chrome = this.chromeOf(s);
    const night = s.nightSnap || { inside: fmtNum(d.zones.living.cur, '°C') + '°', batt: Math.round(d.soc) + '%', cheap: pad(CHEAP) + ':00–' + pad(CHEAP + 3) + ':00', at: this.staleAt(s) };

    return {
      osName: this.osName,
      // Display style (renderVals additions from the package's CHANGES.md)
      lookClass: sleek ? 'look-sleek' : 'look-classic', isSleek: sleek, isClassic: !sleek,
      screenFont: font.t, fontD: font.d, fontS: font.s, fontK: font.k,
      gridPad: sleek ? '2px 14px 14px' : '14px', gridGap: sleek ? '10px' : '12px',
      weekday: tx(('day' + now.getDay()) as StrKey), dayMonth: now.getDate() + ' ' + tx(('month' + now.getMonth()) as StrKey),
      t: tx,
      pagesBgS: s.menu === 'pages' ? TRACK : 'transparent',
      // the app switcher is open: no page position (#151, it kept "3 / 3" of the page behind it)
      pageDots: (() => { const tot = s.setup ? 2 : f.length, cur = s.setup ? (s.setup === 'wifi' ? 0 : 1) : s.menu === 'apps' ? -1 : pos;
        return Array.from({ length: Math.min(tot, 8) }, (_, k) => ({ w: k === Math.min(cur, 7) ? 22 : 8, c: INK })); })(),
      lookOpts: LOOKS.map(([k, label]) => ({ label, ...sel(look === k), pick: () => this.setLook(k) })),
      devBatt: this.battery,
      bodyColor: black ? '#232325' : '#E9E6DF', keyColor: black ? '#6a6a6e' : '#8a877f',
      isBoot: s.mode === 'boot', isMain: s.mode === 'main', isSleeping: (s.sleeping || (!!s.asleep && !s.asleep.glance && !nightOn)) && s.mode === 'main',
      asleepLine: !s.asleep || s.asleep.glance ? '' : s.asleep.wakeAt ? tx('asleepWakes', hm(new Date(s.asleep.wakeAt))) : tx('asleepLow'),
      term: this.termVm(s),
      markInput: () => this.input(),
      // ambient (#27): the first touch only brings the chrome back; its click never reaches a button
      ambientDown: (e: React.PointerEvent) => { this.swallowClick = this.wakeChrome('TOUCH'); if (this.swallowClick) e.stopPropagation(); },
      ambientClick: (e: React.MouseEvent) => { if (!this.swallowClick) return; this.swallowClick = false; e.stopPropagation(); e.preventDefault(); },
      firstInstall: () => { this.log('SIM first install (factory fresh)', 'warn'); this.factoryReset(); },
      installed: () => this.installedSim(),
      noHaSim: () => {
        this.log('SIM Home Assistant never linked', 'warn');
        const home = s.screens.findIndex((x) => x.id === 'overview');
        this.setState({ ha: { ...s.ha, linked: false, revoked: false, view: 'status', stage: 0, running: false }, offline: true, idx: Math.max(0, home), sub: 0, menu: false });
        this.fullRefresh('not linked');
      },
      revokeKey: () => {
        if (!s.ha.linked) return;
        this.log('HA WebSocket auth_invalid · POST /auth/token refresh → 400 invalid_grant (revoked in Profile › Security)', 'warn');
        this.setState({ ha: { ...s.ha, linked: false, revoked: true, view: 'status' }, offline: true }); this.partialRefresh('status bar', ['bar']);
      },
      isOnboard: s.mode === 'onboard', isOff: s.mode === 'off',
      onboardSim: () => this.onboardSim(),
      onboardSteps: [
        ['Connect to Wi-Fi', 'Pick your network on the phone; no typing on this screen'],
        ['Link Home Assistant', 'Found automatically on your network; sign in on the phone'],
        ['Choose what to show', 'Energy comes from your Energy dashboard; pick rooms and routes'],
      ].map(([title, sub], k) => { const st = s.onboard ? s.onboard.step : 0; const done = st > k; const cur = st === k;
        return { title, sub, mark: done ? '✓' : String(k + 1), bg: done ? INK : PAPER, fg: done ? PAPER : INK, cur }; }),
      bootMsg: s.bootMsg, isUpdating: s.mode === 'updating' && !!s.upd, upd: s.upd || { version: '', pct: 0, step: '' },
      updateBadge: s.ota.status === 'available' && s.ota.auto !== 'off',
      // No message pill any more: the middle zone shows quiet icons only. Travel never appears here.
      note: { isPill: false, isQuiet: false, text: '', hasMore: false, more: '', go: () => {}, bg: PAPER, fg: INK, icon: '' },
      statusIcons: s.setup ? [] : [
        !s.ha.linked ? { d: ICON.unlinked, fill: 'none', stroke: INK, label: 'Home Assistant not linked' }
          // HA unreachable (#86): the icon + "since 14:05" (the last data), quiet; the tiles keep their last values
          : s.offline ? { d: ICON.offline, fill: 'none', stroke: INK, label: 'Home Assistant offline since ' + (s.lastUpdate ? hm(s.lastUpdate) : '—'), text: s.lastUpdate ? tx('since', hm(s.lastUpdate)) : '' } : null,
        Object.keys(s.pending).length ? { d: ICON.sync, fill: 'none', stroke: INK, label: 'Sending to tado' } : null,
        s.ota.status === 'available' && s.ota.auto !== 'off' ? { d: ICON.update, fill: 'none', stroke: INK, label: 'Update ready' } : null,
        s.ota.status === 'error' ? { d: ICON.alert, fill: 'none', stroke: INK, label: 'Update did not finish' } : null,
        s.away ? { d: ICON.away, fill: 'none', stroke: INK, label: 'Heating in away mode' } : null,
        this.nightHour(s) && !this.nightActive(s) && !s.sleeping ? { d: ICON.night, fill: INK, stroke: 'none', label: 'Night mode — night face returns shortly' } : null,
        s.cfg.brightness > 0 && !this.nightActive(s) ? { d: ICON.light, fill: 'none', stroke: INK, label: 'Front light on' } : null,
      ].filter(Boolean),
      battLow: this.battery < 20,
      swipeStart: (e: React.PointerEvent) => { this.swipe = { x: e.clientX, y: e.clientY, t: Date.now() }; },
      swipeEnd: (e: React.PointerEvent) => {
        const sw = this.swipe; this.swipe = null; if (!sw) return;
        const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - sw.t < 800) this.nav(dx < 0 ? 1 : -1, dx < 0 ? 'SWIPE ←' : 'SWIPE →');
      },
      repoLine: REPO + ' · stable ' + s.releases.stable.version + ' · beta ' + s.releases.beta.version,
      publishRelease: () => {
        const v = semver(s.releases.stable.version).n; const nv = v[0] + '.' + v[1] + '.' + (v[2] + 1);
        this.setState({ releases: { ...s.releases, stable: { version: nv, size: s.releases.stable.size, notes: ['Bug fixes from v' + s.releases.stable.version, 'Smaller redraw regions on the Energy screen'] } } });
        this.log('GitHub · tag v' + nv + ' pushed → Actions built firmware.bin → release published', 'ha');
      },
      travelOpts: [['calm', 'All good'], ['mixed', 'One of each'], ['bad', 'Bad day']].map(([k, label]) => ({ label, ...sel(s.travel === k),
        pick: () => { this.log('SIM travel → ' + label); this.commit({ travel: k }, 'travel update'); } })),
      failOpts: ([['ok', 'Works'], ['hash', 'Bad download'], ['boot', 'Won’t start']] as const).map(([k, label]) => ({ label, ...sel(s.failMode === k), pick: () => { this.setState({ failMode: k }); this.log('SIM next update → ' + label); } })),
      checkOpts: ([['ok', 'Works'], ['memory', 'Low memory'], ['busy', 'Rate limit'], ['network', 'No answer']] as const).map(([k, label]) => ({ label, ...sel(s.checkFail === k), pick: () => { this.setState({ checkFail: k }); this.log('SIM next check → ' + label); } })),
      isNight: nightOn, isPeek: peeking,
      // night face as a poster (#27): clock, date, three values; a footer only when asleep or the data was stale
      night, nightAsOf: night.at ? tx('asOf', night.at) : '',
      peek: () => { if (!this.asleepIgnores('TOUCH night face')) this.doPeek('TOUCH night face'); },
      isMenu: !!s.menu, isGrid: !s.menu,
      appTitle: s.setup ? tx('setup') : this.appDef(s, this.appOf(s)).title,
      // setup (#183): "Step 2 of 2" as the title and no pager; the arrows went nowhere until setup was done
      pageTitle: s.setup ? tx('setupStep', s.setup === 'wifi' ? 1 : 2, 2) : s.menu === 'apps' ? tx('allApps') : s.menu === 'pages' ? tx('allPages') : sc.title,
      toggleApps: () => this.setMenu('apps', 'TOUCH app title'),
      togglePages: () => this.setMenu('pages', 'TOUCH page count'),
      pagesBg: s.menu === 'pages' ? INK : PAPER, pagesFg: s.menu === 'pages' ? PAPER : INK,
      menuHeading: s.menu === 'apps' ? tx('apps') : this.appDef(s, this.appOf(s)).title + ' · ' + tx('nPages', f.length),
      screenFilter: s.render === 'mono' ? 'grayscale(1) contrast(12)' : s.render === 'gray4' ? (s.panelPreview && s.bw.length ? 'url(#x4-panel-bw)' : 'grayscale(1)') : 'none',
      bwRects: s.render === 'gray4' && s.panelPreview ? s.bw : [], regionsClass: s.showRegions ? '' : ' regions-hidden',
      flashing: !!s.flash, flashColor: s.flash || PAPER,
      lightOn: b > 0, lightColor: 'rgb(' + lr + ',' + lg + ',' + lb + ')', lightOpacity: s.sleeping ? 0 : (b / 100) * 0.5,
      clock, dateText,
      offline: s.offline, online: !s.offline,
      lastUpdate: s.lastUpdate ? hm(s.lastUpdate) : '—',
      barDirty: s.dirty.indexOf('bar') >= 0, timeDirty: s.dirty.indexOf('time') >= 0,
      screenTitle: sc.title,
      hasSub: !s.setup && !s.menu && nSub > 1 && chrome.app,
      chromeApp: chrome.app, chromePager: chrome.pager, chromeBatt: chrome.battery, chromeClock: chrome.clock, subText: tx('ofN', sub + 1, nSub),
      chevronPath: s.menu === 'apps' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6',
      pageText: s.menu === 'apps' ? '' : pos + 1 + ' / ' + f.length,
      menuItems: s.menu === 'apps'
        ? s.apps.map((a) => { const first = s.screens.findIndex((x) => x.app === a.id); const n = first < 0 ? 0 : this.flat({ ...s, idx: first }).length;
            const builtin = APP[a.id] && APP[a.id].title === a.title ? APP[a.id] : null;
            return { hasIcon: true, noIcon: false, icon: builtin ? builtin.icon : GENERIC_APP_ICON, num: '', pages: n === 1 ? tx('page1') : tx('nPages', n), title: a.title, descLines: a.title.length <= 10 ? 2 : 1,
              desc: builtin ? tx(builtin.desc) : s.screens.filter((x) => x.app === a.id).map((x) => x.title).join(', ') || tx('noScreensYet'),
              border: a.id === this.appOf(s) ? (sleek ? '3px solid #111' : '4px solid #111') : sleek ? '3px solid transparent' : '2px solid #111', go: () => this.openApp(a.id, 'TOUCH app') }; })
        : f.map(([i, q], k) => { const x = s.screens[i]; const n = this.subPages(x, s);
            return { hasIcon: false, noIcon: true, icon: '', num: String(k + 1), pages: n > 1 ? tx('partOf', q + 1, n) : '', title: x.title, descLines: x.title.length <= 10 ? 2 : 1, desc: x.widgets.length === 1 ? tx('widget1') : tx('nWidgets', x.widgets.length),
              border: i === s.idx && q === sub ? (sleek ? '3px solid #111' : '4px solid #111') : sleek ? '3px solid transparent' : '2px solid #111',
              go: () => { this.setState({ idx: i, sub: q, menu: false }); this.navRefresh('page'); this.log('TOUCH page overview → ' + x.title + (n > 1 ? ' ' + (q + 1) + '/' + n : '')); } }; }),
      menuBg: sleek ? SURF : PAPER, menuRadius: sleek ? '20px' : '10px',
      widgets, isEmpty: widgets.length === 0, noHa,
      emptyHint: tx('addWidgetsAt', s.wifi.connected ? tx('hostOr', HOST, SIM_IP) : HOST) + '.',
      standbySolar: neverLinked ? '—' : kw(d.solar).v + ' ' + kw(d.solar).u, standbyBatt: neverLinked ? '—' : Math.round(d.soc) + '%', standbyPrice: neverLinked ? '—' : money(PRICES[h]), standbyHeat: neverLinked ? '—' : tx('nRooms', d.heatingCount),
      hwPrev: () => this.recoveryKeys(KEY_LEFT, 'BTN_PREV') || this.wakeChrome('BTN_PREV') || this.nav(-1, 'BTN_PREV'),
      hwNext: () => this.recoveryKeys(KEY_RIGHT, 'BTN_NEXT') || this.wakeChrome('BTN_NEXT') || this.nav(1, 'BTN_NEXT'),
      tapPrev: () => this.nav(-1, 'TOUCH ‹'), tapNext: () => this.nav(1, 'TOUCH ›'),
      hwHome: () => this.recoveryKeys(KEY_OTHER, 'KEY_HOME') || this.wakeChrome('KEY_HOME') || this.home('KEY_HOME'), hwPower: () => this.recoveryKeys(KEY_POWER, 'BTN_POWER') || this.power(),
      recoveryOn: s.recovery.phase === 'confirm', recoveryCrash: s.recovery.crash,
      recoveryTouch: () => this.recoveryKeys(KEY_OTHER, 'TOUCH'),
      holdReset: () => this.holdResetSim(), holdRestart: () => this.holdRestartSim(), holdPower: () => this.holdPowerSim(), crashLoop: () => this.crashLoopSim(),
      hwReset: () => { this.log('BTN_RESET', 'warn'); this.boot(); },
      forceFull: () => this.fullRefresh('manual'),
      statusLine: this.appDef(s, this.appOf(s)).title + ' · page ' + (pos + 1) + '/' + f.length + ' · "' + sc.title + '"' + (nSub > 1 ? ' ' + (sub + 1) + '/' + nSub : '') + ' · ' + (s.asleep ? (s.asleep.glance ? 'glance' : 'asleep') : s.sleeping ? 'standby' : nightOn ? 'night' : s.menu ? 'index' : s.ambient ? 'ambient' : s.mode) + ' · sim ' + clock,
      hourOpts: [null, 7, 13, 19, 23].map((hv) => ({ label: hv == null ? 'Live' : pad(hv) + ':00', ...sel(s.simHour === hv),
        pick: () => { this.log('SIM time → ' + (hv == null ? 'live' : pad(hv) + ':00')); this.setState({ simHour: hv, peekUntil: 0 }, () => this.tick(false)); } })),
      zoneOpts: [4, 10, 14].map((n) => ({ label: String(n), ...sel(s.zoneCount === n), pick: () => { this.setState({ zoneCount: n, sub: 0 }); this.log('SIM tado zones → ' + n); } })),
      renderOpts: ([['gray4', '4-gray'], ['mono', '1-bit'], ['none', 'Off']] as const).map(([k, label]) => ({ label, ...sel(s.render === k), pick: () => this.setState({ render: k }) })),
      pauseLabel: s.paused ? 'Resume data' : 'Pause data',
      togglePause: () => { this.setState({ paused: !s.paused }); this.log(s.paused ? 'Mock HA stream resumed' : 'Mock HA stream paused'); },
      offlineLabel: s.offline ? 'Reconnect HA' : 'Drop HA link',
      usbLabel: s.usb ? 'Unplug USB' : 'Plug in USB', toggleUsb: () => this.setUsb(!s.usb),
      toggleOffline: () => { const off = !s.offline; this.setState({ offline: off }); this.log(off ? 'HA connection lost — showing last known values' : 'HA reconnected', off ? 'warn' : 'ha'); this.partialRefresh('status bar', ['bar']); if (!off) setTimeout(() => this.tick(false), 0); },
      panelLabel: s.panelPreview ? 'Panel preview: on' : 'Panel preview: off',
      togglePanel: () => this.setState({ panelPreview: !s.panelPreview }),
      haLangLabel: 'HA language: ' + s.haLang,
      haCurLabel: 'HA currency: ' + s.haCurrency,
      toggleHaCurrency: () => { const haCurrency = SIM_CURRENCIES[(SIM_CURRENCIES.indexOf(s.haCurrency) + 1) % SIM_CURRENCIES.length]; this.setState({ haCurrency }); this.log('SIM Home Assistant currency → ' + haCurrency + ' (get_config)'); this.fullRefresh('currency'); },
      toggleHaLang: () => { const haLang: Lang = s.haLang === 'nl' ? 'en' : 'nl'; this.setState({ haLang }); this.log('SIM Home Assistant language → ' + haLang + ' (get_config)'); this.fullRefresh('language'); },
      regionsLabel: s.showRegions ? 'Hide redraw regions' : 'Show redraw regions',
      toggleRegions: () => this.setState({ showRegions: !s.showRegions }),
      refreshStats: 'fast ' + s.fastCount + ' · clean ' + s.fullCount + ' · partial ' + s.partialCount + ' · ' + s.sinceFull + ' since clean · ' + (s.sinceFull ? 'clean at ' + hm(new Date(nextCleanMin(this.lastFullMin, s.cfg.cleanEvery) * 60000)) : 'no clean due') + (s.bw.length ? ' · B/W: ' + (s.bw.length === 1 && s.bw[0].w * s.bw[0].h === 800 * 480 ? 'whole screen' : s.bw.length + ' area' + (s.bw.length > 1 ? 's' : '')) : ''),
      log: s.log, clearLog: () => this.setState({ log: [] }),
      screenPos: 'screen ' + (s.idx + 1) + ' of ' + s.screens.length + ' · id: ' + sc.id,
      configJson: JSON.stringify({ id: sc.id, app: sc.app, title: sc.title, pages: nSub, widgets: pw.map((w: Widget, i: number) => ({ ...w, rect: rects(pw)[i] })) }, null, 2),
      capacity: cellsUsed(pw) + ' / 8 cells used',
    };
  }

  render() {
    const v = this.renderVals();
    return (
      <div style={{ width: '2708px', height: '1100px', boxSizing: 'border-box', padding: '40px', background: '#DAD8D2', display: 'flex', gap: '40px', alignItems: 'flex-start', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", color: '#1d1d1f' }}>
        {/* LEFT: device + laptop terminal */}
        <div style={{ width: '908px', flex: 'none', display: 'flex', flexDirection: 'column', gap: '40px' }}>
          <Device v={v} />
          <Terminal v={v} />
        </div>
        {/* RIGHT: dev panel */}
        <SidePanel v={v} />
        {/* WEB CONSOLE: served by the device at http://ha-paper-XXXX.local */}
        <WebConsole api={this.api} osName={v.osName} chrome />
      </div>
    );
  }
}

export type Vals = ReturnType<Emulator['renderVals']>;
