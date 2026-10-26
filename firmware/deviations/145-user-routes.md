# User-defined routes (issue #145)

- `core/catalog` has no route list; `parseConfig` accepts any route with an optional `sensor.*` entity and checks
  `mode` (train / bus / car). The route tile (`ui_tiles.cpp`) reads only its widget: title = `label`, else the entity's
  friendly name, else "Route"; data from `routeState()` (`core/home`) on the entity; footer from the entity's `note`
  or the generic severity strings. No entity: "Pick a sensor for this route"; `unavailable` / `unknown`: the #86 gap ring
  and word. A car sensor without `typical` shows the minutes without badge (the catalog's 21 min default is gone).
- `HomeData::routes` is gone; the Home Assistant page counts route tiles whose sensor HA reports.
- `EntityAdapter`: logical ids are the fixed ones only. An unmapped `sensor.x4_route_*` now passes through under its own
  id (it is a route tile's entity); older settings overrides for those ids still map.
- `kDefaultYaml` drops the Travel screen and gains `apps:` (home, house, settings), matching spec/default-screens.yaml.
  Host tests that opened Settings as app 4 now open app 3; the travel render uses `demo::travelYaml()`.
