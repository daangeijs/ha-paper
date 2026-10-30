# Config PUT parsed and applied in PSRAM (issue #160)

- Firmware only (the emulator has no heap split). Every PUT /api/v1/config parsed the YAML (line vector, key/value
  pairs, widget maps), wrote `toYaml` text, built the entity id sets and made two long-lived `Config` copies (Hub,
  App) plus a transient one in `pump`, all blocks under malloc's 4 KB internal threshold. Measured on QEMU (real
  house, 20 PUTs of a 10-screen config, `heap_caps_*` tracer with backtraces): internal low-water 73.1 → 49.4 KB, the
  largest block 43.0 → 31.7 KB; top allocators `parseYamlText` / `parseConfig` (~15 KB), `Config::operator=` in
  `applyConfig` and `pump` (~5 KB each). The real test display started lower and hit ~1.4 KB.
- `putConfig` / `validateConfig` parse the request body inside `PsramScope`; `DeviceServices::applyConfig` (PUT and
  the seed) runs in one too: the Hub's copy, the YAML text and the id sets live in PSRAM. Unlike eink-ha-os#137 the scope now
  covers `storage().writeFile`: LittleFS and the flash driver allocate with `malloc` and write from their own buffers,
  so no DMA buffer moves. `pump` builds the display config (`withSettings`, eink-ha-os#159: user screens + the Settings pages) in a
  scope and hands it to `App::setDisplayConfig`, which moves it in: the App's copy is that PSRAM block, and the panel
  redraw stays outside the scope. `App::setConfig` (tests, emulator parity) composes and calls it. GET /config serializes in a scope; the boot copy is parsed in one. The
  request body buffer (`_tempObject`) is PSRAM when there is any.
- `PsramScope` is per task (up to four at once): the web task's PUT now overlaps the net task's entity scopes, and the
  single global owner of eink-ha-os#149 let one task's scope end restore the other's state.
- Measured after (same run): low-water 112.3 KB, largest block 77.8 KB after the 20 PUTs. Contract test
  `eink-ha-os#160: 20 PUTs …` checks the low-water drop over the PUTs (≤ 12 KB; base 23.7 KB) and a largest block ≥ 20 KB.
