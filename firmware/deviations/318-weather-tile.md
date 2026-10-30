# Weather tile: forecast fetch, RTC cache and drawings (issue #318)

- The emulator (spec) draws `weather.home` from a demo forecast in `core/weather.ts` (`demoWeatherForecast`,
  `DEMO_WEATHER_ATTRS`); other weather entities show no forecast there. The firmware asks HA `weather.get_forecasts`
  (`type: daily`, then `type: hourly`, `return_response`) per weather entity, streamed through `hist::ListScanner` into
  12-byte entries (`core/weather.cpp`). The device simulator (`server/device.ts`) does not ask for forecasts.
- Forecasts are asked again after an hour (`wx::kRefreshMs`); a failed or over-cap answer keeps the last good list and
  is asked again after 10 min. Both lists of up to 2 entities (`wx::Rtc`, 632 B) live in RTC_NOINIT memory, so a glance
  wake within the hour draws them without a request; after power-on the record's checksum fails and they are asked.
- Before the first daily answer the strip shows "No forecast" (no separate loading state).
- Drawings: one source, `emulator/src/core/weatherArt.ts`; `npm run vectors` writes `firmware/assets/weather-icons.json`
  and `tools/icongen.py` rasterises 12 × 44 px and 12 × 120 px 2 bpp bitmaps (49 KB flash). The emulator draws the same
  layers as SVG; anti-aliasing differs at the edges.
- The weather tile is not in the Values view (`tileValue` ""), like the history tile.
