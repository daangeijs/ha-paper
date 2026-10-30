// Web console view model: port of `webVm()` from Main.dc.html. Browser-side state (tab, draft, YAML text,
// forms) lives here; everything about the display comes from / goes to `DeviceApi`.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import { PALETTE, PAL_GROUPS, ENDPOINTS, HOST, type HaEntity } from '../core/data.ts';
import { barsFor, entityGap, hm, type EntityGap } from '../core/format.ts';
import { reportLine, type ReportStatus } from '../core/haReport.ts';
import { toYaml, parseYaml, wLabel, cellsUsed, gridLayout, listOf, MAX_CELLS, MAX_APPS, MAX_USER_APPS, userConfig, BARS_SERIES, ENTITY_DOMAINS, GAUGE_DEFAULT_ENTITY, LIST_PICKS, ROUTE_MODES, type Config, type Screen, type Widget } from '../core/config.ts';
import { settingsPages, type DeviceSettings, type SettingField, type SettingsPatch } from '../core/settings.ts';
import { DEFAULT_EMPTY_SOURCE, validEmptySource } from '../core/emptyHouse.ts';
import { fmtUptime, type Diagnostics } from '../core/diag.ts';
import { armLine } from '../core/glance.ts';
import { parseHaAddress } from '../core/haAddress.ts';
import { consoleLang, tr, trMsg, trParts, type StrKey } from '../core/strings.ts';
import { DeviceUnreachableError, type DeviceApi, type DeviceSnapshot, type EntityLists, type OtaView } from './DeviceApi.ts';
import { otaLine } from '../core/otaStatus.ts';
import { HISTORY_AGGS, WINDOW_DEFAULT, historySource, parseSpan } from '../core/history.ts';
import { AGENDA_TYPES } from '../core/agenda.ts';
import { HA_NO_ANSWER } from './httpApi.ts';
import { MAX_FAVORITES, favoritesOf, parseFavorites } from '../core/media.ts';
import { setFavorites } from './configEdit.ts';
import { loadAdvPage, loadView, panelAspect, panelPlace, saveAdvPage, saveView, tileCrops, tileValueFor, useScreenPreview, useScreenValues, type AdvPage, type ScreenView } from './preview.ts';
import { CLASSIC_GRID, SLEEK_GRID } from '../core/paging.ts';
import { fromKey, logicalSource, nowLine, sharedLine, sharedWith, tileLogical } from './tileSource.ts';
import { loadPreviewSeen, savePreviewSeen } from './checklist.ts';
import { useDeviceLogs } from './logsView.ts';
import { binRows, setBinLabel, toggleBin } from './binsEdit.ts';
import { setGuestField, type GuestKey } from './guestEdit.ts';
import { fieldDecode, GUEST_PW_DOMAINS, GUEST_SECURITY } from '../core/guestWifi.ts';
import { addApp, addTile, cleanLabel, clearPicks, pickGroups, togglePick, entitiesFor, hasLabelField, pickDomains, pickedEntity, setBarsSeries, setHistoryKey, setHistorySource, historyWindows, historyIssue, agendaIssue, bucketsFor, entityIssue, entityValue, firstIssue, matches, moveApp, moveScreen, moveTile, nudgeTile, rankEntities,
  capHides, removeApp, removeTile, renameApp, resizeTile, setSceneAllOff, setTileEntity, setTileLabel, tileSize, titleIssue, type TileEdit } from './configEdit.ts';

type Tab = 'screens' | 'device' | 'advanced';
type Pal = { label: string; prefer?: string };
type Drag = { kind: 'move'; from: number } | { kind: 'new'; w: Widget; pal?: Pal } | { kind: 'screen'; from: number } | { kind: 'app'; from: number } | null;
type Local = {
  signing: boolean; tab: Tab; sel: number; selW: number; draft: Config | null; dirty: boolean;
  qScreens: string; qPalette: string; qEntity: string; newApp: string; editApp: string | null; appMsg: string; dropApp: string | null;
  settings: DeviceSettings | null; settingsMsg: { ok: boolean; text: string } | null;
  diag: Diagnostics | null; diagMsg: string; haReport: ReportStatus | null;
  /** Updates card (eink-ha-os#250): GET /ota; otaMsg = a refused POST /ota/check */
  ota: OtaView | null; otaMsg: string;
  yaml: string; yamlEdited: boolean; yamlMsg: { ok: boolean; text: string } | null;
  newName: string; newScope: 'ro' | 'rw'; reveal: { id: string; secret: string } | null;
  wifiSel: string; wifiPw: string; wifiMsg: string; wifiBusy: boolean;
  haUrl: string | null; haEdit: boolean; haMsg: string;
  canvasMsg: string; dropCell: number;
  /** A tile just added from the palette, until its entity is picked (eink-ha-os#184): named after the palette item; `prefer`
   *  domain first in the picker ("Light" adds a switch tile with lights on top). */
  pend: (Pal & { screen: string; j: number }) | null;
  /** Tile source (eink-ha-os#191): Change panel open, its search, the sign chosen before a pick, the last save. */
  srcOpen: boolean; qSrc: string; srcFlip: boolean; srcMsg: { ok: boolean; text: string; warn?: boolean } | null;
  /** Device settings (eink-ha-os#190): the Wi-Fi form unfolded, the settings whose (i) text is open. */
  wifiOpen: boolean; infoOpen: Record<string, boolean>;
};
const INITIAL: Local = { signing: false, tab: 'screens', sel: 0, selW: -1, draft: null, dirty: false,
  qScreens: '', qPalette: '', qEntity: '', canvasMsg: '', dropCell: -1, pend: null, newApp: '', editApp: null, appMsg: '', dropApp: null, settings: null, settingsMsg: null, diag: null, diagMsg: '', haReport: null, ota: null, otaMsg: '', yaml: '', yamlEdited: false, yamlMsg: null,
  srcOpen: false, qSrc: '', srcFlip: false, srcMsg: null, wifiOpen: false, infoOpen: {},
  newName: 'Laptop', newScope: 'rw', reveal: null, wifiSel: 'HomeNet', wifiPw: '', wifiMsg: '', wifiBusy: false, haUrl: null, haEdit: false, haMsg: '' };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const palOf = (it: (typeof PALETTE)[number]): Pal => ({ label: it.label, prefer: it.prefer });
/** Entities of the `prefer` domain first, otherwise in rank order (sort is stable). */
const preferFirst = (list: HaEntity[], prefer?: string): HaEntity[] =>
  prefer ? [...list].sort((a, b) => Number(b.id.startsWith(prefer + '.')) - Number(a.id.startsWith(prefer + '.'))) : list;

export function useConsole(api: DeviceApi, initial: DeviceSnapshot | null = null) {
  const [S, setS] = useState<DeviceSnapshot | null>(initial);
  const [W, setW] = useState<Local>(INITIAL);
  const drag = useRef<Drag>(null);
  const setWeb = useCallback((patch: Partial<Local>) => setW((w) => ({ ...w, ...patch })), []);

  // ---- device state (emulator: on every change; HTTP: polling) ----
  useEffect(() => {
    let alive = true;
    const pull = () => api.getState().then((s) => { if (alive) setS(s); }, (e) => { if (alive && e instanceof DeviceUnreachableError) setS(null); });
    pull();
    const off = api.subscribe(pull);
    return () => { alive = false; off(); };
  }, [api]);
  // New config applied anywhere (this console, the API, the CLI) → drop the draft (as pushConfig did).
  const rev = S?.configRev;
  useEffect(() => { setW((w) => ({ ...w, draft: null, dirty: false, yamlEdited: false, selW: -1 })); }, [rev]);
  // Factory reset → forget everything browser-side.
  const installId = S?.installId;
  useEffect(() => { setW((w) => ({ ...w, draft: null, dirty: false, reveal: null, wifiPw: '', wifiMsg: '', haUrl: null, haEdit: false, haMsg: '' })); }, [installId]);

  // Settings is built into the display (eink-ha-os#159): an older firmware's settings app / screens never reach the editor
  const live: Config = userConfig({ apps: S ? S.apps : [], screens: S ? S.screens : [] });
  const cfg = W.draft || live; const draft = cfg.screens;
  const sel = Math.max(0, Math.min(W.sel, draft.length - 1)); const cur: Screen | undefined = draft[sel];
  // Before Wi-Fi the display is not on the home network: the browser can't reach it (unless a phone joined its setup hotspot).
  const phase = !S ? 'unreachable' : S.setup === 'wifi' ? 'setup' : !S.ha.linked ? 'link' : S.session.signedIn ? 'in' : 'out';
  const seg = (on: boolean) => ({ bg: on ? '#1d1d1f' : '#fff', fg: on ? '#fff' : '#1d1d1f' });
  const used = cur ? cellsUsed(cur.widgets) : 0;
  const selW = cur && W.selW < cur.widgets.length ? W.selW : -1; const sw = selW >= 0 && cur ? cur.widgets[selW] : null;
  const ob = S?.setup === 'wifi' ? 0 : S?.setup === 'web' ? 1 : 2;
  const yamlText = W.yamlEdited ? W.yaml : toYaml(cfg);
  const gmap: Record<string, typeof PALETTE> = {}; PALETTE.filter((it) => matches(W.qPalette, it.label, it.w.type)).forEach((it) => { const g = (PAL_GROUPS.find((p) => p[0] === it.kind) || [0, 'Other'])[1]; (gmap[g] = gmap[g] || []).push(it); });
  const setDrag = (e: DragEvent, d: Drag) => { drag.current = d; try { e.dataTransfer.setData('text/plain', 'widget'); e.dataTransfer.effectAllowed = 'move'; } catch { /* ignore */ } };
  const user = S ? S.session.user || S.ha.user : '';
  // eink-ha-os#98: HA's language while linked, else the browser's; English for anything but Dutch
  const lang = consoleLang(S, typeof navigator === 'undefined' ? '' : navigator.language);
  const t = (k: StrKey, ...a: (string | number)[]) => tr(lang, k, ...a);
  /** English from the device API, the screen editor or a shared table, in the console language (eink-ha-os#111). */
  const tm = (s: string) => trMsg(lang, s);
  // Signed in as a Home Assistant user who is not an admin: read scope only (issue eink-ha-os#22).
  const viewOnly = phase === 'in' && !S!.session.admin;
  // An unpushed draft (eink-ha-os#183): the browser asks before a reload or close drops it.
  const unsaved = (W.dirty || W.yamlEdited) && !viewOnly;
  useEffect(() => {
    if (!unsaved) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [unsaved]);
  // Screens view (eink-ha-os#83, eink-ha-os#122): Names = tile names, Values = each tile's live value as the display formats it (every 5 s).
  const [view, setView] = useState<ScreenView>(loadView);
  const [advPage, setAdvPage] = useState<AdvPage>(loadAdvPage);
  const logsVm = useDeviceLogs(api, phase === 'in' && W.tab === 'advanced' && advPage === 'logs', t, tm);
  const values = phase === 'in' && W.tab === 'screens' && view === 'values';
  const pushedSc = cur && S ? S.screens.find((x) => x.id === cur.id) : undefined; const pushed = !!pushedSc;
  const { lv, err: lvErr } = useScreenValues(api, values && pushed ? cur!.id : null, rev);
  const liveValue = (w: Widget, j: number) => (values && lv && pushedSc ? tileValueFor(w, pushedSc.widgets[j], lv.values[j]) : '');
  // eink-ha-os#189: each card shows its tile cropped from the display's own render (grid per display style, so after settings)
  const shot = useScreenPreview(api, values && pushed ? cur!.id : null, rev);
  const grid = W.settings?.display.style === 'sleek' ? SLEEK_GRID : CLASSIC_GRID;
  const crops = shot && pushedSc && cur && W.settings ? tileCrops(cur.widgets, pushedSc.widgets, grid) : [];
  const place = (col: number, row: number, cs: number, rs: number) => (values ? panelPlace(grid, col, row, cs, rs) : null);
  // First-run checklist (eink-ha-os#91): "preview checked" once the Values view was open in this browser.
  const [previewSeen, setPreviewSeen] = useState(loadPreviewSeen);
  useEffect(() => { if (values && !previewSeen) { setPreviewSeen(true); savePreviewSeen(); } }, [values, previewSeen]);

  const webEdit = (fn: (d: Screen[], c: Config) => boolean | void) => {
    setW((w) => {
      const c = clone(w.draft || live); const d = c.screens;
      if (fn(d, c) === false) return w;
      return { ...w, draft: c, dirty: true, yamlEdited: false, yamlMsg: null };
    });
  };
  /** Apply a pure Config edit (configEdit.ts); a string result is shown as the sidebar message. */
  const cfgEdit = (fn: (c: Config) => Config | string, extra: Partial<Local> = {}) => {
    const r = fn(cfg);
    if (typeof r === 'string') { setWeb({ appMsg: tm(r) }); return; }
    setW((w) => ({ ...w, ...extra, draft: r, dirty: true, yamlEdited: false, yamlMsg: null, appMsg: '' }));
  };
  // ---- screen canvas: tiles sit on a 4 × 2 grid (core gridLayout); dragging pins them to a cell (col/row) ----
  const warn = (m: string) => { setWeb({ canvasMsg: tm(m), dropCell: -1 }); api.trace('WEB ' + m, 'warn'); };
  const commit = (ws: Widget[], selected: number) => {
    webEdit((d) => { d[sel].widgets = ws; });
    // the pending palette name follows its tile while that tile is the one edited (a move keeps it selected)
    setW((w) => ({ ...w, selW: selected, canvasMsg: '', dropCell: -1, pend: w.pend && w.pend.j === w.selW && selected >= 0 ? { ...w.pend, j: selected } : null }));
  };
  /** Apply a tile edit (configEdit.ts) to the current screen; a string is shown above the canvas. */
  const tileEdit = (r: TileEdit, selected?: number) => { if (typeof r === 'string') warn(r); else commit(r.ws, selected ?? r.sel); };
  const resizeSel = (k: 'cs' | 'rs', n: number) => { if (cur && cur.widgets[selW]) tileEdit(resizeTile(cur.widgets, selW, k, n)); };
  /** New tile: entity widgets stay selected so the user picks which Home Assistant entity it shows. */
  const addNew = (w: Widget, cell?: [number, number], pal?: Pal) => {
    if (!cur) return;
    const r = addTile(cur.widgets, w, cell);
    tileEdit(r, typeof r === 'string' || !(pickDomains(w.type) || w.type === 'guestWifi') ? -1 : r.sel);   // eink-ha-os#329: guest Wi-Fi opens its fields
    if (typeof r !== 'string' && pickDomains(w.type)) setWeb({ qEntity: '', pend: pal ? { ...pal, screen: cur.id, j: r.sel } : null });
  };
  const removeAt = (j: number) => { if (!cur || !cur.widgets[j]) return; commit(removeTile(cur.widgets, j), -1); };
  type Target = { cell: [number, number] } | { tile: number } | null;
  const dropAt = (t: Target) => {
    const d = drag.current; drag.current = null; setWeb({ dropCell: -1 }); if (!d || !cur) return;
    if (d.kind === 'screen' || d.kind === 'app') return;
    if (d.kind === 'move') { if (t && !('tile' in t && t.tile === d.from)) tileEdit(moveTile(cur.widgets, d.from, t)); return; }
    addNew(d.w, t && 'cell' in t ? t.cell : undefined, d.pal);
  };
  // Screen list drag & drop: a screen onto a category header / before another screen; a category onto another category.
  const dropScreen = (app: string, before: number | null) => {
    const d = drag.current; drag.current = null; setWeb({ dropApp: null }); if (!d) return;
    if (d.kind === 'screen') { const r = moveScreen(cfg, d.from, app, before); cfgEdit(() => r.cfg, { sel: r.index, selW: -1 }); }
    else if (d.kind === 'app' && before == null) { const to = cfg.apps.findIndex((a) => a.id === app); if (to >= 0 && to !== d.from) cfgEdit((c) => moveApp(c, d.from, to)); }
  };
  const pushConfig = (c: Config, src: string) => api.putConfig(c, src);

  // ---- Home Assistant entities for the picker (GET /ha/entities; not ready yet → retry every 2 s) ----
  const [ents, setEnts] = useState<{ ready: boolean; list: HaEntity[]; areas: { id: string; name: string }[]; lists?: EntityLists; error: string }>({ ready: false, list: [], areas: [], error: '' });
  const [fav, setFav] = useState({ name: '', target: '' });   // media tile: the favorite being added (eink-ha-os#319)
  const [guestShow, setGuestShow] = useState(false);   // guest Wi-Fi tile: password field shown plain (eink-ha-os#329)
  const signedIn = phase === 'in';
  useEffect(() => {
    if (!signedIn) return;
    let alive = true; let t: ReturnType<typeof setTimeout> | undefined;
    const pull = () => api.listEntities().then(
      (r) => { if (!alive) return; setEnts({ ready: r.ready, list: r.entities, areas: r.areas || [], lists: r.lists, error: '' }); if (!r.ready) t = setTimeout(pull, 2000); },
      (e: Error) => { if (!alive) return; setEnts((x) => ({ ...x, error: e.message || 'The display did not answer' })); t = setTimeout(pull, 2000); });
    pull();
    return () => { alive = false; clearTimeout(t); };
  }, [api, signedIn, S?.ha.linked]);
  const names: Record<string, string> = {}; ents.list.forEach((e) => { names[e.id] = e.name; });
  /** Tile name: the user's label or HA's name as is, our own default names in the console language. */
  const wName = (w: Widget) => { const n = wLabel(w, names); const e = pickedEntity(w); return w.label || (e && names[e] === n) ? n : tm(n); };
  const pendAt = (j: number) => (W.pend && cur && W.pend.screen === cur.id && W.pend.j === j && cur.widgets[j] && !pickedEntity(cur.widgets[j]) ? W.pend : null);
  /** Tile `j` of the current screen: wName, or the palette item's name while its entity is not picked yet (eink-ha-os#184). */
  const nameAt = (w: Widget, j: number) => { const p = pendAt(j); return p && !w.label ? tm(p.label) : wName(w); };
  // No value in HA (eink-ha-os#86): the display's live view for entities on pushed screens (entity_gaps), else the entity list's
  // state (read at most 5 min ago) for one only in the draft.
  const onPanel = new Set(live.screens.flatMap((x) => x.widgets.map((w) => w.entity)));
  const gapOf = (id: unknown): EntityGap | null => typeof id !== 'string' ? null
    : onPanel.has(id) ? S?.entityGaps[id] ?? null : entityGap(ents.list.find((e) => e.id === id)?.state);
  /** The display's subscription cap hides some of an unpicked list's lights / rooms (eink-ha-os#134): the note, else ''. */
  const capNote = (w: Widget) => { const c = capHides(w, ents.lists); return c ? t(w.type === 'lightList' ? 'capLights' : 'capRooms', ...c) : ''; };
  const gapWord = (g: EntityGap, inHa = false) => t(g === 'unavailable' ? (inHa ? 'gapUnavailableHa' : 'gapUnavailable') : inHa ? 'gapUnknownHa' : 'gapUnknown');
  const selIssue = (w: Widget) => {
    const e = entityIssue(w, ents.ready ? ents.list : null); if (e) return { ...e, msg: tm(e.msg) };
    const g = ENTITY_DOMAINS[w.type] && w.type !== 'scene' ? gapOf(w.entity) : null;   // a scene is unknown until it first runs
    return g ? { msg: t('gapNote', gapWord(g).toLowerCase()), hard: false } : null;
  };

  // ---- display settings (Device settings tab) and the selected tile's source (logical id → HA entity, eink-ha-os#191) ----
  const onDevice = signedIn && W.tab === 'device';
  const selLogical = signedIn && W.tab === 'screens' && sw ? tileLogical(sw) : null;
  const onSource = !!selLogical;
  useEffect(() => {
    if (!onDevice && !onSource && !values) return;
    const pull = () => api.getSettings().then((st) => setWeb({ settings: st }), (e: Error) => setWeb({ settingsMsg: { ok: false, text: tm(e.message) } }));
    pull();
    // entity_sources follow a change asynchronously (the display remaps once HA answers): keep them fresh
    const t = onSource ? setInterval(pull, 4000) : undefined;
    return () => clearInterval(t);
  }, [api, onDevice, onSource, values, rev]);
  const loadDiag = () => api.getDiagnostics().then((d) => setWeb({ diag: d, diagMsg: '' }), (e: Error) => setWeb({ diagMsg: e.message }));
  const loadReport = () => api.getHaReport().then((r) => setWeb({ haReport: r }), () => setWeb({ haReport: null }));
  useEffect(() => { if (onDevice) { loadDiag(); loadReport(); } }, [api, onDevice, rev]);
  const loadOta = useCallback(() => api.getOta().then((o) => setWeb({ ota: o }), () => {}), [api, setWeb]);
  // a check runs on the display for a few seconds: follow it until the result is in
  const otaChecking = W.ota?.status === 'checking';
  useEffect(() => {
    if (!onDevice) return;
    loadOta();
    const t = otaChecking ? setInterval(loadOta, 1000) : undefined;
    return () => clearInterval(t);
  }, [loadOta, onDevice, otaChecking]);
  const putSetting = (f: SettingField, value: string | number | boolean) => {
    const key = f.key;
    api.putSettings((f.top ? { [key]: value } : { display: { [key]: value } }) as SettingsPatch).then(
      (st) => { setWeb({ settings: st, settingsMsg: { ok: true, text: t('saved') } }); if (key === 'haReport') loadReport(); },
      (e: Error) => setWeb({ settingsMsg: { ok: false, text: t('notSaved', tm(e.message)) } }));
  };
  // a source pick applies at once (PUT /settings `entities`); Done only folds the panel
  const putEntity = (patch: SettingsPatch, done: string, warn = false) => {
    api.putSettings(patch).then(
      (st) => setWeb({ settings: st, srcMsg: { ok: true, text: done, warn } }),
      (e: Error) => setWeb({ srcMsg: { ok: false, text: t('notSaved', tm(e.message)) } }));
  };
  const srcL = selLogical ? logicalSource({ id: selLogical, settings: W.settings, list: ents.list, ready: ents.ready, q: W.qSrc, flip: W.srcFlip, t, tm, put: putEntity }) : null;
  // other tiles reading the same logical id, named like the editor names them (another screen's in brackets)
  const sharedNames = sw && cur ? sharedWith(cfg, sel, selW).map((o) => (o.screen === sel ? nameAt(cur.widgets[o.tile], o.tile) : wName(draft[o.screen].widgets[o.tile]) + ' (' + draft[o.screen].title + ')')) : [];
  const swEntity = sw ? pickedEntity(sw) : '';
  const srcHard = !!sw && !!selIssue(sw)?.hard;
  const webHaSignIn = (src: string, haUrl?: string) => {
    if (W.signing) return;
    setWeb({ signing: true, haMsg: '' });
    api.signInWithHa(src, haUrl).then(() => setWeb({ signing: false, yamlEdited: false, tab: 'screens' }),
      (e: Error) => setWeb({ signing: false, haMsg: e.message === HA_NO_ANSWER ? t('haNoAnswer') : tm(e.message) || t('signInFailed'), haEdit: true }));
  };
  // Link page address (eink-ha-os#54): "Found … on your network" only for an mDNS answer; a typed one is "Home Assistant at …".
  const haServer = S ? S.ha.server : '';
  const haLabel = haServer.replace(/^http:\/\//, '');
  const haAsk = !!S && !S.ha.linked && (!haServer || W.haEdit);   // linked: the display uses its own server
  const haField = W.haUrl ?? haLabel;
  const linkSignIn = (src: string) => {
    if (!haAsk) return webHaSignIn(src);
    const a = parseHaAddress(haField);
    if ('error' in a) { setWeb({ haMsg: tm(a.error) }); return; }
    webHaSignIn(src, haField.trim());
  };
  const webWifiConnect = () => {
    if (!S) return;
    const ssid = W.wifiSel; const net = S.networks.find((n) => n.ssid === ssid);
    const saved = S.wifi.saved.includes(ssid);
    if (net && net.secure && !saved && W.wifiPw.length < 8) { setWeb({ wifiMsg: t('wifiPwShort') }); return; }
    setWeb({ wifiBusy: true, wifiMsg: '' });
    api.wifiConnect(ssid, W.wifiPw).then(
      () => setWeb({ wifiBusy: false, wifiPw: '', wifiMsg: '' }),
      (e: Error) => setWeb({ wifiBusy: false, wifiMsg: tm(e.message) || t('wrongPassword'), wifiPw: '' }));
  };

  const hostname = S?.hostname || HOST;   // HOST only while the display can't be reached (emulator)
  const web = {
    host: phase === 'setup' ? '192.168.4.1' : hostname, hostname,
    lang, t, tp: (k: StrKey) => trParts(lang, k),
    isUnreachable: phase === 'unreachable',
    path: phase === 'unreachable' ? '' : phase === 'setup' ? '/setup' : phase === 'link' ? (S!.setup ? '/setup' : '/link') : phase === 'out' ? '/' : ({ screens: '/screens', device: '/device', advanced: '/advanced' })[W.tab],
    fw: S ? S.firmware : '', deviceName: S ? S.name : '', user, haServer: S ? S.ha.server : '',
    isSetup: phase === 'setup', isLink: phase === 'link', isOut: phase === 'out', isIn: phase === 'in',
    signLabel: t(W.signing ? 'signWaiting' : 'signIn'),
    signIn: () => linkSignIn('GET /login'),
    reload: () => { api.reload(); },
    linkTitle: t(S?.setup ? 'finishSetup' : 'linkHa'),
    // Link page (eink-ha-os#55): one sentence, the address, the button; the rest behind two disclosures.
    haFound: !haAsk && !!S && S.ha.discovered.includes(haServer), haKnown: !haAsk && !!S && !S.ha.discovered.includes(haServer), haAsk,
    haLabel, haField, haMsg: W.haMsg, hasHaMsg: !!W.haMsg,
    setHaField: (e: ChangeEvent<HTMLInputElement>) => setWeb({ haUrl: e.target.value, haMsg: '' }),
    haChange: () => setWeb({ haEdit: true, haUrl: haLabel, haMsg: '' }),
    // What the stored key can do (issue eink-ha-os#22).
    keyTitle: t('keyTitle'),
    keyText: t('keyText'),
    advancedTitle: t('advancedTitle'),
    advancedText: t('advancedText'),
    viewOnly,
    viewOnlyText: t('viewOnlyText', user),
    signInAdmin: () => { api.signOut().catch(() => undefined).then(() => webHaSignIn('GET /login (admin)')); },
    linkText: t(S?.setup ? 'linkTextSetup' : 'linkText'),
    // setup wizard (also handles Wi-Fi + linking)
    setupSteps: [t('stepWifi'), 'Home Assistant', t('stepDone')].map((l, k) => ({ label: l, mark: ob > k ? '✓' : String(k + 1), ...seg(ob >= k) })),
    sWifi: ob === 0, sHa: ob === 1, sDone: ob >= 2,
    nets: (S ? S.networks : []).map((n) => ({ ssid: n.ssid,
      info: t('netSignal', t((['sigWeak', 'sigFair', 'sigGood', 'sigExcellent'] as const)[barsFor(n.rssi) - 1]).toLowerCase()) + ' · ' + t(n.secure ? 'netPassword' : 'netOpen') + (S!.wifi.connected === n.ssid ? ' · ' + t('netConnected') : S!.wifi.saved.includes(n.ssid) ? ' · ' + t('netSaved') : ''),
      border: W.wifiSel === n.ssid ? '2px solid #1d1d1f' : '1px solid #d3d0c8', bg: W.wifiSel === n.ssid ? '#F6F5F2' : '#fff',
      pick: () => setWeb({ wifiSel: n.ssid, wifiMsg: '' }) })),
    wifiPw: W.wifiPw, setWifiPw: (e: ChangeEvent<HTMLInputElement>) => setWeb({ wifiPw: e.target.value, wifiMsg: '' }), wifiConnect: webWifiConnect,
    wifiLabel: W.wifiBusy ? t('connecting') : t('connectTo', W.wifiSel), wifiMsg: W.wifiMsg, hasWifiMsg: !!W.wifiMsg,
    haSignIn: () => linkSignIn('setup sign-in'),
    finish: () => { api.finishSetup().then(() => setWeb({ tab: 'screens' })); },
    // header
    tabs: ([['screens', 'tabScreens'], ['device', 'tabDeviceSettings'], ['advanced', 'tabAdvanced']] as [Tab, StrKey][]).map(([k, key]) => ({ label: t(key), bg: W.tab === k ? '#1d1d1f' : 'transparent', fg: W.tab === k ? '#fff' : '#3d3c39', pick: () => setWeb({ tab: k }) })),
    dirty: W.dirty && !viewOnly, stateText: t(viewOnly ? 'viewOnly' : W.dirty ? 'draft' : 'live'), stateColor: viewOnly ? '#5c5a55' : W.dirty ? '#9A4A00' : '#1E6B35',
    pushBg: W.dirty ? '#1d1d1f' : '#e3e0d9', pushFg: W.dirty ? '#fff' : '#6f6c66',
    push: () => {
      if (!W.dirty) return;
      // a hard field error (empty title, tile without entity): show it at the field instead of pushing
      const bad = firstIssue(cfg, ents.ready ? ents.list : null);
      if (bad) { if (view === 'values') setView('names'); setWeb({ tab: 'screens', sel: bad.screen, selW: bad.tile, canvasMsg: t('notPushed', tm(bad.msg)) }); return; }
      pushConfig(cfg, 'web console · ' + user).catch((e: Error) => setWeb({ yamlMsg: { ok: false, text: t('notPushed', tm(e.message)) }, canvasMsg: t('notPushed', tm(e.message)) }));
    },
    discard: () => setWeb({ draft: null, dirty: false, yamlEdited: false, yamlMsg: null, selW: -1 }),
    signOut: () => { api.signOut(); },
    // HA unreachable (eink-ha-os#86): one calm line under the header; the display keeps its last values
    haDown: phase === 'in' && !!S && S.offline && S.ha.linked && !!S.wifi.connected, haDownText: t('haDown'),
    // screens
    isScreens: W.tab === 'screens',
    /** Screens tab on screen `id` (the first screen when there is none): the seed report's "Pick one" (eink-ha-os#89). */
    configRev: rev ?? 0,
    offline: !!S?.offline, previewSeen,
    showValues: () => { setView('values'); saveView('values'); setWeb({ tab: 'screens', selW: -1 }); },
    openDevice: () => setWeb({ tab: 'device' }),
    openScreen: (id: string) => setWeb({ tab: 'screens', sel: Math.max(0, draft.findIndex((s) => s.id === id)), selW: -1, qScreens: '' }),
    screenViews: ([['names', 'viewNames'], ['values', 'viewValues']] as [ScreenView, StrKey][]).map(([k, key]) => ({ label: t(key), on: view === k, ...seg(view === k),
      pick: () => { setView(k); saveView(k); setWeb({ selW: -1 }); } })),
    isValues: values, panelAspect: panelAspect(grid),
    pvLine: !values ? '' : !pushed ? t('pvNotPushed')
      : lvErr ? t('pvNoValues', tm(lvErr.text))
      : lv ? t('pvLive', hm(lv.at) + ':' + String(lv.at.getSeconds()).padStart(2, '0')) + (W.dirty ? ' · ' + t('pvPushedVersion') : '') : t('loading'),
    qScreens: W.qScreens, setQScreens: (e: ChangeEvent<HTMLInputElement>) => setWeb({ qScreens: e.target.value }),
    apps: cfg.apps.map((a, ai) => {
      const all = draft.map((x, i) => ({ x, i })).filter((o) => o.x.app === a.id);
      const shown = all.filter((o) => matches(W.qScreens, o.x.title, o.x.id));
      return { id: a.id, title: a.title, count: all.length === 1 ? t('screen1') : t('nScreens', all.length),
        hidden: !!W.qScreens.trim() && !shown.length && !matches(W.qScreens, a.title),
        editing: W.editApp === a.id, canDelete: !all.length && cfg.apps.length > 1,
        dropBg: W.dropApp === a.id ? '#ECEBE5' : 'transparent',
        startEdit: () => setWeb({ editApp: a.id }),
        rename: (e: ChangeEvent<HTMLInputElement>) => { const v = e.target.value; if (v.trim()) cfgEdit((c) => renameApp(c, a.id, v)); },
        endEdit: () => setWeb({ editApp: null }),
        remove: () => cfgEdit((c) => removeApp(c, a.id)),
        addScreen: () => {
          const id = 'screen_' + (Date.now() % 100000); let at = -1; draft.forEach((x, i) => { if (x.app === a.id) at = i; });
          const idx = at >= 0 ? at + 1 : draft.length;
          webEdit((d) => { d.splice(idx, 0, { id, app: a.id, title: t('newScreen'), widgets: [] }); }); setWeb({ sel: idx, selW: -1, qScreens: '' });
        },
        dragStart: (e: DragEvent) => setDrag(e, { kind: 'app', from: ai }),
        dragOver: (e: DragEvent) => { e.preventDefault(); if (W.dropApp !== a.id) setWeb({ dropApp: a.id }); },
        dragLeave: () => setWeb({ dropApp: null }),
        drop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); dropScreen(a.id, null); },
        screens: shown.map((o) => ({ title: o.x.title, count: String(o.x.widgets.length), bg: o.i === sel ? '#1d1d1f' : 'transparent', fg: o.i === sel ? '#fff' : '#1d1d1f',
          pick: () => setWeb({ sel: o.i, selW: -1 }),
          dragStart: (e: DragEvent) => setDrag(e, { kind: 'screen', from: o.i }),
          drop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); dropScreen(a.id, o.i); } })) };
    }),
    noScreenMatch: !!W.qScreens.trim() && !draft.some((x) => matches(W.qScreens, x.title, x.id)),
    newApp: W.newApp, setNewApp: (e: ChangeEvent<HTMLInputElement>) => setWeb({ newApp: e.target.value, appMsg: '' }),
    canAddApp: cfg.apps.length < MAX_USER_APPS, appLimit: t('appLimit', MAX_APPS),
    addApp: () => cfgEdit((c) => addApp(c, W.newApp), { newApp: '' }),
    appMsg: W.appMsg,
    curTitle: cur ? cur.title : '', titleErr: cur ? tm(titleIssue(cur.title)?.msg || '') : '', rename: (e: ChangeEvent<HTMLInputElement>) => { const v = e.target.value; webEdit((d) => { d[sel].title = v; }); },
    capacity: t('cellsUsed', used), deleteScreen: () => { if (draft.length <= 1) return; webEdit((d) => { d.splice(sel, 1); }); setWeb({ sel: Math.max(0, sel - 1), selW: -1 }); },
    allowDrop: (e: DragEvent) => e.preventDefault(),
    canvasMsg: W.canvasMsg, closeCanvasMsg: () => setWeb({ canvasMsg: '' }),
    // drop targets: all 8 cells (tiles are drawn on top of the occupied ones)
    cells: Array.from({ length: 8 }, (_, k) => {
      const col = (k % 4) + 1, row = Math.floor(k / 4) + 1;
      return { col, row, place: place(col, row, 1, 1), border: W.dropCell === k ? '2px solid #1d1d1f' : '1.5px dashed #c2beb5', bg: W.dropCell === k ? '#F6F5F2' : 'transparent',
        over: (e: DragEvent) => { e.preventDefault(); if (W.dropCell !== k) setWeb({ dropCell: k }); },
        leave: () => setWeb({ dropCell: -1 }),
        drop: (e: DragEvent) => { e.preventDefault(); dropAt({ cell: [col, row] }); } };
    }),
    unplaced: cur ? gridLayout(cur.widgets).filter((c) => !c).length : 0,
    blocks: cur ? gridLayout(cur.widgets).map((c, j) => ({ c, w: cur.widgets[j], j })).filter((o) => o.c).map(({ c, w, j }) => ({ j, col: c!.col, row: c!.row, cs: c!.cs, rs: c!.rs, place: place(c!.col, c!.row, c!.cs, c!.rs), name: liveValue(w, j) || nameAt(w, j),
      // eink-ha-os#184: no widget type, size or entity id on the card; the names are HA's friendly names
      sub: liveValue(w, j) ? nameAt(w, j) : capNote(w) || (gapOf(w.entity) ? gapWord(gapOf(w.entity)!, true) : ''), border: j === selW ? '3px solid #1d1d1f' : '1.5px solid #1d1d1f', bg: j === selW ? '#F6F5F2' : '#fff',
      on: j === selW, bad: !!entityIssue(w, ents.ready ? ents.list : null)?.hard || !!historyIssue(w) || !!agendaIssue(w),
      aria: nameAt(w, j) + (liveValue(w, j) ? ', ' + liveValue(w, j) : '') + ', ' + tileSize(w) + ', column ' + c!.col + ', row ' + c!.row,
      crop: crops[j] && shot ? { url: shot.url, box: `${crops[j]!.x} ${crops[j]!.y} ${crops[j]!.w} ${crops[j]!.h}` } : null,
      select: () => setWeb({ selW: j === selW ? -1 : j, srcOpen: false, qSrc: '', srcFlip: false, srcMsg: null }),
      // keyboard (eink-ha-os#84; tiles are buttons, so Enter / Space select): arrows move one cell (onto a tile = swap),
      // Delete / Backspace remove, Escape deselects
      key: (e: KeyboardEvent) => {
        const arrow: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrow[e.key]) { e.preventDefault(); tileEdit(nudgeTile(cur.widgets, j, ...arrow[e.key])); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeAt(j); }
        else if (e.key === 'Escape') setWeb({ selW: -1 });
      },
      dragStart: (e: DragEvent) => setDrag(e, { kind: 'move', from: j }),
      drop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); dropAt({ tile: j }); } })) : [],
    hasSel: !!sw, selName: sw ? nameAt(sw, selW) : '',
    // list picker (eink-ha-os#127): which lights / areas a lightList shows, which climate entities a zoneList shows
    hasListPicker: !!sw && !!LIST_PICKS[sw.type],
    listTitle: sw ? t(sw.type === 'lightList' ? 'pickLights' : AGENDA_TYPES.includes(sw.type) ? 'pickCalendars' : 'pickRooms') : '',
    listCount: sw && LIST_PICKS[sw.type] ? (() => { const n = Object.keys(LIST_PICKS[sw.type]).reduce((a, k) => a + listOf(sw, k).length, 0);
      return n ? t('pickCount', n) : capNote(sw) || t(sw.type === 'lightList' ? 'pickAllLights' : AGENDA_TYPES.includes(sw.type) ? 'pickCalendarHint' : 'pickAllRooms'); })() : '',
    listPicked: !!sw && !!LIST_PICKS[sw.type] && !AGENDA_TYPES.includes(sw.type) && Object.keys(LIST_PICKS[sw.type]).some((k) => listOf(sw, k).length),
    listShowAll: t('pickShowAll'), listSearch: t('pickSearch'), listAreaLabel: t('pickArea'),
    clearList: () => { if (cur) commit(clearPicks(cur.widgets, selW), selW); },
    listGroups: sw && LIST_PICKS[sw.type] ? pickGroups(ents.list, ents.areas, sw, W.qEntity, t('pickNoArea')).map((g) => ({ ...g,
      toggle: () => { if (cur && g.area) commit(togglePick(cur.widgets, selW, 'areas', g.area), selW); },
      rows: g.rows.map((r) => ({ ...r, toggle: () => { if (cur && !r.viaArea) commit(togglePick(cur.widgets, selW, 'entities', r.id), selW); } })) })) : [],
    listEmpty: ents.ready && !!sw && !!LIST_PICKS[sw.type] && !pickGroups(ents.list, ents.areas, sw, W.qEntity, '').length,
    // bin day tile (eink-ha-os#317): tick each bin's sensor, name it
    hasBinsPicker: !!sw && sw.type === 'bins', binsTitle: t('pickBins'), binsHint: t('pickBinsHint'),
    binRows: sw && sw.type === 'bins' ? binRows(ents.list, sw, W.qEntity).map((r) => ({ ...r, nameLabel: t('binName', r.name),
      toggle: () => { if (cur) commit(toggleBin(cur.widgets, selW, r.id), selW); },
      setLabel: (e: ChangeEvent<HTMLInputElement>) => { if (cur) commit(setBinLabel(cur.widgets, selW, r.id, e.target.value, true), selW); } })) : [],
    // entity picker (stat / gauge / switch)
    hasPicker: !!sw && !!pickDomains(sw.type, sw),
    pickerHint: sw && pickDomains(sw.type, sw) ? t('pickerHint', pickDomains(sw.type, sw)!.join(', ')) : '',
    entLoading: !ents.ready, entError: ents.error, entStatus: ents.error ? t('retrying', tm(ents.error))
      : S && !S.ha.linked ? t('notLinkedNoList')
        : S && S.offline ? t('haDownList')
          : t('loadingHa'),
    qEntity: W.qEntity, setQEntity: (e: ChangeEvent<HTMLInputElement>) => setWeb({ qEntity: e.target.value }),
    // best fit for the widget first (configEdit rankEntities), with HA's value when the list was read
    entities: sw && pickDomains(sw.type, sw) ? [
      // scene tile (eink-ha-os#146): the built-in all lights off first (no entity), then HA's scenes and scripts
      ...(sw.type === 'scene' && matches(W.qEntity, t('allLightsOff'), 'all_off') ? [{ id: 'all_off', name: t('allLightsOff'), value: t('sceneBuiltIn'), on: !sw.entity }] : []).map((r) => ({ ...r,
        bg: r.on ? '#1d1d1f' : '#fff', fg: r.on ? '#fff' : '#1d1d1f', sub: r.on ? '#d9d6ce' : '#5c5a55', pick: () => { if (cur) commit(setSceneAllOff(cur.widgets, selW), selW); } })),
      ...preferFirst(rankEntities(ents.list, sw.type, W.qEntity, sw), pendAt(selW)?.prefer).slice(0, 200).map((en) => {
        const on = (pickedEntity(sw) || (sw.type === 'gauge' ? GAUGE_DEFAULT_ENTITY : '')) === en.id;
        const value = sw.type === 'scene' ? '' : entityGap(en.state) ? gapWord(entityGap(en.state)!) : tm(entityValue(en));
        return { id: en.id, name: en.name, value, on, bg: on ? '#1d1d1f' : '#fff', fg: on ? '#fff' : '#1d1d1f', sub: on ? '#d9d6ce' : '#5c5a55',
          pick: () => { if (cur) { commit(setTileEntity(cur.widgets, selW, en.id), selW); setWeb({ srcOpen: true }); } } };
      })] : [],
    entityErr: sw ? selIssue(sw) : null,
    noEntities: ents.ready && !!sw && !!pickDomains(sw.type, sw) && !entitiesFor(ents.list, sw.type, W.qEntity, sw).length && !(sw.type === 'scene' && !W.qEntity.trim()),
    // the display lists at most 800 entities, the most useful first (eink-ha-os#150)
    entCut: ents.lists?.entities && ents.lists.entities.shown < ents.lists.entities.total ? t('capEntities', ents.lists.entities.shown, ents.lists.entities.total) : '',
    // nothing to pick (eink-ha-os#86): the search found nothing, or HA has no entity of these domains at all
    noEntitiesText: W.qEntity.trim() ? t('noMatch', W.qEntity.trim()) : t('noFit'),
    selLabel: sw ? String(sw.label || '') : '',
    hasLabel: !!sw && hasLabelField(sw.type),
    labelPlaceholder: sw ? nameAt({ ...sw, label: undefined }, selW) : '',
    setLabel: (e: ChangeEvent<HTMLInputElement>) => { if (cur) commit(setTileLabel(cur.widgets, selW, e.target.value, true), selW); },
    endLabel: () => { if (!cur || !sw || sw.label === undefined || cleanLabel(String(sw.label)) === sw.label) return; commit(setTileLabel(cur.widgets, selW, String(sw.label)), selW); },
    widths: [1, 2, 4].map((n) => ({ label: String(n), ...seg(!!sw && (sw.cs || 1) === n), pick: () => resizeSel('cs', n) })),
    heights: [1, 2].map((n) => ({ label: String(n), ...seg(!!sw && (sw.rs || 1) === n), pick: () => resizeSel('rs', n) })),
    // route kind (eink-ha-os#145): icon and how the entity is read; absent = train
    isRoute: !!sw && sw.type === 'route',
    modes: ROUTE_MODES.map((m) => ({ label: t(({ train: 'modeTrain', bus: 'modeBus', car: 'modeCar' } as const)[m as 'train' | 'bus' | 'car']), ...seg(!!sw && (sw.mode || 'train') === m),
      pick: () => { if (cur && sw) commit(cur.widgets.map((x, k) => (k === selW ? { ...x, mode: m } : x)), selW); } })),
    // a second departure entity (ha-paper#22): train / bus only; empty = none
    routeEntity2: sw && sw.type === 'route' ? String(sw.entity2 ?? '') : '',
    routeShows2: !!sw && sw.type === 'route' && sw.mode !== 'car',
    setRouteEntity2: (e: ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value.replace(/[,;\s]/g, '');
      if (cur && sw) commit(cur.widgets.map((x, k) => { if (k !== selW) return x; const { entity2: _, ...rest } = x; return v ? { ...rest, entity2: v } : rest; }), selW);
    },
    // OVapi names its sensors …_current_… / …_next_…: offer the next one first
    route2Suggest: sw && sw.type === 'route' && typeof sw.entity === 'string' && sw.entity.includes('_current_') ? sw.entity.replace('_current_', '_next_') : 'sensor.…',
    route2Entities: sw && sw.type === 'route' ? ents.list.filter((e) => e.id.startsWith('sensor.') && e.id !== sw.entity).map((e) => ({ id: e.id, name: e.name })) : [],
    // bar chart series (eink-ha-os#148)
    isBars: !!sw && sw.type === 'bars',
    seriesOpts: BARS_SERIES.map((m) => ({ label: t(({ prices: 'seriesPrices', usage: 'seriesUsage', solar: 'seriesSolar' } as const)[m as 'prices' | 'usage' | 'solar']), ...seg(!!sw && (sw.series || 'usage') === m),
      pick: () => { if (cur) commit(setBarsSeries(cur.widgets, selW, m), selW); } })),
    // history tile (eink-ha-os#267): window, per bar, value, chart, range; choices from core/history.ts
    isHistory: !!sw && sw.type === 'history',
    ...(() => {
      const h = sw && sw.type === 'history' ? sw : null;
      const put = (k: Parameters<typeof setHistoryKey>[2], v: string | undefined) => { if (cur) commit(setHistoryKey(cur.widgets, selW, k, v), selW); };
      const win = String(h?.window ?? WINDOW_DEFAULT), src = h ? historySource(h) : 'recorder', wins = historyWindows(src);
      const winMs = parseSpan(win) ?? 0, half = winMs / 2 % 3_600_000 === 0 ? winMs / 7_200_000 + 'h' : winMs / 120_000 + 'm';
      const ahead = h?.ahead === undefined ? 'next' : String(h.ahead) === '0' ? 'past' : 'around';
      const field = (k: 'attribute' | 'value' | 'time') => (e: ChangeEvent<HTMLInputElement>) => put(k, e.target.value.replace(/[^A-Za-z0-9_]/g, ''));
      const opt = (label: string, on: boolean, pick: () => void) => ({ label, ...seg(on), pick });
      const err = h ? historyIssue(h) : null;
      return {
        // data source (eink-ha-os#283): recorder, a list in an attribute, a weather forecast
        histSources: ([['recorder', 'srcRecorder'], ['attribute', 'srcAttribute'], ['forecast', 'srcForecast']] as const).map(([k, lk]) => opt(t(lk), src === k, () => { if (cur) commit(setHistorySource(cur.widgets, selW, k), selW); })),
        histIsAttr: src === 'attribute', histIsSeries: src !== 'recorder', histIsForecast: src === 'forecast',
        histAttr: h?.attribute === undefined ? '' : String(h.attribute), setHistAttr: field('attribute'),
        histValue: h?.value === undefined ? '' : String(h.value), setHistValue: field('value'), histValueHint: src === 'forecast' ? 'temperature' : 'value',
        histTime: h?.time === undefined ? '' : String(h.time), setHistTime: field('time'),
        // eink-ha-os#307: a recorder entity drawn before now
        histPast: h?.past === undefined ? '' : String(h.past), setHistPast: (e: ChangeEvent<HTMLInputElement>) => put('past', e.target.value.replace(/[^a-z0-9_.]/g, '')),
        histPastIds: ents.ready ? ents.list.filter((e) => /^(sensor|input_number|number)\./.test(e.id) && !!e.unit).map((e) => e.id) : [],
        histAheads: ([['next', 'aheadNext', undefined], ['around', 'aheadAround', half], ['past', 'aheadPast', '0']] as const).map(([k, lk, v]) => opt(t(lk), ahead === k, () => put('ahead', v))),
        histForecasts: ([['hourly', 'fcHourly'], ['daily', 'fcDaily']] as const).map(([k, lk]) => opt(t(lk), String(h?.forecast ?? 'hourly') === k, () => put('forecast', k === 'hourly' ? undefined : k))),
        histWindows: (wins.includes(win) ? wins : [...wins, win]).map((x) => opt(x, win === x, () => put('window', x === WINDOW_DEFAULT ? undefined : x))),
        histBuckets: [opt(t('histAuto'), h?.bucket === undefined, () => put('bucket', undefined)), ...bucketsFor(win, h ?? undefined).map((b) => opt(b, String(h?.bucket) === b, () => put('bucket', b)))],
        histAggs: HISTORY_AGGS.map((a) => opt(t(({ mean: 'aggMean', max: 'aggMax', min: 'aggMin', last: 'aggLast', change: 'aggChange' } as const)[a]), String(h?.agg ?? 'mean') === a, () => put('agg', a === 'mean' ? undefined : a))),
        histStyles: ([['auto', 'histAuto'], ['bars', 'styleBars'], ['line', 'styleLine'], ['area', 'styleArea'], ['step', 'styleStep'], ['dots', 'styleDots'], ['band', 'styleBand']] as const).map(([k, lk]) => opt(t(lk), String(h?.style ?? 'auto') === k, () => put('style', k === 'auto' ? undefined : k))),
        // eink-ha-os#304: a dashed reference line; min / max / last printed on the chart
        histThreshold: h?.threshold === undefined ? '' : String(h.threshold),
        setHistThreshold: (e: ChangeEvent<HTMLInputElement>) => put('threshold', e.target.value.replace(/[^-\d.]/g, '')),
        // eink-ha-os#304 wave 2: the same window a day / week before (recorder only)
        histCompares: src === 'recorder' ? ([['off', 'cmpOff', undefined], ['1d', 'cmpDay', '1d'], ['7d', 'cmpWeek', '7d']] as const).map(([k, lk, v]) => opt(t(lk), String(h?.compare ?? 'off') === k, () => put('compare', v))) : [],
        histLabelOpts: ([['on', 'histLabelsOn'], ['off', 'histLabelsOff']] as const).map(([k, lk]) => opt(t(lk), (h?.labels === 'true') === (k === 'on'), () => put('labels', k === 'on' ? 'true' : undefined))),
        histMin: h?.min === undefined ? '' : String(h.min), histMax: h?.max === undefined ? '' : String(h.max),
        setHistMin: (e: ChangeEvent<HTMLInputElement>) => put('min', e.target.value.replace(/[^-\d.]/g, '')),
        setHistMax: (e: ChangeEvent<HTMLInputElement>) => put('max', e.target.value.replace(/[^-\d.]/g, '')),
        histErr: err ? tm(err.msg) : '',
      };
    })(),
    // now playing tile (eink-ha-os#319): favorites as free type:id entries or HA's scripts / scenes (no browse_media: the display
    // has no media browser to proxy, emulator/deviations/319-media-favorites.md)
    isMedia: !!sw && sw.type === 'media',
    ...(() => {
      const m = sw && sw.type === 'media' ? sw : null; const fs = m ? favoritesOf(m) : [];
      const runs = ents.list.filter((e) => /^(script|scene)\./.test(e.id));
      const clean = (x: string) => x.replace(/[,;=]/g, '').trim();
      const target = fav.target.trim(), name = clean(fav.name) || clean(runs.find((e) => e.id === target)?.name ?? '');
      const p = target ? parseFavorites(name + '=' + target)[0] : null, ok = !!p && !('bad' in p);
      return {
        favList: fs.map((f, k) => ({ label: f.label, target: f.entity ? (runs.find((e) => e.id === f.entity)?.name ?? f.entity) : f.type + ':' + f.id, removeLabel: t('favRemove', f.label),
          remove: () => { if (cur) commit(setFavorites(cur.widgets, selW, fs.filter((_, j) => j !== k)), selW); } })),
        favName: fav.name, favTarget: fav.target, favRuns: runs.map((e) => ({ id: e.id, name: e.name })),
        setFavName: (e: ChangeEvent<HTMLInputElement>) => setFav((x) => ({ ...x, name: e.target.value.replace(/[,;=]/g, '') })),
        setFavTarget: (e: ChangeEvent<HTMLInputElement>) => setFav((x) => ({ ...x, target: e.target.value.replace(/[,;\s]/g, '') })),
        favCanAdd: ok && !!name && fs.length < MAX_FAVORITES, favErr: target && !ok ? t('favBad') : '',
        addFav: () => { if (!cur || !ok || !name || fs.length >= MAX_FAVORITES) return; commit(setFavorites(cur.widgets, selW, [...fs, { ...(p as object), label: name }]), selW); setFav({ name: '', target: '' }); },
      };
    })(),
    // guest Wi-Fi tile (eink-ha-os#329): network, password (masked unless shown), security, hidden, optional password entity
    isGuest: !!sw && sw.type === 'guestWifi',
    ...(() => {
      const g = sw && sw.type === 'guestWifi' ? sw : null;
      const put = (k: GuestKey, v: string) => { if (cur) commit(setGuestField(cur.widgets, selW, k, v), selW); };
      const sec = String(g?.security ?? 'WPA');
      return {
        guestSsid: g ? fieldDecode(g.ssid) : '', setGuestSsid: (e: ChangeEvent<HTMLInputElement>) => put('ssid', e.target.value),
        guestPw: g ? fieldDecode(g.password) : '', setGuestPw: (e: ChangeEvent<HTMLInputElement>) => put('password', e.target.value),
        guestShow, toggleGuestShow: () => setGuestShow((x) => !x), guestOpen: sec === 'nopass',
        guestSecs: GUEST_SECURITY.map((k) => ({ label: k === 'nopass' ? t('guestSecOpen') : k, ...seg(sec === k), pick: () => put('security', k) })),
        guestHidden: g?.hidden === 'true', toggleGuestHidden: () => put('hidden', g?.hidden === 'true' ? '' : 'true'),
        guestPwEntity: g?.password_entity === undefined ? '' : String(g.password_entity), setGuestPwEntity: (e: ChangeEvent<HTMLInputElement>) => put('password_entity', e.target.value),
        guestPwEntities: ents.list.filter((e) => GUEST_PW_DOMAINS.includes(e.id.split('.')[0])).map((e) => ({ id: e.id, name: e.name })),
      };
    })(),
    removeSel: () => removeAt(selW),
    moves: ([['←', 'moveLeft', -1, 0], ['→', 'moveRight', 1, 0], ['↑', 'moveUp', 0, -1], ['↓', 'moveDown', 0, 1]] as const)
      .map(([label, ak, dx, dy]) => ({ label, aria: t(ak), pick: () => { if (cur && sw) tileEdit(nudgeTile(cur.widgets, selW, dx, dy)); } })),
    // add a tile without dragging (keyboard, phone): the palette as a grouped <select>
    addGroups: [...new Set(PAL_GROUPS.map((p) => p[1]))].map((g) => ({ label: tm(g),
      items: PALETTE.map((it, k) => ({ it, k })).filter(({ it }) => (PAL_GROUPS.find((p) => p[0] === it.kind) || [0, 'Other'])[1] === g).map(({ it, k }) => ({ value: String(k), label: tm(it.label) })) })),
    addPick: (e: ChangeEvent<HTMLSelectElement>) => { const it = PALETTE[Number(e.target.value)]; if (it) addNew(it.w, undefined, palOf(it)); },
    full: used >= MAX_CELLS,
    qPalette: W.qPalette, setQPalette: (e: ChangeEvent<HTMLInputElement>) => setWeb({ qPalette: e.target.value }), noPalette: !Object.keys(gmap).length,
    groups: Object.keys(gmap).map((g) => ({ label: tm(g), items: gmap[g].map((it) => ({ label: tm(it.label), dragStart: (e: DragEvent) => setDrag(e, { kind: 'new', w: it.w, pal: palOf(it) }), add: () => addNew(it.w, undefined, palOf(it)) })) })),
    // tile source (eink-ha-os#191): one line, the Change panel behind it. Logical tiles: logicalSource (saved at once);
    // tiles with their own entity: the entity picker above (part of the draft, pushed with the screen)
    hasSource: !!sw && (!!selLogical || !!pickDomains(sw.type, sw)), srcLogical: !!selLogical, src: srcL,
    srcEntity: srcL ? srcL.entity : swEntity || (sw?.type === 'scene' ? t('allLightsOff') : '—'),
    srcFrom: srcL ? srcL.from : swEntity ? t('srcByYou') : sw?.type === 'scene' ? t('sceneBuiltIn').toLowerCase() : t(fromKey(null)),
    srcNowLine: srcL ? srcL.now : swEntity && sw?.type !== 'scene' ? nowLine(t, tm, ents.list, swEntity) : '',
    srcShared: selLogical ? sharedLine(t, sharedNames) : '',
    // a tile still without its entity (new from the palette) keeps the picker open
    srcOpen: W.srcOpen || (!selLogical && srcHard), srcForced: !selLogical && srcHard,
    toggleSrc: () => setWeb({ srcOpen: !(W.srcOpen || (!selLogical && srcHard)), qSrc: '', srcMsg: null }),
    closeSrc: () => setWeb({ srcOpen: false, qSrc: '', srcMsg: null }),
    srcFlips: srcL ? srcL.flips.map((o) => ({ label: o.label, ...seg(o.on), on: o.on, pick: () => { setWeb({ srcFlip: o.flip }); o.apply(); } })) : [],
    qSrc: W.qSrc, setQSrc: (e: ChangeEvent<HTMLInputElement>) => setWeb({ qSrc: e.target.value, srcMsg: null }),
    srcEntities: srcL ? srcL.entities.map((en) => ({ ...en, bg: en.on ? '#1d1d1f' : '#fff', fg: en.on ? '#fff' : '#1d1d1f', sub: en.on ? '#d9d6ce' : '#5c5a55' })) : [],
    hasSrcMsg: !!W.srcMsg, srcMsg: W.srcMsg ? W.srcMsg.text : '', srcMsgColor: W.srcMsg && !W.srcMsg.ok ? '#B3261E' : W.srcMsg?.warn ? '#8A5A00' : '#1E6B35',
    // yaml
    // advanced (eink-ha-os#191): Screens as YAML and API, one page at a time, the choice remembered per browser
    isAdvanced: W.tab === 'advanced',
    advPages: ([['yaml', 'advYaml'], ['api', 'advApi'], ['logs', 'advLogs']] as [AdvPage, StrKey][]).map(([k, key]) => ({ label: t(key), on: advPage === k, ...seg(advPage === k),
      pick: () => { setAdvPage(k); saveAdvPage(k); } })),
    isYaml: W.tab === 'advanced' && advPage === 'yaml', yaml: yamlText,
    isLogs: W.tab === 'advanced' && advPage === 'logs', ...logsVm,
    yamlSource: t(W.yamlEdited ? 'yamlEdited' : W.dirty ? 'yamlDraft' : 'yamlLive'),
    editYaml: (e: ChangeEvent<HTMLTextAreaElement>) => setWeb({ yaml: e.target.value, yamlEdited: true, yamlMsg: null }),
    validate: () => { try { const c = parseYaml(yamlText); setWeb({ yamlMsg: { ok: true, text: t('yamlOk', c.apps.length, c.screens.length, c.screens.reduce((a, x) => a + x.widgets.length, 0)) } }); } catch (err: any) { setWeb({ yamlMsg: { ok: false, text: t('yamlLine', err.line, err.msg) } }); } },
    pushYaml: () => {
      let sc: Config;
      try { sc = parseYaml(yamlText); } catch (err: any) { setWeb({ yamlMsg: { ok: false, text: t('notPushed', t('yamlLine', err.line, err.msg)) } }); return; }
      pushConfig(sc, 'web console YAML · ' + user).then(() => setWeb({ yamlMsg: { ok: true, text: t('yamlPushed') } }), (e: Error) => setWeb({ yamlMsg: { ok: false, text: t('notPushed', tm(e.message)) } }));
    },
    hasYamlMsg: !!W.yamlMsg, yamlMsg: W.yamlMsg ? W.yamlMsg.text : '', yamlMsgColor: W.yamlMsg && !W.yamlMsg.ok ? '#B3261E' : '#1E6B35',
    // api
    isApi: W.tab === 'advanced' && advPage === 'api', newName: W.newName, setName: (e: ChangeEvent<HTMLInputElement>) => setWeb({ newName: e.target.value }),
    scopes: ([['ro', 'readOnly'], ['rw', 'readWrite']] as ['ro' | 'rw', StrKey][]).map(([k, lk]) => ({ label: t(lk), ...seg(W.newScope === k), pick: () => setWeb({ newScope: k }) })),
    createToken: () => { api.createToken(W.newName, W.newScope).then((r) => setWeb({ reveal: { id: r.token.id, secret: r.secret } })); },
    hasReveal: !!W.reveal, reveal: W.reveal ? W.reveal.secret : '',
    curlExample: 'export X4=http://' + hostname + '\nexport X4_TOKEN=' + (W.reveal ? W.reveal.secret : '') + '\n\ncurl -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/config -o screens.yaml\ncurl -X PUT -H "Authorization: Bearer $X4_TOKEN" \\\n  -H "Content-Type: application/yaml" \\\n  --data-binary @screens.yaml $X4/api/v1/config',
    noTokens: !(S && S.tokens.length),
    tokens: (S ? S.tokens : []).map((k) => ({ name: k.name, masked: k.masked, created: k.created, last: k.last, scopeLabel: t(k.scope === 'rw' ? 'readWrite' : 'readOnly'),
      revoke: () => { api.revokeToken(k.id).then(() => setW((w) => ({ ...w, reveal: w.reveal && w.reveal.id === k.id ? null : w.reveal }))); } })),
    specUrl: 'http://' + (phase === 'setup' ? '192.168.4.1' : hostname) + '/openapi.yaml',
    specHref: '/openapi.yaml',
    endpoints: ENDPOINTS.map(([m, path, desc, scope]) => ({ m, path, desc, scope, bg: m === 'GET' ? '#E3ECF7' : m === 'PUT' ? '#FBE7CF' : '#E8E2F4', fg: '#1d1d1f' })),
    // device
    isDevice: W.tab === 'device',
    wifiNow: (S && S.wifi.connected) || t('notConnected'),
    // Wi-Fi folded to one line (eink-ha-os#190): network · signal · Change
    wifiSignal: (() => { const c = S?.wifi.connected; const n = c ? S?.networks.find((x) => x.ssid === c) : undefined;
      return n ? t('netSignal', t((['sigWeak', 'sigFair', 'sigGood', 'sigExcellent'] as const)[barsFor(n.rssi) - 1]).toLowerCase()) : ''; })(),
    wifiOpen: W.wifiOpen, toggleWifi: () => setWeb({ wifiOpen: !W.wifiOpen, wifiMsg: '', wifiPw: '' }),
    haLines: S ? [{ k: t('kvServer'), v: S.ha.server }, { k: t('kvSignedInAs'), v: S.ha.user }, { k: t('kvKey'), v: t('keyStored') }, { k: t('kvConnection'), v: t(S.offline ? 'offline' : 'connLive') },
      ...(W.haReport ? [{ k: t('kvReporting'), v: reportLine(W.haReport, (e) => hm(new Date(e * 1000)), lang) }] : [])] : [],
    devLines: S ? [{ k: t('firmware'), v: 'v' + S.firmware }, { k: t('kvIp'), v: S.ip || '—' }, { k: t('battery'), v: S.battery + '%' }, { k: t('tabScreens'), v: String(S.screens.length) }] : [],
    settingsReady: !!W.settings,
    // Settings (eink-ha-os#159): the device's fixed Settings pages, field for field
    settingsGroups: W.settings ? settingsPages().map((p) => ({ id: p.id, title: t(p.title), fields: p.fields.map((f) => {
      const st = W.settings as Record<string, unknown> & DeviceSettings;
      const curV = f.top ? st[f.key] : (st.display as Record<string, unknown>)[f.key];
      // tz (eink-ha-os#147): "From Home Assistant · Europe/Amsterdam"; a POSIX string set over the API is offered as itself
      // eink-ha-os#331: the presence source also offers HA's on/off entities (off = nobody home), named like the picker
      const fv = f.key === 'emptyHouse' ? [...f.values, ...ents.list.map((e) => e.id).filter((id) => id !== DEFAULT_EMPTY_SOURCE && validEmptySource(id))] : f.values;
      const values = curV !== undefined && !fv.includes(curV as string) ? [curV as string, ...fv] : fv;
      const optLabel = (v: string | number | boolean) => (f.key === 'emptyHouse' && v !== '' && names[String(v)] ? names[String(v)] + ' · ' + v : f.fmt(v, lang))
        + (f.key === 'tz' && v === '' && st.tz_ha ? ' · ' + st.tz_ha : '');
      return { key: f.key, label: t(f.label), info: f.info ? t(f.info) : '', infoOpen: !!W.infoOpen[f.key],
        toggleInfo: () => setW((w) => ({ ...w, infoOpen: { ...w.infoOpen, [f.key]: !w.infoOpen[f.key] } })), value: curV === undefined ? '' : String(curV), options: values.map((v) => ({ value: String(v), label: optLabel(v) })),
        change: (e: ChangeEvent<HTMLSelectElement>) => { const raw = e.target.value; const v = typeof f.values[0] === 'number' ? Number(raw) : typeof f.values[0] === 'boolean' ? raw === 'true' : raw; putSetting(f, v); } };
    }) })) : [],
    hasSettingsMsg: !!W.settingsMsg, settingsMsg: W.settingsMsg ? W.settingsMsg.text : '', settingsMsgColor: W.settingsMsg && !W.settingsMsg.ok ? '#B3261E' : '#1E6B35',
    // Updates (eink-ha-os#250): what the display's Settings › Updates says, and Check
    otaReady: !!W.ota,
    otaLine: W.ota ? (W.ota.repo === '' ? { title: t('otaChecksOff'), sub: t('otaChecksOffText') }
      : otaLine(lang, { status: W.ota.status, error: W.ota.error ?? null, version: W.ota.available?.version ?? '', checked: W.ota.last_check ? hm(new Date(W.ota.last_check)) : '', channel: W.ota.channel, message: W.ota.message }))
      : { title: '', sub: '' },
    otaMsg: W.otaMsg,
    otaCanCheck: !!W.ota && W.ota.repo !== '' && !viewOnly && !['downloading', 'installing', 'verifying'].includes(W.ota.status),
    otaChecking,
    otaCheck: () => { if (otaChecking) return; setWeb({ otaMsg: '', ota: W.ota && { ...W.ota, status: 'checking' } });
      api.otaCheck().then(loadOta, (e: Error) => { setWeb({ otaMsg: tm(e.message) }); loadOta(); }); },
    diagReady: !!W.diag, diagMsg: W.diagMsg,
    diagLines: W.diag ? diagLines(W.diag) : [],
    diagPanic: W.diag?.last_crash?.panic || '',
    diagCore: W.diag?.coredump ? W.diag.coredump.task + ' at ' + W.diag.coredump.pc + ' · ' + W.diag.coredump.backtrace.join(' ') : '',
    diagCoreHref: '/api/v1/diagnostics/coredump',
    diagClear: () => { api.clearDiagnostics().then(loadDiag, (e: Error) => setWeb({ diagMsg: e.message })); },
    haRelink: () => webHaSignIn('re-link'),
    haUnlink: () => { api.haUnlink(); },
  };
  return web;
}

/** "Diagnostics" card rows (Device tab). */
function diagLines(d: Diagnostics): { k: string; v: string }[] {
  const c = d.last_crash;
  const kb = (n: number) => Math.round(n / 1024) + ' KB';
  return [
    { k: 'This boot', v: d.reset_reason + ' · up ' + fmtUptime(d.uptime_s) },
    { k: 'Last crash', v: c ? c.reason + ' · v' + c.version + (c.uptime_s !== null ? ' · after ' + fmtUptime(c.uptime_s) : '') : 'None recorded' },
    { k: 'Boots kept', v: d.boots.map((b) => b.reason).join(', ') || '—' },
    { k: 'Heap (internal)', v: kb(d.heap.largest_free_internal) + ' largest · ' + kb(d.heap.min_free_internal) + ' lowest' },
    { k: 'Panel', v: d.panel.controller + ' (' + d.panel.source + (d.panel.ver ? ' ' + d.panel.ver : '') + ')' },
    ...(d.deep_sleep ? [{ k: 'Deep sleep', v: armLine(d.deep_sleep.boots_left) }] : []),
  ];
}

export type WebVm = ReturnType<typeof useConsole>;
export type ConsoleView = { web: WebVm; osName: string };
