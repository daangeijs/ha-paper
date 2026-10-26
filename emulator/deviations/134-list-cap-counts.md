# Subscription cap counts in GET /ha/entities (issue #134)

The firmware subscribes to at most 80 climate + light entities (climate first, `kMaxWatched` in `core/home.h`), so an
unpicked lightList in a big house shows only part of its lights. GET /ha/entities now reports `lists`
(`{climate, lights}: {total, shown}`, emulator `core/paging.ts` `listCounts`), and the console says "Showing 66 of 149
lights — pick rooms to choose which" on the tile and in the list picker.

- The device-sim keeps its unfiltered subscription (every `light.*` / `climate.*`) and does not apply the cap; it only
  reports the counts the firmware would, from HA's `get_states` when the entity list is read.
- The in-browser emulator reports the counts of its mock house (14 climate, 16 lights: nothing hidden).
- The firmware reports `lists` only with `ready: true`; the counts come from the latest discovery answer, not from the
  cached (5 min) entity list.
