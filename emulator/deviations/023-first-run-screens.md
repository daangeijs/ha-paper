14. **First-run screens from the user's HA** (issue #23, not in the handoff). The default screens are the owner's house
    (Dutch routes, tado, `sensor.living_temperature`); a stranger saw "—" everywhere. Now the first HA link of a display
    without saved screens (`screensSaved: false`; firmware: no `/screens.yaml` in userdata) builds them from that HA:
    `seedConfig()` in `src/core/seed.ts` reads the Energy dashboard, one `render_template` (`SEED_TEMPLATE`: areas,
    climate ids, lights + area, temperature / humidity sensors + area, `sensor.x4_route_*`, which logical ids exist)
    and the logical ids that have a mapped source, and only makes tiles that have data. Apps without screens are left
    out (`apps:` is written). Saved once; unlink / re-link keeps them; factory reset seeds again. Vectors:
    `spec/test-vectors/seed.json`. The demo keeps the old screens: the emulator UI and the device-sim `installed`
    preset (`never-linked` / `first-install` seed on link). The device-sim maps logical ids only from the Energy
    dashboard's power sensors and price entity (`aliasesOf()` in `server/device.ts`; home use = grid when grid is the
    only source); the firmware's device discovery and recorder statistics are not simulated. No weather tile: there
    is no weather widget, an outside temperature sensor stands in.
