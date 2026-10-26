# Stuck panel BUSY: bounded waits, panel given up once (issue #181)

- The freeink SDK's BUSY waits are unbounded on the X4 Pro's UC8179/UC8279 (`BusyPolarity::UcIdleHigh`, "deliberately
  no fixed millisecond timeout") and 30 s on SSD1677, all on loopTask, which the 30 s task watchdog watches. A dead
  panel boot-looped on `TASK_WDT`. We do not edit the vendored SDK (a submodule): the linker wraps
  `EpdBus::waitBusy(const char*)`, `EpdBus::waitBusy(BusyPolarity, const char*)` and `EpdBus::waitRefreshComplete`
  (`-Wl,--wrap`, platformio.ini) and `hw/x4_display.cpp` gates every driver call through `core/panel_guard.h`:
  poll `isBusy()` every 1 ms, feed the watchdog, give up after 20 s (`kPanelBusyMaxMs`). Calls inside `EpdBus.cpp`
  are not wrapped (they run after the gate, BUSY already released). Verified in the x4pro ELF: no driver references
  the raw symbols.
- This puts a 20 s ceiling on the UC idle-high wait the SDK leaves open. A healthy refresh is ~3 s; a panel slower than
  20 s per wait would now be marked failed.
- `waitRefreshComplete` runs the SDK's own wait under `wdt::BlockingCall` after the gate: SSD1677's completion edge can
  trail the gate, and the SDK's ISR wait may then block up to 30 s.
- After the first timeout the panel is failed for the rest of the boot: every later wait returns at once (the rest of
  `begin()` takes milliseconds), `X4Display` skips refreshes and the panel sleep command, the failure is logged once,
  `GET /status` reports `panel: "failed"` and `GET /diagnostics` `panel.failed` / `panel.failure`. No retry until the
  next boot. The last frame is still kept for `preview.png`.
- QEMU has no panel: `QemuDisplay` runs the same guard against a simulated BUSY line, `POST /__qemu/panel?stuck=1|0`
  (x4qemu only; `stuck=0` also clears the failure, which a real panel never does). The emulator and device-sim always
  report the panel ok.
