17. **Black/white only; minute window** (issue #38; the handoff palette used G1/G2 for text and live bars). The panel
    preview showed Heating NOW "17.8°" as "'7.8" and Home losing every gray at the first minute tick. Rule
    (`src/core/panel.ts`): what a partial refresh can redraw is ink and paper only, which on this device is every screen
    but boot. Secondary text is ink (weight/size carry the hierarchy; Heating NOW 17 px regular vs SET 21 px bold);
    text that was G2 on ink cards is paper; hairlines and ghost frames are 1–2 px dotted ink; light/dark bars use
    `TRACK` (25 % dots) / `HATCH` (2 px diagonal stripes); the light chip's brightness track and the Sleek pages
    highlight use them too; toggles are ink/paper; the Sleek day-progress track is a 2 px paper hairline. Exempt: boot
    and the Sleek card surface SURF (dither vs dots still open). Lint: `render.test.ts` › "B/W-only rule" renders every
    screen, sub-page, menu, setup, night, standby and OTA state in Classic and the four Sleek faces and greps the
    screen markup for `GRAYS`.
    Minute tick: `minuteKeys()` (`src/core/refresh.ts`) redraws `time` (top-bar / night / standby clock text) and `k<i>`
    (clock tile digits; Sleek: digits + day progress, the card below the date line), the whole tile only at midnight.
    Classic Home window 584 × 189 = 29 % (was 800 × 263 = 55 % → whole-frame B/W). The emulator's top-bar clock keeps
    its flex width; the firmware reserves a fixed "00:00" box.
