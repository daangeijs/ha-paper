# Three power phases: Live, Standby (Wi-Fi on), Deep sleep (issue #37)

- ha-paper#37 (Daan) reworks the #32 standby step (`032-standby-step.md` describes the old one). On battery there are two
  choices: Save battery (`glance`, recommended) and Always live (`off`). The Standby mode (`powerSave: standby`, deep
  sleep with timer wakes every `wakeEvery` minutes while the standby face is on) is gone: settings schema 4 moves it to
  glance. `wakeEvery` and the Display › Standby key (`standby`, the standby face after N min) stay stored and served for a
  rollback, ignored, in no menu. The Power key still toggles the standby face by hand.
- Save battery: Live for `standbyAfter` (1 / 3 / 5 min) after a key or touch, then Standby for `deepAfter` (5 / 15 / 30 /
  60 min / never), then deep sleep with the glance sleep face, as before. Labels "Live for" / "Then standby for"; the
  Save battery tile and the console show a summary line ("Live 1 min → standby 15 min → deep sleep until you press
  power."). Both settings hide with Always live: the device draws an empty cell, the console drops the rows.
- Standby: `powerDecision` returns `standby: true` (reason `standby`, awake, no timer); the device decides again every
  check (1 s). The dashboard stays as drawn: `App::nap` blocks every commit and the minute tick (no clock, no clean
  refresh), front light off, no footer or marker. `HaClient::pause(true)` closes the WebSocket and holds it closed; the
  HA status stays Connected (a pause, like `yieldTls`), so the bar does not change. Wi-Fi stays associated with the
  battery profile's modem sleep (80 MHz, `WIFI_PS_MIN_MODEM`); the API and the web console answer. An API request does
  not end the step (the step wins over `recent api`); quiet hours (deep sleep), setup and the 03:00 install window win
  over it. Any key or touch ends it (consumed, a Power press is no standby toggle): HA reconnects without backoff and
  what changed is drawn once its snapshot landed (`expectData`), ambient chrome comes back. Into deep sleep from the
  step: HA stays closed, the panel redraws to the sleep face.
- No light sleep any more: #32's `Board::lightSleep` (GPIO level wakes, input task parked) is removed. With Wi-Fi
  associated, light sleep needs `CONFIG_PM_ENABLE` + `CONFIG_FREERTOS_USE_TICKLESS_IDLE` (automatic light sleep between
  DTIM beacons); the Arduino-ESP32 libs ship without them, so enabling it means a custom sdkconfig build (pioarduino
  `custom_sdkconfig`, the libs rebuilt), not done here. Estimates from docs/POWER_BUDGET.md (row F2, not measured, #15):
  this step ≈ 25-38 mA (80 MHz + modem sleep, GT911 scanning), 15 min ≈ 7-9.5 mAh per press; with automatic light sleep
  ≈ 3.3-9.2 mA (≈ 1-2.5 mAh); #32's Wi-Fi-off light sleep ≈ 3.5-4 mA (≈ 1 mAh); deep sleep ≈ 0.1 mA. On 1100 mAh, ten
  presses a day cost ≈ 8 % of the cell a day in standby alone; "Then standby for 5 min" cuts that to a third.
- Emulator: `standbyStep` state (not `asleep`): no data ticks, no clock / clean refresh, front light off, the API answers;
  `stepWake` ends it on any input. QEMU: no radio, the open_eth link stays up as before.
