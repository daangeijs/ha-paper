# TLS next to the WebSocket (issue #123)

- Every TLS caller (WebSocket, token exchange/refresh, health report, address probe, OTA) runs on the net task, so
  two handshakes never overlapped; the failures were one handshake next to the open WebSocket session. mbedTLS
  allocates two 16 KB record buffers per session (`CONFIG_MBEDTLS_SSL_MAX_CONTENT_LEN` 16384, internal RAM) in
  `mbedtls_ssl_setup`; with a 31 KB largest block the second one does not fit and the call fails with `-32512`.
- `net/tls` `tlsConnect` does DNS + TCP + handshake for https:// helpers and the WebSocket, logs
  `[I][TLS] handshake <host>:<port> <ms> ms · internal free … largest … before`, and maps `-32512` to
  `kHttpLowMemory`. A `std::timed_mutex` keeps it to one handshake at a time should a second task ever call it.
  OTA's streamed download and redirect hops still connect inside HTTPClient (not logged).
- Sign-in callback: an exchange that fails with `kHttpLowMemory` closes the HA WebSocket (`HaClient::yieldTls`) and
  retries once; the WebSocket reconnects after the job. HA never saw the first attempt (it failed before the handshake).
- Health report: a push with no HTTP answer (code ≤ 0) gets one early retry after `ha_report::kRetryMs` (10 s), then
  the 60 s gap; the early retry is re-armed by a successful push or an HA reconnect.
- Record-buffer reserve (`net/tls_pool.cpp`, follow-up): CI still failed the report next to the WebSocket with
  `-32512` every 10 s at 105 KB free, largest block 31732 B. A heap walk showed the free space in 17–32 KB pieces split
  by small long-lived blocks, and every mbedTLS allocation ≥ 4 KB is a 16717 B record buffer. mbedTLS now allocates
  those from three static 16.5 KB slots first (`mbedtls_platform_set_calloc_free`), then the heap: the WebSocket holds
  two, a second session takes the third plus one heap block, which the 20 KB largest-block guard already guarantees.
  Cost: +50.7 KB static internal RAM (x4pro 59940 → 110644 B); with the WebSocket open about 15 KB less free heap
  than before (QEMU ~107 → ~93 KB). Not PSRAM: the AES DMA reads these buffers and QEMU's GDMA can't read PSRAM.
