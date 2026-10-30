# Real-house tile fixes: forecast, fitting values, quarter-hour price, zone names (issue #151)

- Solar today: the forecast line ("Of X kWh forecast") needs a real `forecast` attribute on the mapped
  `sensor.solar_hourly`. The old fallback summed the hourly series; that series comes from HA statistics and is today
  *so far*, so the line repeated the total. No forecast attribute = no line (core/home.cpp deriveHome).
- Stat tiles fit value + unit: a value that does not fit drops decimals first (`fewerDecimals`, core/logic.cpp,
  spec/test-vectors/format.json), then Classic steps the value size 50 → 44 → 40; the unit is cut only when an integer
  still does not fit. "28.30 kWh" (HA display_precision 2) drew as "28.30 kW"; now "28.3 kWh". GET /values keeps HA's
  precision ("28.30 kWh"); only the panel rounds. Sleek's stat card does the same before its value is cut.
- Prices: a quarter-hourly source (96 numbers in `today`, or `raw_today` entries starting at :15/:30/:45) gets an extra
  logical attribute `quarters` (96 × €/kWh, core/entity_map.cpp priceSeries). "Now" (price tile, price bars summary,
  Sleek price card, standby face, GET /values) is this quarter-hour's price (`HomeData::priceAt`); the 24 bars and the
  cheap/high tags stay hourly averages. Before, the tile showed the hour's average (€0.42 next to a current-price
  sensor at €0.43). `quarters` is parsed without a JSON DOM into a fixed 96 × int32 array (no heap per redraw).
- Battery sign: the logical `sensor.battery_power` is + = charging (HA's Energy dashboard: + = discharging, so a
  `stat_rate` from the Energy dashboard is negated; a manual override takes "-sensor.x" to flip). The battery stat tile
  and the gauge show the power unsigned with the direction in words ("Charging" / "Discharging"), so the sign never
  shows. A stat tile on the raw HA entity shows HA's number as is, sign included; it is not inverted.
- Zone names that do not fit keep their last word: "Bathroom attic" → "Bath… attic" next to "Bathroom"
  (`fitKeepTail`, core/logic.cpp), in Classic and Sleek zone lists. A zoneList can rename rooms:
  `labels: climate.bathroom_attic=Attic; climate.bathroom=Downstairs` (core/config.cpp labelPairs, applied in pickZones).
- New config or data source: the display draws store changes at once (at most once a second) for 15 s after a config
  apply or a PUT /settings `entities`, until no tile on the page shows "—"; then back to the Live data interval. Before,
  the new entity's state landed a moment after the full redraw and waited up to the interval (10–30 s). The connect
  case uses the same window (2 s delay, 10 s).
- App switcher open: the pager shows no page position (Classic: no "3 / 3"; Sleek: no current dot).
- Not done: GET /screens/{id}/preview.png still returns the current panel for any known screen (`X-X4-Preview:
  current-panel`); rendering another screen off-screen needs a second 96 KB frame (PSRAM) and an ask/answer between the web and
  the App task (follow-up: done in eink-ha-os#168, see 168-preview-off-screen.md).
