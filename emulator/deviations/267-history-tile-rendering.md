# History tile: emulator draws it, firmware not yet (issue #267)

- The browser emulator has no recorder: a history tile charts `core/historyChart.ts demoHistory`, a 5-minute daily
  curve per unit with a nightly gap 02:20–03:10, bucketed by `core/history.ts bucketize`. An entity that is
  unavailable in the mock shows "No history".
- The device-sim fetches for real (fake HA or a real HA): statistics first, history rows in 6 h slices as the fallback,
  only the tiles of the app shown, on connect, a config change, a new app and every 10 min. It does not append live
  state changes between fetches (firmware #269 will). An answer over 512 KB (the firmware's WS frame cap) is "Too many
  changes"; the sim measures the JSON length of the parsed result, not the frame.
- The latest bucket with data is marked (ink bar, or a dot on the line), not strictly the open bucket: right after a
  bucket boundary the open bucket is empty and nothing would be marked.
- The firmware still has no `history` tile (#268 config, #270 drawing): the strings `histLow`, `histHigh`,
  `histNone`, `histTooMany`, `histNeedsStats` are in `core/strings_gen.h` but unused there.
