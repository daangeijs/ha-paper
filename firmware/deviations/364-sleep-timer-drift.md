# Sleep-timer drift correction and early timer wakes (issue #364)

- Hardware only: the ESP32-S3 deep-sleep timer runs on the RC slow clock, ~1 % fast on the first X4 Pro (night
  29-30 Oct: timer wakes 22:59 + 23:00 and 06:55 + 07:00). The BM8563 clock read at boot showed the early time, so quiet
  hours slept again for the last minutes: two Wi-Fi wakes per transition.
- The firmware learns the timer rate from each timer sleep of at least 1 h (seconds given to the timer vs seconds on the
  crystal clock minus this boot's uptime; beyond ±5 % = a clock jump, ignored), keeps it in RTC memory, and scales the
  next timer by it (`glance::timerPpm`, `timerSeconds`).
- A glance timer wake that still arrives early waits awake up to 15 s for the planned second before deciding; earlier,
  it sleeps again for the rest ("early wake"), which can happen once before the rate is learned (`glance::earlyWake`).
- The emulator has the same pure functions and vectors (`spec/test-vectors/glance.json` `timer`) but no real sleep
  timer, so it never applies them; QEMU's simulated sleep is cut short on purpose and skips them too.
