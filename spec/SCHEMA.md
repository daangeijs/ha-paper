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
| price | label (optional) | price now + cheap/normal/high + cheapest 3 h window; `label` replaces the title (eink-ha-os#148) |
| gauge | entity, label (optional) | percentage; domain `sensor` \| `input_number` \| `number`; default `sensor.home_battery_soc` |
| bars | series: prices \| usage \| solar, label (optional) | 24 h chart, now = black; another series draws usage |
| route | label, mode, entity (all optional), route | a user route with severity; `mode` train \| bus \| car (default train), `entity` a `sensor.*`; see *route sensors* |
| lightList | areas, entities (both optional) | lights by HA area, paginated (use cs 4, rs 2); see *list picks* |
| switch | entity | toggle; domain `switch` \| `light` \| `input_boolean` \| `fan` |
| light | light: ‹id› | legacy (pre-0.5): rewritten to `{type: switch, entity: light.‹id›}` (`‹id›` with a `.` kept as-is) |
| scene | entity, label (optional) | tap runs it: `scene.*` → `scene.turn_on`, `script.*` → `script.turn_on`; no entity (or the older `scene: all_off`) = all lights off (`light.turn_off`, `entity_id: all`); an entity wins over `scene:` |
| media | entity, label, favorites (both optional) | now playing on a `media_player`: title, artist, state, previous / play-pause / next, volume slider (or − / +), and up to 6 favorites to start; see *media* (eink-ha-os#319) |
| zoneList | entities (optional) | climate entities (any integration), 10 per page (use cs 4, rs 2); see *list picks*; the away button shows when a climate entity's `preset_modes` has `away` and is sent to those (eink-ha-os#148) |
| history | entity, window, bucket, agg, style, min, max, threshold, labels, label; attribute, value, time, ahead, forecast, past (all but entity optional) | a numeric entity over time; domain `sensor` \| `input_number` \| `number`; or a list in an attribute / a weather forecast (eink-ha-os#283); see *history* (eink-ha-os#264); the firmware parses it (eink-ha-os#268) and draws the unknown-tile face until eink-ha-os#270 |
| weather | entity, label (optional) | a `weather.*` entity: condition drawing, temperature, today's high / low / wind / rain, a 5-day strip; `cs: 4` (`rs: 2` full screen, `rs: 1` the top half); see *weather* (eink-ha-os#318) |
| bins | entities, labels, tonight, label (all optional) | bin day: the next waste collection in words; `entities` space-separated `sensor.*` ids (at most 6); see *bins* (eink-ha-os#317) |
| guestWifi | ssid, password, security, hidden, password_entity (all optional) | guest Wi-Fi: a QR code that joins the network, name and password in large type; 2×2 default, 2×1 compact; see *guestWifi* (eink-ha-os#329) |
| attrList | entity, attribute, title, subtitle, time, empty, label (all but entity optional) | rows from a sensor attribute that holds a list of objects (e.g. rare birds nearby); see *attrList* (eink-ha-os#332) |
| agenda | entities (1–4 `calendar.*`), label (optional) | today, tomorrow and the rest of the week from HA calendars; see *agenda and next* (eink-ha-os#316) |
| next | entities (1–4 `calendar.*`), label (optional) | the next timed event with a countdown; see *agenda and next* (eink-ha-os#316) |
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
- `zoneList labels` (eink-ha-os#151): the tile's own room names, `climate.<id>=Name` items split by `;` (names may have spaces,
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
| train, bus | ignored | `departures` (required): a list, or a JSON string of one, of `{"time": "HH:MM", "delay": minutes, "cancelled": bool, "info": text}`; local clock times, upcoming first. Or, without `departures`, `upcoming` as the NS departures integration (ha-ns-departures) writes it: `{"planned": ISO, "actual": ISO, "delay": minutes, "track": text, "direction": text, "status": "on_time" \| "delayed" \| "cancelled", …}`; the row shows the local time of `actual` (else `planned`), `delay` (else actual − planned), cancelled when `status` is `cancelled`, and "Track ‹track› · ‹direction›" (eink-ha-os#275, `spec/test-vectors/route-departures.json`). `note` (optional): replaces the footer. `per_hour` (bus, optional): adds "‹n› per hour" |
| car | travel time in minutes | `typical` (optional): usual minutes; without it there is no badge and no "usually" line. `note` (optional) |

Severity: worst of the next two departures (delay < 2 on time, < 5 minor, ≤ 15 delayed, > 15 or cancelled disrupted);
car: travel time / typical ≥ 1.15, 1.4, 1.75 (`spec/test-vectors/severity.json`). No entity: "Pick a sensor for this
route". Entity `unavailable` / `unknown`: the gap ring and word (eink-ha-os#86). Entity missing or without upcoming departures: "—".

### media (#319)

`{type: media, entity: media_player.living_room, cs: 2, favorites: Radio 1=music:http://icecast.omroep.nl/radio1-bb-mp3; Bedtime=script.good_night}`

- The tile shows `label` (else the player's friendly name), the state (Playing / Paused / Loading / Idle / Off),
  `media_title` (else "Nothing playing") and `media_artist`, and `volume_level` as a percentage. Nothing else of the
  player is read: no progress bar, no album art, so a playing track redraws only when the title, artist, state or volume
  changes. `unavailable` / `unknown`: the gap ring and word.
- Taps: ⏮ `media_player.media_previous_track`, ⏯ `media_play_pause`, ⏭ `media_next_track`, − / +
  `volume_down` / `volume_up` (HA steps from its own volume, so quick taps add up), each with `entity_id`. A 1-wide tile
  has the three transport buttons only.
- Volume slider (eink-ha-os#351): a player whose `supported_features` has VOLUME_SET (4) gets a bar instead of − / + (from 2 wide),
  filled to `volume_level` with the % on it. A tap, or the end of a drag, at x sets the level (x − bar left) / bar width
  in whole % and sends one `media_player.volume_set` with `volume_level` 0–1; the bar shows the new level at once and the
  next state update corrects it. Other players keep − / +.
- `favorites`: items `Name=target` split by `;` (no commas; names without `=`), at most 6. A target `script.<id>` or
  `scene.<id>` runs `<domain>.turn_on`; any other target is `<media_content_type>:<media_content_id>` (split at the first
  `:`, the type letters, digits and `_ / + . -`) and runs `media_player.play_media` on the tile's player with
  `media_content_type` and `media_content_id`. A 2-high tile lists the favorites under the title; a 1-high tile has a
  ★ button that turns the tile into the list until one is picked (or × / another page).
- Rules: `media: “‹item›” in favorites is not Name=type:id or Name=script.<id> / scene.<id>`,
  `media: at most 6 favorites`. Reference: `emulator/src/core/media.ts`; vectors `spec/test-vectors/media.json`.

### bins (#317)

`{type: bins, entities: sensor.afval_papier sensor.waste_pmd, labels: sensor.afval_papier=Paper; sensor.waste_pmd=Plastic, cs: 2}`.
One sensor per bin, any integration. `labels`: the tile's own bin names, `sensor.<id>=Name` items split by `;` (like
zoneList `labels`); a bin without one keeps HA's friendly name. `tonight` (0–23, default 17): from this local hour the day
before a collection the tile says "put out tonight". `label` replaces the 2-wide title ("Bins"). The display subscribes to
every sensor in `entities`.

What the display reads from each sensor; the first that gives a day from today on wins:

| source | example | integration |
|---|---|---|
| state = a date | `2026-10-29`, `2026-10-29T00:00:00+01:00`, `29-10-2026` | afvalwijzer |
| state = days to | `3` | waste_collection_schedule with `value_template: "{{ value.daysTo }}"` |
| attribute `daysTo` | `3` | waste_collection_schedule `add_days_to: true` |
| attribute `upcoming` | a list (or JSON text of one) of dates or `{date}` | a template sensor |

`unavailable` / `unknown`, a date in the past and anything else: the bin is left out. Words: Today, Tomorrow, in N days,
with the date as "Thursday 29" (2-wide rest list "Thu 29"). From `tonight`:00 the day before: "Thursday 29 · put out
tonight" and a TONIGHT pill; on the day a TODAY pill. Bins on the same soonest day share the headline ("Paper +
Plastic"). A 1-wide tile shows the soonest bin: its name, the when word, the date or "Put out tonight". No sensors:
"Pick bin sensors in the browser"; none with a date: "—" and "No collection date".
Reference: `emulator/src/core/bins.ts` (firmware `core/bins.cpp`); vectors: `spec/test-vectors/bins.json`.

### guestWifi (#329)

`{type: guestWifi, ssid: Harbor Guest, password: tea%2C please, cs: 2, rs: 2}`. `security`: `WPA` (default), `WEP` or
`nopass` (no password row, no `P:`). `hidden: true` adds `H:true`. `password_entity` (an `input_text`, `text` or
`sensor`): its state is the password and overrides `password` (a rotating password follows HA); the display subscribes
to it; `unavailable` / `unknown` / no state: "No password from Home Assistant", no code.

`ssid` and `password` are written with `%XX` (UTF-8 bytes) for `%` `,` `{` `}`, control characters, whitespace at either
end and the first digit of a digits-only value, so the flow map keeps them as typed (`tea, please` → `tea%2C please`,
`00123456` → `%300123456`); `%XX` is read back everywhere, `%00` dropped. The password is stored in the screen config:
anyone with console or API access can read it (the console says so). Never logged.

QR payload `WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:true;;` with `\ ; , : "` backslash-escaped. Encoded with
Nayuki's qrcodegen (emulator TypeScript, firmware C, same modules): ECC M, smallest version 1–6, automatic mask, no ECC
boost. Over version 6 (106 bytes): "Too long for a QR code" in the code's place, the text still shown.

Layout (tile-relative, 2 px border inside): 2-wide × 2-high (cs < 4): the code centred in the square above a 108 px text
block (bottom 10 px); 2×1 and 4-wide: the code in the left square (tile height − 4), text right of it, vertically
centred; 1-wide: the code alone. Whole px per module: ⌊square / (modules + 8)⌋, a 4-module white quiet zone (Modern: a
white rounded square on the card). Text: "Network" / "Password" (16 px) over the value (bold 28 px, smaller to fit).
No network (or no password with WPA/WEP and no entity): "Enter the network in the browser". GET /screens/{id}/values:
the network name, never the password. Static: redraws only when the config or the entity's state changes.
Reference: `emulator/src/core/guestWifi.ts` (firmware `core/guest_wifi.cpp`, `app/ui_guest.cpp`); vectors:
`spec/test-vectors/guest-wifi.json`, `config/329a`–`329d`.

### attrList (#332)

`{type: attrList, entity: sensor.rare_birds_nearby, cs: 2, rs: 2}`. A list from one attribute of a `sensor.*`: a list of
objects (or JSON text of one), in the order the sensor gives it. Field names (letters, digits, `_`), defaults for the
ha-waarneming integration's display-ready fields (`docs/recipes/rare-birds.md`, eink-ha-os#375): `attribute: sightings`,
`title: title`, `subtitle: subtitle` (up to 3 names split by spaces, joined with " · "), `time: ts`. A field left at its
default that an item lacks (absent or null) reads the YAML recipe's field instead: `species`, `place distance_km`,
`observed_at`; a field the tile sets has no fallback. `empty`: the text when the list is empty
(default "Nothing to show"); `label` replaces HA's friendly name in the header.

Per item: the title (an item without one is left out), the subtitle parts that are there, and how long ago the time
field is (epoch seconds or ms, or ISO; ISO without an offset is local time): "just now", "N min ago", "N h ago" (under 24 h), then "yesterday" / "N days ago" by local day; a date without a
time says today / yesterday / N days ago. Numbers show at most 1 decimal; a field name ending in `_km` / `_m` adds the
unit. Rows: below 3 columns two lines per row (title + ago, then the subtitle), 2 rows on 1 row, 6 on 2 rows; from 3
columns one line per row, 4 / 10. Foot: the entity's `attribution` attribute left, "+N more" right. Entity missing,
`unavailable` or `unknown`: "No data yet".

The display keeps only this tile's attribute (and `attribution`) of that entity, at most 10 items and 3072 bytes of
JSON: the first items that fit (`capList`). Reference: `emulator/src/core/attrList.ts` (firmware `core/attr_list.cpp`,
`app/ui_list.cpp`); vectors: `spec/test-vectors/attr-list.json`, `config/332a`–`332d`.

### history (#264)

`{type: history, entity: sensor.outdoor_temperature, window: 24h, agg: mean, cs: 4}`. At most **6** history tiles per
config (the 7th fails: `At most 6 history tiles`).

| key | values | default |
|---|---|---|
| window | `‹n›m` \| `‹n›h` \| `‹n›d`, 10m–7d (a bare number has no unit and fails) | `24h` |
| bucket | `1m 5m 10m 15m 30m 1h 2h 3h 6h 12h 1d`; divides the window into 2–96 bars | the smallest step giving ≤ 12 bars per column (`cs`); else the dividing step with the fewest bars in 2–96 |
| agg | `mean` (time-weighted) \| `max` \| `min` \| `last` (value at the bucket's end) \| `change` (counters: last minus the value before) | `mean` |
| style | `bars` \| `line` \| `area` \| `step` \| `dots` \| `band` \| `auto`; `band` only with `agg: mean` on a recorder series | `auto`: `line` for `mean`, `bars` otherwise |
| min, max | numbers (negative / decimal allowed), `min` < `max` | bars from 0, the other styles auto-ranged with 10 % padding |
| threshold | number (eink-ha-os#304): a dashed reference line; an auto range widens to hold it; outside a fixed range it is not drawn | none |
| labels | `true` \| `false` (eink-ha-os#304): the max, min and last value printed beside their points (last only away from the other two) | `false` |
| compare | `1d` \| `7d` (eink-ha-os#304): the same window a day / week before, behind the tile's own series; at least the window; recorder series only | none |
| label | text | HA friendly name, else the entity id |

Defaults with `cs: 4`: 1h → 5m, 6h → 10m, 24h → 30m, 7d → 6h; `cs: 2`, 24h → 1h. Buckets align to local time; the last
one is open and holds now. Data: `recorder/statistics_during_period` (`period` 5minute below 1h, hour below 1d, else day;
`types` = the agg, `last` reads `mean`); without statistics (or a bucket under 5m)
`history/history_during_period`, only for windows up to 24 h. Unavailable / unknown = an empty bucket: a gap, never
joined across. Styles (eink-ha-os#304): `area` = the line over a 25 % dither fill down to the plot bottom (1-bit safe); `step` =
a flat run per bucket, joined upright to the next; `dots` = one dot per bucket; `band` = the mean as a line over the
same dither between each bucket's min and max (two more series of the entity, agg `min` / `max`; a lone bucket draws no
band). `compare` fetches the tile's series once more, bucketed at now − 1d / 7d, so its bucket i sits under bucket i:
a 2 px level tick (paper halo) over each bar, else a dashed 2 px line under the tile's line or dots; it widens an auto range, not the low /
high or labels. The latest point gets the big dot in every style but `bars`. The chart prints
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
| past | a `sensor` \| `input_number` \| `number` entity whose recorder history fills the window before now (eink-ha-os#307) | — |

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
| past on a recorder series | `history: past needs an attribute or a weather entity` |
| past not a sensor / input_number / number id | `history: past “‹id›” is not a sensor / input_number / number entity` |
| past with ahead absent, 0 or the whole window | `history: past needs ahead shorter than the window` |

#### past and future in one chart (#307)

```yaml
- {type: history, entity: binary_sensor.rain_expected, attribute: forecast, value: precipitation, past: sensor.rain_rate, window: 3h, ahead: 2h, bucket: 10m, agg: max, style: bars, cs: 4}
```

`window` stays the whole chart and `ahead` its part after now, so 1 h back + 2 h ahead is `window: 3h, ahead: 2h`. The
buckets before the one holding now come from the recorder of `past` (fetched like a recorder tile over `window − ahead`
plus the open bucket, same `agg`, statistics or the history fallback); the bucket holding now and the rest come from the
attribute / forecast. Buckets are matched by start time; a part not fetched yet is gaps. State: data from either part
= drawn; else loading while either loads; else the forecast's verdict (or the recorder's `tooMany` / `needsStats` when
the forecast has nothing). The forecast part is drawn lighter, 1-bit safe, in every style: past bars solid ink, forecast
bars an ink outline; the forecast line / step dashed (6 on, 4 off) and joined to the last past point (step: at the Now
edge), no area fill under it; forecast dots hollow. A dotted vertical Now marker sits at the start of the bucket holding
now. Axis, low / high, labels, threshold and the header value (the bucket holding now) span both parts. Each part uses
one series slot (a tile with `past` counts once toward the 6). Vectors: `history-series.json` `both`, `joinState`.

Reference: `emulator/src/core/history.ts`; vectors: `spec/test-vectors/history-series.json`. The firmware does not read
these sources yet: `firmware/deviations/283-attribute-series.md`.

### weather (#318)

`{type: weather, entity: weather.home, cs: 4, rs: 2}` (full screen) or `rs: 1` (half: the top row only). At most **2**
weather tiles per config (the 3rd fails: `At most 2 weather tiles`); another width fails: `weather: needs the full width (cs: 4)`.

| part | from |
|---|---|
| drawing | the state (HA condition) → 12 drawings: sun (`sunny`), moon (`clear-night`), partly (`partlycloudy`), cloud (`cloudy`, any unknown text), fog, rain (`rainy`), pour (`pouring`), snow (`snowy`), sleet (`snowy-rainy`, `hail`), thunder (`lightning`, `lightning-rainy`), wind (`windy`, `windy-variant`), alert (`exceptional`) |
| temperature, "feels" | attributes `temperature`, `apparent_temperature`, rounded to whole degrees |
| condition name | the state in the display language (an unknown condition as HA sent it) |
| high / low | the daily forecast entry dated today (local): `temperature` / `templow`; none → “—” |
| wind | `wind_speed` rounded in `wind_speed_unit` (`Beaufort` → “4 Bft”), then `wind_bearing` on 8 points (degrees, or a short text as is) |
| rain | the hourly forecast, the next 12 h: the first entry with `precipitation` > 0 (without it: a rain / snow / thunder condition) → “from 15:00”; the hour holding now → “now”; none → “none soon” |
| 5-day strip | the next 5 daily entries after today: short weekday, drawing, high / low, `precipitation` (“dry” under 0.05, one decimal under 1, else whole, in `precipitation_unit`) as a bar scaled to the wettest day, at least 10 mm (0.4 in) |

Forecasts come from `weather.get_forecasts` (`type: daily` and `type: hourly`, `return_response`), asked again after an
hour, not on every wake. Kept: 7 daily entries from today, 16 hourly from the hour holding now (an entry without a valid
`datetime` is skipped; numbers to 2 decimals). Unavailable / unknown: the gap ring and word. Reference:
`emulator/src/core/weather.ts` (firmware `core/weather.cpp`); vectors: `spec/test-vectors/weather.json`.

### agenda and next (#316)

`{type: agenda, entities: calendar.family calendar.work, cs: 2, rs: 2}` and `{type: next, entities: calendar.family, cs: 2}`.
`entities` = 1–4 calendar entities, space-separated (picked like a list tile's entities). At most **4** agenda / next
tiles per config. Tiles with the same calendars (sorted, without repeats) share one fetch.

- Data: `calendar.get_events` with `return_response` (HA 2023.12+) over the WebSocket, one call per calendar set, for
  local midnight today to 7 days later; asked again every 30 min and when the local day changes. At most **12** events
  are kept per set (earliest first: start, all-day first, end, calendar, title), each title at most 48 UTF-8 bytes (cut
  on a character boundary; control characters become spaces, outer spaces trimmed). An event with a date-only start is
  all day.
- agenda: a day header ("Today · Wed 28", "Tomorrow · Thu 29", "Fri 30") then its events (time, "all day", or
  "–10:00" for one that began on an earlier day); ended events drop out as time passes; 4 lines (headers + events) on
  one row, 11 on two; "+N more this week" counts what does not fit.
- next: the first timed event not ended: its title, "08:30 – 09:15" and a pill: "Now" while it runs, "in 48 min" under
  an hour, "in 3 h" later today, "Tomorrow", else the short day name.

Reference: `emulator/src/core/agenda.ts` (firmware `core/agenda.cpp`); vectors: `spec/test-vectors/agenda.json`.

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
| stat/gauge/switch/route/history/media/weather entity bad id or domain | widget | `‹type›: “‹entity›” is not a ‹d1 / d2 / …› entity` |
| lightList `areas` item not an area id | widget | `lightList: “‹id›” is not an area id` |
| lightList / zoneList `entities` item not a light / climate entity_id | widget | `‹type›: “‹id›” is not a ‹light \| climate› entity` |
| zoneList `labels` item not `climate.<id>=Name` | widget | `zoneList: “‹item›” in labels is not climate.<id>=Name` |
| media `favorites` item not `Name=type:id` / `Name=script.<id>` / `Name=scene.<id>` | widget | `media: “‹item›” in favorites is not Name=type:id or Name=script.<id> / scene.<id>` |
| media more than 6 favorites | widget | `media: at most 6 favorites` |
| route `mode` not train / bus / car | widget | `route: mode must be train, bus or car` |
| bins `entities` item not a sensor entity_id | widget | `bins: “‹id›” is not a sensor entity` |
| bins `labels` item not `sensor.<id>=Name` | widget | `bins: “‹item›” in labels is not sensor.<id>=Name` |
| bins more than 6 `entities` | widget | `bins: at most 6 sensors` |
| bins `tonight` not a whole hour 0–23 | widget | `bins: tonight must be an hour 0–23` |
| guestWifi `password_entity` not an input_text / text / sensor entity_id | widget | `guestWifi: password_entity is not an input_text / text / sensor entity` |
| guestWifi `security` not WPA / WEP / nopass | widget | `guestWifi: security must be WPA, WEP or nopass` |
| guestWifi `hidden` not true / false | widget | `guestWifi: hidden must be true or false` |
| attrList `attribute` / `title` / `time` not a field name | widget | `attrList: ‹key› must be a field name (letters, digits, _)` |
| attrList `subtitle` empty or not field names | widget | `attrList: subtitle must be field names (letters, digits, _) split by spaces` |
| attrList more than 3 `subtitle` fields | widget | `attrList: at most 3 subtitle fields` |
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
| agenda / next without `entities` | widget | `‹type›: pick at least one calendar` |
| agenda / next `entities` item not a calendar entity_id | widget | `‹type›: “‹id›” is not a calendar entity` |
| agenda / next more than 4 calendars | widget | `‹type›: at most 4 calendars` |
| 5th agenda / next tile | widget | `At most 4 agenda or next tiles` |
| any other line | that line | `Can’t read this line` |
| no screens | 1 | `No screens found` |
| duplicate screen id | `- id:` (last with that id) | `Duplicate screen id “‹id›”` |
| more than 8 cells | screen `- id:` | `“‹title›” uses ‹n› of 8 cells` |

Plus the apps rules above. Widget checks run in table order; `cs: 0`/`rs: 0` count as unset.
Reference implementation: `parseYaml()` in `emulator/src/core/config.ts`; test vectors:
`spec/test-vectors/config/*.json` (apps: `33`–`39`; routes: `22`, `50`–`52`; built-in Settings: `53`–`57`; bins: `90`–`94`; guestWifi: `329a`–`329d`; attrList: `332a`–`332d`).

# settings.json (device settings)

Not a file you write: the display keeps `GET/PUT /api/v1/settings` `display` in `/settings.json` (firmware
`net/storage.cpp`) with a `schema` number. A boot upgrades an older file one step at a time and keeps every key it does
not own, so an OTA rollback still reads it (rules: `emulator/src/core/migrate.ts`, vectors
`spec/test-vectors/migrations/*.json`).

| schema | change |
|---|---|
| 0 → 1 | files from before versioning (eink-ha-os#12): only stamped |
| 1 → 2 | quiet hours (eink-ha-os#295): new key `quiet` (`off` or `HH-HH`) from `night` when that held a window, else `23-07` (on, also for existing installs). `night` stays in the file for a rollback but is no longer read or served. `powerSave: night` ("Sleep at night") becomes `glance`. A `quiet` key already in the file wins. |

A `screens.yaml` from before eink-ha-os#295 may still hold a Settings tile `{type: setting, key: night}`: like every system tile
it is checked and dropped (see "Settings is built in").
