# History tile series from an attribute or a weather forecast (issue #283)

- The emulator (spec) charts a list in an entity attribute (`attribute`, `value`, `time`, `ahead`) and a weather
  entity's `weather.get_forecasts` answer (`forecast: hourly | daily`) on the history tile; vectors in
  `spec/test-vectors/history-series.json`. The firmware does not support these yet (follow-up issue): its
  `core/config.cpp` still rejects a history tile on a `binary_sensor.*` / `weather.*` entity with the recorder's domain
  message, and a `sensor.*` tile with `attribute:` passes its config check but is fetched from the recorder. The
  firmware suite does not read `history-series.json` until then; `history.json` is unchanged.
- Needed on the device: `keepAttr()` must keep the configured attribute (a list up to ~49 entries) for the tile's entity,
  `core/history` gains `parseTime` / `attrSamples` / `fromSamples` and the `aheadMs` span / axis, and `net/` a
  `call_service` with `return_response: true` for `weather.get_forecasts`, refetched on the history timer.
- The device simulator (`emulator/server/device.ts`) already reads both sources (one `get_states` for attribute series,
  one `weather.get_forecasts` per forecast tile) so `make qemu-contract` can compare once the firmware has them.
