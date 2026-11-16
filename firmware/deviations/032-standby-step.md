# Standby step between live mode and deep sleep (issue #32)

- ha-paper#32 (Daan). On battery, glance now has three steps: live for `standbyAfter` minutes after a key or touch
  (1 / 3 / 5, default 1), then the standby step for `deepAfter` minutes (5 / 15 / 30 / 60 / 0 = never, default 15),
  then deep sleep as before. Rules: `core/power` `glancePhase` + `powerDecision` `lightSleepS` (reason "light sleep"),
  vectors `standby-step.json` and `power/11-standby-step.json`. Quiet hours, low battery, setup, OTA, USB and the
  03:00 install window win over the step; a timer wake from deep sleep never enters it (no press since the wake).
- The step reuses the glance sleep face (with the battery line), drawn once on entry; going on to deep sleep keeps the
  same face, so that costs no refresh. Front light off (`App::nap`). The display standby setting (`standby`, 10 to 60
  min) and powerSave standby are unchanged; the Power key still toggles the standby face outside the step.
- Hardware: `esp_light_sleep_start` from the main task, RAM kept. Wake sources: level wakes on Left (GPIO0), Right
  (GPIO7), Power (GPIO3), the GT911 INT (GPIO10) and the charger STAT, the last two on the level opposite to the one
  read before sleeping (their idle level depends on the OEM touch config and the charger), plus a timer (at most 20 s,
  under the 30 s task watchdog, then the rules run again). The input task parks between I2C transactions first; the touch rail and reset pins are
  held. The GT911 keeps its own power and scan in light sleep. Until a touch has come with an INT edge this boot,
  light sleep runs in 200 ms slices and the input task polls touch in between (fallback for a GT911 that never pulses
  INT). Untested on hardware.
- Wi-Fi is off in the step (no modem sleep: without `CONFIG_PM_ENABLE` the CPU would stay awake at 80 MHz). The
  WebSocket closes but the entity store stays; on wake the dashboard is drawn from RAM at once (one full refresh), Wi-Fi
  rejoins from the RTC cache (cached BSSID / channel, cached IP while the lease is under an hour) and HA reconnects
  without backoff. The API is unreachable during the step, as in deep sleep.
- Any key or touch in the step only wakes (consumed): Left does not turn the page, Home does not open the app switcher,
  and a Power press there does not toggle the standby face on its release.
- Settings: Settings › Power shows Standby after and Deep sleep after standby instead of Check every and Live after a
  press (the page holds 8 cells). Check every (`wakeEvery`, Standby mode only) moved to the web console's Power page.
  `liveMin` stays stored and served for a rollback, no effect. Settings schema 3 sets `standbyAfter` from `liveMin`:
  1 and 5 stay, 10 becomes 5, 3 (the old default, untouched on most displays) becomes the new default 1.
- QEMU has no light sleep: `QemuBoard::lightSleep` waits 200 ms and the open_eth link stays up (the API answers, and an
  API request ends the step). The emulator models the step as `asleep.light` (Wi-Fi off: console unreachable).
