# Values view: live values in the tiles (issue #122)

- Replaces the panel image of #83 (Daan, 2026-10-17: "not changes the cards name with the value. I would like to have
  that"). The Values toggle keeps the editor's tile grid and puts each tile's live value where its name was (the name
  moves to the small line under it). Source: `GET /screens/{id}/values`, polled every 5 s like #83
  (`src/webconsole/preview.ts`); a draft tile keeps its name when it no longer shows what the pushed tile at that index
  shows. `GET /screens/{id}/preview.png` stays as API; the console no longer calls it (`Emulator.previewSvg` is gone).
- Values per tile type (`Emulator.tileValues`, firmware `ui::tileValue`): stat = value + " " + unit, gauge = "57%",
  switch = On / Off / "40%" (dimmable light), thermo = "20.5°", price = "€ 0.23", clock = the clock; lists, charts,
  routes, scenes, settings = "" (name stays). An HA entity in state unavailable / unknown gives the word
  ("Unavailable" / "Unknown", keys `gapUnavailable` / `gapUnknown`, the same keys #86 adds), anything else missing "—".
- The device simulator formats with its own `fmtEntity` (one decimal, `toFixed`, not `display_precision`), so its
  values are close to, not exactly, the firmware's; the contract test checks shape (one string per tile, "" only for
  tiles without a value) and answers `ready: true` at once.
