# Glance = sleep face + button wake (issue #356)

- Replaces the glance behaviour of 010-power-saving (Daan, 2026-10-29: "when it's asleep it should just draw a simple
  info that does not have to be updated each hour. Only on a wake by pressing we show the home dashboard and light up
  the light"). Asleep in glance the panel shows the sleep face (Device.tsx SLEEP FACE, shared with the quiet and Nobody
  home faces): "Asleep · press to wake", the date, the Today row (core/quiet.ts, endHour TODAY_END).
- No periodic wakes: `glanceWaitS(localSec, quiet)` (core/power.ts, spec/test-vectors/power/09-glance.json) sleeps to
  midnight or the start of quiet hours, whichever comes first, at most MAX_SLEEP_S (8 h); the 03:00 install slot and
  quiet-hours end still wake it. `wakeEvery` is for standby only; failed wakes no longer stretch the wait.
- An unreachable HA at such a wake still redraws when the face itself changed (its date; glance.json glanceStep).
- A timer wake boots with the front light off (#357, frontlight.json `boot`); the emulator also shows no light asleep.
