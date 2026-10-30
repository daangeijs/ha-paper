# Legibility at 2 m (issue #28)

- Plain zero in every Classic Atkinson font (`tools/fontgen.py plain_zero()`, emulator DEVIATIONS 21). The committed
  `src/app/gen/fonts.cpp` changes only in the `0` glyph of each of the 36 fonts: the new zeros were rendered on macOS
  and spliced into the Linux output (the old zero was byte-identical on both, so CI's gen-check should agree; if it
  does not, commit the `gen-linux` artifact). `emulator/src/plain-zero.css` is fontTools-only and part of gen-check.
- Small text on the Sleek card surface: `Canvas::text` clears surface texture pixels (dither or dots) within 2 px of
  the glyphs of any text under 20 px drawn over a `Tone::Surf` fill on the same canvas (`surfKnockout`). The emulator
  draws SURF as a flat colour, so this has no emulator counterpart. Ring track and spark bars were already 1-bit
  patterns (eink-ha-os#38).
