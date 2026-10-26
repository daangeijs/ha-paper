# Battery gauge off the blocking path, charging wording (issue #11)

- CW2017 SoC is read by `core/cw2017.{h,cpp}`, not the vendored `BatteryMonitor::readPercentageChecked()`: same
  registers, profile (copied from vendor `CW2017_BATINFO`) and reset sequence, but one bus step per call. The vendor
  recovery (`cw2017WaitUntilReady`, `delay()` loops, ~4 s) ran on "x4input" and froze touch and keys. Wire stays on
  that one task; the input loop sleeps until the next gauge step (20 ms VERSION / 100 ms SoC polls during a
  recovery, 30 s otherwise). Longest step: profile check + 81 writes (~25 ms at 100 kHz, only after a lost profile).
  Failed init/recovery retries at 30 s (vendor: next call ≥ 1 s). Boot still waits up to ~5 s for a recovery so the
  first frame has a real percentage. `BatteryMonitor` is kept for the STAT pin (GPIO21) and non-CW2017 boards.
- VCELL (#73): `core/cw2017` reads 0x02/0x03 after every good SoC (5 reads per 30 s poll instead of 3) and decodes
  with the vendor formula (`spec/test-vectors/cw2017-vcell.json`). A failed VCELL read keeps the SoC and reports the
  voltage as unknown (`PowerInfo.mv` 0, `/status` `battery_mv` null). `net/power.cpp` feeds it to `core/power` with
  `chargedAgoMin` = minutes since `inputs()` last saw STAT charging, since boot only (the emulator passes null). QEMU:
  fixed 3950 mV; the emulator device-sim reports the same and takes `battery_mv` in `/__sim/control`.
- `PowerInfo.usb` = `HWCDC::isPlugged()`. About › Battery: "· charging" only on STAT, "· on USB" when a USB host is
  seen without STAT (a full battery on USB drops STAT), nothing otherwise. A full battery on a charger without data
  lines still reads "battery": no VBUS pin is confirmed on the X4 Pro. Wording: `core/power.h` `batteryLabel()` /
  `powerSource()`, emulator `src/core/power.ts`, `spec/test-vectors/battery-label.json`.
- `pio check -e x4pro` (cppcheck, `src/` minus `src/app/gen/`, medium+high) gates CI. Fixed: `App` copy (owns a raw
  `impl_`; now deleted), a moved-from read in `core/json.cpp`. Suppressed inline with reasons: `Canvas::setHits`
  (danglingLifetime, the canvas is a per-draw local) and the CA bundle size (comparePointers, linker symbols).
