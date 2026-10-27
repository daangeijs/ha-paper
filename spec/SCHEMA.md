# screens.yaml

```yaml
version: 1
apps:                     # optional; must come before screens:
  - id: home              # unique
    title: Home           # optional, defaults to id
  - id: garden
    title: "Garden: back" # quote titles containing : # { } [ ] , "
screens:
  - id: overview          # unique
    app: home             # an id from apps: (default: first app)
    title: Home
    widgets:
      - {type: clock, cs: 2}
      - {type: stat, entity: sensor.solar_power}
```

## apps

Apps = categories of screens (the display's app switcher), in file order.
Optional: without `apps:` the apps are `home` (Home), `house` (House), `travel` (Travel).
With `apps:` those defaults are replaced entirely. Entry fields: `id` (required), `title` (defaults to `id`); nothing else.
At most **7** apps. A screen without `app:` belongs to the first app; `app:` must name a defined app.

### Settings is built in (#159)

The display always adds a fixed **Settings** app as the last of its 8 app switcher slots, with fixed pages: Display,
Display style, Power, Updates, Wi-Fi, Home Assistant, About (emulator `settingsScreens()`, firmware
`core/config.cpp settingsScreens()`). It is not part of this file; the same settings are edited with
`GET/PUT /api/v1/settings` (the web console's Device tab). Older files still parse:

- an `apps:` entry `settings` is skipped (its `title` too) and does not count towards the 7; if it was the only entry,
  the default apps apply;
- `app: settings` is always accepted on a screen; those screens are checked like any other (duplicate id, cells), then
  dropped;
- system tiles (`setting`, `ota`, `wifi`, `ha`, `about`) are checked, then dropped from every screen;
- a file whose only screens are Settings screens has no screens of your own: `No screens found` (line 1).

| rule | line | message |
|---|---|---|
| `apps:` after `screens:` | `apps:` | `“apps:” must come before “screens:”` |
| duplicate app id | `- id:` | `Duplicate app id “‹id›”` |
| 8th app (`settings` not counted) | `- id:` | `At most 7 apps` |
| `apps:` with no entries | `apps:` | `No apps found` |
| other key in an app entry (e.g. `app:`) | that line | `Can’t read this line` |
| screen `app:` not defined | `app:` | `Unknown app “‹app›” (‹ids, comma-separated›)` |

## widgets

Widgets are one-line flow maps `{k: v, ...}` (no commas inside values; all-digit values are numbers).
`widgets: []` = empty screen. Common fields: `cs` width in cells (1–4, default 1), `rs` height (1–2, default 1),
`col` (1–4) + `row` (1–2) pin a tile (always together), `label` overrides the tile caption.
A screen holds at most **8 cells** (sum of `cs × rs`) on a 4 × 2 grid.
Placement: pinned tiles first at `col`/`row`; the rest row-major from a forward-only cursor (CSS-grid auto-placement).
A tile with no room is not drawn.

| type | fields | notes |
|---|---|---|
| clock | | time + date |
| stat | entity | HA entity_id, domain `sensor` \| `binary_sensor` \| `input_number` \| `number` |
| price | label (optional) | price now + cheap/normal/high + cheapest 3 h window; `label` replaces the title (#148) |
| gauge | entity, label (optional) | percentage; domain `sensor` \| `input_number` \| `number`; default `sensor.home_battery_soc` |
| bars | series: prices \| usage \| solar, label (optional) | 24 h chart, now = black; another series draws usage |
| route | label, mode, entity (all optional), route | a user route with severity; `mode` train \| bus \| car (default train), `entity` a `sensor.*`; see *route sensors* |
| lightList | areas, entities (both optional) | lights by HA area, paginated (use cs 4, rs 2); see *list picks* |
| switch | entity | toggle; domain `switch` \| `light` \| `input_boolean` \| `fan` |
| light | light: ‹id› | legacy (pre-0.5): rewritten to `{type: switch, entity: light.‹id›}` (`‹id›` with a `.` kept as-is) |
| scene | entity, label (optional) | tap runs it: `scene.*` → `scene.turn_on`, `script.*` → `script.turn_on`; no entity (or the older `scene: all_off`) = all lights off (`light.turn_off`, `entity_id: all`); an entity wins over `scene:` |
| zoneList | entities (optional) | climate entities (any integration), 10 per page (use cs 4, rs 2); see *list picks*; the away button shows when a climate entity's `preset_modes` has `away` and is sent to those (#148) |
| history | entity, window, bucket, agg, style, min, max, threshold, labels, label; attribute, value, time, ahead, forecast (all but entity optional) | a numeric entity over time; domain `sensor` \| `input_number` \| `number`; or a list in an attribute / a weather forecast (#283); see *history* (#264); the firmware parses it (#268) and draws the unknown-tile face until #270 |
| thermo | zone: ‹id›, label (optional) | single room, `‹id›` = object id of a `climate.*` entity (the console picks it); no zone = “—”; rs 2 recommended |
| setting, ota, wifi, ha, about | | system tiles of the built-in Settings pages: accepted for older files, then dropped (see *Settings is built in*) |

entity_id = `^[a-z0-9_]+\.[a-z0-9_]+$`, domain = part before the `.`.

### list picks (#127)

`lightList` and `zoneList` show everything unless a pick narrows them. A pick is a **space-separated** list (the flow
map splits on commas): `{type: lightList, areas: kitchen living_room, entities: light.porch, cs: 4, rs: 2}`,
`{type: zoneList, entities: climate.living climate.office, cs: 4, rs: 2}`.

- `lightList areas`: HA area ids (`^[a-z0-9_]+$`); each brings all lights HA puts in that area (entity or device area).
- `lightList entities`: `light.*` ids. Each is grouped under its own area: after a picked area's lights if that area is
  already shown, else as a new group at the end.
- `zoneList entities`: `climate.*` ids.
- Order follows the pick (areas first, then entities). Ids HA doesn't have are skipped; duplicates count once.
  No pick (or empty values) = every light grouped by area / every climate entity, as before.
- The display subscribes to every picked entity and to the lights of picked areas.
- `zoneList labels` (#151): the tile's own room names, `climate.<id>=Name` items split by `;` (names may have spaces,
  no commas): `{type: zoneList, labels: climate.bathroom_attic=Attic; climate.bathroom=Downstairs, cs: 4, rs: 2}`. A
  room without a label keeps HA's name.

### route sensors (#145)

A route tile is the user's own: `{type: route, label: To work, mode: train, entity: sensor.commute, cs: 2}`. There is no
built-in route list. The title is `label`, else the entity's friendly name, else "Route". `route` is an optional free id
(older files used ids from a built-in demo route list; they still parse, as a route without entity
that asks for a sensor, and the web console blocks saving until one is picked). The display subscribes to `entity`.

What the display reads from the entity (any integration, or a template sensor that reshapes one):

| mode | state | attributes |
|---|---|---|
| train, bus | ignored | `departures` (required): a list, or a JSON string of one, of `{"time": "HH:MM", "delay": minutes, "cancelled": bool, "info": text}`; local clock times, upcoming first. Or, without `departures`, `upcoming` as the NS departures integration (ha-ns-departures) writes it: `{"planned": ISO, "actual": ISO, "delay": minutes, "track": text, "direction": text, "status": "on_time" \| "delayed" \| "cancelled", …}`; the row shows the local time of `actual` (else `planned`), `delay` (else actual − planned), cancelled when `status` is `cancelled`, and "Track ‹track› · ‹direction›" (#275, `spec/test-vectors/route-departures.json`). `note` (optional): replaces the footer. `per_hour` (bus, optional): adds "‹n› per hour" |
| car | travel time in minutes | `typical` (optional): usual minutes; without it there is no badge and no "usually" line. `note` (optional) |

Severity: worst of the next two departures (delay < 2 on time, < 5 minor, ≤ 15 delayed, > 15 or cancelled disrupted);
car: travel time / typical ≥ 1.15, 1.4, 1.75 (`spec/test-vectors/severity.json`). No entity: "Pick a sensor for this
route". Entity `unavailable` / `unknown`: the gap ring and word (#86). Entity missing or without upcoming departures: "—".

### history (#264)

`{type: history, entity: sensor.outdoor_temperature, window: 24h, agg: mean, cs: 4}`. At most **6** history tiles per
config (the 7th fails: `At most 6 history tiles`).

| key | values | default |
|---|---|---|
| window | `‹n›m` \| `‹n›h` \| `‹n›d`, 10m–7d (a bare number has no unit and fails) | `24h` |
| bucket | `1m 5m 10m 15m 30m 1h 2h 3h 6h 12h 1d`; divides the window into 2–96 bars | the smallest step giving ≤ 12 bars per column (`cs`); else the dividing step with the fewest bars in 2–96 |
| agg | `mean` (time-weighted) \| `max` \| `min` \| `last` (value at the bucket's end) \| `change` (counters: last minus the value before) | `mean` |
| style | `bars` \| `line` \| `area` \| `step` \| `dots` \| `auto` | `auto`: `line` for `mean`, `bars` otherwise |
| min, max | numbers (negative / decimal allowed), `min` < `max` | bars from 0, the other styles auto-ranged with 10 % padding |
| threshold | number (#304): a dashed reference line; an auto range widens to hold it; outside a fixed range it is not drawn | none |
| labels | `true` \| `false` (#304): the max, min and last value printed beside their points (last only away from the other two) | `false` |
| label | text | HA friendly name, else the entity id |

Defaults with `cs: 4`: 1h → 5m, 6h → 10m, 24h → 30m, 7d → 6h; `cs: 2`, 24h → 1h. Buckets align to local time; the last
one is open and holds now. Data: `recorder/statistics_during_period` (`period` 5minute below 1h, hour below 1d, else day;
`types` = the agg, `last` reads `mean`); without statistics (or a bucket under 5m)
`history/history_during_period`, only for windows up to 24 h. Unavailable / unknown = an empty bucket: a gap, never
joined across. Styles (#304): `area` = the line over a 25 % dither fill down to the plot bottom (1-bit safe); `step` =
a flat run per bucket, joined upright to the next; `dots` = one dot per bucket. The latest point gets the big dot in
every style but `bars`. The chart prints
the low and high bucket with its time and an x axis: minutes before now (≤ 3 h), round hours (≤ 48 h), else weekdays.
Reference: `emulator/src/core/history.ts` (firmware `core/history.cpp`); vectors: `spec/test-vectors/history.json` (incl. its config cases).

#### series from an attribute or a weather forecast (#283)

The same tile charts a list HA already holds, e.g. a rain nowcast or a weather forecast. The keys pick the source:
`attribute` set → a list in that attribute of the entity (domain `sensor` \| `binary_sensor` \| `weather`); else a
`weather.*` entity → `weather.get_forecasts` (a service call with `return_response`); else the recorder (above).

```yaml
- {type: history, entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, window: 2h, cs: 4}
- {type: history, entity: weather.home, window: 24h, cs: 4}
- {type: history, entity: weather.home, forecast: daily, value: precipitation, window: 7d, bucket: 1d, agg: change, cs: 4}
```

| key | values | default |
|---|---|---|
| attribute | attribute name (letters, digits, `_`) | — (none = recorder or forecast) |
| value | the entry field to chart | `temperature` (forecast), else `value` |
| time | the entry field with its time | `datetime` |
| forecast | `hourly` \| `daily`; weather entity without `attribute` only | `hourly` |
| ahead | `0` or a span ≤ window that the bucket divides: the part of the window after now | the whole window |

The list (or a JSON string of one) holds objects `{‹time›: ISO 8601 or epoch s / ms, ‹value›: number}` (an entry
without a valid time or number is skipped; an ISO time without offset is local), or plain numbers: one per bucket,
the first in the bucket holding now. Entries are samples, not held values: a sample belongs to the bucket its time falls
in; `mean` averages them, `min` / `max`, `last` = the latest, `change` = their sum; a bucket without a sample is empty.
With `ahead` > 0 the bucket holding now starts the last `ahead` of the window (`ahead` = window: the first bucket);
`ahead: 0` is the recorder's span (now in the last bucket). An hourly forecast needs a bucket of 1h or more, a daily
one 1d (the default bucket skips shorter steps). Axis for windows ≤ 3 h: `-60 Now +30 +60`. Validation (first error):

| rule | message |
|---|---|
| attribute entity domain | `history: “‹entity›” is not a sensor / binary_sensor / weather entity` |
| ahead / value / time / forecast on a recorder series | `history: ‹key› needs an attribute or a weather entity` |
| attribute / value / time not a name | `history: ‹key› must be an attribute name (letters, digits, _)` |
| forecast not hourly / daily, or with `attribute` | `history: forecast must be hourly or daily, on a weather entity without attribute` |
| forecast bucket shorter than its step | `history: an hourly forecast needs a bucket of 1h or more` \| `history: a daily forecast needs a bucket of 1d or more` |
| ahead not 0 or a span ≤ window | `history: ahead must be 0 or like 30m or 2h, at most the window` |
| bucket does not divide ahead | `history: bucket ‹bucket› does not divide ahead ‹ahead›` |

Reference: `emulator/src/core/history.ts`; vectors: `spec/test-vectors/history-series.json`. The firmware does not read
these sources yet: `firmware/deviations/283-attribute-series.md`.

## validation

Reject first error with 1-based line number and message (exact text; `‹›` = substituted value).

| rule | line | message |
|---|---|---|
| `version:` not `1` | `version:` | `Only version 1 is supported` |
| `- id:` before `screens:`/`apps:` | that line | `“screens:” must come first` |
| `app:`/`title:`/`widgets:` before any screen | that line | `Belongs to no screen` |
| widget not under `widgets:` | widget | `Widget outside a “widgets:” list` |
| flow-map part without `:` | widget | `Expected key: value` |
| unknown type | widget | `Unknown widget type “‹type›”` |
| stat/gauge/switch/route/history entity bad id or domain | widget | `‹type›: “‹entity›” is not a ‹d1 / d2 / …› entity` |
| lightList `areas` item not an area id | widget | `lightList: “‹id›” is not an area id` |
| lightList / zoneList `entities` item not a light / climate entity_id | widget | `‹type›: “‹id›” is not a ‹light \| climate› entity` |
| zoneList `labels` item not `climate.<id>=Name` | widget | `zoneList: “‹item›” in labels is not climate.<id>=Name` |
| route `mode` not train / bus / car | widget | `route: mode must be train, bus or car` |
| `cs` not 1–4 | widget | `cs must be 1–4` |
| `rs` not 1–2 | widget | `rs must be 1 or 2` |
| `col`/`row` set, `col` not 1–4 | widget | `col must be 1–4` |
| `col`/`row` set, `row` not 1–2 | widget | `row must be 1 or 2` |
| pinned tile sticks out of grid | widget | `Does not fit at col ‹col›, row ‹row›` |
| pinned tile overlaps earlier pinned tile | widget | `Overlaps another tile at col ‹col›, row ‹row›` |
| history `window` not 10m–7d | widget | `history: window must be like 30m, 6h or 7d (10m–7d)` |
| history `bucket` not on the ladder | widget | `history: bucket must be one of 1m 5m 10m 15m 30m 1h 2h 3h 6h 12h 1d` |
| history `bucket` does not divide `window` | widget | `history: bucket ‹bucket› does not divide window ‹window›` |
| history bars not 2–96 | widget | `history: ‹window› / ‹bucket› = ‹n› bars (2–96)` (`1 bar`) |
| history without `bucket`, none fits | widget | `history: no bucket fits window ‹window›; set bucket` |
| history `agg` | widget | `history: agg must be mean, max, min, last, change` |
| history `style` | widget | `history: style must be bars, line, area, step, dots or auto` |
| history `threshold` not a number | widget | `history: threshold must be a number` |
| history `labels` not true / false | widget | `history: labels must be true or false` |
| history `min` / `max` not a number | widget | `history: min and max must be numbers` |
| history `min` ≥ `max` | widget | `history: min must be below max` |
| 7th history tile | widget | `At most 6 history tiles` |
| any other line | that line | `Can’t read this line` |
| no screens | 1 | `No screens found` |
| duplicate screen id | `- id:` (last with that id) | `Duplicate screen id “‹id›”` |
| more than 8 cells | screen `- id:` | `“‹title›” uses ‹n› of 8 cells` |

Plus the apps rules above. Widget checks run in table order; `cs: 0`/`rs: 0` count as unset.
Reference implementation: `parseYaml()` in `emulator/src/core/config.ts`; test vectors:
`spec/test-vectors/config/*.json` (apps: `33`–`39`; routes: `22`, `50`–`52`; built-in Settings: `53`–`57`).

# settings.json (device settings)

Not a file you write: the display keeps `GET/PUT /api/v1/settings` `display` in `/settings.json` (firmware
`net/storage.cpp`) with a `schema` number. A boot upgrades an older file one step at a time and keeps every key it does
not own, so an OTA rollback still reads it (rules: `emulator/src/core/migrate.ts`, vectors
`spec/test-vectors/migrations/*.json`).

| schema | change |
|---|---|
| 0 → 1 | files from before versioning (#12): only stamped |
| 1 → 2 | quiet hours (#295): new key `quiet` (`off` or `HH-HH`) from `night` when that held a window, else `23-07` (on, also for existing installs). `night` stays in the file for a rollback but is no longer read or served. `powerSave: night` ("Sleep at night") becomes `glance`. A `quiet` key already in the file wins. |

A `screens.yaml` from before #295 may still hold a Settings tile `{type: setting, key: night}`: like every system tile
it is checked and dropped (see "Settings is built in").
