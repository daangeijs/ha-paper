# Clock time zone and price currency from Home Assistant (issue #147)

- `PUT /settings` `tz` now takes `""` (follow Home Assistant, the new default), a zone name from the table in
  `src/core/locale.ts` (`spec/test-vectors/locale.json`), or a POSIX string. GET adds read-only `tz_ha` and
  `tz_active`. The 422 text changed to name all three forms.
- The device simulator applies HA's `time_zone` and `currency` like the firmware and reports them, but still draws its
  clock in the host's time zone. The in-browser emulator keeps `tz` (sim HA zone fixed at Europe/Amsterdam) and also
  draws the browser's time.
- The in-browser emulator's side panel steps HA's currency through EUR, USD, GBP, SEK; price tiles, the price stat
  tiles (lowest/highest/cheapest 3 h) and the standby price follow it.
- The fake HA's get_config returns `time_zone` and `currency` (stranger house: Europe/London, GBP; the rest
  Europe/Amsterdam, EUR); `POST /__fake/language` also takes `time_zone` and `currency`.
