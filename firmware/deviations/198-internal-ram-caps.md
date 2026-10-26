# Internal RAM caps: Wi-Fi buffers, TLS allocations, open HTTP connections (issue #198)

- HTTP: the device answers `503` with `Retry-After: 2` (empty body) to a new connection while 8 are open
  (`net/web_server.cpp` `kMaxConns`). The server closes every connection after its response, so 8 = requests in
  flight: one browser (≤ 6 per host) plus two API clients. The emulator and device-sim have no cap. Refusals log one
  rate-limited `[W][WEB]` line. Not in `spec/openapi.yaml` (transport level, every path).
- Wi-Fi (x4pro only, `-Wl,--wrap=esp_wifi_init` in `net/wifi_mgr.cpp`): dynamic RX 32 → 12, dynamic TX 32 → 12,
  RX BA window 6; static RX 4 and cache TX 4 as Arduino sets them. Logged once at boot (`[I][NET] Wi-Fi buffers: …`).
  QEMU has no Wi-Fi driver. Throughput and RSSI side effects are untested on hardware.
- TLS (x4pro only, `net/tls_pool.cpp`): mbedTLS allocations ≤ 16 KB (certs, MPI, handshake, cipher contexts) go to
  PSRAM, internal RAM if PSRAM is full; record buffers stay in the internal pool / internal heap. QEMU keeps all of it
  internal (its GDMA can't read PSRAM), so the contract suite does not cover the PSRAM path. Boot log:
  `[I][NET] TLS: record buffers in a 4 x 16896 B internal pool (#198), other mbedTLS allocations in PSRAM|internal RAM`.
