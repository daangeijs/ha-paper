# First-run screens name real HA sensors (issue #82)

- Item 14 changed: the seed no longer writes logical ids because a source "exists". On the first real HA (800
  entities) `sensor.solar_power`, `home_power`, `grid_power`, `energy_today`, `solar_today` were written, none existed
  there, and 7 of 10 tiles showed "—"; the gauge got a kWh capacity. Now every stat / gauge entity is a sensor from
  the template answer (HA's state list). Per role: the logical id if HA has it, then the Energy dashboard (the
  source's `stat_rate`, else the sensor sharing the longest entity-id prefix with its meters, ≥ 2 words), then
  device_class / unit + name words (English and Dutch). Charge % prefers device_class battery. No match = no tile.
- `SEED_TEMPLATE` now returns `[id, device_class, area, name, unit]` for temperature (available, ≤ 60), power
  (≤ 100), energy-today (≤ 40) and charge % (≤ 60) sensors; humidity and `present` are gone. Today tiles come only
  from a daily HA sensor (e.g. "Zon vandaag"); the recorder-derived logical ids (`sensor.energy_today` …) are not
  seeded. Charts stay (no entity). The Energy screen is not made for home use alone.
- Grid only (no solar or battery anywhere): the grid sensor is the "Home use" tile (was: home and grid tiles, both
  the same P1 sensor).
- Fake HA houses `dutch` (no Energy dashboard: `energy/get_prefs` fails with HA's `No prefs`) and `dutch-energy`
  (meters only) in `server/fake-ha-dutch.ts`; `GET /__fake/entities`; the fake's `states.<domain>` runs in entity_id
  order like HA. `sim/qemu/contract.sh` takes `FAKE_HA_HOUSE` and `X4_VITEST_ARGS`.
- The name rules are guesses checked against one real house and the fixtures. Real HA has not rendered the new
  template yet.
