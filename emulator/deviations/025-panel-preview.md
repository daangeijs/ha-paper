13. **Panel preview** (issue #25, DISPLAY_STYLES_PLAN M1; not in the handoff). Simulation › "Panel preview" (default on,
    4-gray mode only): every partial refresh marks one window B/W until the next full refresh (`src/core/panel.ts`,
    mirrors `hw/x4_display.cpp`): the bounding box of the redrawn regions, x widened to 8 px, or the whole screen when
    that box is ≥ 50 % of the panel (the driver's whole-frame FAST refresh). Inside it an SVG filter thresholds the
    grayscale image at luma 126.5 (gray1 #555 → ink, gray2 #A8A8A8 → paper). Limits:
    - Region rects are measured from the `.dirty` markers in the DOM (always rendered now, hidden by CSS when "Show
      redraw regions" is off). A partial with no keys, or whose regions have no marker (night face, standby), counts as
      the whole screen. Regions removed by a partial are not included; the firmware adds their old rects.
    - Worst case. The partial waveform is differential: pixels whose B/W value did not change vs. the last frame are
      probably not driven, so an untouched light-gray pixel may keep its overlay gray on the glass. Dark gray always
      flips to black (white → black in the B/W plane). Untested on hardware (M0).
    - Since #38 the emulator draws the firmware's 1-bit patterns (TRACK, HATCH in `src/core/panel.ts`) instead of
      flat grays; only the Sleek card surface SURF is still flat (#DEDCD5 → paper). Compare with
      `firmware/test/out/*_bw.png` (`tools/render.sh`).
    - Press feedback (the firmware's inverted-rect partial on tap) is not simulated.
