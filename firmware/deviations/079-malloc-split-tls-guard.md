# malloc split back to 4 KB, TLS heap guard by measurement (issue #79)

- eink-ha-os#62 lowered the PSRAM split for plain `malloc` from Arduino's 4 KB to 256 B. That was wrong: libraries hand plain
  `malloc`'d buffers to DMA peripherals. `NetworkClientSecure` allocates its `sslclient_context` (2096 B) with `new`;
  it holds the CTR_DRBG state, and `ctr_drbg_update_internal` passes its counter to `esp_aes_crypt_ecb` → AES GDMA.
  QEMU's GDMA can't read PSRAM (`[AES] Error reading from GDMA buffer`), the AES driver spins, and every https call
  hung until the 120 s blocking-call watchdog reset the device. The OTA SHA bounce buffer (eink-ha-os#57) was the same bug.
  Real hardware can DMA from PSRAM; not measured there. The split is Arduino's 4 KB again; HA data that fragmented
  internal RAM uses PSRAM explicitly (`net/psram.h`, `core/psram_alloc.h`). The OTA bounce buffer stays.
- TLS guard (`core/net_policy.h`): largest internal block ≥ 20 KB and internal free ≥ 64 KB, instead of largest
  ≥ 40 KB. Measured on QEMU with a hook on mbedTLS's allocator: a handshake to example.com peaks at ~45 KB in total,
  the biggest single piece is 16,717 B (record buffer, `MBEDTLS_SSL_MAX_CONTENT_LEN` 16384, one in + one out). On the
  device the largest internal region is 40,948 B, so the old 40,960 B rule refused TLS forever ("skipping TLS",
  HA report -100) even on an idle heap.
- `httpProbe`/`httpGet`/… set the TLS handshake timeout from their own timeout (at most 10 s), so a 5 s probe can't
  sit 10 s in a stalled handshake.
- x4qemu only: `hw/qemu_tls.cpp` (`-Wl,--wrap=esp_crt_bundle_attach`) also trusts the test CA of `sim/qemu/tls/`, so
  `make qemu-contract` probes the fake HA over https (`FAKE_HA_TLS_PORT`, default `FAKE_HA_PORT`+1): one real
  handshake with certificate and name check.
- Console: `POST /auth/ha/start` without an answer in 20 s → "Home Assistant didn’t answer: check the address.", the
  button is enabled again (`webconsole/httpApi.ts`, shared by the emulator console and the device's www).
