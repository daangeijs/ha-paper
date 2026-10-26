# Seed answer parsed in PSRAM (issue #137)

- Firmware only (the emulator has no heap split). The first-link seed parses HA's seed template answer with the core
  `x4::Json` DOM (three times: `seedAnswerOk`, `seedSnapshot`, `seedConfig`). Every node, vector and string of that DOM
  is a block under malloc's 4 KB internal threshold, so on QEMU the big house (14 climate + 149 lights) held ~78 KB of
  internal RAM for it (62-68 KB `std::vector<Json>` growth, 10-11 KB strings): internal low-water 1.1 KB on every first
  link, the real-shaped house (#88) the same.
- `net/psram.h` `PsramScope`: while alive, the replaced global `operator new` (`net/psram.cpp`) allocates PSRAM for
  the current task; outside a scope it is plain `malloc` as before. The net task wraps only the pure seed calls (and
  `toYaml` / `parseConfig` of the result) in it; `applyConfig`, sockets and TLS stay outside, so no DMA buffer lands
  in PSRAM. Measured after: low-water 64.8 KB (big house), 39.5 KB (real house, now set by Config copies in
  `pump` / `getConfig` / `applyConfig` during sign-in, not by the seed).
