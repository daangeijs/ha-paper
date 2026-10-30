# Battery gauge filter and awake phases (issue #327)

- The emulator spec (`src/core/battery.ts` gaugeStep, `spec/test-vectors/gauge-filter.json`) is applied on the X4 Pro
  only (`hw/x4_board.cpp`, every gauge read). The emulator and QEMU have no fuel gauge (QEMU reports a fixed 80 %), so
  they show the gauge unfiltered and the filter's device glue (RTC_NOINIT state, power-on reset) is not run in tests.
- The filter does not take a median or EMA, and the gauge is not sampled before Wi-Fi comes up (Wi-Fi starts in
  `services.begin()`, before the board): falls pass at once, so a reading under load can lower the shown % until a
  charger is seen. Every consumer (icon, About, HA report, OTA battery gate, low-battery sleep, history) gets the
  filtered %; the gauge's own read is `raw` in `power_trail.phases`.
- Awake phases (`core/phases.h`, `power_trail.phases`) are firmware only: the emulator returns `boot: null, wakes: []`.
  Only boots that end in deep sleep are kept; one that ends in a restart, an OTA reboot or a power loss is not. The
  phases are wall time, not current: radio-on time and the panel's share are an energy proxy until a meter measures it.
