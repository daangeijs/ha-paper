# One number formatter, HA display_precision (issue #85)

- Every value goes through `core/logic` `fmtValue` / `fmtNum` / `kw` (emulator `core/format.ts`, vectors
  `spec/test-vectors/format.json`): HA `display_precision` first, else W 0, kW 2, kWh 1, % 0, °C/°F/V/A 1, else up to 2
  decimals trimmed. Before: W rounded to 50 W, kW to 0.1, any other entity kept HA's state text unless it had ≥ 2
  decimals (so "390.0" stayed "390.0" while the power tile showed "400 W").
- The 50 W rounding was there against e-ink churn. Redraws are now decided by a deadband instead (`powerMoved`,
  `PowerHold`, `spec/test-vectors/deadband.json`): a power value is taken only when it moved ≥ 50 W and ≥ 5 % of the
  shown value, or crosses W ↔ kW; until then the tile keeps the last shown value. Applies to the four logical power
  fields (`App::Impl::derive`) and to stat tiles of any W/kW entity (`App::Impl::statEntity`; the emulator mock has
  none). Other units redraw when the formatted text changes.
- `display_precision` is not in HA's state attributes: `HaClient` asks `config/entity_registry/get_entries` once per
  `subscribe_entities` chunk and hands `options.sensor.display_precision` (else `suggested_display_precision`) to
  `EntityAdapter::setPrecision`, which adds it as attribute `display_precision` to the entity's values (an attribute
  HA sends itself wins; `keepAttr` keeps it). An HA without the command answers an error; tiles then use the unit
  defaults.
- Logical tiles: a power tile uses its source's precision only when the source is a single entity in W (no kW/MW
  conversion, no `stat_rate_from − _to`); the kW form (≥ 1000 W) always uses 2 decimals. kWh/°C logical tiles use the
  precision of their source entity, except "today" values computed from recorder statistics (unit default). The emulator's mock logical entities have no `display_precision`.
- Not routed through it: prices (money, always 2 decimals: "€0.20"), gauge rings (whole percent of a 0–100 ring),
  the climate setpoint sent to HA.
