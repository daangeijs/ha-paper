# First-run screens and console (issues #183, #184)

- Setup on the panel: the design's pager ("‹ 1 / 2 ›") is gone. The arrows did nothing during setup, so the bar
  shows "SETUP" over "Step 1 of 2" / "Step 2 of 2" and the clock moves to the right edge. Emulator and firmware
  (`chr.pager = false` while in setup) match.
- The setup browser step's texts come from strings.ts (EN + NL); step 3 no longer promises energy, lights, heating
  and travel.
- Getting started card: "N of M tiles filled" counts only tiles the house can fill. Tiles that need solar, a home
  battery, prices, energy history, lights, thermostats or room sensors the seed did not find are one "Not found in
  your Home Assistant, so left out: …" line. The "done" step shows only once it is done.
- Screens editor: tile cards show the name only (no widget type, size or entity id); one way to add a tile (the
  widget column on wide screens, the "+ Add tile" menu on phones and in Values view). A tile added as "Light" is
  named "Light" and lists lights first until its entity is picked.
