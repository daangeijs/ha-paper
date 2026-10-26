# Improv Wi-Fi over the USB console (issue #31)

- `core/improv.{h,cpp}` (frames, stream parser, device session; vectors `spec/test-vectors/improv.json`, shared with
  `flasher/src/improv.ts`) + `net/improv_serial.cpp`. Polled from `loop()` after `pump()` (20 ms cadence; one
  `Serial.available()` call when idle), not a task of its own. Joins and scans are posted to the net task and use
  `WifiMgr::connect` / `scanNow`, so an Improv join saves the network and falls back to the saved one on failure
  exactly like a join from the display or `/setup`. Log line: SSID only.
- Commands: Wi-Fi settings, get state, device info (`HA Paper`, version, `xteink-x4-pro/esp32-s3`, hostname), scan,
  get hostname / device name (setting either: error 0x05 / 0x02; the hostname comes from the MAC), network state.
  Every RPC answer starts with error state 0 (spec). Bad checksum: error 0x01.
- Result URLs: `http://ha-paper-XXXX.local/` first, then `http://<ip>/` (Android often can't resolve `.local`).
  The success result arrives ~3 s after the join because `WifiMgr::onConnected()` runs the HA mDNS browse first.
- Frames are written with one `Serial.write()` each (HWCDC holds its tx lock per call, so log lines from other tasks
  land between frames). With `setTxTimeoutMs(1)` a write can come back short; retried up to 50 x 1 ms. A frame lost
  anyway is recovered by the flasher re-asking "get state" every 5 s.
- Always on, also once linked: USB access already allows re-flashing. Under QEMU the same code runs on UART0
  (untested there; only "QEMU-ETH" joins).
- The flasher waits ~10 s (not the ~5 s in the issue) for an answer after reopening the port: Improv answers only
  once `loop()` runs, after panel init and the first full refresh. The request is resent every second.
