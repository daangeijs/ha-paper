# History tile styles area / step / dots, threshold, labels (issue #304)

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
