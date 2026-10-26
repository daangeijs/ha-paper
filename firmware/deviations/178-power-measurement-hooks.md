# Power measurement hooks: wake counters, refreshes, sleep-now (issue #178)

- The wake counters live in the RTC record (`glance::Rtc::tally`, `core/glance.h`). The magic went from "GLNC" to
  "GLND" and the record got longer: the first boot of this firmware, or an older image read after a downgrade, fails
  `glance::valid()` and starts from zero (snapshot, Wi-Fi cache and fails reset with it, the same as power-on).
- `wakes` counts every deep-sleep wake (timer, button, charger; QEMU: the simulated wake). `redraws`, `failedWakes`
  and `lastWake` come only from glance wakes. `awakeS` = awake time of boots that ended in deep sleep + `millis()` of
  this boot. A restart that is no deep sleep (crash, OTA, `POST /device/restart`) keeps the counters but loses that
  boot's awake time and refreshes. `asleepS` uses `time()` before and after the sleep (the RTC timer keeps it), or the
  planned timer when the clock was unknown.
- `lastWake` times are ms since the reset: `wifiMs` = first loop pass with Wi-Fi up, `haMs` = WebSocket connected
  minus `wifiMs`, `totalMs` = the glance decision. They are sampled from the main loop, so they are late by up to one
  loop pass (on hardware tens of ms; under QEMU a render blocks the loop for seconds, so QEMU numbers are not wake
  costs). The `[POWER] glance wake` log line prints the same numbers. QEMU's `millis()` keeps counting through
  `esp_restart()`, so there the clock starts at `powerEarlyBoot()`.
- `POST /device/sleep` checks the last power inputs (cached by `powerLoop` once a second); the main loop checks again
  500 ms later, then sleeps. A refusal at that second check is only logged (`sleep request dropped`), the 202 is out.
  Before the first `powerLoop` pass it answers 409 `stays awake: starting up` (not in the simulator).
- Not refused: first-boot safety still counting, battery unknown or low. The request is explicit, wakes by timer, and
  Power / Right still wake it.
- QEMU: the simulated sleep lasts at most 8 s whatever `seconds` says, and the network stays up during it (there is no
  Wi-Fi to switch off), so `/status` may still answer until the reset.
