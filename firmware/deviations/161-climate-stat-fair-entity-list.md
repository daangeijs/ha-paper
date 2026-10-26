# Climate / weather stat tiles, list tile values, a fair 800-entity list (issue #161, #150)

- A stat tile takes `climate.*` and `weather.*` (core/config.cpp, emulator core/config.ts). It shows the temperature,
  not the HVAC state: climate → `current_temperature` in °C (HA sends no unit for climate; the display assumes °C like
  the thermo tile), weather → `temperature` in `temperature_unit` (kept at ingest now, absent = °C). No temperature →
  "—". One rule, `statSource` (emulator core/format.ts, firmware core/home.cpp), spec/test-vectors/stat-raw.json.
- GET /screens/{id}/values gives zoneList / lightList a count instead of "": "2 of 3 heating" (new string `nOfHeating`),
  "4 of 9 lights on" (`lightsOnOf`), "—" when the list shows nothing. Counts follow the tile's picks.
- GET /ha/entities: the old template sorted by entity_id and stopped at 800, so on the real-shaped house 67 of 122
  switches were cut, and `weather.*` was never in the list's domains. Now each domain first gets a budget of pickable
  entities (climate 50, weather 10, light 100, switch 100, input_boolean 30, input_number 30, fan 20, binary_sensor 60,
  number 30, sensor 370 = 800), then pickable entities past their budget fill the room left, then unavailable / unknown
  entities and sensors that are no reading (no unit, `device_class: signal_strength`). HA renders it
  (net/ha_client.cpp); the fake HA and device-sim use the same rule in emulator core/entityList.ts. HA has no
  `entity_category` in templates, so "diagnostic" is approximated by unit and device class.
- The template answer is `{"t": count, "e": rows}`; the response adds `lists.entities` {total, shown}; the console's
  entity picker says "Showing 800 of 868 Home Assistant entities, the most useful first" when cut. A climate / weather
  row carries its temperature as `state` with unit °C (the picker showed "auto").
- Real-shaped house (fake HA, TypeScript mirror): template answer 72 490 → 71 606 B, device JSON 98 578 → 97 801 B;
  868 entities in the list's domains, 800 sent, the 68 left out are all unit-less sensors or unavailable / unknown.
