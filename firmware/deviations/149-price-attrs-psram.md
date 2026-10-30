# Price attributes parsed in PSRAM, pool-aware TLS heap guard (issue #149)

- Firmware only (the emulator has no heap split). A Frank Energie price sensor mapped as `sensor.energy_prices` sends
  `prices` (today + tomorrow, 192 quarter-hours {from,till,price}) and `prices_today` (96), ~26 KB per event. The
  attribute text (`scalarText`) and the `x4::Json` DOM `hourlyPrices` builds from it are blocks under malloc's 4 KB
  internal threshold: on QEMU (demo house) the first ingest took the internal low-water 67 → 54.5 KB, the next update
  54.5 → 38.5 KB; The real test display started lower and hit ~1.2 KB.
- `HaClient` now runs every `EntityAdapter` call (entity events, `push`, overrides, energy prefs, device discovery,
  statistics, registry precision) inside `PsramScope` (eink-ha-os#137), which now nests on one task. Measured after: low-water
  75.9 → 74.3 KB over the same sequence. The mirror keeps the raw attribute text as one PSRAM string; nothing else of it
  is stored (the logical keeps 24 hourly values).
- `tlsHeapOk` counts the TLS record-buffer reserve (`net/tls_pool.cpp`): with two of its three slots free (no WebSocket
  open) a handshake needs internal free ≥ 40 KB and a largest block ≥ 4 KB instead of 64 KB / 20 KB. Measured on QEMU:
  the largest non-reserve mbedTLS allocation of a handshake is 944 B, handshake + WebSocket start ~18 KB. Before, a
  heap left fragmented by such an episode (largest block 7.6 KB) refused every reconnect until a restart. With the
  WebSocket open (one slot free) the old rule applies to a second session.
- QEMU only: `POST /__qemu/heap-hog?free=<bytes>` holds internal RAM in 1 KB blocks, `?free=0` lets go (contract test
  for the relink). Fake HA: `POST /__fake/price-sensor {entity_id?, days?}`.
