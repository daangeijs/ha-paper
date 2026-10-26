# Ambient idle mode, night face poster (issue #27)

- `core/logic.h` `ambientDue` / `chromeFor` / `nightStale` follow emulator `core/ambient.ts` and
  `spec/test-vectors/ambient.json`. `App::Impl::ambient` is set in `idleCheck()` (1 s cadence) and cleared by
  `input()`. `App::loop()` consumes the first touch/swipe/Prev/Next/Home in ambient (`commit("chrome")`, a partial of
  the bar region only); Power passes through. The returnHome jump to Home enters ambient in the same full refresh.
- The bar region keeps its key; region `time` is omitted when the page has a clock tile, so the minute tick on Home
  in ambient redraws only `k0`.
- Night face: `NightSnap::asOf` is the HH:MM of `haLastDataEpoch`, set at capture only when it is > 30 min old. The
  face is frozen for the night, so data going stale during the night does not add the line (no extra partial).
