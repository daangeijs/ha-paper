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
| train, bus | ignored | `departures` (required): a list, or a JSON string of one, of `{"time": "HH:MM", "delay": minutes, "cancelled": bool, "info": text}`; local clock times, upcoming first. `note` (optional): replaces the footer. `per_hour` (bus, optional): adds "‹n› per hour" |
| car | travel time in minutes | `typical` (optional): usual minutes; without it there is no badge and no "usually" line. `note` (optional) |

Severity: worst of the next two departures (delay < 2 on time, < 5 minor, ≤ 15 delayed, > 15 or cancelled disrupted);
car: travel time / typical ≥ 1.15, 1.4, 1.75 (`spec/test-vectors/severity.json`). No entity: "Pick a sensor for this
route". Entity `unavailable` / `unknown`: the gap ring and word (#86). Entity missing or without upcoming departures: "—".

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
| stat/gauge/switch/route entity bad id or domain | widget | `‹type›: “‹entity›” is not a ‹d1 / d2 / …› entity` |
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
| any other line | that line | `Can’t read this line` |
| no screens | 1 | `No screens found` |
| duplicate screen id | `- id:` (last with that id) | `Duplicate screen id “‹id›”` |
| more than 8 cells | screen `- id:` | `“‹title›” uses ‹n› of 8 cells` |

Plus the apps rules above. Widget checks run in table order; `cs: 0`/`rs: 0` count as unset.
Reference implementation: `parseYaml()` in `emulator/src/core/config.ts`; test vectors:
`spec/test-vectors/config/*.json` (apps: `33`–`39`; routes: `22`, `50`–`52`; built-in Settings: `53`–`57`).
