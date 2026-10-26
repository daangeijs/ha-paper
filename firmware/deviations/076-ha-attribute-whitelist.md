# HA attributes: whitelist at ingest, one mirror (issue #76)

- The emulator has no HA state stream (demo data only), so it has nothing to compare against. The firmware keeps only
  HA attributes a reader uses (`core/ha_stream.cpp` `keepAttr`: the names in `core/entities.h` plus the price keys of
  `hourlyPrices()`); `icon`, `attribution`, `options`, `device_class`, `last_seen` … are dropped for both added (`a`)
  and changed (`c`) entities. A new attribute reader in `core/` must be added to `keepAttr`, or it reads nothing on
  the device.
- `subscribe_entities` diffs apply to `EntityAdapter::raw()` instead of a separate `HaClient` mirror (two copies of
  every entity instead of three). Host measurement (`test/test_ha_stream`, 97 big-house entities, one copy, ESP32
  estimate): 776 attributes / ~103 KB in 1372 blocks before, 180 / ~31 KB in 471 blocks after.
- That alone still left the largest internal block at 19–23 KB on the big-house endurance run (free ~73 KB: the
  remaining small blocks fragment it). `EntityValue`'s strings and map, the adapter's raw states and `EntityStore` now
  use `core/psram_alloc.h` (`PStr`, `PMap`: `heap_caps_malloc(MALLOC_CAP_SPIRAM)`, internal RAM only when PSRAM is
  full; malloc on the host). The global 256 B extmem threshold stays: lowering it broke OTA hashing via DMA. The host
  test checks that building the mirror leaves 0 bytes on the default heap.
