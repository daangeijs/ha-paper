21. **Legibility at 2 m** (issue #28, visual strategy; the handoff used Atkinson Hyperlegible as shipped and filler
    subtitles). Classic numerals use a plain zero: Atkinson's slashed zero read "23:3Ø" across a room. The face has no
    plain alternate, so `firmware/tools/fontgen.py` builds one (the two counters beside the slash become one counter,
    the outer contour scaled onto their joint box) and also writes `src/plain-zero.css`, a one-glyph @font-face
    ('X4 Plain Zero', unicode-range U+0030) first in the Classic stack (`core/skin.ts`). No slashed zero is kept for
    pairing codes or IPs: the pairing alphabet has no 0/O/1/I and IPs and the hex hostname have no letter O, so the
    slash told nothing apart there. Stat subtitles are a fact or empty (`spec/test-vectors/stat-sub.json`): Solar and
    Home use show today's kWh, Grid "In/Out · x kWh today", Battery flow adds the charge %, Cheapest 3h the window's
    average price; Used today, Imported and Exported drop the line (the label already says it); "1 room heating" is
    singular. The heating flame path is scaled ×1.45 to fill 22 of 24 units, and the Sleek flame is 16 px: the flame
    itself is now 14.7 px tall (was 9.5 px at 15 px).
