18. **Scheduled clean instead of every 8 partials** (issue #26; the handoff flashed after `fullEvery` partials). With the
    clock known a partial never forces a full. `cleanDue()` (`src/core/refresh.ts`) turns the minute tick into one full
    refresh ("clean screen") at the first :00/:30 at least `cleanEvery` minutes after the last full, only if a partial
    was drawn since and never while night mode is active (standby keeps it). User actions, wake, night end and a style
    switch flash as before. Settings › Clean screen now steps `display.cleanEvery` (30 min / hourly / every 2 h, default
    30); the screens.yaml tile key stays `fullEvery` (`SETTING_CFG` maps it). `display.fullEvery` is legacy: validated,
    stored and served, no effect (migrate.ts: never change a key's meaning). Clock unset: `CLEAN_CAP` = 30 partials force
    a full; the emulator always has a clock. The side panel shows partials since the last full and the next clean time.
    The device-sim (`server/device.ts`) has no minute tick, so it never runs the scheduled clean. Vectors:
    `spec/test-vectors/refresh.json`.
