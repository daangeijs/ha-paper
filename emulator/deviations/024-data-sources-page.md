16. **Data sources page** (issue #24, not in the handoff). Web console tab "Data sources" (`pages/SourcesTab.tsx`):
    every logical id (`src/core/entityMap.ts` = firmware `fixedLogical()` + the catalog routes) with its resolved
    source from `GET /settings` `entity_sources` (Energy dashboard / device / same id in HA / manual / none), an HA
    entity search (`GET /ha/entities`, sensor / input_number / number; any valid id can be typed) and a sign toggle
    for the four power ids. Saves with `PUT /settings` `entities` right away, like the Display card; no API change.
    The device-sim now implements `entities` (same merge rules and 422 messages as the firmware, kept in the state
    file) and `entity_sources` (override > Energy dashboard > identity, formatted like `HaClient::publishSources()`).
    It reports the firmware's negated Energy-dashboard battery sign (`-sensor.x (energy)`) but, as before, does not
    apply it to the value; overrides with "-" are applied. The in-browser emulator only stores the overrides: its mock
    HA already carries every logical id, so the screens do not change.
    Since eink-ha-os#191 the page is gone: each tile's source sits in the screen editor ([191](191-console-layout.md)).
