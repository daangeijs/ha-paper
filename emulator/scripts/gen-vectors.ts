// Generates spec/test-vectors/ from the TypeScript reference implementation (src/core).
// Run: npm run vectors   (Node ≥ 22.18 / 24: runs .ts directly via type stripping)
// The C++ firmware runs the same vectors for parity. `src/core/vectors.test.ts` fails if they drift.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateYaml, cellsUsed, toYaml, sceneAction } from '../src/core/config.ts';
import { sevOf, routeLevel, carEta, carLevel, SEV, CAR_FACTOR } from '../src/core/severity.ts';
import { routeDepartures } from '../src/core/route.ts';
import { logPush, logRing, logsQuery, logTail, redact, LOG_CAP, LOG_TAIL_CAP, type LogLevel, type LogRing, type LogsQuery } from '../src/core/logs.ts';
import { BATT_HISTORY_N, BATT_SAMPLE_S, BATT_ZERO, battHistory, battStep, type BattIn } from '../src/core/battery.ts';
import { bootsJson, diagApply, lastCrash, type DiagOp, type DiagRing } from '../src/core/diag.ts';
import { seedAnswerOk, seedPlan, SEED_TEMPLATE, templateEventFinal, type HaSnapshot } from '../src/core/seed.ts';
import { houseData, seedAnswer, type House } from '../server/fake-ha.ts';
import { aliasesOf } from '../server/device.ts';
import { gridFlows, statisticIds } from '../src/core/energyPrefs.ts';
import { parseHaAddress, resolveHaAddress, type ProbeAnswer } from '../src/core/haAddress.ts';
import { lightGroupsOf, listPages, pickLights, pickZones, type LightGroup } from '../src/core/paging.ts';
import { ROOMS, LIGHT_LIST, ZONE_LIST } from '../src/core/data.ts';
import type { Widget } from '../src/core/config.ts';
import { statSource } from '../src/core/format.ts';
import { TZ_TABLE, currencySymbol, money, tzFor, validTzSetting } from '../src/core/locale.ts';
import { STRINGS, LANGS, langOf, tr, dateLine, type Lang, type StrKey } from '../src/core/strings.ts';
import { otaErrOf, otaLine, HTTP_LOW_MEMORY, type OtaLineIn } from '../src/core/otaStatus.ts';
import { HISTORY_AGGS, attrSamples, axisTicks, bucketize, fromSamples, historyError, historySource, parseTime, chartSpan, dayLowHigh, defaultBucket, fromHistoryRows, fromStatistics, historySpec, lowHigh, parseSpan, resolveStyle, statsPeriod, statsType, yScale, type HistoryAgg, type HistoryStyle, type StatRow } from '../src/core/history.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'spec', 'test-vectors');
const DEFAULT_YAML = readFileSync(join(ROOT, 'spec', 'default-screens.yaml'), 'utf8');

const H = '# HA Paper display config\nversion: 1\nscreens:\n';
const scr = (id: string, widgets: string[], extra = '') => '  - id: ' + id + '\n' + extra + '    widgets:\n' + widgets.map((w) => '      - {' + w + '}\n').join('');

/** [file name, description (rule), input] */
export const CONFIG_CASES: [string, string, string][] = [
  ['00-default-screens', 'The default config shipped with the device (spec/default-screens.yaml) is valid.', DEFAULT_YAML],
  ['01-minimal', 'Smallest valid file: one screen, one widget.', H + scr('a', ['type: clock'], '    app: home\n    title: A\n')],
  ['02-comments-blank-lines', 'Blank lines and # comments (any indent) are ignored; line numbers still count them.', '# hello\n\nversion: 1\n   # indented comment\nscreens:\n\n' + scr('a', ['type: clock, cs: 2'])],
  ['03-defaults', 'Missing app defaults to "home", missing title defaults to the id; cs/rs default to 1.', H + scr('just_id', ['type: price'])],
  ['04-quoted-title', 'Titles containing YAML specials are JSON-quoted by toYaml and unquoted on read.', H + scr('q', ['type: clock'], '    app: settings\n    title: "Energy: today, {all}"\n')],
  ['05-empty-widgets', '"widgets: []" is an empty screen (valid).', H + '  - id: empty\n    app: house\n    title: Empty\n    widgets: []\n'],
  ['06-numeric-values', 'Values matching ^\\d+$ become numbers ("02" → 2); everything else stays a string.', H + scr('n', ['type: stat, entity: sensor.solar_power, cs: 02', 'type: setting, key: 12'])],
  ['07-cs-zero-quirk', 'Quirk kept for parity: cs: 0 / rs: 0 are falsy, so they are NOT range-checked and count as 1 cell.', H + scr('z', ['type: clock, cs: 0, rs: 0'])],
  ['08-crlf-quirk', 'Quirk kept for parity: with CRLF endings the app/title lines fail (JS "(.+)$" does not match the trailing \\r), so the first app/title line is unreadable. Other lines tolerate the \\r.', (H + scr('w', ['type: wifi, cs: 4, rs: 2'], '    app: settings\n    title: Wi-Fi\n')).replace(/\n/g, '\r\n')],
  ['09-exactly-8-cells', 'Exactly 8 cells is allowed.', H + scr('full', ['type: lightList, cs: 4, rs: 2'])],
  ['10-version-unsupported', 'Rule: version must be 1.', 'version: 2\nscreens:\n' + scr('a', ['type: clock'])],
  ['11-version-not-integer', 'Rule: version must be exactly "1" ("1.0" is rejected).', 'version: 1.0\nscreens:\n' + scr('a', ['type: clock'])],
  ['12-screen-before-screens', 'Rule: a "- id:" before "screens:".', 'version: 1\n' + scr('a', ['type: clock'])],
  ['13-app-without-screen', 'Rule: app/title outside a screen.', H + '    app: home\n'],
  ['14-widgets-without-screen', 'Rule: "widgets:" outside a screen.', H + '    widgets:\n'],
  ['15-unknown-app', 'Rule: app must be one of the apps (without an apps: section: home | house | travel | settings).', H + scr('a', ['type: clock'], '    app: garden\n')],
  ['16-widget-outside-list', 'Rule: a widget line before that screen\'s "widgets:".', H + '  - id: a\n      - {type: clock}\n'],
  ['17-malformed-pair', 'Rule: every comma-separated part must be key: value.', H + scr('a', ['type clock'])],
  ['18-unknown-widget-type', 'Rule: type must be one of the widget types.', H + scr('a', ['type: weather'])],
  ['19-missing-type', 'Rule: a widget without type is an unknown type (quirk: the message literally says “undefined”).', H + scr('a', ['cs: 2'])],
  ['20-stat-wrong-domain', 'Rule: stat entity must be an HA entity_id in sensor / binary_sensor / input_number / number / climate / weather.', H + scr('a', ['type: clock', 'type: stat, entity: switch.coffee'])],
  ['21-entity-not-an-id', 'Rule: entity must look like domain.object_id ("constructor" is not one).', H + scr('a', ['type: stat, entity: constructor'])],
  ['22-route-bad-mode', 'Rule: route mode must be train, bus or car (#145).', H + scr('t', ['type: route, label: To work, mode: plane, entity: sensor.commute, cs: 2'], '    app: travel\n')],
  ['23-cs-out-of-range', 'Rule: cs must be 1–4.', H + scr('a', ['type: bars, series: prices, cs: 5'])],
  ['24-cs-not-a-number', 'Rule: cs must be 1–4 (non-numeric value).', H + scr('a', ['type: clock, cs: wide'])],
  ['25-rs-out-of-range', 'Rule: rs must be 1 or 2.', H + scr('a', ['type: thermo, zone: living, rs: 3'])],
  ['26-unreadable-line', 'Rule: anything else (e.g. wrong indent) is unreadable.', H + '  - id: a\n   app: home\n'],
  ['27-flow-map-not-closed', 'Rule: a widget must be a one-line {…} flow map.', H + '  - id: a\n    widgets:\n      - {type: clock\n'],
  ['28-no-screens', 'Rule: at least one screen (reported on line 1).', '# empty\nversion: 1\n'],
  ['29-empty-screens-list', 'Rule: "screens:" with no screens (reported on line 1).', H],
  ['30-duplicate-id', 'Rule: duplicate screen id (reported on the LAST line that declares it).', H + scr('dup', ['type: clock']) + scr('other', ['type: price']) + scr('dup', ['type: gauge'])],
  ['31-too-many-cells', 'Rule: more than 8 cells (reported on the screen\'s id line, message uses the title).', H + scr('busy', ['type: bars, series: prices, cs: 4', 'type: clock, cs: 2', 'type: price', 'type: gauge', 'type: stat, entity: sensor.grid_power'], '    title: Busy\n')],
  ['32-too-many-cells-rs', 'Rule: cells = Σ cs × rs.', H + scr('tall', ['type: lightList, cs: 4, rs: 2', 'type: clock'])],
  ['33-custom-apps', 'apps: (before screens:) replaces the default apps, in order; a screen without app: belongs to the first app; toYaml writes apps: back.', '# HA Paper display config\nversion: 1\napps:\n  - id: garden\n    title: "Garden: back"\n  - id: home\n    title: Home\n  - id: empty\nscreens:\n' + scr('g', ['type: clock']) + scr('h', ['type: price'], '    app: home\n')],
  ['34-apps-after-screens', 'Rule: apps: must come before screens:.', H + scr('a', ['type: clock']) + 'apps:\n'],
  ['35-duplicate-app', 'Rule: duplicate app id (reported on the second one).', 'version: 1\napps:\n  - id: a\n  - id: a\nscreens:\n' + scr('x', ['type: clock'])],
  ['36-too-many-apps', 'Rule: at most 7 apps of your own (reported on the 8th); the 8th slot is the built-in Settings app (#159).', 'version: 1\napps:\n' + [1, 2, 3, 4, 5, 6, 7, 8].map((k) => '  - id: a' + k + '\n').join('') + 'screens:\n' + scr('x', ['type: clock'])],
  ['37-empty-apps', 'Rule: an apps: section needs at least one app (reported on the apps: line).', 'version: 1\napps:\nscreens:\n' + scr('x', ['type: clock'], '    title: X\n')],
  ['38-app-key-inside-apps', 'Rule: an app entry only has id and title.', 'version: 1\napps:\n  - id: a\n    app: b\nscreens:\n' + scr('x', ['type: clock'])],
  ['39-unknown-app-custom', 'Rule: with an apps: section, the message lists those ids.', 'version: 1\napps:\n  - id: garden\n  - id: car\nscreens:\n' + scr('x', ['type: clock'], '    app: home\n')],
  ['40-ha-entities', 'stat / gauge / switch take any HA entity_id of their domains (sensor, binary_sensor, input_number, number, climate, weather | sensor, input_number, number | switch, light, input_boolean, fan); gauge without entity = home battery.', H + scr('a', ['type: stat, entity: sensor.outdoor_temperature', 'type: stat, entity: binary_sensor.front_door, label: Door', 'type: stat, entity: input_number.target', 'type: gauge', 'type: gauge, entity: sensor.phone_battery', 'type: switch, entity: switch.coffee', 'type: switch, entity: input_boolean.guest_mode', 'type: switch, entity: fan.attic'])],
  ['41-gauge-wrong-domain', 'Rule: gauge entity must be sensor / input_number / number.', H + scr('a', ['type: gauge, entity: binary_sensor.door'])],
  ['42-switch-without-entity', 'Rule: switch needs an entity.', H + scr('a', ['type: switch'])],
  ['43-legacy-light', 'Legacy {type: light, light: id} is read as {type: switch, entity: light.id} (key keeps its position); a full id is kept.', H + scr('a', ['type: light, light: living_ceiling, cs: 2', 'type: light, light: light.kitchen_spots'])],
  ['44-entity-uppercase', 'Rule: entity ids are lower-case (HA entity_id format).', H + scr('a', ['type: switch, entity: switch.Coffee'])],
  ['46-list-picks', 'lightList areas / entities and zoneList entities are space-separated lists (#127); kept as one string value, written back as is.', H + scr('a', ['type: lightList, areas: kitchen living_room, entities: light.porch light.hall_2, cs: 4']) + scr('b', ['type: zoneList, entities: climate.living climate.office, cs: 4', 'type: lightList, areas: , cs: 4'])],
  ['47-lightlist-bad-entity', 'Rule: lightList entities are light.* ids.', H + scr('a', ['type: lightList, entities: light.porch switch.coffee'])],
  ['48-lightlist-bad-area', 'Rule: lightList areas are HA area ids (^[a-z0-9_]+$), not names.', H + scr('a', ['type: lightList, areas: kitchen Living Room'])],
  ['49-zonelist-bad-entity', 'Rule: zoneList entities are climate.* ids (any integration).', H + scr('a', ['type: zoneList, entities: sensor.living_temperature'])],
  ['50-user-routes', 'Routes are user tiles (#145): free label, mode train | bus | car (absent = train), entity = a sensor.* id; the route id is optional free text.', H + scr('t', ['type: route, label: To work, mode: train, entity: sensor.commute_departures, cs: 2', 'type: route, label: Bus 52, mode: bus, entity: sensor.bus_52, cs: 2', 'type: route, label: Drive, mode: car, entity: sensor.drive_time, cs: 2', 'type: route, route: my_line, entity: sensor.x4_route_my_line, cs: 2'], '    app: travel\n')],
  ['51-legacy-route', 'Old catalog routes (`route: renkum_arn`, `route: car`, …, before #145) still parse: an empty user route without entity (the tile asks for a sensor; the console blocks saving until one is picked).', H + scr('t', ['type: route, route: renkum_arn, cs: 2', 'type: route, route: car, cs: 2'], '    app: travel\n')],
  ['52-route-wrong-domain', 'Rule: a route entity must be a sensor.* id.', H + scr('t', ['type: route, label: Drive, entity: switch.car'], '    app: travel\n')],
  ['66-zonelist-labels', 'A zoneList can rename rooms (#151): labels = "climate.<id>=Name" items split by ";"; kept as one string value, written back as is.', H + scr('a', ['type: zoneList, entities: climate.bathroom climate.bathroom_attic, labels: climate.bathroom_attic=Attic; climate.bathroom=Bathroom downstairs, cs: 4'])],
  ['67-zonelist-label-wrong-domain', 'Rule: a zoneList labels item names a climate.* entity (#151).', H + scr('a', ['type: zoneList, labels: sensor.bathroom=Bathroom'])],
  ['68-zonelist-label-no-name', 'Rule: a zoneList labels item is climate.<id>=Name with a name (#151).', H + scr('a', ['type: zoneList, labels: climate.bathroom'])],
  ['70-labels-on-panel-tiles', 'price, bars, the home battery gauge and thermo keep a label (#148): the panel draws it instead of the built-in title.', H + scr('a', ['type: price, label: Power', 'type: bars, series: solar, label: Solar today, cs: 2', 'type: gauge, label: Battery', 'type: thermo, zone: living_room, label: Living room, rs: 2'])],
  ['71-thermo-no-zone', 'A thermo tile without a zone parses (#148: the console palette adds it, then the user picks a climate entity); the panel shows "—".', H + scr('a', ['type: thermo, rs: 2'])],
  ['58-stat-climate-weather', 'A stat tile takes a climate or weather entity (#161): it shows the temperature (stat-raw.json).', H + scr('a', ['type: stat, entity: climate.living_room', 'type: stat, entity: weather.forecast_home, label: Outside'])],
  ['45-label-free-text', 'Labels and titles are free text: spaces, %, accents (issue #80); surrounding spaces are trimmed.', H + scr('a', ['type: stat, entity: sensor.phone_battery, label: Batterij %', 'type: gauge, entity: sensor.phone_battery, label:  Température café ', 'type: switch, entity: switch.coffee, label: Koffie & thee'], '    title: Energie & café 100%\n')],
  // #159: Settings is built in. Older files keep parsing: the settings app entry is skipped, its screens and settings tiles are dropped.
  ['53-legacy-settings-screens', 'Settings screens (app: settings) from older files parse and are dropped; the display adds its fixed Settings pages.', H + scr('a', ['type: clock'], '    app: home\n') + scr('display', ['type: setting, key: brightness', 'type: setting, key: night'], '    app: settings\n') + scr('updates', ['type: ota, cs: 4, rs: 2'], '    app: settings\n')],
  ['54-legacy-settings-app', 'An apps: entry “settings” (with its title) is skipped and does not count towards the 7; a screen may still name it.', 'version: 1\napps:\n  - id: home\n    title: Home\n  - id: settings\n    title: Instellingen\n' + [1, 2, 3, 4, 5, 6].map((k) => '  - id: a' + k + '\n').join('') + 'screens:\n' + scr('h', ['type: price']) + scr('wifi', ['type: wifi, cs: 4, rs: 2'], '    app: settings\n')],
  ['55-legacy-settings-tiles', 'Settings tiles (setting, ota, wifi, ha, about) on your own screens parse and are dropped (they only live on the fixed Settings pages).', H + scr('a', ['type: clock', 'type: setting, key: night', 'type: price', 'type: wifi', 'type: about'], '    app: home\n') + scr('b', ['type: ha, cs: 4, rs: 2'], '    app: house\n')],
  ['56-legacy-only-settings', 'Rule: a file with only Settings screens has no screens of your own → No screens found (line 1), like an empty list.', 'version: 1\napps:\n  - id: settings\n    title: Settings\nscreens:\n' + scr('about', ['type: about, cs: 4, rs: 2'], '    app: settings\n')],
  ['57-settings-duplicate-checked', 'Rule: settings screens are checked before they are dropped (duplicate id, cells), so an old file fails the same way it always did.', H + scr('wifi', ['type: clock'], '    app: home\n') + scr('wifi', ['type: wifi, cs: 4, rs: 2'], '    app: settings\n')],
  // #146: the scene tile runs an HA scene or script; no entity (or the older scene: all_off) = all lights off
  ['63-scene-entity', 'A scene tile takes a scene.* or script.* entity and an optional label (#146); without entity, or with the older `scene: all_off`, it is all lights off.', H + scr('a', ['type: scene, entity: scene.movie_night, cs: 2', 'type: scene, entity: script.good_night, label: Bedtime', 'type: scene, scene: all_off, label: Lights out', 'type: scene'])],
  ['64-scene-wrong-domain', 'Rule: a scene entity must be a scene.* or script.* id.', H + scr('a', ['type: clock', 'type: scene, entity: light.kitchen, cs: 2'])],
  ['65-scene-entity-wins', 'An entity next to the older `scene: all_off` parses with both keys kept; the tap runs the entity (scene-action.json).', H + scr('a', ['type: scene, scene: all_off, entity: scene.movie_night, cs: 2'])],
];

function summarize(input: string) {
  const r = validateYaml(input);
  if (!r.ok) return { ok: false, line: r.line, message: r.message };
  return { ok: true, apps: r.config.apps, screens: r.config.screens.map((s) => ({ id: s.id, app: s.app, title: s.title, cells: cellsUsed(s.widgets), widgets: s.widgets })), yaml: toYaml(r.config) };
}

export function configVectors() {
  return CONFIG_CASES.map(([name, description, input]) => ({ name, description, input, expect: summarize(input) }));
}

/** History tile config cases (#265); in history.json next to the rest of the tile's vectors (firmware test_core runs them, #268). */
export const HISTORY_CONFIG_CASES: [string, string, string][] = [
  ['history-defaults', 'A history tile needs only a numeric entity: window 24h, bucket from the ladder (≤ 12 bars per column), agg mean, style auto. Other keys are kept as written.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, cs: 4', 'type: history, entity: input_number.target, window: 7d, bucket: 1d, agg: max, style: bars, min: -5, max: 30.5, label: Week, cs: 2', 'type: history, entity: number.level, window: 10m, agg: change, style: line, rs: 1'])],
  ['history-wrong-domain', 'Rule: the entity must be a sensor / input_number / number.', H + scr('a', ['type: history, entity: binary_sensor.door, cs: 4'])],
  ['history-no-entity', 'Rule: entity is required.', H + scr('a', ['type: history, cs: 4'])],
  ['history-window-bare-number', 'Rule: a window needs a unit (24 is a number in the dialect).', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 24'])],
  ['history-window-too-short', 'Rule: window at least 10m.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 5m'])],
  ['history-window-too-long', 'Rule: window at most 7d.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 8d'])],
  ['history-bucket-not-on-ladder', 'Rule: bucket is one of 1m 5m 10m 15m 30m 1h 2h 3h 6h 12h 1d.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, bucket: 20m'])],
  ['history-bucket-not-dividing', 'Rule: the bucket divides the window.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 90m, bucket: 1h'])],
  ['history-too-many-bars', 'Rule: 2–96 bars.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 24h, bucket: 5m'])],
  ['history-one-bar', 'Rule: 2–96 bars (a bucket as long as the window is 1).', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 1d, bucket: 1d'])],
  ['history-no-default-bucket', 'Rule: a window no ladder step divides into 2–96 bars needs an explicit bucket (and none fits).', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 97m'])],
  ['history-bad-agg', 'Rule: agg is mean, max, min, last or change.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, agg: sum'])],
  ['history-bad-style', 'Rule: style is bars, line or auto.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, style: area'])],
  ['history-min-not-number', 'Rule: min and max are numbers (negative and decimal allowed).', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, min: low'])],
  ['history-min-above-max', 'Rule: min below max.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, min: 20, max: 20'])],
  ['history-seven-tiles', 'Rule: at most 6 history tiles in the whole config; the 7th fails on its own line.', H + scr('a', ['type: history, entity: sensor.a, cs: 2', 'type: history, entity: sensor.b, cs: 2', 'type: history, entity: sensor.c, cs: 2', 'type: history, entity: sensor.d, cs: 2']) + scr('b', ['type: history, entity: sensor.e, cs: 2', 'type: history, entity: sensor.f, cs: 2', 'type: history, entity: sensor.g, cs: 2'])],
];

const HNOW = Date.UTC(2026, 9, 26, 14, 37);   // 15:37 in Amsterdam (tz +60)
/** Deterministic HA history rows ({s, lu}, lu in seconds): a value every 7 min from `from`, gaps where `gap(i)`. */
function histRows(from: number, to: number, f: (i: number) => number, gap: (i: number) => string | null = () => null) {
  const rows: { s: string; lu: number }[] = [];
  for (let t = from, i = 0; t <= to; t += 7 * 60_000, i++) rows.push({ s: gap(i) ?? String(Math.round(f(i) * 10) / 10), lu: t / 1000 + (i % 3) * 0.125 });
  return rows;
}
/** Deterministic statistics rows of one period. */
function statRows(from: number, to: number, periodMs: number, skip: (i: number) => boolean = () => false): StatRow[] {
  const rows: StatRow[] = [];
  for (let t = from, i = 0; t + periodMs <= to; t += periodMs, i++) {
    if (skip(i)) continue;
    const m = Math.round((8 + 6 * Math.sin(i / 3)) * 100) / 100;
    rows.push({ start: t, end: t + periodMs, mean: m, min: Math.round((m - 1.5) * 100) / 100, max: Math.round((m + 2) * 100) / 100, change: (i * 7) % 5 === 0 ? null : ((i * 7) % 5) / 10 });
  }
  return rows;
}

export function historyVectors() {
  const MIN = 60_000, HOUR = 60 * MIN;
  const spec = (window: string, bucket: string) => ({ windowMs: parseSpan(window) as number, bucketMs: parseSpan(bucket) as number });
  const aggs = HISTORY_AGGS as readonly HistoryAgg[];
  const histCases = [
    { name: '1h-5m', description: '1 h of 5-minute buckets; one row before the window carries in; a gap (unavailable) from row 5 to 7.', tz: 60, ...spec('1h', '5m'),
      rows: histRows(HNOW - 66 * MIN, HNOW, (i) => 12 + 3 * Math.sin(i), (i) => (i >= 5 && i < 7 ? (i === 5 ? 'unavailable' : 'unknown') : null)) },
    { name: '6h-30m', description: '6 h of 30-minute buckets; data starts inside the window, so the first buckets are empty.', tz: 60, ...spec('6h', '30m'),
      rows: histRows(HNOW - 4 * HOUR - 11 * MIN, HNOW - 3 * MIN, (i) => 20 - i * 0.4) },
    { name: '24h-1h-counter', description: '24 h of hourly buckets on a counter: change = last held minus last held before; a :30 time zone (tz +330).', tz: 330, ...spec('24h', '1h'),
      rows: histRows(HNOW - 25 * HOUR, HNOW - 20 * MIN, (i) => 100 + i * 0.3, (i) => (i === 40 ? 'unavailable' : null)) },
    { name: '10m-1m-sparse', description: '10 min of 1-minute buckets; a single change before the window holds through all of it.', tz: 0, ...spec('10m', '1m'),
      rows: [{ s: '3.5', lu: (HNOW - 3 * HOUR) / 1000 }, { s: '4', lu: (HNOW - 4 * MIN - 30_000) / 1000 }] },
  ];
  const statCases = [
    { name: '24h-2h-hourly', description: 'Hourly statistics into 2-hour buckets (period hour); the open bucket has no row yet.', tz: 60, ...spec('24h', '2h'),
      rows: statRows(Date.UTC(2026, 9, 25, 14), Date.UTC(2026, 9, 26, 14), HOUR, (i) => i === 9) },
    { name: '7d-6h-hourly', description: '7 days of 6-hour buckets from hourly rows; rows outside the span are ignored.', tz: 60, ...spec('7d', '6h'),
      rows: statRows(Date.UTC(2026, 9, 19, 0), Date.UTC(2026, 9, 26, 14), HOUR, (i) => i % 17 === 3) },
    { name: '2h-15m-5minute', description: '5-minute statistics into 15-minute buckets (period 5minute).', tz: 60, ...spec('2h', '15m'),
      rows: statRows(HNOW - 3 * HOUR - 2 * MIN, HNOW, 5 * MIN) },
  ];
  const styles: HistoryStyle[] = ['bars', 'line'];
  return {
    _doc: 'History tile (#264, #265): emulator src/core/history.ts; firmware core/history.cpp + core/config.cpp run these (#268, test_core). Times are epoch ms; tz = local UTC offset in minutes. Compare floats with a 1e-6 tolerance. config: like config/*.json. defaultBucket: window/cs → bucket (null = needs an explicit bucket). spec: historySpec of a parsed widget. history: HA history rows (s, lu seconds) → fromHistoryRows → bucketize per agg. statistics: rows → fromStatistics per agg (statsType picks the field). yScale, lowHigh (times as shown, en and nl), dayLowHigh (values = one day in n buckets), axis (x 0..1 across the span).',
    now: HNOW,
    config: HISTORY_CONFIG_CASES.map(([name, description, input]) => ({ name, description, input, expect: summarize(input) })),
    defaultBucket: ([['10m', 1], ['1h', 1], ['1h', 4], ['6h', 4], ['24h', 1], ['24h', 2], ['24h', 4], ['2d', 1], ['3d', 1], ['7d', 1], ['7d', 4], ['90m', 1], ['97m', 1], ['25h', 1]] as [string, number][])
      .map(([window, cs]) => ({ window, cs, bucket: ((b) => (b === null ? null : b / MIN + 'm'))(defaultBucket(parseSpan(window) as number, cs)) })),
    spec: ([{ entity: 'sensor.outdoor_temperature', cs: 4 }, { entity: 'sensor.outdoor_temperature', window: '7d', cs: 2, agg: 'max' }, { entity: 'sensor.rain_total', window: '24h', bucket: '1h', agg: 'change', style: 'line', min: '0', max: '12.5' }, { entity: 'number.level', window: '10m', agg: 'last', min: '-5' }] as Record<string, string | number>[])
      .map((widget) => ({ widget, out: historySpec(widget) })),
    style: aggs.flatMap((agg) => [undefined, 'auto', 'bars', 'line'].map((style) => ({ agg, style: style ?? null, out: resolveStyle(agg, style) }))),
    stats: {
      period: [1, 5, 10, 15, 30, 60, 120, 360, 720, 1440].map((m) => ({ bucketMin: m, period: statsPeriod(m * MIN) })),
      type: aggs.map((agg) => ({ agg, type: statsType(agg) })),
    },
    history: histCases.map((c) => {
      const points = fromHistoryRows(c.rows);
      return { name: c.name, description: c.description, tz: c.tz, windowMs: c.windowMs, bucketMs: c.bucketMs, rows: c.rows, span: chartSpan(c, HNOW, c.tz),
        points, out: Object.fromEntries(aggs.map((agg) => [agg, bucketize(points, { ...c, agg }, HNOW, c.tz).values])) };
    }),
    statistics: statCases.map((c) => ({ name: c.name, description: c.description, tz: c.tz, windowMs: c.windowMs, bucketMs: c.bucketMs, rows: c.rows, span: chartSpan(c, HNOW, c.tz),
      out: Object.fromEntries(aggs.map((agg) => [agg, fromStatistics(c.rows, { ...c, agg }, HNOW, c.tz).values])) })),
    yScale: ([[[3, 5, null, 4], null, null], [[-2, 5, 1], null, null], [[], null, null], [[7, 7], null, null], [[0, 0], null, null], [[3, 5, 4], 0, null], [[3, 5, 4], null, 4], [[3, 5], 10, null]] as [(number | null)[], number | null, number | null][])
      .flatMap(([values, min, max]) => styles.map((style) => ({ values, style, min, max, out: yScale(values, style, min, max) }))),
    lowHigh: [
      { windowMs: 24 * HOUR, bucketMs: HOUR, tz: 60, start: Date.UTC(2026, 9, 25, 15), values: [5, 3, null, 3, 9, 9, 1.5, ...Array(17).fill(null)] },
      { windowMs: 7 * 24 * HOUR, bucketMs: 6 * HOUR, tz: 60, start: Date.UTC(2026, 9, 19, 23), values: [2, 8, -1, 4, ...Array(24).fill(null)] },
      { windowMs: 6 * HOUR, bucketMs: 30 * MIN, tz: 330, start: Date.UTC(2026, 9, 26, 9), values: Array(12).fill(null) },
    ].flatMap((c) => (['en', 'nl'] as const).map((lang) => ({ ...c, lang, out: lowHigh({ start: c.start, bucketMs: c.bucketMs, values: c.values }, c.windowMs, c.tz, lang) }))),
    // the price chart's low / high (#260): n equal buckets from local midnight, the drawn resolution
    dayLowHigh: [[0.22, 0.21, 0.2, 0.2, 0.21, 0.23, 0.27, 0.33, 0.35, 0.3, 0.26, 0.22, 0.19, 0.18, 0.19, 0.22, 0.27, 0.34, 0.38, 0.36, 0.31, 0.27, 0.25, 0.23],
      Array.from({ length: 96 }, (_, i) => Math.round((0.25 + 0.1 * Math.sin(i / 7)) * 10000) / 10000), [-0.02, 0.1, -0.02, 0.4, ...Array(20).fill(0.1)], []]
      .flatMap((values) => (['en', 'nl'] as const).map((lang) => ({ values, lang, out: dayLowHigh(values, lang) }))),
    axis: ([['10m', '1m', 60], ['1h', '5m', 60], ['2h', '10m', 60], ['3h', '15m', 60], ['6h', '30m', 60], ['24h', '1h', 60], ['24h', '30m', 330], ['48h', '2h', 60], ['3d', '6h', 60], ['7d', '6h', 60], ['7d', '1d', 0]] as [string, string, number][])
      .flatMap(([window, bucket, tz]) => (['en', 'nl'] as const).map((lang) => ({ window, bucket, tz, lang, out: axisTicks(spec(window, bucket), HNOW, tz, lang) }))),
  };
}

/** History tile series from an attribute or a weather forecast (#283). Separate from history.json so the firmware's
 *  history suite keeps passing until it reads these (firmware/deviations/283-attribute-series.md). */
export const HISTORY_SERIES_CONFIG_CASES: [string, string, string][] = [
  ['series-attribute', 'An attribute series: any sensor / binary_sensor / weather entity; value and time name the entry fields; ahead 0…window. Keys kept as written.', H + scr('a', ['type: history, entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, window: 2h, bucket: 5m, cs: 4', 'type: history, entity: sensor.rain_nowcast, attribute: forecast, value: precipitation, time: datetime, window: 4h, ahead: 2h, bucket: 10m, cs: 4']) + scr('b', ['type: history, entity: sensor.prices, attribute: today, window: 24h, ahead: 0, style: bars, cs: 4'])],
  ['series-forecast', 'A weather entity without attribute reads weather.get_forecasts (hourly by default; daily).', H + scr('a', ['type: history, entity: weather.home, window: 24h, cs: 4', 'type: history, entity: weather.home, forecast: daily, value: precipitation, window: 7d, bucket: 1d, cs: 4'])],
  ['series-attr-wrong-domain', 'Rule: an attribute series reads a sensor / binary_sensor / weather entity.', H + scr('a', ['type: history, entity: light.kitchen, attribute: forecast'])],
  ['series-forecast-on-recorder', 'Rule: forecast only on a weather entity (an input_number is a recorder series).', H + scr('a', ['type: history, entity: input_number.target, forecast: daily'])],
  ['series-ahead-on-recorder', 'Rule: ahead / value / time / forecast need an attribute or a weather entity.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, ahead: 1h'])],
  ['series-bad-field', 'Rule: attribute, value and time are attribute names.', H + scr('a', ['type: history, entity: sensor.rain_nowcast, attribute: forecast, value: rain-mm'])],
  ['series-forecast-on-attribute', 'Rule: forecast is hourly or daily and only on a weather entity without attribute.', H + scr('a', ['type: history, entity: weather.home, attribute: forecast, forecast: hourly'])],
  ['series-forecast-bad-type', 'Rule: forecast is hourly or daily.', H + scr('a', ['type: history, entity: weather.home, forecast: twice_daily'])],
  ['series-hourly-bucket', 'Rule: an hourly forecast needs a bucket of 1h or more (a daily one 1d).', H + scr('a', ['type: history, entity: weather.home, window: 6h, bucket: 30m'])],
  ['series-ahead-too-long', 'Rule: ahead is 0 or a span, at most the window.', H + scr('a', ['type: history, entity: sensor.rain_nowcast, attribute: forecast, window: 2h, ahead: 3h'])],
  ['series-ahead-not-divided', 'Rule: the bucket divides ahead.', H + scr('a', ['type: history, entity: sensor.rain_nowcast, attribute: forecast, window: 2h, bucket: 30m, ahead: 45m'])],
];

export function historySeriesVectors() {
  const MIN = 60_000, HOUR = 60 * MIN;
  const iso = (t: number, tz: number) => { const d = new Date(t + tz * MIN), a = Math.abs(tz); return d.toISOString().slice(0, 19) + (tz < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
  // a nowcast: 5-minute entries from 2 h before to 2 h after HNOW (15:37 local, tz +60), UTC times, one without a number
  const rain = Array.from({ length: 49 }, (_, i) => { const t = Math.floor(HNOW / (5 * MIN)) * 5 * MIN - 2 * HOUR + i * 5 * MIN;
    return { datetime: iso(t, 0), precipitation: i === 30 ? null : Math.round(Math.max(0, 3 * Math.sin((i - 20) / 6)) * 10) / 10 }; });
  const hourly = Array.from({ length: 30 }, (_, i) => ({ datetime: iso(Date.UTC(2026, 9, 26, 15 + i), 60), temperature: Math.round((11 + 4 * Math.sin(i / 4)) * 10) / 10, precipitation: i % 7 === 3 ? 1.2 : 0, condition: 'cloudy' }));
  const daily = Array.from({ length: 7 }, (_, i) => ({ datetime: iso(Date.UTC(2026, 9, 26 + i, 11), 0), temperature: 12 + i % 3, templow: 5 + i % 2, precipitation: (i * 3) % 5 }));
  const w = (s: string) => Object.fromEntries(s.split(', ').map((kv) => { const [k, v] = kv.split(': '); return [k, /^\d+$/.test(v) ? Number(v) : v]; }));
  const cases: { name: string; description: string; tz: number; widget: Record<string, string | number>; raw: unknown }[] = [
    { name: 'nowcast-ahead', description: 'Rain nowcast, the next 2 h in 5-minute bars: the first bucket holds now; entries before it are outside; a null value is skipped.', tz: 60,
      widget: w('entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, window: 2h, bucket: 5m, cs: 4'), raw: rain },
    { name: 'nowcast-around', description: 'The same list ±2 h in 10-minute bars (ahead 2h): the bucket holding now starts the second half; two samples per bucket.', tz: 60,
      widget: w('entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, window: 4h, ahead: 2h, bucket: 10m, cs: 4'), raw: rain },
    { name: 'nowcast-json-string', description: 'The list as a JSON string (how the firmware stream keeps list attributes), 30-minute bars, agg max.', tz: 60,
      widget: w('entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, window: 2h, bucket: 30m, agg: max'), raw: JSON.stringify(rain) },
    { name: 'plain-numbers', description: 'A list of plain numbers: one per bucket from the bucket holding now; text that is not a number is skipped (a gap).', tz: 60,
      widget: w('entity: sensor.rain_nowcast, attribute: forecast, window: 1h, bucket: 10m'), raw: [0, '0.4', 1.5, 'n/a', 2] },
    { name: 'plain-numbers-past', description: 'Plain numbers with ahead 0 (the recorder span): only the first lands in the last (open) bucket.', tz: 60,
      widget: w('entity: sensor.rain_nowcast, attribute: forecast, window: 1h, bucket: 10m, ahead: 0'), raw: [7, 8, 9] },
    { name: 'weather-hourly', description: 'weather.get_forecasts hourly, temperature, 24 h in 2-hour bars on a 2-wide tile (local times with +01:00).', tz: 60,
      widget: w('entity: weather.home, window: 24h, cs: 2'), raw: hourly },
    { name: 'weather-hourly-change', description: 'Hourly precipitation summed per 6 h (agg change = sum of the samples).', tz: 60,
      widget: w('entity: weather.home, value: precipitation, window: 24h, bucket: 6h, agg: change'), raw: hourly },
    { name: 'weather-daily', description: 'weather.get_forecasts daily, 7 days of 1-day bars, max temperature; daily times at 11:00 UTC.', tz: 60,
      widget: w('entity: weather.home, forecast: daily, window: 7d, agg: max'), raw: daily },
    { name: 'not-a-list', description: 'An attribute that is not a list (or JSON text of one) has no samples.', tz: 60,
      widget: w('entity: sensor.rain_nowcast, attribute: forecast'), raw: { precipitation: 3 } },
  ];
  const aggs = HISTORY_AGGS as readonly HistoryAgg[];
  return {
    _doc: 'History tile series from an attribute or weather.get_forecasts (#283): emulator src/core/history.ts (historySource, historyError, historySpec, parseTime, attrSamples, fromSamples, chartSpan / axisTicks with aheadMs). Not yet run by the firmware (firmware/deviations/283-attribute-series.md). Times are epoch ms; tz = local UTC offset in minutes. config: like config/*.json. spec: historySpec (aheadMs and source only for these sources). parseTime: input, tz → ms or null. series: raw attribute → samples → buckets per agg, plus the span and the axis.',
    now: HNOW,
    config: HISTORY_SERIES_CONFIG_CASES.map(([name, description, input]) => ({ name, description, input, expect: summarize(input) })),
    source: [{ entity: 'sensor.outdoor_temperature' }, { entity: 'weather.home' }, { entity: 'weather.home', attribute: 'forecast' }, { entity: 'binary_sensor.rain_expected', attribute: 'forecast' }]
      .map((widget) => ({ widget, source: historySource(widget), error: historyError(widget) })),
    parseTime: ([['2026-10-26T14:05:00+01:00', 60], ['2026-10-26T14:05:00Z', 60], ['2026-10-26T14:05:00.123-05:30', 60], ['2026-10-26 14:05', 60], ['2026-10-26T14:05', -300], ['2026-10-26', 60],
      ['2026-10-26T14:05:00+0100', 0], [1793025900, 0], [1793025900000, 0], ['14:05', 60], ['2026-13-01T00:00:00Z', 0], ['2026-10-26T24:00:00Z', 0], ['', 0], [null, 0], [-5, 0]] as [unknown, number][])
      .map(([input, tz]) => ({ input, tz, out: parseTime(input, tz) })),
    series: cases.map((c) => {
      const sp = historySpec(c.widget), samples = attrSamples(c.raw, sp.source!, sp.bucketMs, HNOW, c.tz);
      return { name: c.name, description: c.description, tz: c.tz, widget: c.widget, error: historyError(c.widget), spec: sp, raw: c.raw, samples, span: chartSpan(sp, HNOW, c.tz),
        out: Object.fromEntries(aggs.map((agg) => [agg, fromSamples(samples, { ...sp, agg }, HNOW, c.tz).values])),
        axis: (['en', 'nl'] as const).map((lang) => ({ lang, ticks: axisTicks(sp, HNOW, c.tz, lang) })) };
    }),
    axis: ([['10m', '1m', '10m'], ['1h', '5m', '1h'], ['2h', '5m', '2h'], ['2h', '10m', '1h'], ['3h', '15m', '3h'], ['3h', '30m', '1h'], ['6h', '30m', '6h'], ['48h', '1h', '48h'], ['48h', '2h', '24h'], ['7d', '1d', '7d']] as [string, string, string][])
      .map(([window, bucket, ahead]) => { const s = { windowMs: parseSpan(window) as number, bucketMs: parseSpan(bucket) as number, aheadMs: parseSpan(ahead) as number };
        return { window, bucket, ahead, tz: 60, span: chartSpan(s, HNOW, 60), out: axisTicks(s, HNOW, 60, 'en') }; }),
  };
}

/** Route tile departures (#145, #275). attrs as the HA stream keeps them: list attributes as JSON text. tz = local UTC
 *  offset in minutes (emulator); posixTz = the same zone for the firmware's localtime(). */
export function routeVectors() {
  const CET = 'CET-1CEST,M3.5.0,M10.5.0/3';
  const up = (xs: Record<string, unknown>[]) => JSON.stringify(xs);
  const ns = (planned: string, actual: string, delay: number | undefined, track: string, direction: string, status: string, message: string | null = null) =>
    ({ planned, actual, ...(delay === undefined ? {} : { delay }), track, planned_track: track, track_changed: false, direction, train: 'IC 1234', status, message });
  const cases: { name: string; tz: number; posixTz: string; attrs: Record<string, string> }[] = [
    { name: 'departures-shape', tz: 120, posixTz: CET, attrs: { departures: JSON.stringify([{ time: '08:04', delay: 0, cancelled: false, info: 'Intercity' }, { time: '08:19', delay: 6, cancelled: false, info: 'Sprinter · track 4' }, { time: '8:34', delay: 0, cancelled: true }]) } },
    { name: 'departures-wins-over-upcoming', tz: 120, posixTz: CET, attrs: { departures: JSON.stringify([{ time: '09:00', delay: 1, cancelled: false, info: 'Bus 1' }]), upcoming: up([ns('2026-09-29T07:55:00+02:00', '2026-09-29T07:55:00+02:00', 0, '5', 'Harbour', 'on_time')]) } },
    { name: 'upcoming-ns', tz: 120, posixTz: CET, attrs: { upcoming: up([
      ns('2026-09-29T07:55:00+02:00', '2026-09-29T07:55:00+02:00', 0, '5', 'Harbour', 'on_time'),
      ns('2026-09-29T08:10:00+02:00', '2026-09-29T08:14:00+02:00', 4, '5b', 'Airport', 'delayed', 'Signal failure'),
      ns('2026-09-29T08:25:00+02:00', '2026-09-29T08:25:00+02:00', 0, '7', 'Central', 'cancelled', 'Cancelled due to staff shortage'),
    ]) } },
    { name: 'upcoming-delay-from-times', tz: 120, posixTz: CET, attrs: { upcoming: up([
      ns('2026-09-29T23:52:00+02:00', '2026-09-30T00:03:30+02:00', undefined, '', 'Harbour', 'delayed'),
      { planned: '2026-09-30T00:20:00+02:00', direction: 'Central', status: 'on_time' },
      { actual: '2026-09-30T00:41:00+02:00', planned: '2026-09-30T00:44:00+02:00', track: '2' },
    ]) } },
    { name: 'upcoming-utc-and-winter', tz: 60, posixTz: CET, attrs: { upcoming: up([
      ns('2026-12-01T06:55:00Z', '2026-12-01T06:57:00Z', 2, '1', 'Central', 'delayed'),
      ns('2026-12-01T08:05:00+01:00', '2026-12-01T08:05:00+01:00', 0, '3a', 'Airport', 'on_time'),
      ns('2026-12-01 09:15:00', '2026-12-01 09:15:00', 0, '3', 'Harbour', 'on_time'),
    ]) } },
    { name: 'upcoming-skips-bad-entries', tz: 120, posixTz: CET, attrs: { upcoming: up([
      { direction: 'Central', status: 'on_time' }, { planned: 'soon', actual: null, status: 'on_time' }, 'x' as unknown as Record<string, unknown>,
      ns('2026-09-29T10:00:00+02:00', '2026-09-29T10:00:00+02:00', 0, '', '', 'on_time'),
    ]) } },
    { name: 'upcoming-not-a-list', tz: 120, posixTz: CET, attrs: { upcoming: 'none' } },
  ];
  return {
    description: 'Route tile departures (spec/SCHEMA.md route, #275). `departures` [{time HH:MM, delay, cancelled, info}] wins; else `upcoming` [{planned, actual, delay, track, direction, status}] with ISO timestamps (the NS departures integration): time = local HH:MM of actual, else planned; delay = `delay`, else max(0, round(actual − planned in minutes)); cancelled = status "cancelled" (the integration\'s statuses: on_time, delayed, cancelled); info = "Track ‹track› · ‹direction›" (strings routeTrack). Timestamps without an offset are local.',
    cases: cases.flatMap((c) => (['en', 'nl'] as const).map((lang) => ({ ...c, lang, out: routeDepartures(c.attrs, c.tz, lang) }))),
  };
}

export function severityVectors() {
  const delays = [0, 1, 1.9, 2, 3, 4.9, 5, 10, 15, 15.1, 16, 30];
  return {
    description: 'Travel severity (SPEC §6). sevOf(delay, cancelled) per departure; route = worst of the NEXT TWO departures; car ETA = round(typical × factor[level]). carLevel is the inverse used with a real travel-time sensor (ratio ≥ 1.75 → 4, ≥ 1.4 → 3, ≥ 1.15 → 2).',
    levels: SEV,
    carFactor: CAR_FACTOR,
    sevOf: [...delays.map((delay) => ({ delay, cancelled: false, level: sevOf(delay, false) })), { delay: 0, cancelled: true, level: sevOf(0, true) }, { delay: 3, cancelled: true, level: sevOf(3, true) }],
    routeLevel: ([
      [],
      [{ delay: 0, cancelled: false }, { delay: 0, cancelled: false }, { delay: 0, cancelled: false }],
      [{ delay: 3, cancelled: false }, { delay: 0, cancelled: false }, { delay: 2, cancelled: false }],
      [{ delay: 8, cancelled: false }, { delay: 6, cancelled: false }, { delay: 0, cancelled: false }],
      [{ delay: 0, cancelled: true }, { delay: 18, cancelled: false }, { delay: 25, cancelled: false }],
      [{ delay: 0, cancelled: false }, { delay: 0, cancelled: false }, { delay: 40, cancelled: false }],
      [{ delay: 1, cancelled: false }, { delay: 0, cancelled: false }, { delay: 0, cancelled: true }],
      [{ delay: 4, cancelled: false }],
    ] as { delay: number; cancelled: boolean }[][]).map((deps) => ({ deps, level: routeLevel(deps) })),
    carEta: [1, 2, 3, 4].map((level) => ({ typical: 21, level, eta: carEta(21, level) })),
    carLevel: [[21, 21], [24, 21], [25, 21], [29, 21], [30, 21], [36, 21], [37, 21], [60, 21]].map(([eta, typical]) => ({ eta, typical, level: carLevel(eta, typical) })),
  };
}

/** Battery history (#231): ops = power-loop passes in order from an empty ring; each case lists the log lines and the
 *  final GET /diagnostics `battery`. */
/** JSON with 2-space indent, but flat objects and arrays (no nesting inside) on one line: 291 ops stay readable. */
const compactJson = (v: unknown): string => JSON.stringify(v, null, 2).replace(/([[{])\n\s+([^[\]{}]*?)\n\s*([\]}])/g, (_, a: string, body: string, b: string) => a + body.replace(/\n\s*/g, ' ') + b) + '\n';
export function batteryVectors() {
  const E = 1_760_000_000, M = BATT_SAMPLE_S * 1000;
  const at = (ms: number, o: Partial<BattIn> = {}): BattIn => ({ ms, epoch: E + Math.floor(ms / 1000), pct: 80, mv: 3950, chg: false, usb: false, power: 'not armed', rssi: -78, ...o });
  const cases: { name: string; ops: BattIn[] }[] = [
    { name: 'gauge not read yet: nothing', ops: [at(0, { pct: -1 }), at(1000, { pct: -1 })] },
    { name: 'first reading samples at once; the next one after 300 s', ops: [at(5000), at(6000), at(5000 + M - 1, { pct: 79 }), at(5000 + M, { pct: 79 })] },
    { name: 'USB plugged / STAT changes log a line but add no row', ops: [at(0), at(60_000, { usb: true, chg: true, power: 'external power' }), at(120_000, { usb: true, chg: false, power: 'external power' }), at(M, { usb: true, power: 'external power' })] },
    { name: 'clock unknown: t = uptime seconds; mv and rssi unknown', ops: [at(42_000, { epoch: 0, mv: null, rssi: null }), at(42_000 + M, { epoch: 0, power: 'glance' })] },
    { name: 'ring keeps the newest 288 (24 h)', ops: Array.from({ length: BATT_HISTORY_N + 3 }, (_, n) => at(n * M, { pct: 100 - Math.floor(n / 4) })) },
  ];
  return {
    description: 'Battery history (#231, emulator src/core/battery.ts, firmware core/battery_history.cpp). ops = power-loop passes {ms uptime, epoch (0 = clock unknown), pct (< 0 = not read), mv|null, chg, usb, power reason, rssi|null} from an empty ring. A row every ' + BATT_SAMPLE_S + ' s (the first at once), newest ' + BATT_HISTORY_N + ' kept; t = epoch, or uptime seconds while the clock is unknown. log = the [BATT] lines written: every sample and every chg / usb change. battery = GET /diagnostics battery.',
    cases: cases.map((c) => {
      let st = BATT_ZERO; const log: string[] = [];
      for (const o of c.ops) { const r = battStep(st, o); st = r.s; if (r.log) log.push(r.log); }
      return { name: c.name, ops: c.ops, log, battery: battHistory(st) };
    }),
  };
}

export function diagVectors() {
  const boot = (reason: string, version = '0.3.0', panic: string | null = null, hw?: string): DiagOp => ({ op: 'boot', reason, version, panic, ...(hw ? { hw } : {}) });
  const touch = (uptime_s: number, min_free_heap: number, epoch = 0): DiagOp => ({ op: 'touch', uptime_s, min_free_heap, epoch });
  const cases: { name: string; ops: DiagOp[] }[] = [
    { name: 'first boot', ops: [boot('POWERON')] },
    { name: 'touch updates only the running boot; last_seen stays null until the clock is known', ops: [boot('POWERON'), touch(10, 200000), boot('SW'), touch(20, 190000), touch(30, 180000, 1760000000), touch(40, 170000, 0)] },
    { name: 'panic after a long run: last_crash names the crashed boot', ops: [boot('POWERON', '0.3.0'), touch(3600, 150000, 1760003600), boot('PANIC', '0.3.0', 'assert failed: xQueueSemaphoreTake queue.c:1709 (pxQueue->uxItemSize == 0)')] },
    { name: 'crash after an OTA: version is the one that crashed', ops: [boot('POWERON', '0.3.0'), boot('SW', '0.4.0-beta.1'), touch(95, 120000), boot('TASK_WDT', '0.3.0')] },
    { name: 'the newest crash wins; brownout counts', ops: [boot('POWERON'), boot('PANIC', '0.3.0', 'abort() was called at PC 0x42001234'), touch(50, 1), boot('BROWNOUT'), touch(5, 2), boot('SW')] },
    { name: 'ring keeps 8; the crashed boot fell out → uptime null', ops: [boot('POWERON'), boot('INT_WDT'), boot('SW'), boot('SW'), boot('SW'), boot('SW'), boot('SW'), boot('SW'), boot('SW')] },
    { name: 'clear empties the ring (running boot included); touch on an empty ring does nothing', ops: [boot('POWERON'), touch(10, 1), boot('PANIC', '0.3.0', 'boom'), touch(20, 2), { op: 'clear' }, touch(30, 3)] },
    { name: 'long strings are cut to the RTC field sizes', ops: [boot('PWR_GLITCH_TOO_LONG', '1.2.3-beta.45+averyveryverylongbuild', 'x'.repeat(120))] },
    { name: 'a boot after clear starts a new ring', ops: [boot('POWERON'), boot('PANIC'), { op: 'clear' }, boot('SW')] },
    { name: 'glance: DEEPSLEEP wakes in a row take one slot; they are not crashes and keep the old crash in view', ops: [boot('POWERON'), boot('PANIC', '0.3.0', 'boom'), touch(30, 1), boot('DEEPSLEEP'), touch(8, 2, 1760000000), boot('DEEPSLEEP'), touch(6, 3), boot('DEEPSLEEP'), touch(7, 4, 1760001800), boot('DEEPSLEEP'), boot('DEEPSLEEP'), boot('DEEPSLEEP'), boot('DEEPSLEEP'), boot('DEEPSLEEP'), boot('DEEPSLEEP')] },
    { name: 'hw: the raw reset cause rides along (#241); a TWDT panic is CORE_SW, a hardware watchdog stage CORE_MWDT0; cut to 15', ops: [boot('POWERON', '0.3.0', null, 'POWERON'), boot('TASK_WDT', '0.3.0', 'task_wdt: loopTask (CPU 1)', 'CORE_SW'), boot('TASK_WDT', '0.3.0', null, 'CORE_MWDT0'), boot('USB', '0.3.0', null, 'USB_UART'), boot('WDT', '0.3.0', null, 'A_VERY_LONG_HW_CAUSE')] },
    { name: 'a crash during a glance wake names that wake', ops: [boot('POWERON'), boot('DEEPSLEEP'), touch(12, 5, 1760000000), boot('PANIC', '0.3.0', 'boom'), boot('DEEPSLEEP')] },
  ];
  return {
    description: 'Boot / crash ring (GET /api/v1/diagnostics boots + last_crash). ops run in order on an empty ring: boot = a new boot (esp_reset_reason name, firmware version, panic message or null, optional hw = raw chip reset cause, null when absent), touch = the running boot is alive (uptime_s, min_free_heap, epoch; epoch 0 = clock unknown → last_seen unchanged), clear = DELETE /diagnostics. Newest first, 8 kept; a DEEPSLEEP boot right after a DEEPSLEEP boot replaces it (glance wakes, #10). Strings are cut to 11 / 23 / 95 / 15 bytes (RTC struct).',
    cases: cases.map((c) => { const ring = c.ops.reduce<DiagRing>(diagApply, []); return { ...c, boots: bootsJson(ring), last_crash: lastCrash(ring) }; }),
  };
}

/** Device log ring (#200): push ops on a small ring, then queries; the RTC tail; redaction. */
export function logsVectors() {
  type Op = { ms: number; epoch: number; level: LogLevel; tag: string; msg: string };
  const op = (ms: number, level: LogLevel, tag: string, msg: string, epoch = 0): Op => ({ ms, epoch, level, tag, msg });
  const run = (cap: number, ops: Op[]) => ops.reduce<LogRing>((r, o) => logPush(r, o.ms, o.epoch, o.level, o.tag, o.msg), logRing(cap));
  const boot = [op(12, 'I', 'MAIN', 'HA Paper 0.3.0 · X4 Pro'), op(40, 'I', 'EPD', 'controller UC8179 · profile default'), op(900, 'W', 'NET', 'Wi-Fi join failed · retry in 5 s'),
    op(5200, 'I', 'HA', 'WebSocket connected', 1760000000), op(5300, 'E', 'HEAP', 'alloc failed · 16384 B caps 0x1800', 1760000001), op(6100, 'I', 'APP', 'EPD partial (HA update · 1 region) · 312 ms', 1760000002)];
  const qs: LogsQuery[] = [{}, { since: 3 }, { level: 'W' }, { level: 'E' }, { tags: ['HA', 'EPD'] }, { limit: 2 }, { since: 2, limit: 2 }, { since: 6 }, { since: 1, level: 'I', tags: ['app'] }];
  const cases = [
    { name: 'fits: every line kept', cap: 4096, ops: boot },
    { name: 'budget full: the oldest lines go; dropped when since fell out', cap: 180, ops: boot, queries: [{ since: 1 }] as LogsQuery[] },
    { name: 'long tag and message are cut on a UTF-8 boundary', cap: 4096, ops: [op(1, 'I', 'AVERYLONGTAGNAME_X', 'é'.repeat(130) + 'end'), op(2, 'W', 'T', 'x'.repeat(300))] },
    { name: 'secrets are masked before they are stored', cap: 4096, ops: [op(1, 'I', 'HA', 'POST /auth/token refresh_token=' + 'ab12'.repeat(32) + ' ok'), op(2, 'I', 'WEB', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')] },
    { name: 'empty ring', cap: 4096, ops: [] as Op[] },
  ];
  const redactCases = [
    'Wi-Fi password: hunter2', 'password=hunter2&ssid=Home', '{"refresh_token":"0123abcd","expires_in":1800}', 'Authorization: Bearer abc.def', 'x4_session=Zm9vYmFy; Path=/',
    'API token "kitchen" created (rw) · only its hash is stored', 'HA code → refresh token stored', 'tokens: 3 · sessions 2', 'token ' + 'f'.repeat(31), 'sha ' + 'A'.repeat(64) + '.',
    'id g' + 'a'.repeat(40), 'key x4_ABCDEFGHJKMNPQRSTVWXYZ23 end', 'short x4_ABC', 'jwt eyJhbGciOiJIUzI1NiJ9.e30.x', 'no eyJ123', 'PASSWORD:"p w"', 'secret:', 'TOKEN = abc,def', 'cookie: a=b', 'naïve token=é→x',
  ];
  return {
    _doc: 'Device log ring (GET /api/v1/logs, #200): emulator src/core/logs.ts = firmware core/log_ring.{h,cpp}. ops push lines in order into a ring of `cap` bytes (16 + tag + message bytes per line, oldest dropped; tag cut to 15 and message to 239 UTF-8 bytes after redaction; seq from 1; epoch 0 → null). queries: since / level (E|W|I and worse) / tags (case-insensitive) / limit → the response. tail: a ring of tail_cap bytes fed the same lines = the newest lines that fit (on the device the RTC copy is ' + LOG_TAIL_CAP + ' bytes, boot=previous). redact: in → out.',
    cases: cases.map((c) => { const r = run(c.cap, c.ops); const tail = logTail(run(LOG_CAP, c.ops), 300); return { ...c, queries: undefined, results: (c.queries ?? qs).map((q) => ({ query: q, response: logsQuery(r, q) })), tail_cap: 300, tail: logsQuery(tail, {}, 'previous') }; }),
    redact: redactCases.map((i) => ({ in: i, out: redact(i) })),
  };
}

/** lightList / zoneList picks (#127): what the tile shows and how many pages it needs. */
export function listPickVectors() {
  const groups: LightGroup[] = [...lightGroupsOf(ROOMS, LIGHT_LIST), { area: 'attic', ids: Array.from({ length: 12 }, (_, k) => 'attic_' + k) }];
  const zones = ZONE_LIST.map((z) => ({ id: z.id }));
  const cases: [string, Widget][] = [
    ['nothing picked = all', { type: 'lightList' }],
    ['areas in pick order; unknown area skipped', { type: 'lightList', areas: 'kitchen nowhere living' }],
    ['entities grouped under their area, a new area last', { type: 'lightList', entities: 'light.hall_stairs light.living_tv light.hall_ceiling light.gone light.hall_stairs' }],
    ['entity of a picked area adds nothing; another area appends', { type: 'lightList', areas: 'office living', entities: 'light.living_tv light.garden_path light.office_desk' }],
    ['a long area pages', { type: 'lightList', areas: 'attic kitchen' }],
    ['only unknown ids = empty list', { type: 'lightList', entities: 'light.gone' }],
    ['zones: all', { type: 'zoneList' }],
    ['zones: pick order, unknown and duplicates skipped', { type: 'zoneList', entities: 'climate.office climate.x climate.living climate.office' }],
    ['zones: only unknown', { type: 'zoneList', entities: 'climate.x' }],
  ];
  return {
    description: 'lightList / zoneList picks (spec/SCHEMA.md list picks, emulator src/core/paging.ts pickLights / pickZones / listPages). `groups`: the derived lights by area (ids without "light."), `zones`: derived climate ids (without "climate."). Each case: the widget, the groups / zone ids it shows, and its page count (0 = nothing to show; the screen still has one page).',
    groups, zones: zones.map((z) => z.id),
    cases: cases.map(([name, w]) => ({ name, widget: w, ...(w.type === 'lightList' ? { groups: pickLights(groups, w) } : { zones: pickZones(zones, w).map((z) => z.id) }), pages: listPages(w, zones, groups) })),
  };
}

/** What tapping a scene tile asks HA (#146, core config.ts sceneAction; the firmware sends `data` as service_data). */
export function sceneActionVectors() {
  const cases: [string, Widget][] = [
    ['scene entity → scene.turn_on', { type: 'scene', entity: 'scene.movie_night', cs: 2 }],
    ['script entity → script.turn_on; the label changes nothing', { type: 'scene', entity: 'script.good_night', label: 'Bedtime' }],
    ['no entity → all lights off', { type: 'scene' }],
    ['older scene: all_off → all lights off', { type: 'scene', scene: 'all_off' }],
    ['an entity wins over scene: all_off', { type: 'scene', scene: 'all_off', entity: 'scene.movie_night' }],
  ];
  return { description: 'Scene tile tap (#146, spec/SCHEMA.md scene): the widget and the HA service call it makes.', cases: cases.map(([name, w]) => ({ name, widget: w, ...sceneAction(w) })) };
}

/** Stat tile source of a raw HA entity (#161): state + unit the tile formats. Attribute values as the firmware keeps
 *  them (text; a number is its JSON text, null is ""). */
/** Clock zone + currency from HA (#147): emulator src/core/locale.ts = firmware core/locale.{h,cpp}. */
export function localeVectors() {
  const tzFor_ = ([override, ha]: [string, string]) => ({ override, ha, posix: tzFor(override, ha) });
  return {
    _doc: 'Clock time zone and price currency from Home Assistant get_config (#147). zones: the whole IANA → POSIX table (firmware must hold exactly these). tzFor(override, ha): the PUT /settings tz override (POSIX or a zone name) wins, else HA time_zone; null = keep the current zone (boot default Europe/Amsterdam). validTz: what PUT /settings accepts for tz. currency: get_config currency → the symbol price tiles show. money: a price in the point number format.',
    zones: TZ_TABLE,
    tzFor: ([['', 'Europe/Amsterdam'], ['', 'America/New_York'], ['', 'Australia/Sydney'], ['', 'Mars/Olympus'], ['', ''],
      ['UTC0', 'Europe/Amsterdam'], ['Europe/London', 'Europe/Amsterdam'], ['Mars/Olympus', 'Europe/Amsterdam'], ['GMT0BST,M3.5.0/1,M10.5.0', '']] as [string, string][]).map(tzFor_),
    validTz: ['', 'Europe/Amsterdam', 'US/Pacific', 'CET-1CEST,M3.5.0,M10.5.0/3', 'Mars/Olympus', 'europe/amsterdam', 'CET'].map((tz) => ({ tz, ok: validTzSetting(tz) })),
    currency: ['EUR', 'USD', 'GBP', 'SEK', 'chf', '', null].map((code) => ({ code, symbol: currencySymbol(code) })),
    money: ([[0.234, '€'], [0.2, '$'], [1.5, '£'], [0.31, 'SEK'], [-0.05, '€']] as [number, string][]).map(([v, sym]) => ({ v, sym, text: money(v, sym) })),
  };
}

export function statRawVectors() {
  const cases: [string, string, string, Record<string, string>][] = [
    ['sensor: state and unit_of_measurement', 'sensor.outdoor_temperature', '11.4', { unit_of_measurement: '°C' }],
    ['sensor without a unit', 'sensor.afvalwijzer_gft', '2026-10-21', {}],
    ['climate: current_temperature in °C, not the hvac state', 'climate.living_room', 'auto', { current_temperature: '20.83', temperature: '21' }],
    ['climate off with a temperature still shows it', 'climate.playroom', 'off', { current_temperature: '18.5' }],
    ['climate without current_temperature: no value', 'climate.car', 'heat_cool', { temperature: '21' }],
    ['climate with current_temperature null (empty text): no value', 'climate.attic', 'auto', { current_temperature: '' }],
    ['weather: temperature in its temperature_unit', 'weather.forecast_home', 'cloudy', { temperature: '10.9', temperature_unit: '°C' }],
    ['weather in °F', 'weather.us', 'sunny', { temperature: '51', temperature_unit: '°F' }],
    ['weather without temperature_unit: °C', 'weather.old', 'rainy', { temperature: '8' }],
    ['weather without temperature: no value', 'weather.broken', 'cloudy', {}],
  ];
  return {
    description: 'What a stat tile shows for an HA entity that is not one of our logical sensors (emulator src/core/format.ts statSource, firmware core/home.cpp statSource, #161). climate: current_temperature in °C; weather: temperature in temperature_unit (absent = °C); anything else: its state and unit_of_measurement. ok false = a climate / weather without a temperature: the tile shows "—". The console entity list sends the same state / unit for climate and weather. Unavailable / unknown states never get here (gap, #86). attrs are text as the firmware keeps them ("" = null).',
    cases: cases.map(([name, entity, state, attrs]) => { const r = statSource(entity, state, attrs); return { name, entity, state, attrs, ok: r.state !== undefined, out: { state: r.state ?? '', unit: r.unit } }; }),
  };
}

/** A fake HA house as the firmware would see it: energy prefs + `live` (what EntityAdapter maps) + the seed template answer. */
function houseSnapshot(h: House, live: string[]): HaSnapshot {
  const d = houseData(h);
  return { energy: d.prefs as HaSnapshot['energy'], live, ...seedAnswer(d.states.values(), d.areas, d.areaOf, d.reg?.deviceOf) };
}
const grid = (o: Record<string, unknown> = {}) => ({ type: 'grid', flow_from: [{ stat_energy_from: 'sensor.import_kwh', entity_energy_price: null }], flow_to: [], ...o });

/** [name, description, snapshot] — expected output = toYaml(seedConfig(snapshot, [])) (no Settings tail). */
export const SEED_CASES: [string, string, HaSnapshot][] = [
  ['empty', 'An HA with nothing the display knows: only the clock (no "—" tiles, no Travel / House apps).', {}],
  ['stranger-house', 'Fake HA --house stranger: P1 meter (grid only: stat_rate sensor.p1_meter_power becomes the home use tile), Nest thermostat, lights, room thermometers. NAS and phone temperatures are not rooms; "Office: upstairs" loses its colon in the label. Clutter of a real install (#58): sensors without device_class / unit / area, an unavailable hallway thermometer (no Hallway room), text states.', houseSnapshot('stranger', ['sensor.grid_power'])],
  ['demo-house', 'Fake HA --house demo (the emulator data): HA has the logical ids themselves (no labels: the catalog tiles), Energy dashboard price entity, tado zones, lights. No sensor.x4_route_* → no Travel app (the demo\'s routes are emulator mock data); one room thermometer → no Rooms screen.', houseSnapshot('demo', ['sensor.energy_prices'])],
  ['dutch-house', 'Fake HA --house dutch (#82, shaped like the first real HA): no Energy dashboard. Names and units find SolarEdge (Zonproductie, not the Anker PV input), the P1 net power (not phase 1), Anker home load (Huisverbruik), Anker battery power and SOC % (not the kWh capacity, the phone, iPad, Zigbee, P1 Wi-Fi or tado heating %), Zon vandaag, Buienradar outside, tado rooms. No meters → no Energy screen, no charts.', houseSnapshot('dutch', [])],
  ['dutch-house-energy', 'Fake HA --house dutch-energy: the same house with an Energy dashboard of meters only (HA < 2025.12, no stat_rate). Power sensors come from the meters\' entity-id prefix (solaredge_i1_ac → ac_power, p1_meter, anker_solix); charts appear.', houseSnapshot('dutch-energy', [])],
  ['real-house', 'Fake HA --house real, the large example house (#88, #136): ~1100 entities. Zigbee chip temperatures (`…_device_temperature`) and one-phase power sensors are not in the answer; rooms and inside are real thermometers, outside the Shelly H&T "Outdoor". Envoy: stat_rate production = solar, current_power_consumption = home use, energy_production_today = solar today (`…_last_seven_days` has no day token). Energy dashboard grid flows have no today sensor and Envoy consumption is no grid import → no imported / exported tiles. The Tesla climate (its device has a device_tracker) is a vehicle: the zoneList names the 6 tado zones. #152 traps: a "Forecast Max temperature today" is no Outside; the dryer plug\'s "Today consumption" is no Imported / Used today (Used today = the "Home energy usage today" helper); the Better-Thermostat-style wrapper (same room and name, off) is no zone; lights: per room the Hue group (not the second HA group of the living room), bulbs where a room has no group, the two lights without an area left out.', houseSnapshot('real', [])],
  ['seed-lessons', '#152: no outdoor thermometer but forecast-like ones (max, min, feels, Today tokens) → Outside is the first weather entity with a temperature (rule found), the forecast sensors are no room either; an appliance\'s day counter is no Imported (needs a grid word) and no Used today (needs a house / total word); a grid-named one is; zones: duplicates by area (the one not off wins, in the first one\'s place) and by friendly name (case-insensitive), a lone off zone stays; lights: only area-less ones left out → `areas`.', {
    areas: [['lr', 'Living room'], ['kit', 'Kitchen']],
    climate: [['climate.lr_bt', 'Living room', 'lr', 'off'], ['climate.lr_trv', 'Living room TRV', 'lr', 'heat'], ['climate.kitchen', 'Kitchen', 'kit', 'off'], ['climate.k2', ' kitchen ', '', 'heat'], ['climate.attic', 'Attic', '', 'off']],
    lights: [['light.lr_1', 'lr', ''], ['light.lr_2', 'lr', ''], ['light.kit', 'kit'], ['light.lost', '']],
    weather: ['weather.home', 'sensor.not_weather'],
    sensors: [
      ['sensor.owm_forecast_temperature', 'temperature', '', 'OpenWeatherMap Forecast Temperature', '°C'], ['sensor.buiten_max_today', 'temperature', '', 'Buiten max vandaag', '°C'],
      ['sensor.outdoor_feels_like', 'temperature', 'lr', 'Outdoor feels like', '°C'], ['sensor.lr_min', 'temperature', 'lr', 'Living room min', '°C'],
      ['sensor.lr_temp', 'temperature', 'lr', 'Living room', '°C'], ['sensor.kit_temp', 'temperature', 'kit', 'Kitchen', '°C'],
      ['sensor.dryer_today_consumption', 'energy', '', 'Dryer Today consumption', 'kWh'], ['sensor.dryer_energy_daily', 'energy', '', 'Dryer verbruik daily', 'kWh'],
      ['sensor.p1_energy_consumption_today', 'energy', '', 'P1 Energy consumption today', 'kWh'], ['sensor.house_energy_today', 'energy', '', 'House energy today', 'kWh'],
    ],
  }],
  ['light-groups', '#152: a group per area wins over its bulbs (the first group by order; a second group of the room is a duplicate), a room without a group keeps its bulbs in area order, a group without an area is left out; no light with an area at all → every light (no picks).', {
    areas: [['a', 'A'], ['b', 'B'], ['c', 'C']],
    lights: [['light.c_bulb', 'c', ''], ['light.a_bulb', 'a', ''], ['light.a_group', 'a', 'g'], ['light.a_group_2', 'a', 'g'], ['light.b1', 'b', ''], ['light.b2', 'b', ''], ['light.all', '', 'g']],
  }],
  ['lights-no-areas', '#152: no light has an area → every light (the lightList default), not an empty pick.', { lights: [['light.x', ''], ['light.y', '', 'g']] }],
  ['day-tokens-vehicle', '#136: day words as whole tokens (_day, Daily and vandaag count; _days, dagelijks and "monday" do not); a grid flow meter\'s today sensor (same 2-word prefix) beats an import-named one; a vehicle climate (`vehicles`) makes the zoneList name the others; only vehicles → no Heating screen.', {
    energy: { energy_sources: [grid({ flow_from: [{ stat_energy_from: 'sensor.p1_meter_energy_import_total' }], flow_to: [{ stat_energy_to: 'sensor.p1_meter_energy_export_total' }] })] },
    climate: ['climate.hall', 'climate.bad id'], vehicles: ['climate.model_3'],
    sensors: [
      ['sensor.solar_energy_day', 'energy', '', 'Solar energy day', 'kWh'], ['sensor.solar_energy_days', 'energy', '', 'Solar 7 days', 'kWh'],
      ['sensor.import_monday', 'energy', '', 'Import monday', 'kWh'], ['sensor.grid_import_dagelijks', 'energy', '', 'Afname dagelijks', 'kWh'],
      ['sensor.zz_import_today', 'energy', '', 'Import today', 'kWh'], ['sensor.p1_meter_energy_import_today', 'energy', '', 'P1 Daily', 'kWh'],
      ['sensor.p1_meter_export_x', 'energy', '', 'P1 export vandaag', 'kWh'],
      ['sensor.p1_meter_power_phase_l1', 'power', '', 'P1 power phase 1', 'W'], ['sensor.hall_device_temperature', 'temperature', '', 'Hall chip', '°C'],
    ],
  }],
  ['vehicle-only', '#136: the only climate is a car\'s → no Heating screen, report heating: none.', { vehicles: ['climate.tesla'] }],
  ['stale-logical', '#82: logical ids with a source (`live`) but no such sensor in HA\'s answer → no tile (the demo ids on a real house showed "—"). Price still comes from live.', {
    energy: { energy_sources: [{ type: 'solar', stat_energy_from: 'sensor.pv_kwh' }] },
    live: ['sensor.solar_power', 'sensor.grid_power', 'sensor.home_power', 'sensor.home_battery_soc', 'sensor.energy_prices'],
  }],
  ['solar-battery-routes', 'Solar + battery: solar power from stat_rate (a name without solar words), battery power and SOC from the meters\' prefix; a kW grid sensor by name; price via live; routes (#145) from every sensor.x4_route_* in the answer or mapped (live: car), sorted by id, at most 4, mode car when the sensor reports min; bad entity ids are skipped; rooms capped at 8.', {
    energy: { energy_sources: [{ type: 'solar', stat_energy_from: 'sensor.pv_kwh', stat_rate: 'sensor.roof_output' }, { type: 'battery', stat_energy_from: 'sensor.powerwall_battery_energy_out', stat_energy_to: 'sensor.powerwall_battery_energy_in' }, grid({ flow_to: [{ stat_energy_to: 'sensor.export_kwh' }] })] },
    live: ['sensor.energy_prices', 'sensor.x4_route_car'],
    areas: [['a1', 'Hall'], ['a2', 'Living room'], ['a3', 'Kids {1}'], ['a4', 'Bath'], ['a5', 'Study'], ['a6', 'Attic'], ['a7', 'Cellar'], ['a8', 'Guest'], ['a9', 'Gym'], ['a10', 'Shed']],
    climate: [], lights: [['light.x', '']],
    sensors: [
      ...Array.from({ length: 10 }, (_, i) => ['sensor.t' + (i + 1), 'temperature', 'a' + (10 - i), 'T' + (i + 1)] as [string, string, string, string]),
      ['sensor.Bad_ID', 'temperature', 'a1', 'Upper case'], ['sensor.x4_route_work', '', '', 'Train to work'], ['sensor.x4_route_school', '', '', 'Bus to school'], ['sensor.x4_route_drive', '', '', 'Drive', 'min'], ['sensor.x4_route_zoo', '', '', 'Fifth: over the cap'],
      ['sensor.porch_temp', 'temperature', 'a1', 'Buiten temperatuur'],
      ['sensor.roof_output', 'power', '', 'Roof', 'W'], ['sensor.powerwall_energy_level', 'energy_storage', '', 'Powerwall energy', 'kWh'],
      ['sensor.powerwall_battery_charge', 'battery', '', 'Powerwall charge', '%'], ['sensor.powerwall_battery_power', 'power', '', 'Powerwall battery power', 'kW'],
      ['sensor.powerwall_load_power', 'power', '', 'Powerwall load power', 'kW'], ['sensor.site_grid_power', 'power', '', 'Grid power', 'kW'],
    ],
  }],
  ['battery-only', 'Battery without solar: screen title "Battery"; SOC by name (device_class battery beats none on a tie); no meters → no Energy screen; no home sensor → no home tile.', {
    energy: { energy_sources: [{ type: 'battery', stat_energy_from: 'sensor.b_out', stat_energy_to: 'sensor.b_in' }] },
    live: ['sensor.battery_power', 'sensor.home_battery_soc'], climate: ['climate.hall'],
    sensors: [['sensor.thuisaccu_soc', '', '', 'Thuisaccu SOC', '%'], ['sensor.thuisaccu_level', 'battery', '', 'Thuisaccu', '%']],
  }],
  ['flat-grid', '#274: HA 2025.12+ flat grid source (stat_energy_from / stat_energy_to / entity_energy_price / stat_rate, no flow_from / flow_to): grid power from stat_rate, imported / exported today by the meters\' prefix, price from entity_energy_price, Energy screen with the usage chart.', {
    energy: { energy_sources: [{ type: 'grid', stat_energy_from: 'sensor.grid_meter_energy_import', stat_energy_to: 'sensor.grid_meter_energy_export', entity_energy_price: 'sensor.grid_tariff', entity_energy_price_export: 'sensor.grid_tariff_export', number_energy_price: null, stat_rate: 'sensor.grid_meter_power', cost_adjustment_day: 0 }] },
    live: ['sensor.energy_prices'],
    sensors: [['sensor.grid_meter_power', 'power', '', 'Grid meter power', 'W'], ['sensor.grid_meter_import_today', 'energy', '', 'Grid import today', 'kWh'], ['sensor.grid_meter_export_today', 'energy', '', 'Grid export today', 'kWh']],
  }],
  ['grid-meter-no-power', 'Grid meter without a power sensor: no grid tile; HA has its own sensor.home_power → home tile (catalog label); import meter → Energy screen with the usage chart.', {
    energy: { energy_sources: [grid()] }, areas: [['k', 'Kitchen']], sensors: [['sensor.k_temp', 'temperature', 'k', 'Kitchen'], ['sensor.home_power', '', '', 'Home power', 'W']],
  }],
];

export function seedVectors() {
  return {
    description: 'First-run screens from the user\'s HA (#23): seedConfig(snapshot, tail = []) → toYaml. Reference: emulator/src/core/seed.ts; firmware core/seed.cpp. snapshot = energy/get_prefs (energy) + logical ids with a source (live) + the SEED_TEMPLATE answer (present, areas, climate, lights, sensors). report = the seed report (#89; firmware seedReportJson, compact JSON in this key order).',
    cases: SEED_CASES.map(([name, description, snapshot]) => { const p = seedPlan(snapshot, []); return { name, description, snapshot, yaml: toYaml(p.config), report: p.report }; }),
    template: SEED_TEMPLATE,
    answers_description: 'seedAnswerOk(text): only a JSON object is a seed answer; anything else saves nothing and retries on the next link (#58).',
    answers: ['{"areas":[],"sensors":[]}', '{}', '', 'None', '[]', 'null', '"x"', '{"areas":'].map((text) => ({ text, ok: seedAnswerOk(text) })),
    events_description: 'templateEventFinal(has_result, level): render_template with report_errors; a WARNING event (undefined attribute) is followed by the result (#58). level null = absent.',
    events: ([[false, 'WARNING'], [false, 'ERROR'], [false, null], [true, null], [true, 'WARNING']] as [boolean, string | null][])
      .map(([has_result, level]) => ({ has_result, level, final: templateEventFinal(has_result, level) })),
  };
}

/** [name, description, energy/get_prefs] — both grid shapes (#274). Neutral entity ids. */
const ENERGY_PREFS_CASES: [string, string, unknown][] = [
  ['legacy', 'HA < 2025.12: flow_from[] (two tariffs, price on the first) and flow_to[] (its entity_energy_price = export price).', { energy_sources: [
    { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.meter_import_t1', entity_energy_price: 'sensor.tariff' }, { stat_energy_from: 'sensor.meter_import_t2', entity_energy_price: 'sensor.tariff_t2' }], flow_to: [{ stat_energy_to: 'sensor.meter_export', entity_energy_price: 'sensor.tariff_export' }], cost_adjustment_day: 0 },
    { type: 'solar', stat_energy_from: 'sensor.pv_energy' }] }],
  ['flat', 'HA 2025.12+: the grid source is flat: stat_energy_from / stat_energy_to / entity_energy_price / entity_energy_price_export / stat_rate.', { energy_sources: [
    { type: 'grid', stat_energy_from: 'sensor.meter_import', stat_energy_to: 'sensor.meter_export', stat_cost: null, entity_energy_price: 'sensor.tariff', number_energy_price: null, entity_energy_price_export: 'sensor.tariff_export', number_energy_price_export: null, stat_rate: 'sensor.meter_power', cost_adjustment_day: 0 },
    { type: 'solar', stat_energy_from: 'sensor.pv_energy', stat_rate: 'sensor.pv_power' },
    { type: 'battery', stat_energy_from: 'sensor.batt_out', stat_energy_to: 'sensor.batt_in', stat_rate: 'sensor.batt_power' }] }],
  ['flat-two-grids', 'HA 2025.12+ with one grid source per tariff: meters of both, the first price that is set, the first stat_rate.', { energy_sources: [
    { type: 'grid', stat_energy_from: 'sensor.meter_import_t1', stat_energy_to: 'sensor.meter_export_t1', entity_energy_price: null, number_energy_price: 0.25 },
    { type: 'grid', stat_energy_from: 'sensor.meter_import_t2', stat_energy_to: 'sensor.meter_export_t2', entity_energy_price: 'sensor.tariff_t2', stat_rate: 'sensor.meter_power' }] }],
  ['flat-import-only', 'Flat grid with only an import meter and a fixed price: no export meter, no price entity.', { energy_sources: [
    { type: 'grid', stat_energy_from: 'sensor.meter_import', stat_energy_to: null, entity_energy_price: null, number_energy_price: 0.3, entity_energy_price_export: null }] }],
  ['both-shapes', 'A source carrying both shapes (a migration leftover): legacy first, a meter named twice counts once, the legacy price wins.', { energy_sources: [
    { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.meter_import', entity_energy_price: 'sensor.tariff' }], flow_to: [], stat_energy_from: 'sensor.meter_import', stat_energy_to: 'sensor.meter_export', entity_energy_price: 'sensor.tariff_new', entity_energy_price_export: 'sensor.tariff_export' }] }],
  ['junk', 'Not objects / wrong types are skipped: flow_from not a list, a number as meter, a string source.', { energy_sources: [
    'grid', { type: 'grid', flow_from: { stat_energy_from: 'sensor.x' }, flow_to: [null, 7, { stat_energy_to: 5 }], stat_energy_from: 42, entity_energy_price: ['sensor.y'] }] }],
];

export function energyPrefsVectors() {
  return {
    _doc: 'Energy dashboard prefs (energy/get_prefs) → grid meters and price (#274). grid = gridFlows(source) per grid source (emulator src/core/energyPrefs.ts = firmware gridFlows() in core/entity_map.cpp); statistic_ids = EntityAdapter::statisticIds() after setEnergyPrefs; sources = the Energy-dashboard entity_sources for sensor.grid_power and sensor.energy_prices (emulator aliasesOf in server/device.ts, firmware EntityAdapter::sources()).',
    cases: ENERGY_PREFS_CASES.map(([name, description, prefs]) => {
      const a = aliasesOf(prefs); const sources: Record<string, string> = {};
      for (const k of ['sensor.grid_power', 'sensor.energy_prices']) if (a[k]) sources[k] = a[k];
      const srcs = (prefs as { energy_sources: unknown[] }).energy_sources;
      return { name, description, prefs, grid: srcs.filter((s) => (s as { type?: string })?.type === 'grid').map(gridFlows), statistic_ids: statisticIds(prefs), sources };
    }),
  };
}

const PROV = '{"providers":[{"name":"Home Assistant Local","id":null,"type":"homeassistant"}],"preselect_remember_me":true}';
const HA_PARSE = ['', '  homeassistant.local:8123 ', 'homeassistant.local', '192.168.1.5', 'HTTPS://HA.Example.com/lovelace/0', 'http://ha.local:8123/',
  'https://ha.example.com:443', 'http://ha.local:80', '[fd00::1]:8123', 'ha.local?x=1', 'ftp://ha.local', 'ws://ha.local:8123', 'ha local', 'user@ha.local',
  'ha.local:99999', 'ha.local:0', 'http://',
  // #75: loopback / link-local refused (also inet_aton short forms and IPv4-mapped IPv6), LAN kept; typed port stays with its scheme
  'localhost:8123', 'LOCALHOST.', 'x.localhost', '127.0.0.1:8080', 'http://127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '0.0.0.0',
  '169.254.1.1', '169.254', '[::1]:8123', '[::]', '[0:0:0:0:0:0:0:1]', '[fe80::1]', '[FEBF::1]', '[::ffff:127.0.0.1]', '[::ffff:169.254.0.1]',
  '10.0.0.2', '172.16.0.1', '[fd00::1]', '[fec0::1]', '128.0.0.1', '1.2.3.4.5', '127.256', 'localhost.example.com', 'http://ha.local:8080', 'https://ha.local:8443'];
const HA_RESOLVE: [string, string, Record<string, ProbeAnswer>][] = [
  ['found', 'homeassistant.local:8123', { 'http://homeassistant.local:8123': { status: 200, body: PROV } }],
  ['older HA: bare provider list', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 200, body: '[{"name":"Home Assistant Local","id":null,"type":"homeassistant"}]' } }],
  ['no scheme, only https answers', 'ha.example.com', { 'https://ha.example.com': { status: 200, body: PROV } }],
  ['http typed, redirected to https', 'http://ha.example.com', { 'http://ha.example.com': { status: 301, location: 'https://ha.example.com/auth/providers' }, 'https://ha.example.com': { status: 200, body: PROV } }],
  ['https typed, HA only on http: wrong scheme', 'https://ha.local:8123', { 'http://ha.local:8123': { status: 200, body: PROV } }],
  ['nothing answers', 'http://10.0.0.9:8123', {}],
  ['a web page, not HA', '192.168.1.1', { 'http://192.168.1.1:8123': { status: 200, body: '<!doctype html><title>Router</title>' } }],
  ['404', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 404, body: '404: Not Found' } }],
  ['providers not a list', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 200, body: '{"providers":"x"}' } }],
  ['empty provider list', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 200, body: '[]' } }],
  ['empty JSON object','http://ha.local:8123', { 'http://ha.local:8123': { status: 200, body: '{}' } }],
  ['wrong scheme typed', 'ftp://ha.local', {}],
  ['loopback refused, nothing probed', '127.0.0.1:8080', {}],
  ['http→https upgrade on the same port', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 302, location: 'https://ha.local:8123/auth/providers' }, 'https://ha.local:8123': { status: 200, body: PROV } }],
  ['https upgrade with the default port spelled out', 'http://ha.example.com', { 'http://ha.example.com': { status: 301, location: 'HTTPS://HA.example.com:443/' }, 'https://ha.example.com': { status: 200, body: PROV } }],
  ['redirect to another host refused', 'http://ha.example.com', { 'http://ha.example.com': { status: 302, location: 'http://127.0.0.1:8080/' }, 'http://127.0.0.1:8080': { status: 200, body: PROV } }],
  ['redirect to another port refused', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 307, location: 'https://ha.local:9999/' }, 'https://ha.local:9999': { status: 200, body: PROV } }],
  ['redirect to plain http of another port refused', 'ha.local', { 'http://ha.local:8123': { status: 302, location: 'http://ha.local:80/' }, 'http://ha.local': { status: 200, body: PROV } }],
  ['refused redirect, HA on the other scheme', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 302, location: 'https://evil.example/' }, 'https://ha.local:8123': { status: 200, body: PROV } }],
  ['relative redirect: not HA', 'http://ha.local:8123', { 'http://ha.local:8123': { status: 302, location: '/login' } }],
  ['typed http port, HA on https default port', 'http://ha.local:8080', { 'https://ha.local': { status: 200, body: PROV } }],
];
export async function haAddressVectors() {
  const resolve = [];
  for (const [name, input, answers] of HA_RESOLVE) {
    const probed: string[] = [];
    const result = await resolveHaAddress(input, async (u) => { probed.push(u); return answers[u] || { status: -1 }; });
    resolve.push({ name, input, answers, probed, result });
  }
  return {
    _doc: 'Home Assistant address on the link page (#54). parseHaAddress(input) and resolveHaAddress(input, probe): emulator src/core/haAddress.ts = firmware core/ha_address.cpp. probe(url) is one GET url + /auth/providers without following redirects; only a redirect to the https upgrade of the same host and port is probed next (#75). Loopback and link-local hosts are refused, LAN addresses kept. A url missing from answers has no answer (status -1). probed = the urls in probe order.',
    parse: HA_PARSE.map((input) => ({ input, ...parseHaAddress(input) })),
    resolve,
  };
}

/** UI strings (#98): the table, language resolution, placeholder fill and the clock date line. */
export function otaStatusVectors() {
  const base: OtaLineIn = { status: 'idle', error: null, version: '', checked: '', channel: 'stable', message: '' };
  const lines: [string, Partial<OtaLineIn>][] = [
    ['never checked', {}],
    ['checking', { status: 'checking', checked: '09:05' }],
    ['up to date', { status: 'uptodate', checked: '16:42' }],
    ['up to date, clock unknown', { status: 'uptodate' }],
    ['available on beta', { status: 'available', version: '0.2.0-beta.3', checked: '16:42', channel: 'beta' }],
    ['low memory', { status: 'error', error: 'memory', checked: '16:42', message: 'Not enough memory right now — try again in a minute' }],
    ['no connection', { status: 'error', error: 'network', message: 'No network — try again later' }],
    ['GitHub rate limit', { status: 'error', error: 'busy', checked: '16:42', message: 'GitHub not reachable (HTTP 403)' }],
    ['no releases', { status: 'error', error: 'none', checked: '16:42', message: 'No releases published yet' }],
    ['other check error', { status: 'error', error: 'other', message: 'GitHub not reachable (HTTP 502)' }],
    ['install failed', { status: 'error', message: 'Download was corrupted — nothing changed. Try again.' }],
    ['battery too low', { status: 'blocked', version: '0.3.0', message: 'Battery at 15% — charge to 30% first' }],
  ];
  return {
    _doc: 'Settings › Updates status line + web console Updates card (#250; emulator src/core/otaStatus.ts, firmware core/ota_status.h). errOf(code, online): a failed GitHub request → GET /ota `error` (code ≤ 0 = no answer; ' + HTTP_LOW_MEMORY + ' = TLS heap guard). line(lang, in): title + detail; checked = local HH:MM of the last check ("" = none).',
    errOf: ([[HTTP_LOW_MEMORY, true], [403, true], [429, true], [404, true], [-1, true], [0, true], [502, true], [500, true], [200, false], [HTTP_LOW_MEMORY, false]] as [number, boolean][])
      .map(([code, online]) => ({ code, online, error: otaErrOf(code, online) })),
    line: lines.flatMap(([name, p]) => LANGS.map((lang) => { const i = { ...base, ...p }; return { name, lang, in: i, out: otaLine(lang, i) }; })),
  };
}

export function stringsVectors() {
  const keys = Object.keys(STRINGS) as StrKey[];
  return {
    _doc: 'UI strings (#98): emulator src/core/strings.ts = firmware core/strings.{h,cpp} + the generated core/strings_gen.h (npm run vectors writes both). langOf(code): HA get_config language or browser language → en | nl (any nl variant → nl, everything else → en). tr(lang, key, args): each {} takes the next arg. dateLine(lang, wday, mday, month): struct tm numbering.',
    langs: LANGS,
    strings: Object.fromEntries(keys.map((k) => [k, { en: STRINGS[k][0], nl: STRINGS[k][1] }])),
    langOf: ['nl', 'nl-NL', 'nl_BE', 'NL', ' nl ', 'en', 'en-GB', 'de', 'fr-BE', 'nld', '', null].map((input) => ({ input, lang: langOf(input) })),
    tr: ([['en', 'charging', ['2.1 kW']], ['nl', 'charging', ['2.1 kW']], ['nl', 'standbyFoot', ['07:45']], ['en', 'cheapestAt', []], ['nl', 'off', ['x']], ['nl', 'haOffline', []]] as [Lang, StrKey, string[]][])
      .map(([lang, key, args]) => ({ lang, key, args, out: tr(lang, key, ...args) })),
    dateLine: ([['en', 2, 13, 9], ['nl', 2, 13, 9], ['nl', 0, 1, 0], ['en', 6, 31, 11], ['nl', 4, 7, 4]] as [Lang, number, number, number][])
      .map(([lang, wday, mday, month]) => ({ lang, wday, mday, month, out: dateLine(lang, wday, mday, month) })),
  };
}

const CPP_WORDS = new Set(['and', 'auto', 'bool', 'break', 'case', 'char', 'class', 'const', 'count', 'default', 'delete', 'do', 'double', 'else', 'enum', 'false', 'float', 'for', 'if', 'int', 'long', 'new', 'not', 'or', 'private', 'public', 'return', 'short', 'signed', 'static', 'struct', 'switch', 'this', 'true', 'union', 'void', 'while']);
/** C++ string literal: non-ASCII as UTF-8 \x escapes, each closed with "" so a following hex digit stays text. */
const cStr = (s: string) => '"' + [...s].map((c) => {
  if (c === '"' || c === '\\') return '\\' + c;
  if (c.charCodeAt(0) < 0x80) return c;
  return [...Buffer.from(c, 'utf8')].map((b) => '\\x' + b.toString(16)).join('') + '""';
}).join('') + '"';
/** firmware/src/core/strings_gen.h: the enum and the table, generated from src/core/strings.ts. */
export function stringsHeader(): string {
  const keys = Object.keys(STRINGS) as StrKey[];
  for (const k of keys) if (!/^[a-z][A-Za-z0-9]*$/.test(k) || CPP_WORDS.has(k)) throw new Error('string key is not a C++ identifier: ' + k);
  return '// GENERATED by emulator/scripts/gen-vectors.ts from emulator/src/core/strings.ts (#98). Do not edit: change\n' +
    '// strings.ts and run `npm run vectors`. emulator src/core/strings.test.ts fails when this file is stale.\n' +
    '#pragma once\n#include <cstdint>\n\nnamespace x4 {\n\n' +
    'enum class S : uint16_t {\n' + keys.map((k) => '  ' + k + ',\n').join('') + '  count\n};\n\n' +
    '// [key][0 = en, 1 = nl]\ninline constexpr const char* kStrTable[][2] = {\n' +
    keys.map((k) => '  {' + cStr(STRINGS[k][0]) + ', ' + cStr(STRINGS[k][1]) + '},\n').join('') + '};\n\n' +
    '// key names for the vector test (not referenced by the firmware, so not linked in)\ninline constexpr const char* kStrKeys[] = {\n' +
    keys.map((k) => '  "' + k + '",\n').join('') + '};\n\n}  // namespace x4\n';
}
export const STRINGS_HEADER = join(ROOT, 'firmware', 'src', 'core', 'strings_gen.h');

if (process.argv[1] && process.argv[1].endsWith('gen-vectors.ts')) {
  const dir = join(OUT, 'config');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));
  for (const v of configVectors()) writeFileSync(join(dir, v.name + '.json'), JSON.stringify(v, null, 2) + '\n');
  writeFileSync(join(OUT, 'severity.json'), JSON.stringify(severityVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'route-departures.json'), JSON.stringify(routeVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'diag.json'), JSON.stringify(diagVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'battery-history.json'), compactJson(batteryVectors()));
  writeFileSync(join(OUT, 'logs.json'), JSON.stringify(logsVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'seed.json'), JSON.stringify(seedVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'energy-prefs.json'), JSON.stringify(energyPrefsVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'ha-address.json'), JSON.stringify(await haAddressVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'list-pick.json'), JSON.stringify(listPickVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'stat-raw.json'), JSON.stringify(statRawVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'scene-action.json'), JSON.stringify(sceneActionVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'strings.json'), JSON.stringify(stringsVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'locale.json'), JSON.stringify(localeVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'history.json'), compactJson(historyVectors()));
  writeFileSync(join(OUT, 'history-series.json'), compactJson(historySeriesVectors()));
  writeFileSync(join(OUT, 'ota-status.json'), JSON.stringify(otaStatusVectors(), null, 2) + '\n');
  writeFileSync(STRINGS_HEADER, stringsHeader());
  console.log('wrote ' + CONFIG_CASES.length + ' config vectors + severity.json to ' + OUT);
}
