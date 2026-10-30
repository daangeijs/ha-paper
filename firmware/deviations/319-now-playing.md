# Now playing tile (issue #319)

- Mockup (beta.5, "Now playing"): a 4-wide card plus four separate Previous / Pause / Next / Volume tiles. Built as one
  `media` tile instead: header (name, volume %, state pill), title, artist, and the buttons inside the tile, so it works
  at 1, 2 or 4 wide and on one or two rows. A 1-wide tile has the three transport buttons only (no volume); its ★ sits in
  the header where the pill would be.
- No progress bar and no time line, on battery or USB: `media_position` is not kept at ingest (`core/ha_stream.cpp`
  keepAttr keeps only `media_title`, `media_artist`, `volume_level`), and the drawing reads nothing else, so the region
  signature changes only with title, artist, state or volume. No album art (the square in the mockup): waits for the
  dither pipeline (camera idea).
- Volume − / + send `media_player.volume_down` / `volume_up`, not `volume_set`: HA steps from its own level, so two
  quick taps before HA answers add up. A `volume_set` from the display would have to guess the level from a state that
  is one round trip old and keep a local override (a new map in internal RAM).
- No optimistic state: play/pause, next and volume taps get the standard press feedback (the button inverted with one
  partial, ~565 ms on the panel, then restored); the tile redraws when HA reports the new state. Opening the favorites
  picker, ×, and picking a favorite redraw the tile with one partial (that redraw is the feedback).
- Favorites are capped at 6 (the issue said "a list"): a 2 × 1 tile's picker holds 4 rows × 2 columns with × in the last
  cell. A 2-high tile lists them under the title instead; ★ appears only when some do not fit. The picker closes on ×,
  on a pick, or on any page change (`navRefresh`).
- Glyphs (⏮ ⏯ ⏭ − + ★) are drawn as filled polygons from the emulator's 24-unit SVG paths (`app/ui_media.cpp`); the
  firmware fonts have none of them.
