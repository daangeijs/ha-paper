# Device log ring, GET /logs and the heap low point (issue #200)

- `include/Logging.h` now sends `LOG_*` through `x4Log()` (`net/log.cpp`) instead of `Serial.printf`: one formatted
  line, redacted (`core/log_ring.cpp redact`, spec `emulator/src/core/logs.ts`), printed on Serial as before and kept
  in a 64 KB PSRAM ring plus a 2 KB tail in `RTC_NOINIT` memory (RTC slow, not heap). Lines are cut at 255 bytes before
  redaction (Serial and ring); the ring stores at most 239. Serial output is redacted too.
- The emulator's lines are its event log: the tag is the first upper-case word of the message (`logSplit`), the level
  is guessed (CRASH → E, failed/refused/rejected/unreachable → W). The firmware has real tags and levels. The browser
  emulator never reboots: `boot=previous` is always empty there; the device-sim keeps `logTail()` of the ring across
  its simulated restarts and crashes, like the RTC tail. A power cut empties the tail on the device (RTC memory is not
  kept); the device-sim has no power cut.
- Previous-boot tail: the RTC ring is written with every line, so a panic or watchdog reset in the middle of a write
  leaves a ring that fails `valid()` and the tail of that boot is lost (an empty `boot=previous`). The panic message
  itself is in GET /diagnostics either way.
- Refresh lines (`[I][APP] EPD full refresh (reason) · 1234 ms`, `EPD partial (reason · N regions) · 312 ms`, `· held`
  on a glance wake) carry the panel call's duration; the emulator's lines do not (no panel).
- `[I][HEAP]` minute line gained `min_dma` and `min_8bit_int`. New `[W][HEAP] low point …` lines and
  `heap.low_point` in GET /diagnostics (net/health.cpp `heapCheckpoint`, after TLS handshakes, HA report pushes, API
  requests and every 10 s; logged when the internal minimum dropped >= 512 B). The device-sim reports a fixed
  `low_point`; the browser emulator `null`.
- Failed heap allocations are counted allocation-free in a `heap_caps_register_failed_alloc_callback` and logged as
  one `[W][HEAP] alloc failed xN …` line per 10 s health tick (net task), not at the moment of failure.
