# History tile rendering (issue #270)

- One painter for both looks: `historyTile` in `app/ui_tiles.cpp` branches on `sleek()` (fonts, padding, 3 px line,
  rounded bars) on the card `tileFrame` draws; `ui_sleek.cpp` has no history card of its own.
- Low / high on a tile too narrow for both: the firmware drops the low and keeps the high on one line. The emulator
  wraps the row (the plot gets shorter).
- The line is a th × th pen along a Bresenham path (`Canvas::line`, no anti-aliasing); the emulator draws an SVG stroke
  with round joins. Lone points between gaps draw as one pen square.
- The redraw decision is the region signature (bar rects and line ends in pixels, ticks and low / high text), not
  `chartKey`; `core/history_chart` keeps `chartKey` matching the emulator for the fetch (#269) to use.
- Until #269 fetches from HA, `App::setHistory` is the only input (native tests and `tools/render_host.cpp`); a tile
  without a series draws the Loading state (frame, axis, baseline). No QEMU hook: the hooks live in `src/net`.
