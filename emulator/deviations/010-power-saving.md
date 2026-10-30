10. **Power saving and deep sleep** (docs/ROBUSTNESS_PLAN.md Phase 3.1; not in Main.dc.html). `src/core/power.ts`
    `powerDecision()` is the spec, checked by `spec/test-vectors/power/*.json` (the firmware runs the same files).
    - Settings (GET/PUT `/settings` `display`, eink-ha-os#10): `powerSave` ("On battery": Glance / Sleep at night / Standby +
      night / Always live = `glance | night | standby | off`, default `glance` per eink-ha-os#18), `wakeEvery` ("Check every":
      15 / 30 / 60 min) and `liveMin` ("Live after a press": 1 / 3 / 5 / 10 min, default 3). New keys with defaults, no
      schema bump (migrate.ts rules). The default config has a `power` screen ("Power", Settings app, after Display
      style) with the three tiles; so does the firmware's.
    - Glance (`src/core/glance.ts`, `spec/test-vectors/glance.json`, `power/09-glance.json`): on battery, without a key
      press for `liveMin` minutes, the display deep-sleeps with the dashboard on the panel (no standby face, no footer,
      clock frozen) and wakes every `wakeEvery` minutes without a boot screen: one HA sample, `snapshotDiff()` of the
      region hashes against the snapshot taken when it went to sleep (clock tiles ignored), a full refresh only when
      `glanceStep()` says so (changed, first, back online, or unchanged for 60 min), then sleep again. HA unreachable:
      no redraw, the wait doubles per failed wake (cap 2 h), the 3rd failure draws the offline mark once. Power or Right
      wakes into live mode (a reset with the boot screen); Right pressed on the boot screen keeps it live 10 min. The
      emulator's wake is instant (the firmware's 20 s cap and Wi-Fi fast join are device-only).
    - First-boot safety: `armBootsLeft` (no deep sleep until 3 confirmed boots of this version). The emulator plays an
      installed display (`armLeft = 0`); the Diagnostics card shows "Glance armed" / "Glance armed after N more boots"
      from `GET /diagnostics` `deep_sleep`. The device simulator reports armed.
    - Boot ring: a DEEPSLEEP boot right after another DEEPSLEEP boot replaces it (`core/diag.ts`), so wakes never
      push a crash out of the 8 kept boots.
    - Device state `asleep` (deep sleep), separate from `sleeping` (the standby face). Asleep, the panel keeps the face it
      showed (standby or night) with the clock frozen and the footer "Asleep · wakes HH:MM · press power" ("Asleep ·
      battery low · charge or press power" below 5 %). No data ticks, no clock redraws, touch and Left / Home are ignored.
      Power, Right (`BTN_NEXT`), the wake timer or Simulation › Plug in USB wake it; a wake is a reset: "Connecting…",
      then a full refresh (a timer wake from standby returns to the standby face).
    - The emulator checks the rules every second and waits 5 s after a boot, wake or key press before sleeping
      (`AWAKE_MIN_MS`, emulator pacing, not part of the spec).
    - While asleep the web console can't reach the display. Console requests other than the state poll count as API
      use (no sleep for 2 min).
    - Device simulator: `POST /__sim/control` takes `usb` (plugging in wakes it), `sleep` (409 "stays awake: <reason>"
      when the rules forbid it, with power saving taken as Standby + night), `wake` and `api_idle`. While asleep it
      closes every connection except `/__sim/*`. `GET /status` has `power` (3.0 instrumentation; `mode` is always
      `awake` there, like the firmware).
