7. **Display styles** (handoff `x4-display-styles`, `src/core/skin.ts`). Differences from the package's `Main.dc.html`:
   - The look is the device settings `display.style` (classic | sleek) + `display.typeface`, not a separate `look` state
     (owner decision 3). Default **Classic** (owner decision 4; the package defaults to Archivo). Simulation › Display style
     and `?look=` set the same two settings. `display.surface` (dither | dots) is accepted and stored but not drawn: the
     emulator shows SURF as the flat #DEDCD5.
   - The default config gets one extra screen after Display: `style` ("Display style", Settings app) with `setting` tiles
     for `style`, `typeface` and `surface`, the same as the firmware's default (`firmware/src/core/config.cpp`). Display's
     8 cells are full. The values live in the device settings, never in `screens.yaml`; the tiles only step them, like the
     other setting tiles. So the default config is now the handoff `screens.yaml` plus this screen.
   - `sleek-fallback.css` matched inline style text; React writes styles through the CSSOM, so it uses class names instead
     (`lbl`, `num`, `ob`, `rt`/`rr`/`rl`/`rbt`, `hl`, `pb`). Its `.tile .ob{background-color:#ECEBE5}` rule is not copied:
     it made black buttons with paper text (Simulate phone, Link with phone, Install) invisible. Outlined buttons keep their
     fill and lose the outline. Grid padding/gap and app-switcher tiles are set from render values, not CSS overrides.
   - Favourite-light card in Sleek: −/+ only when the light is dimmable (the package always shows them, also for switches).
   - Page dots with more than 8 pages: the 8th dot stays active from page 8 on (the package shows no active dot).
   - Known divergence (plan §3.1): `skin()` reads the hour, which `vm()` does not contain, so in Sleek a stat card's spark
     bars and the price strip don't redraw on the hour unless the value changes too. The firmware diffs drawn output and
     will redraw them. Kept as is: diffing stays on `vm()`, as the package requires.
