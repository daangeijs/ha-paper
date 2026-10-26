# User-defined routes, no demo data in shared code (issue #145)

- Routes are the user's own tiles: `{type: route, label, mode: train|bus|car, entity: sensor.*}` (spec/SCHEMA.md
  "route sensors"). The route catalog (`ROUTES` in `core/data.ts`, with place names and notes) is gone; `route` is an
  optional free id. Old catalog ids parse as an empty route; `entityIssue` ("Pick an entity below.") blocks a console
  save until a sensor is picked (vector `51-legacy-route`).
- Default screens: no Travel screen, and an `apps:` section (home, house, settings) so the app switcher has no empty
  Travel app. Seeded configs already dropped unused apps.
- The emulator's demo Travel screen and its mock timetables moved to `src/emulator/demoTravel.ts` (showcase only). Its
  widgets are shaped like real user routes (label + mode + `sensor.demo_route_*`); a user route without demo data shows
  the "no data" state.
- Console: one empty "Route" palette item with a Kind selector (train / bus / car) and the entity picker; "Sensor
  value", "Switch" and "Light" start without an entity; the "Living (tall)" thermo item is gone (no zone picker yet).
  Palette group `tado` → `climate`. Data sources lists no routes (older `sensor.x4_route_*` overrides still map).
- Seed: a route tile for every `sensor.x4_route_*` in HA or mapped, sorted by id, at most 4, `mode: car` when the
  sensor reports `min`; the title is the sensor's friendly name.
- Integration-neutral strings: `useHeatSrc`, `useTravelSrc`, `noHaClimate`, `noHaTravel`, `srcIntro`; route footers are
  generic per severity (`routeNote1`–`4`, `carNote1`–`4`, `perHour`); `hintCar` / `hintTransit` removed.
