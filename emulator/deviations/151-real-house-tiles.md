# Real-house tile fixes in the emulator (issue #151)

- `fewerDecimals` (core/format.ts, spec/test-vectors/format.json) is the rule the firmware uses to fit a stat value and
  its unit; the emulator draws tiles with CSS and still cuts long values with an ellipsis instead.
- Zone names that do not fit: the firmware keeps the last word ("Bath… attic", core/logic.cpp fitKeepTail); the
  emulator's CSS ellipsis cuts the end. It has no text measurement in core.
- zoneList `labels` ("climate.<id>=Name" items split by ";", core/config.ts labelPairs/zoneLabel) rename rooms in the
  emulator's zone list; a bad item is rejected (config vectors 66–68).
- Quarter-hour prices: the emulator's mock prices are hourly, so "now" is the hour's price. The device simulator's price
  tile value is the price entity's state, which HA keeps at the current quarter.
- The solar forecast line stays: the mock has a forecast. The firmware only shows it with a `forecast` attribute.
- The app switcher hides the pager's page position (no "3 / 3", no current Sleek dot), like the firmware.
