# Tile labels, thermo zone, away presets, no climate.living guess (issue #148)

- `label` now replaces the built-in title of price (Classic "Price", Sleek "Power price"), bars (the series title) and
  the home battery gauge (Classic "Home battery"; Sleek already did). Route and thermo already honoured it. A thermo
  without `zone:` (the console palette adds one empty) draws "Room" (or its label) and "—"; − / + do nothing.
- A thermo's zone is subscribed explicitly (`climate.<zone>` in DeviceServices::entityIdsOf, like the device sim), so
  it no longer depends on the 80-entity climate + lights cap.
- "{} kWh so far" goes through the strings table (`soFar`) on Classic and on Sleek's usage chart: Dutch "kWh tot nu".
- Away: the climate attr `preset_modes` is kept at ingest (ha_stream keepAttr). The zoneList's away button (Classic
  button, Sleek pill) shows only when at least one climate entity lists `away`, and `climate.set_preset_mode` goes to
  those zones only. Before, every zone got it and the button showed on houses without any away preset.
- `sensor.living_temperature` no longer falls back to `climate.living` (home.cpp statText, night snapshot): unmapped =
  "—". The seed maps the inside thermometer; the Data sources tab sets it by hand.
- Emulator: the mock's inside temperature is still the living zone (it stands for a mapped thermometer); the mock
  garage has no presets, and the away rule counts the zones the zone-count slider shows.
