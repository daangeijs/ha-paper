# History tile series from an attribute or a weather forecast (issue #283)

- The emulator (spec) charts a list in an entity attribute (`attribute`, `value`, `time`, `ahead`) and a weather
  entity's `weather.get_forecasts` answer (`forecast: hourly | daily`) on the history tile; vectors in
  `spec/test-vectors/history-series.json`. The firmware runs them since eink-ha-os#292; what still differs is in
  `292-forecast-on-device.md`.
