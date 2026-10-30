# History tile styles area / step / dots / band, compare, threshold, labels (issue #304)

- Area fill: the firmware fills one 1 px column per x under each segment between bucket centres
  (`Canvas::toneUnder`, Tone::Track, 25 % black), recorded once per segment. The emulator clips a div with the TRACK
  background to a `polygon()`; edge pixels can differ by one column.
- Step: flat runs and upright joins are `Canvas::line` pen strokes (square ends); the emulator strokes an SVG path with
  miter joins.
- Labels: the firmware keeps a label inside the plot both ways (x clamped to the plot, baseline between plot top and
  bottom) on a paper box; the emulator clamps only vertically (`clamp()` on `bottom`), so a label beside a point at
  the far edge can poke out sideways by a few px.
- Dot size (`dotPx`) follows the bucket count for a 4-wide tile in both; on a 2-wide tile the dots can touch.
- The threshold is a 2 px dash 6 / gap 4 in both; the firmware draws it with `Canvas::dashedHLine` (one record).

Wave 2 (band, compare):

- Band fill: `Canvas::toneBetween` fills one 1 px column per x between the max and min segments of two neighbouring
  buckets (Tone::Track); the emulator clips a TRACK div to a `polygon()` over the max points and back along the min
  points. Edge pixels can differ by one column. A lone bucket (gap on both sides) has no band in either.
- Band data: the min and max are two more series of the entity (agg `min` / `max`, `hist::tileSpecs`). With statistics
  they ride the same request (`types` is the union). Without statistics (history fallback, windows up to 24 h) the
  firmware fetches the same history three times, once per series: 3x the bytes and HA load for that tile. The device
  sim asks statistics once per period and type.
- Compare data: the compare series asks its own statistics request (`end_time` = now - compare) instead of joining the
  tile's; its history slices end there too. It takes no live appends; its span moves with the tick and its refetch
  (every max(10 min, bucket)). The device sim groups it with the other tiles of its period, without `end_time`.
- Compare on bars: a 2 px ink tick at the earlier value over each bar, in a 1 px paper halo (`Canvas::fill`); the
  emulator draws the tick with a 1 px CSS outline in the ground colour. An outline bar was tried first: under the hatch
  it read as a thicker bar border, not as yesterday.
- Store: `App::Impl::kHistSlots` grew from 12 to 24 series (6 tiles x mean + min + max + compare), in PSRAM.
