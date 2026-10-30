// Generates spec/test-vectors/ from the TypeScript reference implementation (src/core).
// Run: npm run vectors   (Node ≥ 22.18 / 24: runs .ts directly via type stripping)
// The C++ firmware runs the same vectors for parity. `src/core/vectors.test.ts` fails if they drift.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateYaml, cellsUsed, toYaml, sceneAction } from '../src/core/config.ts';
import { sevOf, routeLevel, carEta, carLevel, SEV, CAR_FACTOR } from '../src/core/severity.ts';
import { routeDeparturesOf } from '../src/core/route.ts';
import { binDays, binsView } from '../src/core/bins.ts';
import { capList, listAgo, listRows, listSpec, listView, LIST_MAX_BYTES, LIST_MAX_ITEMS } from '../src/core/attrList.ts';
import { fieldDecode, fieldEncode, guestLayout, guestPayload, guestQr, guestView } from '../src/core/guestWifi.ts';
import { logPush, logRing, logsQuery, logTail, redact, LOG_CAP, LOG_TAIL_CAP, type LogLevel, type LogRing, type LogsQuery } from '../src/core/logs.ts';
import { BATT_HISTORY_N, BATT_SAMPLE_S, BATT_ZERO, GAUGE_RISE_PTS, GAUGE_RISE_READS, GAUGE_ZERO, battHistory, battStep, gaugeStep, type BattIn } from '../src/core/battery.ts';
import { bootsJson, diagApply, lastCrash, type DiagOp, type DiagRing } from '../src/core/diag.ts';
import { seedAnswerOk, seedPlan, SEED_TEMPLATE, templateEventFinal, type HaSnapshot } from '../src/core/seed.ts';
import { houseData, seedAnswer, type House } from '../server/fake-ha.ts';
import { aliasesOf } from '../server/device.ts';
import { gridFlows, metersOf, statisticIds } from '../src/core/energyPrefs.ts';
import { hourlyStatistics, localDay, statsDayRoll } from '../src/core/energyHourly.ts';
import { parseHaAddress, resolveHaAddress, type ProbeAnswer } from '../src/core/haAddress.ts';
import { lightGroupsOf, listPages, pickLights, pickZones, type LightGroup } from '../src/core/paging.ts';
import { ROOMS, LIGHT_LIST, ZONE_LIST } from '../src/core/data.ts';
import type { Widget } from '../src/core/config.ts';
import { fmtNum, statSource } from '../src/core/format.ts';
import { TZ_TABLE, currencySymbol, money, tzFor, validTzSetting } from '../src/core/locale.ts';
import { STRINGS, LANGS, langOf, tr, dateLine, type Lang, type StrKey } from '../src/core/strings.ts';
import { otaErrOf, otaLine, HTTP_LOW_MEMORY, type OtaLineIn } from '../src/core/otaStatus.ts';
import { HISTORY_AGGS, attrSamples, axisTicks, bucketize, compareSpec, joinSeries, pastSpec, seriesNow, type HistorySpec, fromSamples, historyError, historySource, parseTime, chartSpan, dayLowHigh, defaultBucket, fromHistoryRows, fromStatistics, historySpec, lowHigh, parseSpan, resolveStyle, statsPeriod, statsType, yScale, type HistoryAgg, type HistoryStyle, type StatRow } from '../src/core/history.ts';
import { chartKey, historyChart, joinState, type HistState } from '../src/core/historyChart.ts';
import { WX_ICONS, weatherView, wxEntries, wxIcon } from '../src/core/weather.ts';
import { WX_ART, WX_GRID, WX_HERO_STROKE } from '../src/core/weatherArt.ts';
import { agendaKey, agendaLines, cutTitle, demoAnswer, eventsRequest, nextView, parseAnswer, type AgendaFetch } from '../src/core/agenda.ts';
import { TODAY_END, quietSources, quietTomorrow, type QuietIn } from '../src/core/quiet.ts';
import type { WxEntry } from '../src/core/weather.ts';
import type { CalEvent } from '../src/core/agenda.ts';
import { mediaAction, mediaLayout, mediaView, parseFavorites, volumeAt, type MediaTarget } from '../src/core/media.ts';
import { MORNING_EVENTS, MORNING_IDLE, MORNING_MS, morningSources, morningStep, morningView, type MorningState, type MorningTick } from '../src/core/morning.ts';

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
  ['18-unknown-widget-type', 'Rule: type must be one of the widget types.', H + scr('a', ['type: radar'])],
  ['19-missing-type', 'Rule: a widget without type is an unknown type (quirk: the message literally says “undefined”).', H + scr('a', ['cs: 2'])],
  ['20-stat-wrong-domain', 'Rule: stat entity must be an HA entity_id in sensor / binary_sensor / input_number / number / climate / weather.', H + scr('a', ['type: clock', 'type: stat, entity: switch.coffee'])],
  ['21-entity-not-an-id', 'Rule: entity must look like domain.object_id ("constructor" is not one).', H + scr('a', ['type: stat, entity: constructor'])],
  ['22-route-bad-mode', 'Rule: route mode must be train, bus or car (eink-ha-os#145).', H + scr('t', ['type: route, label: To work, mode: plane, entity: sensor.commute, cs: 2'], '    app: travel\n')],
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
  ['36-too-many-apps', 'Rule: at most 7 apps of your own (reported on the 8th); the 8th slot is the built-in Settings app (eink-ha-os#159).', 'version: 1\napps:\n' + [1, 2, 3, 4, 5, 6, 7, 8].map((k) => '  - id: a' + k + '\n').join('') + 'screens:\n' + scr('x', ['type: clock'])],
  ['37-empty-apps', 'Rule: an apps: section needs at least one app (reported on the apps: line).', 'version: 1\napps:\nscreens:\n' + scr('x', ['type: clock'], '    title: X\n')],
  ['38-app-key-inside-apps', 'Rule: an app entry only has id and title.', 'version: 1\napps:\n  - id: a\n    app: b\nscreens:\n' + scr('x', ['type: clock'])],
  ['39-unknown-app-custom', 'Rule: with an apps: section, the message lists those ids.', 'version: 1\napps:\n  - id: garden\n  - id: car\nscreens:\n' + scr('x', ['type: clock'], '    app: home\n')],
  ['40-ha-entities', 'stat / gauge / switch take any HA entity_id of their domains (sensor, binary_sensor, input_number, number, climate, weather | sensor, input_number, number | switch, light, input_boolean, fan); gauge without entity = home battery.', H + scr('a', ['type: stat, entity: sensor.outdoor_temperature', 'type: stat, entity: binary_sensor.front_door, label: Door', 'type: stat, entity: input_number.target', 'type: gauge', 'type: gauge, entity: sensor.phone_battery', 'type: switch, entity: switch.coffee', 'type: switch, entity: input_boolean.guest_mode', 'type: switch, entity: fan.attic'])],
  ['41-gauge-wrong-domain', 'Rule: gauge entity must be sensor / input_number / number.', H + scr('a', ['type: gauge, entity: binary_sensor.door'])],
  ['42-switch-without-entity', 'Rule: switch needs an entity.', H + scr('a', ['type: switch'])],
  ['43-legacy-light', 'Legacy {type: light, light: id} is read as {type: switch, entity: light.id} (key keeps its position); a full id is kept.', H + scr('a', ['type: light, light: living_ceiling, cs: 2', 'type: light, light: light.kitchen_spots'])],
  ['44-entity-uppercase', 'Rule: entity ids are lower-case (HA entity_id format).', H + scr('a', ['type: switch, entity: switch.Coffee'])],
  ['46-list-picks', 'lightList areas / entities and zoneList entities are space-separated lists (eink-ha-os#127); kept as one string value, written back as is.', H + scr('a', ['type: lightList, areas: kitchen living_room, entities: light.porch light.hall_2, cs: 4']) + scr('b', ['type: zoneList, entities: climate.living climate.office, cs: 4', 'type: lightList, areas: , cs: 4'])],
  ['47-lightlist-bad-entity', 'Rule: lightList entities are light.* ids.', H + scr('a', ['type: lightList, entities: light.porch switch.coffee'])],
  ['48-lightlist-bad-area', 'Rule: lightList areas are HA area ids (^[a-z0-9_]+$), not names.', H + scr('a', ['type: lightList, areas: kitchen Living Room'])],
  ['49-zonelist-bad-entity', 'Rule: zoneList entities are climate.* ids (any integration).', H + scr('a', ['type: zoneList, entities: sensor.living_temperature'])],
  ['50-user-routes', 'Routes are user tiles (eink-ha-os#145): free label, mode train | bus | car (absent = train), entity = a sensor.* id; the route id is optional free text.', H + scr('t', ['type: route, label: To work, mode: train, entity: sensor.commute_departures, cs: 2', 'type: route, label: Bus 52, mode: bus, entity: sensor.bus_52, cs: 2', 'type: route, label: Drive, mode: car, entity: sensor.drive_time, cs: 2', 'type: route, route: my_line, entity: sensor.x4_route_my_line, cs: 2'], '    app: travel\n')],
  ['51-legacy-route', 'Old catalog routes (`route: home_centre`, `route: car`, …, before eink-ha-os#145) still parse: an empty user route without entity (the tile asks for a sensor; the console blocks saving until one is picked).', H + scr('t', ['type: route, route: home_centre, cs: 2', 'type: route, route: car, cs: 2'], '    app: travel\n')],
  ['52a-route-entity2', 'A train/bus route may name a second departure entity (ha-paper#22): `entity2`, a sensor.* id; its departures follow the first entity\'s.', H + scr('t', ['type: route, label: Bus 12, mode: bus, entity: sensor.bus_stop_12345678_current_departure_time, entity2: sensor.bus_stop_12345678_next_departure_time, cs: 2'], '    app: travel\n')],
  ['52b-route-entity2-domain', 'Rule: a route entity2 must be a sensor.* id (ha-paper#22).', H + scr('t', ['type: route, label: Bus 12, mode: bus, entity: sensor.bus_12, entity2: switch.bus'], '    app: travel\n')],
  ['52-route-wrong-domain', 'Rule: a route entity must be a sensor.* id.', H + scr('t', ['type: route, label: Drive, entity: switch.car'], '    app: travel\n')],
  // eink-ha-os#319: the now playing tile on a media_player, with favorites (Name=type:id or Name=script.<id> / scene.<id>, split by ;)
  ['319a-media-favorites', 'A media tile takes a media_player entity, an optional label and up to 6 favorites (eink-ha-os#319); ids may hold colons and slashes.', H + scr('a', ['type: media, entity: media_player.living_room, cs: 2, favorites: Radio 1=music:http://icecast.omroep.nl/radio1-bb-mp3; Bedtime=script.good_night; Movie=scene.movie_night', 'type: media, entity: media_player.kitchen, label: Kitchen'])],
  ['319b-media-wrong-domain', 'Rule: a media entity must be a media_player.* id.', H + scr('a', ['type: clock', 'type: media, entity: switch.speaker, cs: 2'])],
  ['319c-media-no-entity', 'Rule: a media tile needs its entity.', H + scr('a', ['type: media, cs: 2'])],
  ['319d-media-bad-favorite', 'Rule: a favorite is Name=type:id or Name=script.<id> / scene.<id>.', H + scr('a', ['type: media, entity: media_player.living_room, cs: 2, favorites: Radio=music:http://x; light.kitchen'])],
  ['319e-media-too-many', 'Rule: at most 6 favorites.', H + scr('a', ['type: media, entity: media_player.living_room, cs: 2, favorites: A=music:1; B=music:2; C=music:3; D=music:4; E=music:5; F=music:6; G=music:7'])],
  // eink-ha-os#329: guest Wi-Fi; ssid / password fieldEncode'd (%XX for "%" "," "{" "}", control characters, edge spaces, a leading digit)
  ['329a-guest-wifi', 'A guestWifi tile (eink-ha-os#329): ssid, password (fieldEncode: %2C = ","), security WPA | WEP | nopass, hidden: true, password_entity (input_text / text / sensor) overriding password; values kept as written.', H + scr('a', ['type: guestWifi, ssid: Harbor Guest, password: tea%2C please, cs: 2, rs: 2', 'type: guestWifi, ssid: Lobby, security: nopass, hidden: true, cs: 2']) + scr('b', ['type: guestWifi, ssid: Attic, password: %3012345678, security: WEP, hidden: false', 'type: guestWifi, ssid: Harbor Guest, password_entity: input_text.guest_password, cs: 2'])],
  ['329b-guest-wifi-security', 'Rule: security is WPA, WEP or nopass.', H + scr('a', ['type: guestWifi, ssid: Harbor Guest, password: x, security: WPA3, cs: 2, rs: 2'])],
  ['329c-guest-wifi-hidden', 'Rule: hidden is true or false.', H + scr('a', ['type: guestWifi, ssid: Harbor Guest, password: x, hidden: yes, cs: 2, rs: 2'])],
  // eink-ha-os#332: list from attributes
  ['332a-attr-list', 'An attrList tile (eink-ha-os#332): entity (sensor), attribute / title / time = field names, subtitle = up to 3 field names split by spaces, empty = free text, label; all but entity optional (defaults sightings, title, subtitle, ts; eink-ha-os#375).', H + scr('a', ['type: attrList, entity: sensor.rare_birds_nearby, cs: 2, rs: 2', 'type: attrList, entity: sensor.departures_board, attribute: trains, title: destination, subtitle: platform, time: departs, empty: No trains, label: Trains, cs: 2, rs: 2'])],
  ['332b-attr-list-wrong-domain', 'Rule: an attrList entity is a sensor.', H + scr('a', ['type: attrList, entity: calendar.birds, cs: 2'])],
  ['332c-attr-list-bad-field', 'Rule: attribute / title / time are field names (letters, digits, _).', H + scr('a', ['type: attrList, entity: sensor.rare_birds_nearby, title: species-name, cs: 2'])],
  ['332d-attr-list-subtitle', 'Rule: at most 3 subtitle fields.', H + scr('a', ['type: attrList, entity: sensor.rare_birds_nearby, subtitle: a b c d, cs: 2'])],
  ['329d-guest-wifi-password-entity', 'Rule: password_entity is an input_text / text / sensor entity; the message never repeats the ssid or password.', H + scr('a', ['type: guestWifi, ssid: Harbor Guest, password: x, password_entity: light.porch, cs: 2, rs: 2'])],
  ['66-zonelist-labels', 'A zoneList can rename rooms (eink-ha-os#151): labels = "climate.<id>=Name" items split by ";"; kept as one string value, written back as is.', H + scr('a', ['type: zoneList, entities: climate.bathroom climate.bathroom_attic, labels: climate.bathroom_attic=Attic; climate.bathroom=Bathroom downstairs, cs: 4'])],
  ['67-zonelist-label-wrong-domain', 'Rule: a zoneList labels item names a climate.* entity (eink-ha-os#151).', H + scr('a', ['type: zoneList, labels: sensor.bathroom=Bathroom'])],
  ['68-zonelist-label-no-name', 'Rule: a zoneList labels item is climate.<id>=Name with a name (eink-ha-os#151).', H + scr('a', ['type: zoneList, labels: climate.bathroom'])],
  ['70-labels-on-panel-tiles', 'price, bars, the home battery gauge and thermo keep a label (eink-ha-os#148): the panel draws it instead of the built-in title.', H + scr('a', ['type: price, label: Power', 'type: bars, series: solar, label: Solar today, cs: 2', 'type: gauge, label: Battery', 'type: thermo, zone: living_room, label: Living room, rs: 2'])],
  ['71-thermo-no-zone', 'A thermo tile without a zone parses (eink-ha-os#148: the console palette adds it, then the user picks a climate entity); the panel shows "—".', H + scr('a', ['type: thermo, rs: 2'])],
  ['90-bins', 'A bins tile (eink-ha-os#317): entities = space-separated sensor ids, labels = sensor.<id>=Name items split by ";", tonight = the hour (0–23) from which the day before says "put out tonight"; a 1-wide tile shows the soonest bin.', H + scr('a', ['type: bins, entities: sensor.afval_papier sensor.waste_pmd, labels: sensor.afval_papier=Paper; sensor.waste_pmd=Plastic, tonight: 18, cs: 2', 'type: bins, entities: sensor.waste_gft', 'type: bins'])],
  ['91-bins-wrong-domain', 'Rule: bins entities must be sensor.* ids.', H + scr('a', ['type: bins, entities: sensor.afval_papier calendar.afval, cs: 2'])],
  ['92-bins-label-no-name', 'Rule: bins labels items must be sensor.<id>=Name.', H + scr('a', ['type: bins, entities: sensor.afval_papier, labels: sensor.afval_papier, cs: 2'])],
  ['93-bins-tonight', 'Rule: bins tonight must be a whole hour 0–23.', H + scr('a', ['type: bins, entities: sensor.afval_papier, tonight: 24, cs: 2'])],
  ['94-bins-too-many', 'Rule: at most 6 sensors on a bins tile.', H + scr('a', ['type: bins, entities: sensor.b1 sensor.b2 sensor.b3 sensor.b4 sensor.b5 sensor.b6 sensor.b7, cs: 2'])],
  ['58-stat-climate-weather', 'A stat tile takes a climate or weather entity (eink-ha-os#161): it shows the temperature (stat-raw.json).', H + scr('a', ['type: stat, entity: climate.living_room', 'type: stat, entity: weather.forecast_home, label: Outside'])],
  ['45-label-free-text', 'Labels and titles are free text: spaces, %, accents (issue eink-ha-os#80); surrounding spaces are trimmed.', H + scr('a', ['type: stat, entity: sensor.phone_battery, label: Batterij %', 'type: gauge, entity: sensor.phone_battery, label:  Température café ', 'type: switch, entity: switch.coffee, label: Koffie & thee'], '    title: Energie & café 100%\n')],
  // eink-ha-os#159: Settings is built in. Older files keep parsing: the settings app entry is skipped, its screens and settings tiles are dropped.
  ['53-legacy-settings-screens', 'Settings screens (app: settings) from older files parse and are dropped; the display adds its fixed Settings pages.', H + scr('a', ['type: clock'], '    app: home\n') + scr('display', ['type: setting, key: brightness', 'type: setting, key: night'], '    app: settings\n') + scr('updates', ['type: ota, cs: 4, rs: 2'], '    app: settings\n')],
  ['54-legacy-settings-app', 'An apps: entry “settings” (with its title) is skipped and does not count towards the 7; a screen may still name it.', 'version: 1\napps:\n  - id: home\n    title: Home\n  - id: settings\n    title: Instellingen\n' + [1, 2, 3, 4, 5, 6].map((k) => '  - id: a' + k + '\n').join('') + 'screens:\n' + scr('h', ['type: price']) + scr('wifi', ['type: wifi, cs: 4, rs: 2'], '    app: settings\n')],
  ['55-legacy-settings-tiles', 'Settings tiles (setting, ota, wifi, ha, about) on your own screens parse and are dropped (they only live on the fixed Settings pages).', H + scr('a', ['type: clock', 'type: setting, key: night', 'type: price', 'type: wifi', 'type: about'], '    app: home\n') + scr('b', ['type: ha, cs: 4, rs: 2'], '    app: house\n')],
  ['56-legacy-only-settings', 'Rule: a file with only Settings screens has no screens of your own → No screens found (line 1), like an empty list.', 'version: 1\napps:\n  - id: settings\n    title: Settings\nscreens:\n' + scr('about', ['type: about, cs: 4, rs: 2'], '    app: settings\n')],
  ['57-settings-duplicate-checked', 'Rule: settings screens are checked before they are dropped (duplicate id, cells), so an old file fails the same way it always did.', H + scr('wifi', ['type: clock'], '    app: home\n') + scr('wifi', ['type: wifi, cs: 4, rs: 2'], '    app: settings\n')],
  // eink-ha-os#146: the scene tile runs an HA scene or script; no entity (or the older scene: all_off) = all lights off
  ['63-scene-entity', 'A scene tile takes a scene.* or script.* entity and an optional label (eink-ha-os#146); without entity, or with the older `scene: all_off`, it is all lights off.', H + scr('a', ['type: scene, entity: scene.movie_night, cs: 2', 'type: scene, entity: script.good_night, label: Bedtime', 'type: scene, scene: all_off, label: Lights out', 'type: scene'])],
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

/** Weather tile (eink-ha-os#318): config rules, condition → drawing, forecast lists → kept entries, and the tile's text. */
export const WEATHER_CONFIG_CASES: [string, string, string][] = [
  ['weather-full-and-half', 'A weather tile on a weather.* entity, full width: rs 2 (full screen) or rs 1 (top half), with a label.', H + scr('a', ['type: weather, entity: weather.home, cs: 4, rs: 2']) + scr('b', ['type: weather, entity: weather.forecast_home, label: Outside, cs: 4', 'type: clock, cs: 4'])],
  ['weather-not-full-width', 'Rule: a weather tile is full width (cs: 4).', H + scr('a', ['type: weather, entity: weather.home, cs: 2, rs: 2'])],
  ['weather-default-width', 'Rule: no cs is 1 wide, not full width.', H + scr('a', ['type: weather, entity: weather.home'])],
  ['weather-wrong-domain', 'Rule: the entity must be a weather.* id.', H + scr('a', ['type: weather, entity: sensor.outdoor_temperature, cs: 4'])],
  ['weather-no-entity', 'Rule: entity is required.', H + scr('a', ['type: weather, cs: 4'])],
  ['weather-third', 'Rule: at most 2 weather tiles per config.', H + scr('a', ['type: weather, entity: weather.home, cs: 4']) + scr('b', ['type: weather, entity: weather.home, cs: 4']) + scr('c', ['type: weather, entity: weather.home, cs: 4'])],
];
export function weatherVectors() {
  const NOW = HNOW, TZ = 60, HOUR = 3_600_000;
  const iso = (t: number, tz: number) => { const d = new Date(t + tz * 60_000), a = Math.abs(tz); return d.toISOString().slice(0, 19) + (tz < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0'); };
  const conds = ['sunny', 'clear-night', 'partlycloudy', 'cloudy', 'fog', 'rainy', 'pouring', 'snowy', 'snowy-rainy', 'hail', 'lightning', 'lightning-rainy', 'windy', 'windy-variant', 'exceptional', 'tornado', ''];
  // met.no-like daily entries at 11:00 UTC from yesterday; one without a datetime, one with a bad one, a string number
  const daily: Record<string, unknown>[] = [-1, 0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ datetime: iso(Date.UTC(2026, 9, 26 + k, 11), 0), condition: conds[(k + 3) % 9], temperature: 12 + (k % 3) + 0.456, templow: 5 - k * 1.5, precipitation: [0, 0.4, 8.25, 2, 0, 0.04, 12, 1, 0][k + 1], wind_speed: 14 }));
  daily.splice(3, 0, { condition: 'sunny', temperature: 30 }, { datetime: 'tomorrow', temperature: 30 });
  daily[5].temperature = '13.5';
  delete daily[6].precipitation;
  // hourly from 2 h before the hour holding now (local times), a shower from 19:00 local
  const h0 = Math.floor(NOW / HOUR) * HOUR - 2 * HOUR;
  const hourly = Array.from({ length: 30 }, (_, k) => ({ datetime: iso(h0 + k * HOUR, TZ), condition: k === 6 || k === 7 ? 'rainy' : 'cloudy', temperature: 11 - k * 0.25, precipitation: k === 0 ? 3 : k === 6 ? 0.6 : k === 7 ? 1.1 : 0 }));
  const hourlyNow = hourly.map((e, k) => ({ ...e, precipitation: k === 2 ? 0.2 : 0 }));
  const hourlyNoMm = hourly.map(({ precipitation: _, ...e }, k) => ({ ...e, condition: k === 9 ? 'snowy' : 'cloudy' }));
  const attrs = { temperature: 11.4, apparent_temperature: 9.5, temperature_unit: '°C', wind_speed: 4, wind_speed_unit: 'Beaufort', wind_bearing: 225, precipitation_unit: 'mm' };
  const entries = [
    { name: 'daily', description: 'Daily from today (local date, tz +60): yesterday skipped, entries without a valid datetime skipped, at most 7; numbers to 2 decimals, a numeric string read, a missing field null.', kind: 'daily' as const, tz: TZ, raw: daily },
    { name: 'daily-json-string', description: 'The same list as JSON text.', kind: 'daily' as const, tz: TZ, raw: JSON.stringify(daily) },
    { name: 'hourly', description: 'Hourly from the hour holding now (15:00 local): earlier hours skipped, at most 16.', kind: 'hourly' as const, tz: TZ, raw: hourly },
    { name: 'not-a-list', description: 'Not a list: no entries.', kind: 'hourly' as const, tz: TZ, raw: { forecast: [] } },
  ].map((c) => ({ ...c, out: wxEntries(c.raw, c.kind, NOW, c.tz) }));
  const views: { name: string; description: string; state: string | null; attrs: Record<string, unknown>; daily: unknown; hourly: unknown; tz: number; lang: Lang }[] = [
    { name: 'full-en', description: 'Partly cloudy, feels 10°, high / low from today, 4 Bft SW, rain from 19:00 (18:00 UTC), the next 5 days with bars scaled to 10 mm or the wettest day.', state: 'partlycloudy', attrs, daily, hourly, tz: TZ, lang: 'en' },
    { name: 'full-nl', description: 'The same in Dutch: decimal comma, ZW, vanaf 19:00, short weekday names.', state: 'partlycloudy', attrs, daily, hourly, tz: TZ, lang: 'nl' },
    { name: 'kmh-text-bearing', description: 'Wind in km/h, a text bearing kept as is; no apparent_temperature = no "feels"; rain in the hour holding now = "now".', state: 'rainy', attrs: { temperature: -0.4, wind_speed: 19.6, wind_speed_unit: 'km/h', wind_bearing: 'NNW' }, daily, hourly: hourlyNow, tz: TZ, lang: 'en' },
    { name: 'no-precipitation', description: 'Hourly entries without precipitation: wet by condition (snowy at 22:00); bearing 350° = N; an unknown condition by name.', state: 'tornado', attrs: { temperature: 3, wind_speed: 2.5, wind_speed_unit: 'm/s', wind_bearing: 350 }, daily, hourly: hourlyNoMm, tz: TZ, lang: 'en' },
    { name: 'dry', description: 'No wet hour in the next 12 h: "none soon".', state: 'sunny', attrs, daily, hourly: hourly.map((e) => ({ ...e, precipitation: 0 })), tz: TZ, lang: 'nl' },
    { name: 'no-forecast', description: 'No forecast answer yet (null): high / low / rain "—", no strip.', state: 'cloudy', attrs, daily: null, hourly: null, tz: TZ, lang: 'en' },
    { name: 'unavailable', description: 'Unavailable entity: the gap, no temperature, no wind; the forecast still shows.', state: 'unavailable', attrs: {}, daily, hourly, tz: TZ, lang: 'en' },
    { name: 'no-state', description: 'Not in the mirror yet: "—".', state: null, attrs: {}, daily: [], hourly: [], tz: TZ, lang: 'en' },
    { name: 'inches-west', description: 'precipitation_unit in: bars scaled to at least 0.4 in; tz -300 shifts the local dates (today = the 26th).', state: 'cloudy', attrs: { ...attrs, precipitation_unit: 'in', wind_speed_unit: 'mph' }, daily: daily.map((e) => ({ ...e, precipitation: typeof e.precipitation === 'number' ? e.precipitation / 20 : e.precipitation })), hourly, tz: -300, lang: 'en' },
  ];
  return {
    _doc: 'Weather tile (eink-ha-os#318): emulator src/core/weather.ts (weatherError, wxIcon, wxEntries, weatherView). Firmware: core/weather.cpp, test_core test_weather_vectors. Times epoch ms; tz = local UTC offset in minutes; now = ' + iso(NOW, 0) + '. config: like config/*.json. icons: HA condition → drawing. entries: a weather.get_forecasts list → kept entries (t, icon, temp, low, mm; null = absent). views: entity state + attributes + both lists (raw, through wxEntries) → the tile text.',
    now: NOW, icons: WX_ICONS,
    config: WEATHER_CONFIG_CASES.map(([name, description, input]) => ({ name, description, input, expect: summarize(input) })),
    conditions: conds.map((c) => ({ condition: c, icon: wxIcon(c) })),
    entries,
    views: views.map((v) => ({ ...v, out: weatherView({ state: v.state, attrs: v.attrs, daily: v.daily === null ? null : wxEntries(v.daily, 'daily', NOW, v.tz), hourly: v.hourly === null ? null : wxEntries(v.hourly, 'hourly', NOW, v.tz), now: NOW, tz: v.tz, lang: v.lang }) })),
  };
}

/** History tile config cases (eink-ha-os#265); in history.json next to the rest of the tile's vectors (firmware test_core runs them, eink-ha-os#268). */
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
  ['history-bad-style', 'Rule: style is bars, line, area, step, dots, band or auto.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, style: pie'])],
  ['history-styles', 'Styles area, step, dots (eink-ha-os#304); threshold is a number (negative / decimal), labels true or false. Kept as written.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, style: area, threshold: 18, labels: true, cs: 4', 'type: history, entity: sensor.price, style: step, threshold: -0.5, labels: false, cs: 4']) + scr('b', ['type: history, entity: sensor.rain, style: dots, threshold: 2.5, cs: 4'])],
  ['history-band-compare', 'Style band and compare 1d / 7d (eink-ha-os#304 wave 2) on recorder series. Kept as written.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, style: band, compare: 1d, cs: 4', 'type: history, entity: sensor.power, window: 7d, agg: max, style: bars, compare: 7d, cs: 4'])],
  ['history-band-on-forecast', 'Rule: band and compare need a recorder series (a weather forecast is not one).', H + scr('a', ['type: history, entity: weather.home, style: band'])],
  ['history-band-agg', 'Rule: style band needs agg mean (the line is the mean between min and max).', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, style: band, agg: max'])],
  ['history-compare-window', 'Rule: compare is 1d or 7d and at least the window (a 7d window cannot compare a day back).', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, window: 7d, compare: 1d'])],
  ['history-threshold-not-number', 'Rule: threshold is a number.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, threshold: high'])],
  ['history-labels-not-bool', 'Rule: labels is true or false.', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, labels: yes'])],
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

/** History chart geometry (eink-ha-os#267, eink-ha-os#270): historyChart over a series laid on chartSpan(now); bars b / t and line points
 *  at bucket centres in fractions of the plot (0 = bottom), the low / high text with fmtNum(v, unit), and chartKey
 *  (redraw key at px = 200). Firmware core/history_chart.cpp runs these. */
function chartVectors() {
  const cases: { name: string; window: string; bucket: string; style: HistoryStyle; min?: number; max?: number; threshold?: number; labels?: true; tz: number; lang: Lang; state: HistState; unit: string; values: (number | null)[] | null;
    lo?: (number | null)[]; hi?: (number | null)[]; prev?: (number | null)[] }[] = [
    { name: 'bars-gaps-negative', window: '24h', bucket: '2h', style: 'bars', tz: 60, lang: 'en', state: 'ok', unit: '°C', values: [3, -1.5, null, 4, 6, null, 2, 5, 5, 1, null, null] },
    { name: 'bars-all-positive', window: '7d', bucket: '6h', style: 'bars', tz: 60, lang: 'nl', state: 'ok', unit: '%', values: Array.from({ length: 28 }, (_, i) => (i === 27 ? null : 60 + ((i * 7) % 23))) },
    { name: 'line-gap-autorange', window: '6h', bucket: '30m', style: 'line', tz: 60, lang: 'nl', state: 'ok', unit: '°C', values: [12.4, 12.1, 11.8, null, null, 11, 10.6, 10.9, 11.5, 12.2, 12.9, null] },
    { name: 'line-flat', window: '1h', bucket: '5m', style: 'line', tz: 0, lang: 'en', state: 'ok', unit: 'W', values: Array(12).fill(250) },
    { name: 'line-fixed-range-clamped', window: '1h', bucket: '5m', style: 'line', min: 0, max: 10, tz: 0, lang: 'en', state: 'ok', unit: '', values: [-2, 0, 5, 10, 14, 7, null, 3, 3, 3, 3, 3] },
    { name: 'bars-fixed-range', window: '24h', bucket: '1h', style: 'bars', min: 2, max: 8, tz: 330, lang: 'en', state: 'ok', unit: 'mm', values: [...Array(20).fill(null), 1, 4, 9, 6] },
    { name: 'none', window: '24h', bucket: '30m', style: 'line', tz: 60, lang: 'en', state: 'ok', unit: '°C', values: Array(48).fill(null) },
    { name: 'loading', window: '24h', bucket: '30m', style: 'bars', tz: 60, lang: 'en', state: 'loading', unit: '°C', values: null },
    { name: 'too-many', window: '24h', bucket: '30m', style: 'line', tz: 60, lang: 'nl', state: 'tooMany', unit: 'W', values: null },
    { name: 'needs-stats', window: '7d', bucket: '6h', style: 'bars', tz: 60, lang: 'en', state: 'needsStats', unit: 'W', values: null },
    // eink-ha-os#304: area / step / dots, threshold, labels, gaps
    { name: 'area-gap-threshold-labels', window: '6h', bucket: '30m', style: 'area', threshold: 11.5, labels: true, tz: 60, lang: 'en', state: 'ok', unit: '°C', values: [12.4, 12.1, 11.8, null, null, 11, 10.6, 10.9, 11.5, 12.2, 12.9, 12.6] },
    { name: 'area-lone-point', window: '1h', bucket: '10m', style: 'area', tz: 0, lang: 'en', state: 'ok', unit: 'W', values: [5, null, 7, 8, null, 6] },
    { name: 'step-gaps-labels', window: '24h', bucket: '2h', style: 'step', labels: true, tz: 60, lang: 'nl', state: 'ok', unit: '', values: [0.21, 0.21, 0.25, null, 0.31, 0.31, 0.28, 0.22, null, null, 0.19, 0.24] },
    { name: 'dots-sparse-threshold', window: '24h', bucket: '1h', style: 'dots', threshold: 0, tz: 0, lang: 'en', state: 'ok', unit: 'mm', values: [...Array(8).fill(null), 1.2, null, null, 3.4, null, 0.4, ...Array(9).fill(null), 2] },
    { name: 'line-threshold-widens-range', window: '1h', bucket: '5m', style: 'line', threshold: 30, tz: 0, lang: 'en', state: 'ok', unit: '°C', values: [20, 21, 21.5, 22, 22, 21.8, 21.6, 21.4, 21.2, 21, 21, 21.1] },
    { name: 'threshold-outside-fixed-range', window: '1h', bucket: '5m', style: 'step', min: 0, max: 10, threshold: 12, tz: 0, lang: 'en', state: 'ok', unit: '', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 7, 6] },
    { name: 'bars-threshold-labels-last-near-max', window: '6h', bucket: '1h', style: 'bars', threshold: 4, labels: true, tz: 60, lang: 'en', state: 'ok', unit: 'kWh', values: [1, 3, 2, 0.5, 5.5, 5.2] },
    // eink-ha-os#304 wave 2: band (min / max series), compare (the earlier window); a lone bucket has no band, a short extra is ignored
    { name: 'band-gap-lone', window: '6h', bucket: '30m', style: 'band', tz: 60, lang: 'en', state: 'ok', unit: '°C', values: [12.4, 12.1, 11.8, null, 11.5, null, 10.6, 10.9, 11.5, 12.2, 12.9, 12.6],
      lo: [11.9, 11.5, 11.2, null, 11, null, 9.8, 10.1, 10.9, 11.6, 12.1, 12.3], hi: [13.1, 12.6, 12.4, null, 12, null, 11.2, 11.6, 12.3, 12.9, 13.8, null] },
    { name: 'band-fixed-range-threshold', window: '1h', bucket: '10m', style: 'band', min: 0, max: 20, threshold: 15, tz: 0, lang: 'nl', state: 'ok', unit: 'W', values: [5, 8, 12, 9, 7, 6], lo: [2, 6, 8, 8, 5, 5], hi: [9, 11, 25, 10, 9, 7] },
    { name: 'compare-bars', window: '24h', bucket: '2h', style: 'bars', tz: 60, lang: 'en', state: 'ok', unit: 'kWh', values: [1, 2, 3, null, 2, 1, 0.5, 4, 3, 2, 1.5, 0.8], prev: [1.2, 2.5, -0.5, 1, null, 1, 0.4, 6, 3.1, 2, 1.1, 0.9] },
    { name: 'compare-line-gaps', window: '6h', bucket: '30m', style: 'line', labels: true, tz: 60, lang: 'en', state: 'ok', unit: '°C', values: [12.4, 12.1, 11.8, null, null, 11, 10.6, 10.9, 11.5, 12.2, 12.9, 12.6], prev: [9, 9.5, null, 10, 10.4, 10.2, null, null, 8, 8.2, 8.9, 9.1] },
    { name: 'compare-step', window: '24h', bucket: '2h', style: 'step', tz: 60, lang: 'nl', state: 'ok', unit: '', values: [0.21, 0.21, 0.25, null, 0.31, 0.31, 0.28, 0.22, null, null, 0.19, 0.24], prev: [0.2, 0.22, 0.3, 0.3, null, 0.35, 0.29, 0.2, 0.18, 0.18, 0.2, 0.26] },
    { name: 'band-compare', window: '24h', bucket: '2h', style: 'band', tz: 0, lang: 'en', state: 'ok', unit: '°C', values: [8, 7.5, 7, 7.2, 9, 12, 14, 15, 14.5, 12, 10, 9], lo: [7, 7, 6.5, 6.8, 7.5, 10, 13, 14, 13.5, 11, 9.5, 8.6], hi: [9, 8.2, 7.4, 8, 10.5, 13.4, 15.2, 16.1, 15, 13, 10.6, 9.2],
      prev: [6, 5.5, 5, 5.1, 7, 10, 11, 11.5, 11, 9, 8, null] },
    { name: 'compare-none-current', window: '6h', bucket: '1h', style: 'dots', tz: 60, lang: 'en', state: 'ok', unit: '', values: Array(6).fill(null), prev: [1, 2, 3, 4, 5, 6] },
    { name: 'compare-wrong-length', window: '6h', bucket: '1h', style: 'line', tz: 60, lang: 'en', state: 'ok', unit: '', values: [1, 2, 3, 4, 5, 6], prev: [1, 2, 3] },
    { name: 'labels-loading', window: '6h', bucket: '1h', style: 'area', threshold: 4, labels: true, tz: 60, lang: 'en', state: 'loading', unit: '', values: null },
  ];
  return cases.map((c) => {
    const windowMs = parseSpan(c.window) as number, bucketMs = parseSpan(c.bucket) as number, n = windowMs / bucketMs;
    const spec = { entity: 'sensor.x', windowMs, bucketMs, n, agg: 'mean' as HistoryAgg, style: c.style, min: c.min ?? null, max: c.max ?? null, ...(c.threshold !== undefined ? { threshold: c.threshold } : {}), ...(c.labels ? { labels: c.labels } : {}) };
    const series = c.values ? { start: chartSpan(spec, HNOW, c.tz).start, bucketMs, values: c.values } : null;
    const ch = historyChart(spec, series, c.state, HNOW, c.tz, c.lang, (v) => fmtNum(v, c.unit), { lo: c.lo, hi: c.hi, prev: c.prev });
    const values = c.values ?? Array<number | null>(n).fill(null);
    return { ...c, n, min: c.min ?? null, max: c.max ?? null, threshold: c.threshold ?? null, labels: !!c.labels, lo: c.lo ?? null, hi: c.hi ?? null, prev: c.prev ?? null, out: { state: ch.state, stateText: ch.stateText, lo: ch.lo, hi: ch.hi, zero: ch.zero,
      bars: ch.bars, lines: ch.lines, dots: ch.dots, dot: ch.dot, threshold: ch.threshold, band: ch.band, prevTicks: ch.prevTicks, prevLines: ch.prevLines, labels: ch.labels, ticks: ch.ticks, low: ch.low, high: ch.high, lowI: ch.lowI, highI: ch.highI, key: chartKey(ch, values) } };
  });
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
    _doc: 'History tile (eink-ha-os#264, eink-ha-os#265): emulator src/core/history.ts; firmware core/history.cpp + core/config.cpp run these (eink-ha-os#268, test_core). Times are epoch ms; tz = local UTC offset in minutes. Compare floats with a 1e-6 tolerance. config: like config/*.json. defaultBucket: window/cs → bucket (null = needs an explicit bucket). spec: historySpec of a parsed widget. history: HA history rows (s, lu seconds) → fromHistoryRows → bucketize per agg. statistics: rows → fromStatistics per agg (statsType picks the field). yScale, lowHigh (times as shown, en and nl), dayLowHigh (values = one day in n buckets), axis (x 0..1 across the span).',
    now: HNOW,
    config: HISTORY_CONFIG_CASES.map(([name, description, input]) => ({ name, description, input, expect: summarize(input) })),
    defaultBucket: ([['10m', 1], ['1h', 1], ['1h', 4], ['6h', 4], ['24h', 1], ['24h', 2], ['24h', 4], ['2d', 1], ['3d', 1], ['7d', 1], ['7d', 4], ['90m', 1], ['97m', 1], ['25h', 1]] as [string, number][])
      .map(([window, cs]) => ({ window, cs, bucket: ((b) => (b === null ? null : b / MIN + 'm'))(defaultBucket(parseSpan(window) as number, cs)) })),
    spec: ([{ entity: 'sensor.outdoor_temperature', cs: 4 }, { entity: 'sensor.outdoor_temperature', window: '7d', cs: 2, agg: 'max' }, { entity: 'sensor.rain_total', window: '24h', bucket: '1h', agg: 'change', style: 'line', min: '0', max: '12.5' }, { entity: 'number.level', window: '10m', agg: 'last', min: '-5' }, { entity: 'sensor.price', window: '24h', style: 'step', threshold: '-0.5', labels: 'true' }, { entity: 'sensor.rain', style: 'dots', threshold: 3, labels: 'false' }, { entity: 'sensor.outdoor_temperature', style: 'band', compare: '7d', cs: 4 }] as Record<string, string | number>[])
      .map((widget) => ({ widget, out: historySpec(widget) })),
    style: aggs.flatMap((agg) => [undefined, 'auto', 'bars', 'line', 'area', 'step', 'dots', 'band'].map((style) => ({ agg, style: style ?? null, out: resolveStyle(agg, style) }))),
    stats: {
      period: [1, 5, 10, 15, 30, 60, 120, 360, 720, 1440].map((m) => ({ bucketMin: m, period: statsPeriod(m * MIN) })),
      type: aggs.map((agg) => ({ agg, type: statsType(agg) })),
    },
    history: histCases.map((c) => {
      const points = fromHistoryRows(c.rows);
      return { name: c.name, description: c.description, tz: c.tz, windowMs: c.windowMs, bucketMs: c.bucketMs, rows: c.rows, span: chartSpan(c, HNOW, c.tz),
        points, out: Object.fromEntries(aggs.map((agg) => [agg, bucketize(points, { ...c, agg }, HNOW, c.tz).values])) };
    }),
    // eink-ha-os#304 wave 2: a compare series = the same rows bucketed at now − compareMs (bucket i is the tile's bucket i that long ago)
    compare: [{ name: '6h-30m-1d', window: '6h', bucket: '30m', compare: '1d', tz: 60 }, { name: '24h-2h-7d', window: '24h', bucket: '2h', compare: '7d', tz: 330 }].map((c) => {
      const s = historySpec({ entity: 'sensor.x', window: c.window, bucket: c.bucket, compare: c.compare }), cs = compareSpec(s) as HistorySpec, at = seriesNow(cs, HNOW);
      const rows = histRows(at - s.windowMs - HOUR, at + 2 * HOUR, (i) => 10 + 4 * Math.sin(i / 5), (i) => (i === 9 ? 'unavailable' : null));
      const ser = bucketize(fromHistoryRows(rows), cs, at, c.tz);
      return { ...c, compareMs: s.compareMs, shiftMs: cs.shiftMs, rows, span: chartSpan(cs, at, c.tz), tileStart: chartSpan(s, HNOW, c.tz).start, out: ser.values };
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
    // the price chart's low / high (eink-ha-os#260): n equal buckets from local midnight, the drawn resolution
    dayLowHigh: [[0.22, 0.21, 0.2, 0.2, 0.21, 0.23, 0.27, 0.33, 0.35, 0.3, 0.26, 0.22, 0.19, 0.18, 0.19, 0.22, 0.27, 0.34, 0.38, 0.36, 0.31, 0.27, 0.25, 0.23],
      Array.from({ length: 96 }, (_, i) => Math.round((0.25 + 0.1 * Math.sin(i / 7)) * 10000) / 10000), [-0.02, 0.1, -0.02, 0.4, ...Array(20).fill(0.1)], []]
      .flatMap((values) => (['en', 'nl'] as const).map((lang) => ({ values, lang, out: dayLowHigh(values, lang) }))),
    chart: chartVectors(),
    axis: ([['10m', '1m', 60], ['1h', '5m', 60], ['2h', '10m', 60], ['3h', '15m', 60], ['6h', '30m', 60], ['24h', '1h', 60], ['24h', '30m', 330], ['48h', '2h', 60], ['3d', '6h', 60], ['7d', '6h', 60], ['7d', '1d', 0]] as [string, string, number][])
      .flatMap(([window, bucket, tz]) => (['en', 'nl'] as const).map((lang) => ({ window, bucket, tz, lang, out: axisTicks(spec(window, bucket), HNOW, tz, lang) }))),
  };
}

/** History tile series from an attribute or a weather forecast (eink-ha-os#283). Separate from history.json so the firmware's
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
  ['series-past', 'Past and future in one chart (eink-ha-os#307): past names a recorder entity for the part of the window before now; ahead is the rest. Kept as written.', H + scr('a', ['type: history, entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, past: sensor.rain_rate, window: 3h, ahead: 2h, bucket: 10m, agg: max, style: bars, cs: 4', 'type: history, entity: weather.home, past: sensor.outdoor_temperature, window: 48h, ahead: 24h, cs: 4'])],
  ['series-past-on-recorder', 'Rule: past needs an attribute or a weather entity (a recorder tile is all past already).', H + scr('a', ['type: history, entity: sensor.outdoor_temperature, past: sensor.rain_rate'])],
  ['series-past-wrong-domain', 'Rule: past is a sensor / input_number / number entity.', H + scr('a', ['type: history, entity: binary_sensor.rain_expected, attribute: forecast, past: binary_sensor.rain_expected, window: 3h, ahead: 2h'])],
  ['series-past-no-ahead', 'Rule: with past, ahead is shorter than the window and not 0 (the default ahead is the whole window).', H + scr('a', ['type: history, entity: binary_sensor.rain_expected, attribute: forecast, past: sensor.rain_rate, window: 3h'])],
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
    { name: 'weather-hourly', description: 'weather.get_forecasts hourly, temperature, 24 h in 1-hour bars on a 2-wide tile (local times with +01:00).', tz: 60,
      widget: w('entity: weather.home, window: 24h, cs: 2'), raw: hourly },
    { name: 'weather-hourly-change', description: 'Hourly precipitation summed per 6 h (agg change = sum of the samples).', tz: 60,
      widget: w('entity: weather.home, value: precipitation, window: 24h, bucket: 6h, agg: change'), raw: hourly },
    { name: 'weather-daily', description: 'weather.get_forecasts daily, 7 days of 1-day bars, max temperature; daily times at 11:00 UTC.', tz: 60,
      widget: w('entity: weather.home, forecast: daily, window: 7d, agg: max'), raw: daily },
    { name: 'not-a-list', description: 'An attribute that is not a list (or JSON text of one) has no samples.', tz: 60,
      widget: w('entity: sensor.rain_nowcast, attribute: forecast'), raw: { precipitation: 3 } },
  ];
  const aggs = HISTORY_AGGS as readonly HistoryAgg[];
  // eink-ha-os#307: past (recorder rows of `past`) + future (the attribute) in one chart, per style
  const gauge = histRows(HNOW - 75 * MIN, HNOW - 2 * MIN, (i) => Math.max(0, 1.6 * Math.sin(i / 2)), (i) => (i === 4 ? 'unavailable' : null));
  const bothCases: { name: string; description: string; tz: number; widget: Record<string, string | number>; rows: { s: string; lu: number }[]; raw: unknown }[] = [
    { name: 'rain-bars', description: 'Rain: 1 h of the gauge (max per 10 min) before the bucket holding now, then 2 h of the nowcast; an unavailable row leaves its bucket empty.', tz: 60,
      widget: w('entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, past: sensor.rain_rate, window: 3h, ahead: 2h, bucket: 10m, agg: max, style: bars, cs: 4'), rows: gauge, raw: rain },
    { name: 'rain-line', description: 'The same as a line (mean): the forecast line starts at the last past point.', tz: 60,
      widget: w('entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, past: sensor.rain_rate, window: 3h, ahead: 2h, bucket: 10m, style: line, cs: 4'), rows: gauge, raw: rain },
    { name: 'rain-step', description: 'Step: the forecast starts with the upright join at the Now edge.', tz: 60,
      widget: w('entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, past: sensor.rain_rate, window: 2h, ahead: 1h, bucket: 15m, agg: max, style: step, cs: 4'), rows: gauge, raw: rain },
    { name: 'rain-dots-no-past', description: 'Dots without past rows (the gauge has no history): the past buckets are gaps, forecast dots hollow.', tz: 60,
      widget: w('entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, past: sensor.rain_rate, window: 3h, ahead: 2h, bucket: 15m, agg: max, style: dots, cs: 4'), rows: [], raw: rain },
  ];
  return {
    _doc: 'History tile series from an attribute or weather.get_forecasts (eink-ha-os#283): emulator src/core/history.ts (historySource, historyError, historySpec, parseTime, attrSamples, fromSamples, chartSpan / axisTicks with aheadMs). Firmware: core/history.cpp, core/history_series.cpp (eink-ha-os#292), test_core test_history_series_vectors. Times are epoch ms; tz = local UTC offset in minutes. config: like config/*.json. spec: historySpec (aheadMs and source only for these sources). parseTime: input, tz → ms or null. series: raw attribute → samples → buckets per agg, plus the span and the axis.',
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
    // eink-ha-os#307: past + future. pastSpec: the recorder fetch (window, n); past: rows → fromHistoryRows → bucketize(pastSpec);
    // ahead: raw → samples → fromSamples(spec); joined: joinSeries; chart: historyChart(spec, joined) with split (x of
    // the Now marker), bars (ahead = drawn lighter), lines (past) / aheadLines (future, joined to the last past point), dots.
    both: bothCases.map((c) => {
      const sp = historySpec(c.widget), ps = pastSpec(sp), past = bucketize(fromHistoryRows(c.rows), ps, HNOW, c.tz);
      const ahead = fromSamples(attrSamples(c.raw, sp.source!, sp.bucketMs, HNOW, c.tz), sp, HNOW, c.tz), joined = joinSeries(sp, past, ahead, HNOW, c.tz);
      const ch = historyChart(sp, joined, 'ok', HNOW, c.tz, 'en', (v) => fmtNum(v, 'mm/h'));
      return { name: c.name, description: c.description, tz: c.tz, widget: c.widget, error: historyError(c.widget), past: sp.past, pastSpec: { entity: ps.entity, windowMs: ps.windowMs, n: ps.n },
        rows: c.rows, raw: c.raw, pastValues: past.values, aheadValues: ahead.values, joined: joined.values,
        chart: { split: ch.split, latest: ch.dot ? ch.dot : null, bars: ch.bars, lines: ch.lines, aheadLines: ch.aheadLines, dots: ch.dots, key: chartKey(ch, joined.values) } };
    }),
    joinState: (['ok', 'loading', 'none', 'tooMany', 'needsStats'] as HistState[]).flatMap((past) => (['ok', 'loading', 'none', 'tooMany'] as HistState[]).map((ahead) => ({ past, ahead, out: joinState(past, ahead) }))),
  };
}

/** Agenda and Next tiles (eink-ha-os#316): config rules, the get_events request, titles, answers (whole WebSocket frames, as
 *  the firmware streams them) and the tiles' lines at several times. Firmware: core/agenda.cpp, test_agenda. */
const ANOW = Date.UTC(2026, 9, 28, 6, 42);   // Wednesday 28 Oct 2026 07:42 CET (tz 60)
const AGENDA_CONFIG_CASES: [string, string, string][] = [
  ['agenda-basic', 'An agenda tile and a next tile, each with its calendars (space-separated, 1–4). Keys kept as written.', H + scr('a', ['type: agenda, entities: calendar.family calendar.work, cs: 2, rs: 2', 'type: next, entities: calendar.family, label: Up next, cs: 2'])],
  ['agenda-no-calendar', 'Rule: at least one calendar.', H + scr('a', ['type: agenda, cs: 2, rs: 2'])],
  ['agenda-wrong-domain', 'Rule: calendars are calendar.* entities.', H + scr('a', ['type: next, entities: calendar.family sensor.x, cs: 2'])],
  ['agenda-five-calendars', 'Rule: at most 4 calendars per tile.', H + scr('a', ['type: agenda, entities: calendar.a calendar.b calendar.c calendar.d calendar.e, cs: 2, rs: 2'])],
  ['agenda-five-tiles', 'Rule: at most 4 agenda or next tiles in the config; the 5th fails on its own line.', H + scr('a', ['type: agenda, entities: calendar.a, cs: 2, rs: 2', 'type: next, entities: calendar.a, cs: 2', 'type: next, entities: calendar.b, cs: 2']) + scr('b', ['type: next, entities: calendar.c, cs: 2', 'type: next, entities: calendar.d, cs: 2'])],
];
const ev = (start: string, end: string, summary: unknown, extra: Record<string, unknown> = {}) => ({ start, end, summary, ...extra });
const frame = (response: unknown, success = true) => JSON.stringify({ id: 9, type: 'result', success, result: { context: { id: '01JX', parent_id: null, user_id: null }, response } });
export function agendaVectors() {
  const fam = 'calendar.family', two = 'calendar.family calendar.work';
  const many = Array.from({ length: 20 }, (_, i) => ev(new Date(ANOW + ((i * 7) % 20 - 3) * 3_600_000).toISOString(), new Date(ANOW + ((i * 7) % 20 - 2) * 3_600_000).toISOString(), 'Event ' + i));
  // hand-written: escapes, a surrogate pair, nested values inside an event, entries that are not events
  const escaped = '{"id":9,"type":"result","success":true,"result":{"context":{"id":"x","parent_id":null,"user_id":null},"response":{' +
    '"calendar.other":{"events":[{"start":"2026-10-28T10:00:00+01:00","end":"2026-10-28T11:00:00+01:00","summary":"Not mine"}]},' +
    '"calendar.family":{"events":[' +
    String.raw`{"start":"2026-10-28T09:00:00+01:00","end":"2026-10-28T10:00:00+01:00","summary":"Café \"Zoë\" \\ \/ 😀","description":"start: 1999","location":null},` +
    '{"summary":"No start","end":"2026-10-28T10:00:00+01:00"},' +
    '{"start":1793170800,"end":"2026-10-28T10:00:00+01:00","summary":"Number start"},' +
    '{"start":"2026-10-28T11:00:00+01:00","end":"2026-10-28T10:00:00+01:00","summary":null,"attendees":[{"start":"2026-10-27","summary":"inner"}],"rrule":{"start":"x"}},' +
    '"not an event",42,null,[],' +
    String.raw`{"start":"2026-10-27","end":"2026-10-30","summary":"Holiday\nweek  ","uid":"abc"},` +
    '{"start":"2026-10-27T22:00:00Z","end":"2026-10-28T08:15:00+01:00","summary":"Night shift"},' +
    '{"start":"2026-10-28T12:00:00.000+01:00","summary":"  Lunch, no end  "},' +
    '{"start":"2026-10-28","summary":"Bin day"}' +
    ']}}}}';
  const parses: { name: string; key: string; now: number; tz: number; frame: string }[] = [
    { name: 'demo-two-calendars', key: two, now: ANOW, tz: 60, frame: demoAnswer(two, ANOW, 60, 9) },
    { name: 'demo-us-evening', key: two, now: Date.UTC(2026, 9, 29, 2, 10), tz: -300, frame: demoAnswer(two, Date.UTC(2026, 9, 29, 2, 10), -300, 9) },
    { name: 'overflow-keeps-twelve', key: fam, now: ANOW, tz: 60, frame: frame({ [fam]: { events: many } }) },
    { name: 'escapes-and-junk', key: fam, now: ANOW, tz: 60, frame: escaped },
    { name: 'past-and-beyond-window', key: fam, now: ANOW, tz: 60, frame: frame({ [fam]: { events: [ev('2026-10-28T06:00:00+01:00', '2026-10-28T07:00:00+01:00', 'Ended'), ev('2026-11-04T00:00:00+01:00', '2026-11-04T01:00:00+01:00', 'Next week'), ev('2026-11-03T23:30:00+01:00', '2026-11-04T00:30:00+01:00', 'Last slot')] } }) },
    { name: 'not-success', key: fam, now: ANOW, tz: 60, frame: '{"id":9,"type":"result","success":false,"error":{"code":"not_found","message":"Service calendar.get_events not found."}}' },
    { name: 'truncated', key: fam, now: ANOW, tz: 60, frame: frame({ [fam]: { events: [ev('2026-10-28T09:00:00+01:00', '2026-10-28T10:00:00+01:00', 'Cut')] } }).slice(0, 120) },
  ];
  const parsed = parses.map((c) => ({ ...c, out: parseAnswer(c.frame, c.key, c.now, c.tz) }));
  const viewOf = (f: AgendaFetch, now: number, tz: number) => (['en', 'nl'] as const).map((lang) => ({ lang,
    lines4: agendaLines(f, now, tz, lang, 4), lines11: agendaLines(f, now, tz, lang, 11), next: nextView(f, now, tz, lang) }));
  const demo = parsed[0].out!, esc = parsed[3].out!;
  const at = (min: number) => ANOW + min * 60_000;
  return {
    _doc: 'Agenda and Next tiles (eink-ha-os#316): emulator src/core/agenda.ts; firmware core/agenda.cpp, test_agenda. Times are epoch ms; tz = local UTC offset in minutes. config: like config/*.json. request: eventsRequest text (exact bytes). title: cutTitle (≤ 48 UTF-8 bytes). parse: a whole WebSocket result frame → parseAnswer (null = not a successful answer); the firmware streams the same text in any chunking. views: agendaLines (4 and 11 lines) and nextView of `fetch` at `now`, en and nl.',
    config: AGENDA_CONFIG_CASES.map(([name, description, input]) => ({ name, description, input, expect: summarize(input) })),
    key: [{ entities: 'calendar.work calendar.family calendar.work' }, { entities: 'calendar.b  calendar.a' }].map((w) => ({ widget: w, key: agendaKey({ type: 'agenda', ...w }) })),
    request: ([[two, ANOW, 60, 42], [fam, Date.UTC(2026, 9, 29, 2, 10), -300, 7], [fam, Date.UTC(2026, 9, 27, 23, 30), 330, 1]] as [string, number, number, number][])
      .map(([key, now, tz, id]) => ({ key, now, tz, id, out: eventsRequest(key, now, tz, id) })),
    title: ['Dentist', '  padded  ', 'Line\nbreak\ttab', 'x'.repeat(60), 'a'.repeat(47) + 'é and more', 'b'.repeat(46) + '😀', 'ë'.repeat(30), 'c'.repeat(47) + ' d', '', '   ']
      .map((input) => ({ input, out: cutTitle(input) })),
    parse: parsed,
    views: [
      ...[0, 47, 48, 60, 120, 400, 960, 1000].map((m) => ({ name: 'demo +' + m + ' min', fetch: demo, now: at(m), tz: 60 })),
      ...[0, 30, 180].map((m) => ({ name: 'escapes +' + m + ' min', fetch: esc, now: at(m), tz: 60 })),
      { name: 'empty', fetch: { events: [], more: 0 }, now: ANOW, tz: 60 },
      { name: 'overflow', fetch: parsed[2].out!, now: ANOW, tz: 60 },
    ].map((c) => ({ ...c, out: viewOf(c.fetch, c.now, c.tz) })),
  };
}

/** Route tile departures (eink-ha-os#145, eink-ha-os#275). attrs as the HA stream keeps them: list attributes as JSON text. tz = local UTC
 *  offset in minutes (emulator); posixTz = the same zone for the firmware's localtime(). */
export function routeVectors() {
  const CET = 'CET-1CEST,M3.5.0,M10.5.0/3';
  const up = (xs: Record<string, unknown>[]) => JSON.stringify(xs);
  const ns = (planned: string, actual: string, delay: number | undefined, track: string, direction: string, status: string, message: string | null = null) =>
    ({ planned, actual, ...(delay === undefined ? {} : { delay }), track, planned_track: track, track_changed: false, direction, train: 'IC 1234', status, message });
  type Ent = { state?: string; attrs: Record<string, string> };
  const cases: ({ name: string; tz: number; posixTz: string; entity2?: Ent } & Ent)[] = [
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
    // ha-paper#22: single-departure entities (the OVapi integration, made-up stop 12345678), entity then entity2
    { name: 'ovapi-departure-time-pair', tz: 60, posixTz: CET, state: '2026-10-30T07:58:00+00:00',
      attrs: { friendly_name: 'Bus stop 12345678 Current departure time', line_number: '12', destination: 'Central Station', delay_minutes: '3', scheduled_time: '2026-10-30T08:55:00+01:00' },
      entity2: { state: '2026-10-30T08:13:00+00:00', attrs: { line_number: '12', destination: 'Central Station', delay_minutes: '0', scheduled_time: '2026-10-30T09:13:00+01:00' } } },
    { name: 'ovapi-vehicle-pair', tz: 120, posixTz: CET, state: '5 → Harbour',
      attrs: { line_number: '5', destination: 'Harbour', expected_arrival: '2026-09-29T07:57:00', target_arrival: '2026-09-29T07:55:00', delay_minutes: '2', minutes_until_departure: '4' },
      entity2: { state: '5 → Harbour', attrs: { line_number: '5', destination: 'Harbour', expected_arrival: '2026-09-29T08:10:30', target_arrival: '2026-09-29T08:10:00', minutes_until_departure: '17' } } },
    { name: 'ovapi-early-and-no-delay', tz: 120, posixTz: CET, state: '2026-09-29T23:59:00+02:00',
      attrs: { line_number: '300', delay_minutes: '-1', scheduled_time: '2026-09-30T00:00:00+02:00' },
      entity2: { state: '2026-09-30T00:20:00+02:00', attrs: { destination: 'Airport', delay_minutes: '', scheduled_time: '2026-09-30T00:14:00+02:00' } } },
    { name: 'ovapi-scheduled-only-and-empty', tz: 120, posixTz: CET, state: '7 → Harbour',
      attrs: { line_number: '7', target_arrival: '2026-09-29T09:05:00' },
      entity2: { state: 'none', attrs: { line_number: '7' } } },
    { name: 'entity2-unavailable', tz: 120, posixTz: CET, state: '2026-09-29T09:20:00+02:00', attrs: { line_number: '1' },
      entity2: { state: 'unavailable', attrs: { line_number: '1', target_arrival: '2026-09-29T09:40:00' } } },
    { name: 'list-then-single', tz: 120, posixTz: CET, attrs: { departures: JSON.stringify([{ time: '09:00', delay: 0, cancelled: false, info: 'Bus 1' }]) },
      entity2: { state: '2026-09-29T09:20:00+02:00', attrs: { line_number: '1', delay_minutes: '1' } } },
  ];
  return {
    description: 'Route tile departures (spec/SCHEMA.md route, eink-ha-os#275). `departures` [{time HH:MM, delay, cancelled, info}] wins; else `upcoming` [{planned, actual, delay, track, direction, status}] with ISO timestamps (the NS departures integration): time = local HH:MM of actual, else planned; delay = `delay`, else max(0, round(actual − planned in minutes)); cancelled = status "cancelled" (the integration\'s statuses: on_time, delayed, cancelled); info = "Track ‹track› · ‹direction›" (strings routeTrack). Timestamps without an offset are local. Neither list (ha-paper#22): the entity is one departure (the OVapi integration): time = local HH:MM of a timestamp `state`, else `expected_arrival`, else `scheduled_time`, else `target_arrival`; delay = `delay_minutes` (a number, as text; below 0 = 0), else max(0, round(time − (`scheduled_time`, else `target_arrival`))); cancelled false; info = "‹line_number› · ‹destination›" (either may be absent). No time: no departure. `entity2` (optional): a second entity of the tile; its departures follow the first entity\'s (left out when unavailable / unknown). `state` absent = not a timestamp.',
    cases: cases.flatMap((c) => (['en', 'nl'] as const).map((lang) => ({ ...c, lang,
      out: routeDeparturesOf([{ state: c.state ?? '', attrs: c.attrs }, ...(c.entity2 ? [{ state: c.entity2.state ?? '', attrs: c.entity2.attrs }] : [])], c.tz, lang) }))),
  };
}

/** Bin day tile (eink-ha-os#317): binDays per source shape, then binsView (rows, head, big, line, foot, pill, rest) in both
 *  languages. attrs as the HA stream keeps them (scalars as text, lists as JSON text). */
export function binsVectors() {
  const at = (d: number, h: number, m: number, tz: number) => Date.UTC(2026, 9, d, h, m) - tz * 60_000;   // local Oct d, h:m
  const now = at(28, 19, 5, 60);   // Wednesday 28 October 2026, 19:05 CET
  const days: { name: string; state: string; attrs: Record<string, string>; now: number; tz: number }[] = [
    { name: 'date-tomorrow', state: '2026-10-29', attrs: {}, now, tz: 60 },
    { name: 'date-today', state: '2026-10-28', attrs: {}, now, tz: 60 },
    { name: 'date-past', state: '2026-10-27', attrs: {}, now, tz: 60 },
    { name: 'date-past-then-upcoming', state: '2026-10-27', attrs: { upcoming: '["2026-10-27","2026-11-10"]' }, now, tz: 60 },
    { name: 'date-dutch', state: '03-11-2026', attrs: {}, now, tz: 60 },
    { name: 'date-dutch-bad-month', state: '03-13-2026', attrs: {}, now, tz: 60 },
    { name: 'date-with-offset', state: '2026-10-29T00:00:00+01:00', attrs: {}, now, tz: 60 },
    { name: 'date-utc-next-local-day', state: '2026-10-28T23:30:00Z', attrs: {}, now, tz: 60 },
    { name: 'days-state', state: '3', attrs: {}, now, tz: 60 },
    { name: 'days-state-zero', state: '0', attrs: {}, now, tz: 60 },
    { name: 'days-attr', state: 'Paper in 3 days', attrs: { daysTo: '3' }, now, tz: 60 },
    { name: 'upcoming-dates', state: 'Paper', attrs: { upcoming: '["2026-10-20","2026-11-04"]' }, now, tz: 60 },
    { name: 'upcoming-objects', state: 'Paper', attrs: { upcoming: '[{"date":"2026-11-02","type":"Paper"}]' }, now, tz: 60 },
    { name: 'upcoming-not-json', state: 'Paper', attrs: { upcoming: 'soon' }, now, tz: 60 },
    { name: 'text-only', state: 'Paper', attrs: {}, now, tz: 60 },
    { name: 'unavailable', state: 'unavailable', attrs: { daysTo: '2' }, now, tz: 60 },
    { name: 'unknown', state: 'unknown', attrs: {}, now, tz: 60 },
    { name: 'summer-time-late', state: '2026-09-30', attrs: {}, now: at(29, 23, 30, 120) - 30 * 86_400_000, tz: 120 },
  ];
  const paper = { label: 'Paper', state: '2026-10-29', attrs: {} };
  const plastic = { label: 'Plastic', state: '6', attrs: {} };
  const green = { label: 'Green', state: 'Green in 7 days', attrs: { daysTo: '7' } };
  const rest = { label: 'Rest', state: '09-11-2026', attrs: {} };
  const views: { name: string; bins: { label: string; state: string; attrs: Record<string, string> }[]; now: number; tz: number; tonight: number }[] = [
    { name: 'evening-before', bins: [plastic, paper, green, rest], now, tz: 60, tonight: 17 },
    { name: 'before-tonight-hour', bins: [plastic, paper, green, rest], now: at(28, 16, 59, 60), tz: 60, tonight: 17 },
    { name: 'tonight-hour-20', bins: [plastic, paper, green], now, tz: 60, tonight: 20 },
    { name: 'collection-day', bins: [paper, green], now: at(29, 7, 0, 60), tz: 60, tonight: 17 },
    { name: 'tie-joins-labels', bins: [paper, { label: 'Glass', state: '1', attrs: {} }, green], now, tz: 60, tonight: 17 },
    { name: 'single-in-days', bins: [green], now, tz: 60, tonight: 17 },
    { name: 'unknown-left-out', bins: [{ label: 'Paper', state: 'unknown', attrs: {} }, rest], now, tz: 60, tonight: 17 },
    { name: 'none-known', bins: [{ label: 'Paper', state: 'unavailable', attrs: {} }], now, tz: 60, tonight: 17 },
    { name: 'tonight-zero', bins: [paper], now: at(28, 0, 0, 60), tz: 60, tonight: 0 },
  ];
  return {
    description: 'Bin day tile (spec/SCHEMA.md bins, eink-ha-os#317). days: binDays(state, attrs, now, tz) = days from the local today to the next collection, null = unknown. The first source giving a day ≥ today wins: a date state (ISO, or DD-MM-YYYY), a whole-number state (days to), attribute daysTo, attribute upcoming (JSON list of dates or {date}). unavailable / unknown → null. views: binsView(bins, now, tz, tonight, lang): rows soonest first (config order on a tie), head = labels of the soonest day joined with " + ", big = Today / Tomorrow / in N days, line = "‹when› · ‹Weekday d›" or "‹Weekday d› · put out tonight" from tonight:00 the day before, foot (1-cell) = the date or "Put out tonight", pill = Tonight / Today / "", rest = the later rows.',
    days: days.map((c) => ({ ...c, out: binDays(c.state, c.attrs, c.now, c.tz) })),
    views: views.flatMap((c) => (['en', 'nl'] as const).map((lang) => ({ ...c, lang, out: binsView(c.bins, c.now, c.tz, c.tonight, lang) }))),
  };
}

/** Good morning page (eink-ha-os#330): morningStep over a night, morningSources per config, morningView in both languages. Thu 29
 *  Oct 2026, CET (tz 60); made-up events. */
export function morningVectors() {
  const tz = 60, at = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h, m) - tz * 60_000;
  const tick = (now: number, hour: number, o: Partial<MorningTick> = {}): MorningTick => ({ now, hour, clockKnown: true, quiet: '23-07', enabled: true, ...o });
  const seq: { name: string; ticks: MorningTick[] }[] = [
    { name: 'night-then-morning-then-timeout', ticks: [tick(at(28, 22), 22), tick(at(28, 23), 23), tick(at(29, 6, 59), 6), tick(at(29, 7), 7), tick(at(29, 7, 19), 7), tick(at(29, 7, 20), 7), tick(at(29, 8), 8)] },
    { name: 'setting-off', ticks: [tick(at(28, 23), 23, { enabled: false }), tick(at(29, 7), 7, { enabled: false }), tick(at(29, 7, 1), 7, { enabled: false })] },
    { name: 'quiet-turned-off-at-night', ticks: [tick(at(29, 2), 2), tick(at(29, 2, 1), 2, { quiet: 'off' }), tick(at(29, 7), 7, { quiet: 'off' })] },
    { name: 'clock-unknown-waits', ticks: [tick(at(29, 1), 1), tick(at(29, 7), 7, { clockKnown: false }), tick(at(29, 7, 2), 7)] },
    { name: 'no-night-seen', ticks: [tick(at(29, 9), 9), tick(at(29, 9, 30), 9)] },
    { name: 'window-00-06', ticks: [tick(at(29, 0), 0, { quiet: '00-06' }), tick(at(29, 6), 6, { quiet: '00-06' })] },
  ];
  const steps = seq.map((c) => {
    let s: MorningState = MORNING_IDLE;
    return { name: c.name, ticks: c.ticks.map((t) => { const o = morningStep(s, t); s = { armed: o.armed, until: o.until }; return { tick: t, out: o }; }) };
  });
  const w = (type: string, extra: Record<string, string> = {}) => ({ type, ...extra });
  const sources = [
    { name: 'all-three', screens: [{ widgets: [w('clock'), w('bins', { entities: 'sensor.paper sensor.plastic' })] }, { widgets: [w('weather', { entity: 'weather.home' }), w('agenda', { entities: 'calendar.family' })] }] },
    { name: 'next-tile-counts', screens: [{ widgets: [w('next', { entities: 'calendar.work' }), w('agenda', { entities: 'calendar.family' })] }] },
    { name: 'empty-ones-skipped', screens: [{ widgets: [w('weather'), w('agenda'), w('bins'), w('weather', { entity: 'weather.b' }), w('bins', { entities: 'sensor.x' })] }] },
    { name: 'none', screens: [{ widgets: [w('clock'), w('stat', { entity: 'sensor.t' })] }] },
  ].map((c) => ({ ...c, out: morningSources(c.screens) }));
  const H = 3_600_000, now = at(29, 7, 5);
  const daily = [{ t: Date.UTC(2026, 9, 29, 11), icon: 'partly', temp: 13.4, low: 5.6, mm: 1.2 }, { t: Date.UTC(2026, 9, 30, 11), icon: 'rain', temp: 10, low: 6, mm: 8 }];
  const hourly = Array.from({ length: 16 }, (_, k) => ({ t: Date.UTC(2026, 9, 29, 6) + k * H, icon: k === 1 || k === 2 ? 'rain' : 'cloud', temp: 8 + k / 2, low: null, mm: k === 1 ? 0.6 : k === 2 ? 0.2 : 0 }));
  const ev = (start: number, end: number, title: string, allDay = false) => ({ start, end, allDay, cal: 0, title });
  const events = { events: [
    ev(at(28, 22), at(29, 7, 30), 'Night shift'), ev(at(29, 0), at(30, 0), 'Bin day', true), ev(at(29, 8, 30), at(29, 9, 15), 'Dentist'),
    ev(at(29, 12), at(29, 13), 'Lunch with Sam'), ev(at(29, 15), at(29, 16), ''), ev(at(29, 19, 30), at(29, 21), 'Book club'),
    ev(at(30, 9), at(30, 10), 'Plumber') ], more: 0 };
  const bins = [{ label: 'Paper', days: 0 }, { label: 'Plastic', days: 1 }, { label: 'Glass', days: 0 }, { label: 'Green', days: 6 }, { label: 'Rest', days: null }];
  const views = [
    { name: 'full', now, daily, hourly, events, bins },
    { name: 'weather-only', now, daily, hourly, events: null, bins: null },
    { name: 'rain-now', now: at(29, 8, 10), daily, hourly, events: null, bins: null },
    { name: 'no-low-dry', now, daily: [{ ...daily[0], low: null }], hourly: hourly.map((e) => ({ ...e, mm: 0, icon: 'cloud' })), events: null, bins: null },
    { name: 'rain-only-tomorrow', now: at(29, 18), daily: daily.slice(1), hourly: hourly.map((e, k) => ({ ...e, t: at(29, 18) + k * H, mm: k === 8 ? 1 : 0 })), events: null, bins: null },
    { name: 'no-forecast-yet', now, daily: null, hourly: null, events: { events: [], more: 0 }, bins: [{ label: 'Green', days: 6 }] },
    { name: 'events-short', now, daily: null, hourly: null, events: { events: events.events.slice(2, 4), more: 3 }, bins: [{ label: 'Paper', days: 1 }] },
  ];
  return {
    description: 'Good morning page (eink-ha-os#330, emulator src/core/morning.ts). steps: morningStep(state, tick) from {armed:false,until:0}, each tick feeding the previous out; clock unknown = no change; inside the quiet window = armed, until 0 (end when it was up); outside and armed = disarmed and, setting on and quiet not off, until = now + morningMs (start); until reached = 0 (end). sources: morningSources(screens) = [screen, widget] of the first weather tile with an entity, agenda/next tile with calendars, bins tile with sensors. views: morningView(in) per language (wx entries as kept: t epoch ms, temp/low/mm or null, icon name; events as kept, sorted).',
    morningMs: MORNING_MS, maxEvents: MORNING_EVENTS, steps, sources,
    views: views.flatMap((c) => (['en', 'nl'] as const).map((lang) => ({ ...c, tz, lang, out: morningView({ ...c, tz, lang } as Parameters<typeof morningView>[0]) }))),
  };
}

/** List from attributes tile (eink-ha-os#332): ago words, rows per tile size, the rows from an attribute value, the ingest cap.
 *  Values as the HA stream keeps them (JSON text). Made-up birds and places. */
export function attrListVectors() {
  const tz = 60, now = Date.UTC(2026, 9, 28, 14, 30) - tz * 60_000;   // Wed 28 Oct 2026 14:30 CET
  const agoIn: unknown[] = ['2026-10-28T14:30:00+01:00', '2026-10-28T14:29:30+01:00', '2026-10-28T14:33:00+01:00', '2026-10-28T14:40:00+01:00',
    '2026-10-28T14:00:00+01:00', '2026-10-28T13:31:00', '2026-10-28T12:30:00Z', '2026-10-28T00:10:00+01:00', '2026-10-27T23:59:00+01:00',
    '2026-10-27T09:00:00+01:00', '2026-10-25T18:00:00+01:00', '2026-10-28', '2026-10-27', '2026-10-21', '2026-10-29', 'yesterday', '', 1793194200, 1793187000, 1793187000000, 1793187000.5];
  const bird = (species: unknown, place: unknown, km: unknown, at: unknown) => ({ species, scientific: 'Aves', count: 1, place, distance_km: km, observed_at: at, rarity: 3, certain: true, url: 'https://waarneming.nl/observation/0/' });
  const list = [bird('Klapekster', 'Heideveld Oost', 3.24, '2026-10-28T13:05:00+01:00'), bird('Grote zilverreiger', 'Polder De Weide', 5.8, '2026-10-28T11:50:00+01:00'),
    bird('', 'Plas Noordhoek', 7, '2026-10-28T10:00:00+01:00'), bird('Roodkeelduiker', '', 12, '2026-10-27T16:00:00+01:00'),
    bird('Velduil', 'Heideveld Oost', null, '2026-10-26'), bird('Kleine zwaan', 'Uiterwaard West', 8.75, 'soon')];
  // eink-ha-os#375: ha-waarneming 0.2.0 adds display-ready title / subtitle / ts (epoch seconds) and keeps the recipe's fields
  const ready = (title: unknown, subtitle: unknown, ts: unknown, b: Record<string, unknown>) => ({ ...b, title, subtitle, ts });
  const t0 = Math.floor(now / 1000);
  const newList = [ready('3× Kraanvogel ?', 'Heidebos · 3,2 km', t0 - 2 * 3600, bird('Kraanvogel ?', 'Heidebos', 3.2, '2026-10-28T12:30:00')),
    ready('Klapekster', 'Heideveld Oost · 5,8 km', t0 - 600, bird('Klapekster', 'Heideveld Oost', 5.8, '2026-10-28T14:20:00')),
    ready('Velduil', 'Beekdal · 9,1 km', t0 * 1000 - 26 * 3600_000, bird('Velduil', 'Beekdal', 9.1, '2026-10-27T12:30:00')),
    ready('  Roodkeelduiker  ', 'Plas Noordhoek · 7,4 km', '2026-10-28T13:00:00', bird('Roodkeelduiker', 'Plas Noordhoek', 7.4, '2020-01-01')),
    ready('', 'Leeg · 1 km', t0, bird('Leeg', 'Leeg', 1, '2026-10-28'))];
  const mixed = [ready('2× Grote zilverreiger', 'Polder · 4,0 km', t0 - 90 * 60, {}), bird('Klapekster', 'Heideveld Oost', 3.24, '2026-10-28T13:05:00+01:00'),
    { title: 'Kleine zwaan', place: 'Uiterwaard', distance_km: 8.7, observed_at: '2026-10-28T11:00:00+01:00' },
    { title: null, species: 'Taigaboomkruiper', subtitle: 'Landgoed · 6 km', ts: null, observed_at: '2026-10-26' },
    { species: 'Ijsvogel', subtitle: null, place: 'Beek', ts: t0 - 30 }];
  const views: { name: string; value: string; w: Record<string, string>; max: number }[] = [
    { name: 'ready-fields', value: JSON.stringify(newList), w: {}, max: 6 },
    { name: 'ready-mixed', value: JSON.stringify(mixed), w: {}, max: 6 },
    { name: 'ready-set-fields', value: JSON.stringify(mixed), w: { title: 'species', subtitle: 'subtitle', time: 'observed_at' }, max: 6 },
    { name: 'birds-2', value: JSON.stringify(list), w: {}, max: 2 },
    { name: 'birds-all', value: JSON.stringify(list), w: {}, max: 10 },
    { name: 'custom-fields', value: JSON.stringify([{ destination: 'Centraal', platform: 3, departs: '2026-10-28T14:20:00+01:00' }, { destination: 'Noord', platform: '4b', departs: 1793193600 }, { destination: 7, platform: 1 }]),
      w: { attribute: 'trains', title: 'destination', subtitle: 'platform', time: 'departs' }, max: 6 },
    { name: 'metres-and-text', value: JSON.stringify([{ species: '  Ijsvogel ', place: 'Beek', distance_m: 420.5, observed_at: '2026-10-28T14:29:50+01:00' }, 'text item', null, [1, 2]]), w: { subtitle: 'place distance_m' }, max: 6 },
    { name: 'not-a-list', value: '{"species":"Klapekster"}', w: {}, max: 6 },
    { name: 'not-json', value: 'unavailable', w: {}, max: 6 },
    { name: 'empty-list', value: '[]', w: {}, max: 6 },
  ];
  const big = Array.from({ length: 14 }, (_, k) => bird('Soort ' + k, 'Plek ' + k, k, '2026-10-28T12:00:00+01:00'));
  const fat = Array.from({ length: 6 }, (_, k) => ({ ...bird('Soort ' + k, 'Plek ' + k, k, '2026-10-28T12:00:00+01:00'), notes: 'x'.repeat(900) }));
  return {
    description: 'List from attributes tile (spec/SCHEMA.md attrList, eink-ha-os#332). ago: listAgo(v, now, tz, lang) = "just now" under a minute (or up to 5 min ahead), "N min ago", "N h ago" under 24 h, then by local day "yesterday" / "N days ago"; a date without a time: today / yesterday / N days ago; unreadable or later: "". rows: listRows(cs, rs). views: listView(value, listSpec(w), now, tz, lang, max): defaults title / subtitle / time = title / subtitle / ts (eink-ha-os#375); a default field the item lacks (absent or null; subtitle: none of its names) reads species / place distance_km / observed_at; items without a title left out, numbers to 1 decimal ("…_km" + " km", "…_m" + " m"), subtitle parts joined with " · ", more = titled items past max. cap: capList(list) keeps the first items while ≤ ' + LIST_MAX_ITEMS + ' items and the JSON ≤ ' + LIST_MAX_BYTES + ' bytes; kept = item count.',
    now, tz,
    ago: agoIn.flatMap((v) => (['en', 'nl'] as const).map((lang) => ({ v, lang, out: listAgo(v, now, tz, lang) }))),
    rows: [1, 2, 3, 4].flatMap((cs) => [1, 2].map((rs) => ({ cs, rs, ...listRows(cs, rs) }))),
    views: views.flatMap((c) => (['en', 'nl'] as const).map((lang) => ({ ...c, lang, out: listView(c.value, listSpec(c.w), now, tz, lang, c.max) }))),
    cap: [{ name: 'fourteen', value: big }, { name: 'fat-items', value: fat }, { name: 'not-a-list', value: { a: 1 } }].map((c) => ({ name: c.name, value: JSON.stringify(c.value),
      kept: Array.isArray(c.value) ? (capList(c.value) as unknown[]).length : -1 })),
  };
}

/** Guest Wi-Fi tile (eink-ha-os#329): WIFI: payload escaping, the screens.yaml field codec, the tile states, the QR modules
 *  (qrcodegen: byte mode, ECC M, version 1–6, automatic mask, no ECC boost) and the tile geometry. Made-up networks. */
export function guestWifiVectors() {
  const payloads: [string, string, string, boolean][] = [
    ['Harbor Guest', 'tea, please', 'WPA', false], ['Lobby', '', 'nopass', true], ['Attic', 'abcde', 'WEP', true],
    ['a\\b;c,d:e"f', 'p;a:ss\\', 'WPA', false], ['Café Gäste', 'wäsche-42', 'WPA', false],
  ];
  const fields = ['plain', 'with, comma', ' lead', 'trail ', '100%', '{brace}', '00123456', '12345678', 'Café', 'a:b#c"d', 'tab\tin', ''];
  const views: [string, Record<string, string | number>, string | null][] = [
    ['empty', {}, null], ['no-password', { ssid: 'Harbor Guest' }, null], ['open', { ssid: 'Lobby', security: 'nopass', hidden: 'true' }, null],
    ['wpa', { ssid: 'Harbor Guest', password: 'tea%2C please' }, null], ['wep-hidden', { ssid: 'Attic', password: '%3012345678', security: 'WEP', hidden: 'true' }, null],
    ['bad-security-is-wpa', { ssid: 'Harbor Guest', password: 'x', security: 'WPA3' }, null],
    ['entity-overrides', { ssid: 'Harbor Guest', password: 'old', password_entity: 'input_text.guest_password' }, 'otter-42'],
    ['entity-unavailable', { ssid: 'Harbor Guest', password: 'old', password_entity: 'input_text.guest_password' }, 'unavailable'],
    ['entity-unknown', { ssid: 'Harbor Guest', password_entity: 'input_text.guest_password' }, 'unknown'],
    ['entity-missing', { ssid: 'Harbor Guest', password_entity: 'input_text.guest_password' }, null],
    ['open-ignores-entity', { ssid: 'Lobby', security: 'nopass', password_entity: 'input_text.guest_password' }, null],
    ['fits-version-6', { ssid: 'Harbor Guest', password: 'x'.repeat(76) }, null], ['too-long', { ssid: 'Harbor Guest', password: 'x'.repeat(90) }, null],
  ];
  const texts = ['WIFI:T:nopass;S:A;;', 'WIFI:T:WPA;S:Harbor Guest;P:tea\\, please;;', 'WIFI:T:WEP;S:Attic;P:0123456789;H:true;;',
    'WIFI:T:WPA;S:Café Gäste;P:wäsche-42;;', 'WIFI:T:WPA;S:Harbor Guest;P:' + 'k'.repeat(50) + ';;', 'x'.repeat(106), 'x'.repeat(107), '12345', 'HELLO WORLD'];
  const tiles: [number, number, number, number][] = [[380, 394, 2, 2], [380, 191, 2, 1], [184, 191, 1, 1], [184, 394, 1, 2], [772, 394, 4, 2], [772, 191, 4, 1], [384, 398, 2, 2], [384, 194, 2, 1]];
  return {
    description: 'Guest Wi-Fi tile (spec/SCHEMA.md guestWifi, eink-ha-os#329). payload: guestPayload(ssid, password, security, hidden) = WIFI:T:<sec>;S:<ssid>;P:<pw>;H:true;; with \\ ; , : " backslash-escaped, no P for nopass, H only when hidden. fields: fieldEncode(value) and fieldDecode back. views: guestView(widget, pwState) (pwState null = the entity has no state). qr: guestQr(text) rows, "1" = dark, null = too long for version 6. layout: guestLayout(w, h, cs, rs, n) for n = 21..41 modules and 0 (no code).',
    payload: payloads.map(([ssid, password, security, hidden]) => ({ ssid, password, security, hidden, out: guestPayload(ssid, password, security, hidden) })),
    fields: fields.map((value) => ({ value, encoded: fieldEncode(value) })),
    decode: ['%zz%4', '%41%2c', '%C3%A9', 'a%', 'a%00b'].map((v) => ({ value: v, out: fieldDecode(v) })),
    views: views.map(([name, w, pw]) => ({ name, w, pwState: pw, out: guestView(w, pw ?? undefined) })),
    qr: texts.map((text) => { const m = guestQr(text); return { text, size: m ? m.length : 0, rows: m ? m.map((r) => r.join('')) : null }; }),
    layout: tiles.flatMap(([w, h, cs, rs]) => [0, 21, 25, 29, 33, 37, 41].map((n) => ({ w, h, cs, rs, n, out: guestLayout(w, h, cs, rs, n) }))),
  };
}

export function quietTomorrowVectors() {
  const at = (d: number, h: number, m: number, tz = 60) => Date.UTC(2026, 9, d, h, m) - tz * 60_000;   // local Oct d, h:m (CET)
  const HOUR = 3_600_000;
  const wx = (t: number, icon: WxEntry['icon'], temp: number | null, low: number | null, mm: number | null): WxEntry => ({ t, icon, temp, low, mm });
  // daily at local midnight (as met.no at 23:00 UTC), Wed 28 … Sat 31
  const daily = [wx(at(28, 0, 0), 'cloud', 13, 7, 0), wx(at(29, 0, 0), 'rain', 11.6, 4.4, 3.2), wx(at(30, 0, 0), 'sun', 14, 5, 0), wx(at(31, 0, 0), 'partly', 12, null, 0)];
  // hourly from 23:00 Wed, 16 h; wet at 08:00 and 09:00 Thu
  const hourly = Array.from({ length: 16 }, (_, k) => wx(at(28, 23, 0) + k * HOUR, k === 9 || k === 10 ? 'rain' : 'cloud', 8 - k * 0.2, null, k === 9 ? 0.4 : k === 10 ? 1.2 : 0));
  const ev = (start: number, end: number, allDay: boolean, title: string, cal = 0): CalEvent => ({ start, end, allDay, cal, title });
  const events = [ev(at(28, 19, 0), at(28, 23, 30), false, 'Dinner'), ev(at(29, 0, 0), at(30, 0, 0), true, 'Birthday Sam', 1), ev(at(29, 8, 30), at(29, 9, 15), false, 'Dentist'),
    ev(at(29, 14, 0), at(29, 15, 0), false, 'Call')];
  const bins = [{ label: 'Plastic', days: 1 }, { label: 'Green', days: 3 }, { label: 'Paper', days: 1 }, { label: 'Rest', days: null }];
  const base: Omit<QuietIn, 'lang'> = { now: at(28, 23, 5), tz: 60, endHour: 7, daily, hourly, events, bins, tonight: 17 };
  const cases: { name: string; description: string; in: Omit<QuietIn, 'lang'> }[] = [
    { name: 'all', description: '23:05 Wed, window to 07:00: Thursday. Weather 12° / 4° with rain from 08:00, the first timed event (not the all-day one), two bins put out tonight; Green (3 days) and Rest (unknown) left out.', in: base },
    { name: 'none', description: 'No weather, agenda or bins tile: no row.', in: { ...base, daily: null, hourly: null, events: null, bins: null } },
    { name: 'after-midnight', description: '03:00 Thu (booted in the window): the day is today. Rain in the hour holding now is not over: from 03:00; bins collected today.',
      in: { ...base, now: at(29, 3, 0), hourly: Array.from({ length: 16 }, (_, k) => wx(at(29, 2, 0) + k * HOUR, 'cloud', 6, null, k === 1 ? 0.2 : 0)), bins: [{ label: 'Paper', days: 0 }] } },
    { name: 'before-tonight-hour', description: 'Window 22-06 at 22:00 with tonight at 23: "collected tomorrow"; a dry hourly forecast: no rain text.',
      in: { ...base, now: at(28, 22, 0), endHour: 6, tonight: 23, hourly: hourly.map((e) => ({ ...e, mm: 0, icon: 'cloud' as const })) } },
    { name: 'all-day-only', description: 'Only an all-day event and an untitled timed event on another day: "all day", the title.', in: { ...base, events: [events[0], events[1], ev(at(30, 9, 0), at(30, 10, 0), false, '')] } },
    { name: 'untitled', description: 'An untitled timed event: Busy.', in: { ...base, events: [ev(at(29, 7, 45), at(29, 8, 0), false, '')] } },
    { name: 'no-low-no-hourly', description: 'Saturday from 23:05 Fri: a daily entry without a low shows the high only; no hourly list: no rain text; no event on Saturday; the bins (days 1 from Friday) are put out tonight.',
      in: { ...base, now: at(30, 23, 5), daily: [daily[3]], hourly: null } },
    { name: 'no-entry-for-the-day', description: 'The daily list stops before Thursday and its high is absent on Thursday: weather left out.',
      in: { ...base, daily: [daily[0], wx(at(29, 0, 0), 'rain', null, 3, 1)] } },
    { name: 'mm-absent-wet-by-drawing', description: 'Hourly entries without precipitation: wet by drawing (snow at 06:00).',
      in: { ...base, hourly: hourly.map((e, k) => ({ ...e, mm: null, icon: k === 7 ? 'snow' as const : 'cloud' as const })) } },
    { name: 'today-glance', description: 'Glance sleep face (eink-ha-os#356): endHour TODAY_END (24) at 13:00 Thu = today. The rain at 08:00 / 09:00 is over (no text); Dentist (08:30–09:15) is over: Call at 14:00; Paper collected today.',
      in: { ...base, now: at(29, 13, 0), endHour: TODAY_END, bins: [{ label: 'Paper', days: 0 }, { label: 'Green', days: 1 }] } },
    { name: 'today-all-over', description: 'At 23:30 Thu with endHour 24 (quiet hours off): the timed events are over, the all-day one is not: "all day", Birthday Sam.',
      in: { ...base, now: at(29, 23, 30), endHour: TODAY_END, hourly: null, bins: null } },
    { name: 'utc-minus-5', description: 'tz -300 at 23:05 local on the 28th: Thursday local; the daily entries at 05:00 UTC.',
      in: { ...base, tz: -300, now: at(28, 23, 5, -300), daily: daily.map((e) => ({ ...e, t: e.t + 6 * HOUR })), hourly: null, events: [ev(at(29, 8, 30, -300), at(29, 9, 0, -300), false, 'School run')] } },
  ];
  const W = (type: string, f: Record<string, unknown> = {}) => ({ type, ...f });
  const sources = [
    { name: 'spread over pages', description: 'The first tile of each kind in screen then widget order.', screens: [{ widgets: [W('clock'), W('price'), W('stat', { entity: 'sensor.x' })] },
      { widgets: [W('next', { entities: 'calendar.work' }), W('weather', { entity: 'weather.home', cs: 4 })] }, { widgets: [W('bins', { entities: 'sensor.paper sensor.plastic' }), W('agenda', { entities: 'calendar.family' }), W('weather', { entity: 'weather.other', cs: 4 })] }] },
    { name: 'empty picks skipped', description: 'A weather tile without an entity, an agenda without calendars, a bins tile without sensors do not count.',
      screens: [{ widgets: [W('weather', { entity: '' }), W('agenda'), W('bins', { entities: ' ' }), W('bins', { entities: 'sensor.paper' })] }] },
    { name: 'none', description: 'No such tiles.', screens: [{ widgets: [W('clock'), W('stat', { entity: 'sensor.x' })] }, { widgets: [] }] },
  ];
  return {
    _doc: 'Quiet face "Tomorrow" row (eink-ha-os#328): emulator src/core/quiet.ts (quietSources, quietTomorrow), firmware core/tomorrow.h (test_core test_quiet_tomorrow_vectors). sources: the config\'s screens → [screen, widget] of the first weather / agenda-or-next / bins tile with a pick, null = none. items: the row from what the device keeps (no fetch): times epoch ms, tz = local UTC offset in minutes, endHour = the window\'s end hour (24 = always today, the glance sleep face eink-ha-os#356), events not over (end > now), daily / hourly = kept forecast entries (weather.json entries), events = kept agenda events (agenda.ts CalEvent), bins = {label, days to the next collection or null}, tonight = the bins tile\'s hour; null = no source. out.head = Tomorrow / Today / \'\', out.items = [{kind, icon, bold, text}] in the order weather, event, bins.',
    sources: sources.map((c) => ({ ...c, out: quietSources(c.screens) })),
    items: cases.flatMap((c) => (['en', 'nl'] as const).map((lang) => ({ ...c, lang, out: quietTomorrow({ ...c.in, lang }) }))),
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

/** Battery history (eink-ha-os#231): ops = power-loop passes in order from an empty ring; each case lists the log lines and the
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
    description: 'Battery history (eink-ha-os#231, emulator src/core/battery.ts, firmware core/battery_history.cpp). ops = power-loop passes {ms uptime, epoch (0 = clock unknown), pct (< 0 = not read), mv|null, chg, usb, power reason, rssi|null} from an empty ring. A row every ' + BATT_SAMPLE_S + ' s (the first at once), newest ' + BATT_HISTORY_N + ' kept; t = epoch, or uptime seconds while the clock is unknown. log = the [BATT] lines written: every sample and every chg / usb change. battery = GET /diagnostics battery.',
    cases: cases.map((c) => {
      let st = BATT_ZERO; const log: string[] = [];
      for (const o of c.ops) { const r = battStep(st, o); st = r.s; if (r.log) log.push(r.log); }
      return { name: c.name, ops: c.ops, log, battery: battHistory(st) };
    }),
  };
}

/** Gauge filter (eink-ha-os#327): reads in order from GAUGE_ZERO (power-on); each read gives the state after it. */
export function gaugeFilterVectors() {
  const c = (name: string, reads: [number, boolean][]) => {
    let s = GAUGE_ZERO;
    return { name, reads: reads.map(([raw, charging]) => { s = gaugeStep(s, raw, charging); return { raw, charging, shown: s.shown, rise: s.rise }; }) };
  };
  return {
    description: 'Gauge filter (eink-ha-os#327, emulator src/core/battery.ts gaugeStep, firmware core/gauge_filter.cpp). From power-on (shown -1), each read {raw % (< 0 = not read), charging = STAT or USB host} gives shown (the % reported everywhere) and rise (reads in a row ≥ ' + GAUGE_RISE_PTS + ' points above shown). Without a charger the shown % never rises, unless ' + GAUGE_RISE_READS + ' reads in a row are ≥ ' + GAUGE_RISE_PTS + ' points above it; falls pass at once; charging follows the gauge.',
    cases: [
      c('first read is shown as is', [[92, false]]),
      c('rest rebound after a night asleep is held (beta.4: 92 → 94)', [[92, false], [94, false], [94, false], [93, false], [92, false], [91, false]]),
      c('falls pass at once, small rises never', [[80, false], [78, false], [79, false], [79, false], [79, false], [77, false]]),
      c('charging follows the gauge both ways; unplugged it holds again', [[50, false], [52, true], [51, true], [60, true], [62, false], [61, false]]),
      c('a charge the board did not see: 3 reads in a row ≥ 5 points up', [[40, false], [80, false], [80, false], [81, false], [82, false]]),
      c('a read below the confirm level restarts the count', [[40, false], [80, false], [80, false], [44, false], [80, false], [80, false], [80, false]]),
      c('not read keeps the state, also before the first read', [[-1, false], [70, false], [-1, false], [90, false], [-1, false], [90, false], [90, false]]),
    ],
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
    { name: 'hw: the raw reset cause rides along (eink-ha-os#241); a TWDT panic is CORE_SW, a hardware watchdog stage CORE_MWDT0; cut to 15', ops: [boot('POWERON', '0.3.0', null, 'POWERON'), boot('TASK_WDT', '0.3.0', 'task_wdt: loopTask (CPU 1)', 'CORE_SW'), boot('TASK_WDT', '0.3.0', null, 'CORE_MWDT0'), boot('USB', '0.3.0', null, 'USB_UART'), boot('WDT', '0.3.0', null, 'A_VERY_LONG_HW_CAUSE')] },
    { name: 'a crash during a glance wake names that wake', ops: [boot('POWERON'), boot('DEEPSLEEP'), touch(12, 5, 1760000000), boot('PANIC', '0.3.0', 'boom'), boot('DEEPSLEEP')] },
  ];
  return {
    description: 'Boot / crash ring (GET /api/v1/diagnostics boots + last_crash). ops run in order on an empty ring: boot = a new boot (esp_reset_reason name, firmware version, panic message or null, optional hw = raw chip reset cause, null when absent), touch = the running boot is alive (uptime_s, min_free_heap, epoch; epoch 0 = clock unknown → last_seen unchanged), clear = DELETE /diagnostics. Newest first, 8 kept; a DEEPSLEEP boot right after a DEEPSLEEP boot replaces it (glance wakes, eink-ha-os#10). Strings are cut to 11 / 23 / 95 / 15 bytes (RTC struct).',
    cases: cases.map((c) => { const ring = c.ops.reduce<DiagRing>(diagApply, []); return { ...c, boots: bootsJson(ring), last_crash: lastCrash(ring) }; }),
  };
}

/** Device log ring (eink-ha-os#200): push ops on a small ring, then queries; the RTC tail; redaction. */
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
    _doc: 'Device log ring (GET /api/v1/logs, eink-ha-os#200): emulator src/core/logs.ts = firmware core/log_ring.{h,cpp}. ops push lines in order into a ring of `cap` bytes (16 + tag + message bytes per line, oldest dropped; tag cut to 15 and message to 239 UTF-8 bytes after redaction; seq from 1; epoch 0 → null). queries: since / level (E|W|I and worse) / tags (case-insensitive) / limit → the response. tail: a ring of tail_cap bytes fed the same lines = the newest lines that fit (on the device the RTC copy is ' + LOG_TAIL_CAP + ' bytes, boot=previous). redact: in → out.',
    cases: cases.map((c) => { const r = run(c.cap, c.ops); const tail = logTail(run(LOG_CAP, c.ops), 300); return { ...c, queries: undefined, results: (c.queries ?? qs).map((q) => ({ query: q, response: logsQuery(r, q) })), tail_cap: 300, tail: logsQuery(tail, {}, 'previous') }; }),
    redact: redactCases.map((i) => ({ in: i, out: redact(i) })),
  };
}

/** lightList / zoneList picks (eink-ha-os#127): what the tile shows and how many pages it needs. */
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

/** What tapping a scene tile asks HA (eink-ha-os#146, core config.ts sceneAction; the firmware sends `data` as service_data). */
export function sceneActionVectors() {
  const cases: [string, Widget][] = [
    ['scene entity → scene.turn_on', { type: 'scene', entity: 'scene.movie_night', cs: 2 }],
    ['script entity → script.turn_on; the label changes nothing', { type: 'scene', entity: 'script.good_night', label: 'Bedtime' }],
    ['no entity → all lights off', { type: 'scene' }],
    ['older scene: all_off → all lights off', { type: 'scene', scene: 'all_off' }],
    ['an entity wins over scene: all_off', { type: 'scene', scene: 'all_off', entity: 'scene.movie_night' }],
  ];
  return { description: 'Scene tile tap (eink-ha-os#146, spec/SCHEMA.md scene): the widget and the HA service call it makes.', cases: cases.map(([name, w]) => ({ name, widget: w, ...sceneAction(w) })) };
}

/** Now playing tile (eink-ha-os#319, core media.ts): favorites parsing, the HA call per tap target, what the tile shows from the
 *  player (attributes as the firmware keeps them: text), and what fits a cs × rs tile. */
export function mediaVectors() {
  const w = { type: 'media', entity: 'media_player.living_room', favorites: 'Radio 1=music:http://icecast.omroep.nl/radio1-bb-mp3; Jazz=playlist:spotify:playlist:37i9dQ; Bedtime=script.good_night; Movie=scene.movie_night' };
  const fav = ['', 'Radio 1=music:http://x', ' A = music:1 ;; B=scene.b ', 'Spotify=playlist:spotify:playlist:37i9', 'Bad', '=music:1', 'X=music:', 'X=:id', 'X=light.kitchen', 'X=Music:1', 'X=audio/mpeg:http://x/a.mp3'];
  const taps: [MediaTarget, number][] = [['prev', 0], ['play', 0], ['next', 0], ['down', 0], ['up', 0], ['fav', 0], ['fav', 1], ['fav', 2], ['fav', 3], ['fav', 4], ['set', 75], ['set', 0], ['set', 100], ['set', 7], ['set', 140], ['set', -3]];
  const views: [string, string | null, Record<string, string>][] = [
    ['playing with title, artist, volume', 'playing', { media_title: 'Evening Radio Hour', media_artist: 'Local station · live', volume_level: '0.32' }],
    ['paused keeps the title', 'paused', { media_title: 'So What', media_artist: 'Miles Davis', volume_level: '1' }],
    ['buffering', 'buffering', { media_title: 'Clair de lune' }],
    ['idle without title', 'idle', { volume_level: '0.005' }],
    ['standby counts as idle', 'standby', {}],
    ['on counts as idle', 'on', { media_title: 'TV' }],
    ['off drops title and artist', 'off', { media_title: 'Old', media_artist: 'Stale', volume_level: '0.5' }],
    ['unavailable', 'unavailable', {}],
    ['unknown', 'unknown', {}],
    ['not in HA yet', null, {}],
    ['volume out of range or text is no volume', 'playing', { media_title: ' Spaced ', volume_level: '1.5' }],
    ['volume text', 'playing', { volume_level: 'loud' }],
    ['VOLUME_SET in supported_features: the slider', 'playing', { volume_level: '0.32', supported_features: '152511' }],
    ['VOLUME_STEP without VOLUME_SET: − / +', 'playing', { volume_level: '0.32', supported_features: '1024' }],
    ['VOLUME_SET only', 'paused', { supported_features: '4' }],
    ['supported_features not a number', 'playing', { supported_features: 'all' }],
    ['supported_features negative', 'playing', { supported_features: '-4' }],
  ];
  const bars: [number, number, number][] = [[200, 200, 160], [320, 200, 160], [280, 200, 160], [150, 200, 160], [400, 200, 160], [281, 200, 160], [279, 200, 160], [50, 0, 0]];
  const layouts: [number, number, number][] = [[1, 1, 0], [1, 1, 3], [2, 1, 0], [2, 1, 6], [4, 1, 6], [2, 2, 3], [2, 2, 6], [1, 2, 6], [4, 2, 6], [3, 2, 2]];
  return {
    description: 'Now playing tile (eink-ha-os#319, spec/SCHEMA.md media). favorites: items of the favorites value (bad = rejected item). actions: the HA call per tap (fav = index into the valid favorites, or the volume % for set; null = none). views: what the tile shows from the state + attributes (text, like the firmware store; slider = VOLUME_SET in supported_features, eink-ha-os#351). layouts: what fits cs × rs with n favorites. volumeAt: the slider level (%) of a tap / drag end at x on a bar from bx, bw wide (eink-ha-os#351).',
    favorites: fav.map((v) => ({ value: v, items: parseFavorites(v) })),
    actions: taps.map(([t, i]) => ({ widget: w, target: t, fav: i, call: mediaAction(w, t, i) })),
    views: views.map(([name, state, attrs]) => ({ name, state, attrs, view: mediaView(state, attrs) })),
    layouts: layouts.map(([cs, rs, n]) => ({ cs, rs, n, layout: mediaLayout(cs, rs, n) })),
    volumeAt: bars.map(([x, bx, bw]) => ({ x, bx, bw, level: volumeAt(x, bx, bw) })),
  };
}

/** Stat tile source of a raw HA entity (eink-ha-os#161): state + unit the tile formats. Attribute values as the firmware keeps
 *  them (text; a number is its JSON text, null is ""). */
/** Clock zone + currency from HA (eink-ha-os#147): emulator src/core/locale.ts = firmware core/locale.{h,cpp}. */
export function localeVectors() {
  const tzFor_ = ([override, ha]: [string, string]) => ({ override, ha, posix: tzFor(override, ha) });
  return {
    _doc: 'Clock time zone and price currency from Home Assistant get_config (eink-ha-os#147). zones: the whole IANA → POSIX table (firmware must hold exactly these). tzFor(override, ha): the PUT /settings tz override (POSIX or a zone name) wins, else HA time_zone; null = keep the current zone (boot default Europe/Amsterdam). validTz: what PUT /settings accepts for tz. currency: get_config currency → the symbol price tiles show. money: a price in the point number format.',
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
    description: 'What a stat tile shows for an HA entity that is not one of our logical sensors (emulator src/core/format.ts statSource, firmware core/home.cpp statSource, eink-ha-os#161). climate: current_temperature in °C; weather: temperature in temperature_unit (absent = °C); anything else: its state and unit_of_measurement. ok false = a climate / weather without a temperature: the tile shows "—". The console entity list sends the same state / unit for climate and weather. Unavailable / unknown states never get here (gap, eink-ha-os#86). attrs are text as the firmware keeps them ("" = null).',
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
  ['stranger-house', 'Fake HA --house stranger: P1 meter (grid only: stat_rate sensor.p1_meter_power becomes the home use tile), Nest thermostat, lights, room thermometers. NAS and phone temperatures are not rooms; "Office: upstairs" loses its colon in the label. Clutter of a real install (eink-ha-os#58): sensors without device_class / unit / area, an unavailable hallway thermometer (no Hallway room), text states.', houseSnapshot('stranger', ['sensor.grid_power'])],
  ['demo-house', 'Fake HA --house demo (the emulator data): HA has the logical ids themselves (no labels: the catalog tiles), Energy dashboard price entity, tado zones, lights. No sensor.x4_route_* → no Travel app (the demo\'s routes are emulator mock data); one room thermometer → no Rooms screen.', houseSnapshot('demo', ['sensor.energy_prices'])],
  ['dutch-house', 'Fake HA --house dutch (eink-ha-os#82, shaped like the first real HA): no Energy dashboard. Names and units find SolarEdge (Zonproductie, not the Anker PV input), the P1 net power (not phase 1), Anker home load (Huisverbruik), Anker battery power and SOC % (not the kWh capacity, the phone, iPad, Zigbee, P1 Wi-Fi or tado heating %), Zon vandaag, Buienradar outside, tado rooms. No meters → no Energy screen, no charts.', houseSnapshot('dutch', [])],
  ['dutch-house-energy', 'Fake HA --house dutch-energy: the same house with an Energy dashboard of meters only (HA < 2025.12, no stat_rate). Power sensors come from the meters\' entity-id prefix (solaredge_i1_ac → ac_power, p1_meter, anker_solix); charts appear.', houseSnapshot('dutch-energy', [])],
  ['real-house', 'Fake HA --house real, the large example house (eink-ha-os#88, eink-ha-os#136): ~1100 entities. Zigbee chip temperatures (`…_device_temperature`) and one-phase power sensors are not in the answer; rooms and inside are real thermometers, outside the Shelly H&T "Outdoor". Envoy: stat_rate production = solar, current_power_consumption = home use, energy_production_today = solar today (`…_last_seven_days` has no day token). Energy dashboard grid flows have no today sensor and Envoy consumption is no grid import → no imported / exported tiles. The Tesla climate (its device has a device_tracker) is a vehicle: the zoneList names the 6 tado zones. eink-ha-os#152 traps: a "Forecast Max temperature today" is no Outside; the dryer plug\'s "Today consumption" is no Imported / Used today (Used today = the "Home energy usage today" helper); the Better-Thermostat-style wrapper (same room and name, off) is no zone; lights: per room the Hue group (not the second HA group of the living room), bulbs where a room has no group, the two lights without an area left out.', houseSnapshot('real', [])],
  ['seed-lessons', 'eink-ha-os#152: no outdoor thermometer but forecast-like ones (max, min, feels, Today tokens) → Outside is the first weather entity with a temperature (rule found), the forecast sensors are no room either; an appliance\'s day counter is no Imported (needs a grid word) and no Used today (needs a house / total word); a grid-named one is; zones: duplicates by area (the one not off wins, in the first one\'s place) and by friendly name (case-insensitive), a lone off zone stays; lights: only area-less ones left out → `areas`.', {
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
  ['light-groups', 'eink-ha-os#152: a group per area wins over its bulbs (the first group by order; a second group of the room is a duplicate), a room without a group keeps its bulbs in area order, a group without an area is left out; no light with an area at all → every light (no picks).', {
    areas: [['a', 'A'], ['b', 'B'], ['c', 'C']],
    lights: [['light.c_bulb', 'c', ''], ['light.a_bulb', 'a', ''], ['light.a_group', 'a', 'g'], ['light.a_group_2', 'a', 'g'], ['light.b1', 'b', ''], ['light.b2', 'b', ''], ['light.all', '', 'g']],
  }],
  ['lights-no-areas', 'eink-ha-os#152: no light has an area → every light (the lightList default), not an empty pick.', { lights: [['light.x', ''], ['light.y', '', 'g']] }],
  ['day-tokens-vehicle', 'eink-ha-os#136: day words as whole tokens (_day, Daily and vandaag count; _days, dagelijks and "monday" do not); a grid flow meter\'s today sensor (same 2-word prefix) beats an import-named one; a vehicle climate (`vehicles`) makes the zoneList name the others; only vehicles → no Heating screen.', {
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
  ['vehicle-only', 'eink-ha-os#136: the only climate is a car\'s → no Heating screen, report heating: none.', { vehicles: ['climate.tesla'] }],
  ['stale-logical', 'eink-ha-os#82: logical ids with a source (`live`) but no such sensor in HA\'s answer → no tile (the demo ids on a real house showed "—"). Price still comes from live.', {
    energy: { energy_sources: [{ type: 'solar', stat_energy_from: 'sensor.pv_kwh' }] },
    live: ['sensor.solar_power', 'sensor.grid_power', 'sensor.home_power', 'sensor.home_battery_soc', 'sensor.energy_prices'],
  }],
  ['solar-battery-routes', 'Solar + battery: solar power from stat_rate (a name without solar words), battery power and SOC from the meters\' prefix; a kW grid sensor by name; price via live; routes (eink-ha-os#145) from every sensor.x4_route_* in the answer or mapped (live: car), sorted by id, at most 4, mode car when the sensor reports min; bad entity ids are skipped; rooms capped at 8.', {
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
  ['flat-grid', 'eink-ha-os#274: HA 2025.12+ flat grid source (stat_energy_from / stat_energy_to / entity_energy_price / stat_rate, no flow_from / flow_to): grid power from stat_rate, imported / exported today by the meters\' prefix, price from entity_energy_price, Energy screen with the usage chart.', {
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
    description: 'First-run screens from the user\'s HA (eink-ha-os#23): seedConfig(snapshot, tail = []) → toYaml. Reference: emulator/src/core/seed.ts; firmware core/seed.cpp. snapshot = energy/get_prefs (energy) + logical ids with a source (live) + the SEED_TEMPLATE answer (present, areas, climate, lights, sensors). report = the seed report (eink-ha-os#89; firmware seedReportJson, compact JSON in this key order).',
    cases: SEED_CASES.map(([name, description, snapshot]) => { const p = seedPlan(snapshot, []); return { name, description, snapshot, yaml: toYaml(p.config), report: p.report }; }),
    template: SEED_TEMPLATE,
    answers_description: 'seedAnswerOk(text): only a JSON object is a seed answer; anything else saves nothing and retries on the next link (eink-ha-os#58).',
    answers: ['{"areas":[],"sensors":[]}', '{}', '', 'None', '[]', 'null', '"x"', '{"areas":'].map((text) => ({ text, ok: seedAnswerOk(text) })),
    events_description: 'templateEventFinal(has_result, level): render_template with report_errors; a WARNING event (undefined attribute) is followed by the result (eink-ha-os#58). level null = absent.',
    events: ([[false, 'WARNING'], [false, 'ERROR'], [false, null], [true, null], [true, 'WARNING']] as [boolean, string | null][])
      .map(([has_result, level]) => ({ has_result, level, final: templateEventFinal(has_result, level) })),
  };
}

/** [name, description, energy/get_prefs] — both grid shapes (eink-ha-os#274). Neutral entity ids. */
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
    _doc: 'Energy dashboard prefs (energy/get_prefs) → grid meters and price (eink-ha-os#274). grid = gridFlows(source) per grid source (emulator src/core/energyPrefs.ts = firmware gridFlows() in core/entity_map.cpp); statistic_ids = EntityAdapter::statisticIds() after setEnergyPrefs; sources = the Energy-dashboard entity_sources for sensor.grid_power and sensor.energy_prices (emulator aliasesOf in server/device.ts, firmware EntityAdapter::sources()).',
    cases: ENERGY_PREFS_CASES.map(([name, description, prefs]) => {
      const a = aliasesOf(prefs); const sources: Record<string, string> = {};
      for (const k of ['sensor.grid_power', 'sensor.energy_prices']) if (a[k]) sources[k] = a[k];
      const srcs = (prefs as { energy_sources: unknown[] }).energy_sources;
      return { name, description, prefs, grid: srcs.filter((s) => (s as { type?: string })?.type === 'grid').map(gridFlows), statistic_ids: statisticIds(prefs), sources };
    }),
  };
}

/** Today's energy from recorder statistics and the local day change (eink-ha-os#308). Times epoch ms; tz = UTC offset minutes
 *  (emulator), posixTz = the same zone for the firmware's localtime(). 2026-10-28 is CET (+60, after the DST end). */
export function energyHourlyVectors() {
  const CET = 'CET-1CEST,M3.5.0,M10.5.0/3', IST = 'IST-5:30';
  const prefs = { energy_sources: [
    { type: 'solar', stat_energy_from: 'sensor.pv_energy' },
    { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.meter_import' }], flow_to: [{ stat_energy_to: 'sensor.meter_export' }] },
    { type: 'battery', stat_energy_from: 'sensor.batt_out', stat_energy_to: 'sensor.batt_in' }] };
  const gridOnly = { energy_sources: [{ type: 'grid', stat_energy_from: 'sensor.meter_import', stat_energy_to: 'sensor.meter_export' }] };
  const H = 3600000, MID = Date.UTC(2026, 9, 27, 23);   // 2026-10-28 00:00 CET
  const rows = (from: number, xs: number[], iso = false) => xs.map((change, k) => ({ start: iso ? new Date(from + k * H).toISOString() : from + k * H, end: from + (k + 1) * H, change }));
  // yesterday 20:00–23:00 and today 00:00–09:00 local
  const day = {
    'sensor.pv_energy': rows(MID - 4 * H, [0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.4, 0.9]),
    'sensor.meter_import': rows(MID - 4 * H, [0.8, 0.7, 0.6, 0.5, 0.3, 0.25, 0.2, 0.2, 0.2, 0.3, 0.6, 0.5, 0.2, 0]),
    'sensor.meter_export': rows(MID - 4 * H, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3]),
    'sensor.batt_out': rows(MID - 4 * H, [0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    'sensor.batt_in': rows(MID - 4 * H, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2]),
  };
  const late = Object.fromEntries(Object.entries(day).map(([k, v]) => [k, v.slice(0, 4)]));   // asked at 23:59, rows up to 23:00
  const cases: { name: string; description: string; tz: number; posixTz: string; prefs: unknown; now: number; stats: unknown }[] = [
    { name: 'today-only', description: 'Rows from yesterday evening are dropped; hours 0–9 fill, the rest stay 0.', tz: 60, posixTz: CET, prefs, now: MID + 10.5 * H, stats: day },
    { name: 'late-answer-after-midnight', description: 'A request sent at 23:59 answered at 00:00:20 carries only yesterday: every total and bar is 0.', tz: 60, posixTz: CET, prefs, now: MID + 20000, stats: late },
    { name: 'empty-answer', description: 'HA omits ids without rows (right after midnight): nothing is emitted.', tz: 60, posixTz: CET, prefs, now: MID + 60000, stats: {} },
    { name: 'iso-start', description: 'ISO `start` (older HA) counts like ms.', tz: 60, posixTz: CET, prefs: gridOnly, now: MID + 5 * H, stats: { 'sensor.meter_import': rows(MID - 2 * H, [1, 1, 0.4, 0.3, 0.2], true) } },
    { name: 'india-midnight', description: 'Local midnight is not UTC midnight: IST 00:00 = 18:30 UTC.', tz: 330, posixTz: IST, prefs: gridOnly, now: Date.UTC(2026, 9, 27, 20, 0), stats: { 'sensor.meter_import': rows(Date.UTC(2026, 9, 27, 17, 30), [0.5, 0.4, 0.3]) } },
  ];
  const rolls: { name: string; description: string; tz: number; posixTz: string; answeredAt: number | null; now: number }[] = [
    { name: 'same-day', description: '23:00 answer, 23:59 now: no roll.', tz: 60, posixTz: CET, answeredAt: MID - H, now: MID - 60000 },
    { name: 'midnight', description: '23:00 answer, 00:00:05 now: roll, everything 0, ask again.', tz: 60, posixTz: CET, answeredAt: MID - H, now: MID + 5000 },
    { name: 'deep-sleep-two-days', description: 'Woken two days later: roll.', tz: 60, posixTz: CET, answeredAt: MID - 3 * H, now: MID + 2 * 24 * H + 7 * H },
    { name: 'utc-midnight-not-local', description: '00:30 CET answer (23:30 UTC the day before), 01:10 CET now: same local day, no roll.', tz: 60, posixTz: CET, answeredAt: MID + 0.5 * H, now: MID + 70 * 60000 },
    { name: 'never-answered', description: 'No statistics answer yet: nothing to roll.', tz: 60, posixTz: CET, answeredAt: null, now: MID + 5000 },
    { name: 'india-midnight', description: '23:30 IST answer, 00:01 IST now (same UTC day): roll.', tz: 330, posixTz: IST, answeredAt: Date.UTC(2026, 9, 27, 18, 0), now: Date.UTC(2026, 9, 27, 18, 31) },
  ];
  return {
    _doc: "Today's energy from recorder/statistics_during_period (eink-ha-os#308): cases = hourlyStatistics(stats, metersOf(prefs), now, tz) (emulator src/core/energyHourly.ts = firmware EntityAdapter::setHourlyStatistics after setEnergyPrefs, setNow(now/1000)); out = logical id → state kWh and `today` (24 × kWh) for the hourly series. rolls = statsDayRoll after an answer to `stats` at answeredAt (firmware EntityAdapter::rollDay after setNow(now/1000)): roll = ask the recorder again now, out = what the roll emits (every id the answer fed, at 0).",
    cases: cases.map((c) => ({ ...c, out: hourlyStatistics(c.stats, metersOf(c.prefs), c.now, c.tz) })),
    rolls: rolls.map((r) => {
      const owned = r.answeredAt === null ? [] : Object.keys(hourlyStatistics(day, metersOf(prefs), r.answeredAt, r.tz));
      const res = statsDayRoll(r.answeredAt === null ? null : localDay(r.answeredAt, r.tz), owned, r.now, r.tz);
      return { ...r, prefs, stats: day, roll: res.roll, out: res.out };
    }),
  };
}

const PROV = '{"providers":[{"name":"Home Assistant Local","id":null,"type":"homeassistant"}],"preselect_remember_me":true}';
const HA_PARSE = ['', '  homeassistant.local:8123 ', 'homeassistant.local', '192.168.1.5', 'HTTPS://HA.Example.com/lovelace/0', 'http://ha.local:8123/',
  'https://ha.example.com:443', 'http://ha.local:80', '[fd00::1]:8123', 'ha.local?x=1', 'ftp://ha.local', 'ws://ha.local:8123', 'ha local', 'user@ha.local',
  'ha.local:99999', 'ha.local:0', 'http://',
  // eink-ha-os#75: loopback / link-local refused (also inet_aton short forms and IPv4-mapped IPv6), LAN kept; typed port stays with its scheme
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
    _doc: 'Home Assistant address on the link page (eink-ha-os#54). parseHaAddress(input) and resolveHaAddress(input, probe): emulator src/core/haAddress.ts = firmware core/ha_address.cpp. probe(url) is one GET url + /auth/providers without following redirects; only a redirect to the https upgrade of the same host and port is probed next (eink-ha-os#75). Loopback and link-local hosts are refused, LAN addresses kept. A url missing from answers has no answer (status -1). probed = the urls in probe order.',
    parse: HA_PARSE.map((input) => ({ input, ...parseHaAddress(input) })),
    resolve,
  };
}

/** UI strings (eink-ha-os#98): the table, language resolution, placeholder fill and the clock date line. */
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
    _doc: 'Settings › Updates status line + web console Updates card (eink-ha-os#250; emulator src/core/otaStatus.ts, firmware core/ota_status.h). errOf(code, online): a failed GitHub request → GET /ota `error` (code ≤ 0 = no answer; ' + HTTP_LOW_MEMORY + ' = TLS heap guard). line(lang, in): title + detail; checked = local HH:MM of the last check ("" = none).',
    errOf: ([[HTTP_LOW_MEMORY, true], [403, true], [429, true], [404, true], [-1, true], [0, true], [502, true], [500, true], [200, false], [HTTP_LOW_MEMORY, false]] as [number, boolean][])
      .map(([code, online]) => ({ code, online, error: otaErrOf(code, online) })),
    line: lines.flatMap(([name, p]) => LANGS.map((lang) => { const i = { ...base, ...p }; return { name, lang, in: i, out: otaLine(lang, i) }; })),
  };
}

export function stringsVectors() {
  const keys = Object.keys(STRINGS) as StrKey[];
  return {
    _doc: 'UI strings (eink-ha-os#98): emulator src/core/strings.ts = firmware core/strings.{h,cpp} + the generated core/strings_gen.h (npm run vectors writes both). langOf(code): HA get_config language or browser language → en | nl (any nl variant → nl, everything else → en). tr(lang, key, args): each {} takes the next arg. dateLine(lang, wday, mday, month): struct tm numbering.',
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
  return '// GENERATED by emulator/scripts/gen-vectors.ts from emulator/src/core/strings.ts (eink-ha-os#98). Do not edit: change\n' +
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
  writeFileSync(join(OUT, 'bins.json'), JSON.stringify(binsVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'morning.json'), JSON.stringify(morningVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'attr-list.json'), JSON.stringify(attrListVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'guest-wifi.json'), JSON.stringify(guestWifiVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'diag.json'), JSON.stringify(diagVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'battery-history.json'), compactJson(batteryVectors()));
  writeFileSync(join(OUT, 'gauge-filter.json'), compactJson(gaugeFilterVectors()));
  writeFileSync(join(OUT, 'logs.json'), JSON.stringify(logsVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'seed.json'), JSON.stringify(seedVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'energy-prefs.json'), JSON.stringify(energyPrefsVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'energy-hourly.json'), compactJson(energyHourlyVectors()));
  writeFileSync(join(OUT, 'ha-address.json'), JSON.stringify(await haAddressVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'list-pick.json'), JSON.stringify(listPickVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'stat-raw.json'), JSON.stringify(statRawVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'scene-action.json'), JSON.stringify(sceneActionVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'media.json'), JSON.stringify(mediaVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'strings.json'), JSON.stringify(stringsVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'locale.json'), JSON.stringify(localeVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'history.json'), compactJson(historyVectors()));
  writeFileSync(join(OUT, 'history-series.json'), compactJson(historySeriesVectors()));
  writeFileSync(join(ROOT, 'firmware', 'assets', 'weather-icons.json'), JSON.stringify({ _doc: 'GENERATED by emulator npm run vectors from src/core/weatherArt.ts (eink-ha-os#318); firmware tools/icongen.py rasterises it.', grid: WX_GRID, heroStroke: WX_HERO_STROKE, icons: WX_ICONS.map((k) => ({ name: k, layers: WX_ART[k] })) }, null, 2) + '\n');
  writeFileSync(join(OUT, 'weather.json'), JSON.stringify(weatherVectors(), null, 2) + '\n');
  writeFileSync(join(OUT, 'agenda.json'), compactJson(agendaVectors()));
  writeFileSync(join(OUT, 'quiet-tomorrow.json'), JSON.stringify(quietTomorrowVectors(), null, 1) + '\n');
  writeFileSync(join(OUT, 'ota-status.json'), JSON.stringify(otaStatusVectors(), null, 2) + '\n');
  writeFileSync(STRINGS_HEADER, stringsHeader());
  console.log('wrote ' + CONFIG_CASES.length + ' config vectors + severity.json to ' + OUT);
}
