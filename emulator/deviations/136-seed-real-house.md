# Seed picks on the large example house (issue #136)

- Chip temperatures are not temperatures: a sensor with `device_temperature` / `device temperature` in "entity_id name"
  is left out of the template answer (Zigbee2MQTT's diagnostic entity). HA's `entity_category` would be the cleaner
  test, but it is not in a template's state object (only in the entity registry), so the seed goes by name. On the
  large example house inside was `sensor.aquarium_device_temperature`, outside a garden plug's chip ("outdoor").
- Day words are whole tokens (`[^a-z0-9]` separates): `today`, `vandaag`, `daily`, `dag`, `day`. `…_last_seven_days`
  and `dagelijks` no longer count as energy-today. Template: `n | regex_search(…)`.
- Imported / exported today: the grid's `flow_from` / `flow_to` meters go through the device-prefix rule (≥ 2 shared
  words) before name words. Envoy is a solar word (so its consumption is no grid import); Envoy / Enphase are home
  words for home power (Envoy-S Metered `current_power_consumption`), `produc` is a solar word and bad for home.
  `electricity_meter` (DSMR's device name) is a grid word.
- Vehicle climate: the template splits `states.climate` into `climate` and `vehicles` (a climate on a device that has a
  `device_tracker`, e.g. a Tesla). With a vehicle the seeded zoneList names the other climates in `entities` (the
  zoneList default is every climate); only vehicles = no Heating screen. A zone added in HA later is not on that
  zoneList until the user picks it.
- Answer size: one-phase power sensors (`phase`, `fase`, `_l1/2/3`, bad for every power role) are not sent, and the
  area is only sent for temperatures (the only rows the seed groups by area). Large example house 18 859 → 14 120 B; the
  synthetic big house (all caps full, long names) stays at 20.7 KB.
- `koelkast`, `vriezer`, `pomp`, `pump` are not rooms.
