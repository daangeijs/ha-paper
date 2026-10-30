# List from attributes tile: ingest cap and redraw (issue #332)

- The HA stream keeps an attrList tile's attribute only for that tile's entity (`setListAttrs`, plus `attribution`),
  and only the first items while there are at most 10 and the JSON stays within 3072 bytes (`capListText`); the rest is
  dropped at ingest. The emulator's demo sensor sends 7 sightings, so the cap never shows there; the device-sim applies
  `capList` before formatting `GET /screens/{id}/values`. The recipe's sensor sends at most 10 (about 1 KB).
- The rows are parsed with core/json on every draw from the EntityStore (no cache). "N min ago" changes the region
  signature, so a list tile with a sighting under an hour old redraws once a minute, like the agenda countdown.
- The emulator has attributes only for its demo sensor (`sensor.rare_birds_nearby`, data.ts demoBirds); any other
  entity shows "Nothing to show". The firmware reads any sensor's list.
