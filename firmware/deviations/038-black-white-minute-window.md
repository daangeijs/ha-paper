# Black/white only, minute window (issue #38)

The panel preview (#25) showed gray content breaking after a partial refresh (B/W plane only: G1 → black, G2 →
white): Heating NOW "17.8°" read "'7.8" (the thin G1 `1` strokes went white), Home lost every gray after the first
minute, price bars vanished. Not a handoff deviation in itself, but the handoff palette used G1/G2 for text and bars.

- **Rule** (emulator `core/panel.ts`, same in both): everything a partial refresh can redraw is drawn in ink and
  paper. In practice that is every screen except the boot face: tiles, list rows, bar, menus, setup, OTA install,
  night and standby faces all get partials (data tick, tap, sub-page turn, clock). Secondary text (`sub` lines,
  "installed", hints, column headers, NOW) is ink, kept apart by weight and size (regular vs bold). Heating NOW is
  regular 17 px, SET bold 21 px (was G1 19 / bold 21). Text on ink cards that was G2 (Sleek clock card date, axis,
  heating set-point, light/scene sub lines) is paper.
- **Patterns instead of levels:** `Tone::Hatch` (new) = 2 px ink / 2 px paper diagonal stripes for "dark" bars (past
  hours, cheapest 3 h, high price cells, the light chip's brightness track); `Tone::Track` for "light" bars. Classic
  bars chart: now ink, cheapest 3 h / past Hatch, the rest Track (was G1 / G2). Dividers and ghost frames: dotted ink
  (`dottedHLine`, new `dottedVLine`, `dashedFrame(…, 2, 2)`). Gauge / OTA fills: ink. Toggle switch: on = ink track,
  knob paper. Sleek day-progress track: a 2 px paper hairline under the paper fill (was G1).
- **Exempt:** boot face (only ever a full refresh) and the Sleek card surface `Surf`: with `display.surface: dither`
  the cards still turn white after a partial; `dots` survives. That choice is still open (owner, on the panel).
- **Lint:** `Canvas::grayPuts` counts G1/G2 pixels (outside `Tone::Surf`). `test_bw_only_lint` walks every default
  page, the app switcher, night, standby, first install and the OTA face in Classic and Sleek (dots) and expects 0;
  it also checks the boot face does count (> 0). Emulator: `render.test.ts` › "B/W-only rule" greps the rendered
  screen markup for `GRAYS` in both styles.
- **Minute tick:** the clock text is its own region, drawn on top (z 1): `time` (top bar, fixed "00:00" width
  right-aligned against the pager; night/standby big clock) and `k<i>` (clock tile digits; Sleek: card below the
  date line = digits + day progress). The bar and tile no longer draw the time, so the minute diff is `k0 time`
  instead of `bar t0`. Window: Classic 576 × 189 at (30, 8) = 28 % (was 800 × 263 = 55 % → whole-frame B/W),
  Sleek 581 × 253 = 38 %, night face < 25 % (`test_minute_tick_window`). The date line (Classic) / card header (Sleek)
  redraws only when the date changes. In 12-hour mode "9:59" leaves a gap to the battery (fixed box).
- `tools/render.sh` now writes `*_bw.png` for every default page in Classic and all four Sleek faces, plus night and
  standby.
- Untested on hardware: whether the differential partial waveform actually leaves untouched G1/G2 pixels gray (then
  the old look would have survived more often than the preview shows). The rule holds either way.
