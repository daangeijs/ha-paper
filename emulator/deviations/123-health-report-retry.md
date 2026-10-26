# Health report retry (issue #123)

- `reportDue` `last.retry`: a push that got no HTTP answer retries once after 10 s, then every 60 s, like the firmware.
  The emulator has no TLS heap, so the firmware's sign-in retry after closing the WebSocket (`kHttpLowMemory`) has no emulator counterpart.
