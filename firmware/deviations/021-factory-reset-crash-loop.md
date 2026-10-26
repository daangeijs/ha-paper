# Hardware-key factory reset, crash-loop offer (issue #21)

- `core/recovery.{h,cpp}` = `emulator/src/core/recovery.ts`, checked against `spec/test-vectors/recovery.json`.
- `App::loop()` takes one sample per pass (~20 ms): `Board::heldKeys()` (X4: plain `digitalRead` of GPIO3/7/0, safe
  from loopTask, no I2C) OR the keys of the KeyDown events drained this pass (Home, taps and swipes = "other"). While a
  hold or the screen is in progress, input goes to the reset screen, not the UI. Side effect: a Power + Right press
  released before 5 s is swallowed (no page turn, no standby); a Power press well before Right still acts as Power.
  QEMU and the host fake report no held keys (`Board::heldKeys()` default 0); the host test sets them.
- No combo during an OTA install (`Mode::Updating`).
- Confirm = `svc.factoryReset()`, the same path as the Settings tile and `POST /device/factory-reset`
  (`Storage::factoryReset()`: HA Paper NVS namespaces + userdata format; `hw_calib` and `www` untouched).
- Crash loop: `net::diagCrashStreak()` reads the RTC boot ring after `App::begin()`; ≥ 3 → `App::offerRecovery()`.
  Not covered: a crash before `App::begin()` (in `services.begin()`, storage, Wi-Fi) never reaches the screen; the
  hold combo then has the same problem. A real safe mode (skip services when the streak is high) is a follow-up.
- Hold timing: the X4 input task sleeps between key edges, but `heldKeys()` reads the pins directly, so a 5 s hold
  needs no edges. Untested on hardware: whether GPIO3 reads LOW while Power is held on the X4 Pro's power latch.
