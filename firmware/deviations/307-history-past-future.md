# History tile past + forecast in one chart (issue #307)

- Config differs from the brief's example (`window: 1h` past + `ahead: 2h`): `window` stays the whole chart and `ahead`
  its part after now (as in #283), so 1 h back + 2 h ahead is `window: 3h, ahead: 2h`, plus `past: <recorder entity>`.
  `past` needs `ahead` written and shorter than the window; there is no default split.
- The past and the forecast are two series slots (two fetches); the device keeps up to 12 slots (6 tiles × 2), PSRAM.
  The painter joins them per frame into one PSRAM Series (`hist::joinSeries`), never in the fetcher.
- Forecast dashes: the firmware walks Bresenham steps (`Canvas::dashedLine`, 6 on / 4 off, the phase carried across
  pieces, one record per piece); the emulator uses an SVG `stroke-dasharray: 6 4` over the joined path, so dash
  positions differ by a few px. Forecast bars are a 2 px `Canvas::frame`; on 3 px bars (n > 48) the outline is solid.
- The Now marker is at the start of the bucket holding now (the split), not at the exact minute: the "Now" tick can sit
  up to one bucket to its right.
- The emulator demo draws the past from the same demo curve as the nowcast (so the halves meet), not demoHistory.
