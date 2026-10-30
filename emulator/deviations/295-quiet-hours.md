# Quiet hours replace night mode and "Sleep at night" (issue #295)

Daan's decision on eink-ha-os#294 (option B). The handoff's night mode (SPEC §8: Display › Night mode, a night face with a big
clock and Inside / Battery / Cheapest frozen at night start, front light off, a key = 60 s peek) and the Phase 3
power mode "Sleep at night" are one setting now: Settings › Power › **Quiet hours** (`display.quiet`: off / 22–06 /
23–07 / 00–06, default 23–07). Rules: `src/core/quiet.ts`, vectors `spec/test-vectors/quiet.json`, `power/07-quiet-end.json`,
`refresh.json`, `frontlight.json`, `migrations/07-settings-quiet-hours.json`.

- The quiet face replaces the night face: "Back at 07:00" (the window end, 12-hour like the clock), the date, and the
  first three value tiles (stat, gauge, price, thermo) of the Home page with their tiles' labels and values, frozen when
  the face goes up; "as of HH:MM" only when the data was stale. No clock: on battery the panel keeps the face through
  a deep sleep, and a minute clock froze at 23:05 all night.
- Inside the window the face draws nothing more: no data, no minute tick, no scheduled clean (before, the clock ticked).
- On battery Glance and Standby sleep to the window end with no timer wakes (a due 03:00 install still wakes it);
  Always live stays awake. On USB the device stays live with the quiet face up.
- The front light is no longer forced off: it follows the light timeout. A press on the quiet face is not consumed by
  the light, it shows the dashboard.
- Standby inside the window shows the quiet face (before: the standby face). Power on the quiet face (or in standby
  inside the window) shows the dashboard for 60 s; Power while peeking goes to standby = the quiet face.
- A boot opens on the dashboard for 60 s unless a timer woke it: a button or charger wake, a power-on, a power-on after
  a Power hold. Set whatever the hour (the firmware may not know the time yet).
- Setup is never covered by the quiet face.
- `powerSave: night` is gone (`off | standby | glance`); "Standby + night" is "Standby". Settings schema 2 moves
  `night` to `quiet` and "Sleep at night" to Glance (spec/SCHEMA.md). PUT `display.night` → 422 unknown key.
- Settings › Display lost its night tile (7 tiles); Settings › Power: On battery (2×2), Quiet hours (2×1), Check every,
  Live after a press (1×1 each, no hint line any more). Settings › Updates › Automatic "Night" reads "Install" (the
  03:00 install hour is not quiet hours; the API value stays `night`).
