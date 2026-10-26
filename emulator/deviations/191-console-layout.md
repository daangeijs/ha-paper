# Console layout: tile source in the editor, Device settings, Advanced (issues #190, #191)

- Tabs are Screens · Device settings · Advanced (was Screens, Data sources, Advanced, API access, Device). The
  in-browser emulator's address bar shows `/screens`, `/device`, `/advanced`; the device serves every SPA path.
- No Data sources tab (#24). The screen editor shows each tile's source on one line: the HA entity, where it comes
  from (from Energy dashboard / picked by you / same id in HA / none), Change, and HA's value. Logical ids stay
  hidden. For tiles that read a logical id (stat on `sensor.solar_power` …, price, bars series, gauge without
  entity; `webconsole/tileSource.ts` `tileLogical`) Change opens the old page's entity search, sign toggle (power ids
  only) and Use automatic; a pick saves at once with `PUT /settings` `entities`, Done only folds the panel. An id
  read by other tiles (any screen) gets an amber line naming them. Tiles with their own entity show the same line;
  Change opens the entity picker (part of the draft, pushed with the screen). A new tile without an entity keeps
  its picker open.
- Device settings: the settings fill the wide left column, each explained one with an (i) that opens the #190 text
  (EN + NL from `strings.ts` `info*`). Wi-Fi is one line on top of the right column ("Wi-Fi <network> · <signal> ·
  Change"); Change opens the network list, password and Connect.
- Advanced: a sidebar with two full pages, Screens as YAML (editor fills the page, Validate / Push top right) and API
  (tokens on top, OpenAPI + endpoints below). The chosen page is kept per browser (`localStorage x4.advancedPage`).
- Device: Settings › Power's three tiles are two rows tall and show the same text as a hint line under the value
  (classic and sleek; firmware `config.cpp` `settingsScreens()` and `ui_tiles.cpp` / `ui_sleek.cpp` match). Clean
  screen, Live data and Standby sit on Settings › Display, whose eight one-row tiles have no room for a paragraph,
  and Report to Home Assistant has no tile on the device: those four explain themselves only in the browser.
