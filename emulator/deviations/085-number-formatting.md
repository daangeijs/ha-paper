# Number formatting (issue #85)

- `core/format.ts` `fmtValue` / `fmtNum` / `kw` are the spec (`spec/test-vectors/format.json`). The mock HA has
  `display_precision` only on `sensor.outdoor_humidity` (78.4 % shown as "78", `EXTRA_ENTITIES[].dp`); the fake HA
  answers `config/entity_registry/get_entries` with it. Mock logical entities (power, kWh) have none, so they always
  show the unit default; the firmware also honours their source entity's precision (firmware/DEVIATIONS.md).
