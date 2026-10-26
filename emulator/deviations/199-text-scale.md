# Text size scale for a 217 ppi panel (issue #199)

The handoff sized text for a monitor (13–16 px labels, 14 px fine print). On the 4.3" panel that is 1.0–1.25 mm cap
height. Emulator and firmware now use four roles: fine print ≥ 18 px, labels ≥ 20 px, names read across the room
26 px, values unchanged.

- Page overview / app switcher: heading and card number / "N pages" B20, title B26 on up to two lines (ellipsis on the
  second), description R18. Still a 4×2 grid.
- Standby: date B28, stats R26 name + B26 value in a centred 2×2 grid (four stats on one row overflow in Dutch),
  footer R18. Night: the three stats stay on one row and wrap into centred rows only when wider than the screen.
- Classic tiles: labels B20 without letter-spacing ("THUISBATTERIJ" is 156 px in a 156 px tile), sub lines R18,
  price tag B16, chart summary B18, axis ticks R18, heating column heads B16, setting hints R18. Top bar: app name
  B20, "part n of m" / pager / low-battery % B18, "since 14:05" R18.
- Firmware text fit (the emulator draws one size with a CSS clamp or ellipsis): a stat or gauge label that does not fit
  one line wraps to two B20 lines when it has a space, and the value moves down by one line; a single long word
  ("TERUGGELEVERD") steps down to B18/B16. A sub line that does not fit at R18 is drawn at R16 ("Discharging
  2.50 kW", "7 kamers verwarmen"). The price tag steps from B16 down to B13 until it fits beside the label
  ("PRIJS" + "GOEDKOOP").
- Sleek keeps its own sizes (own pass later). Its Classic-layout screens resolve R26 to the nearest Sleek regular
  (19 px) on the standby and night faces.
- Second pass (Daan on the device, 2026-10-26): app switcher / page overview description R18 on up to two lines when the
  title takes one (title + description at most three lines). Lights: summary B20, room header B18 + count R18, light
  name B20, value B20 (was R17), "on / off only" R18 on up to two balanced lines (was R13). Heating: summary B20,
  column heads B20, room name B20, NOW B20 (was R17), SET B22 (was B21). Setting tiles: value B26, a label that does not
  fit one line wraps to two ("TERUG NAAR START"). Updates: labels and segments B18, status B26, sub line and hints R18
  on up to two lines, notes R18. Wi-Fi: labels B20, key/value rows 18, network names B24, tags B18, the 5 GHz note R18
  on two lines. Home Assistant and About: labels B20, rows and notes 18, About values B20.
- Firmware text fit for these (the emulator draws one size with an ellipsis or a line clamp): light and room names drop
  to B18 for the whole page when one name does not fit at B20 ("Island pendants", "Dining room" + flame), then
  ellipsize; an About value steps B20 → B18; a Wi-Fi network name B24 → B20.
- Updates firmware name: a git-describe build name ("0.1.0-alpha.6-18-gbf929d4") overflowed into the right column at
  B46. The firmware measures: B46, B40, then without the "-g<hash>" B46 → B28, then the ellipsis. The emulator drops
  the hash above 14 characters and picks 46 / 40 / 34 px by length. About keeps the whole name.
- The setting tile and system pages are shared with Sleek, which resolves the larger Classic sizes to its nearest
  text size; Sleek's own size pass is still open.
- Not in this pass: first-install and link-card screens, the Wi-Fi password keyboard keys (already B20).
