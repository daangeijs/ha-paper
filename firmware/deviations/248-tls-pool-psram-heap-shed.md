# TLS record pool in PSRAM, Wi-Fi TX 8, WebSocket shed under a heap floor (issue #248)

- x4pro: the 4 x 16,896 B mbedTLS record-buffer reserve (`net/tls_pool.cpp`) moved from internal .bss to one 64 B
  aligned PSRAM block, allocated in `tlsPoolBegin()` (internal heap if PSRAM is missing). Record buffers that miss
  the reserve also go to PSRAM first. Static internal RAM: 128,764 → 61,196 B. IDF 5.5's AES DMA driver
  (`esp_aes_dma_core`) DMAs from PSRAM itself (cache msync, aligned bounce for unaligned ends). Boot log:
  `TLS: record buffers in a 4 x 16896 B PSRAM pool`. x4qemu keeps the internal .bss pool (QEMU's GDMA can't read
  PSRAM, #79), so QEMU does not exercise this path; real-hardware TLS through PSRAM record buffers is untested.
- x4pro: Wi-Fi dynamic TX buffers 12 → 8 (`Wi-Fi buffers: … dynamic TX 8 …`). Dynamic RX stays 12, RX BA window 6.
- Heap shed (`core/net_policy` `HeapStarve`, `net/health.cpp`): internal free < 24 KB or DMA free < 16 KB on every
  2 s sample for 10 s → the HA WebSocket closes (`[W][HA] WebSocket closed: internal RAM under the floor · retry in
  60s`) and stays off 60 s; the TLS guard decides the reconnect. Once per low spell; re-arms at floor + 8 KB. The
  emulator has no heap.
- HTTP: under 12 KB internal or 8 KB DMA free a new connection gets the transport-level `503` + `Retry-After: 2` of #198
  (`[W][WEB] internal RAM low · … refused N (503)`), so the console's state poll and preview.png can't take the RAM
  the Wi-Fi driver needs. The beta.2 `abort() at 0x4037ea73` decodes (rebuilt beta.2 ELF) to `_esp_error_check_failed`,
  whose only runtime callers are the Wi-Fi/coex `ets_timer_*` wrappers: a Wi-Fi driver timer allocation failed.
- Heap marks: `[I][HEAP] mark <what> · internal free N (±Δ) …` before/after Wi-Fi start, at Wi-Fi connected, WebSocket
  auth_ok and every 10 HA entity events; the TLS handshake line adds `free N B after`. QEMU (15 min, 200 events over
  http; 60 over TLS): internal free flat at ~145 / ~134 KB, no creep from the HA stream.
