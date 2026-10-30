# Robustness plan

Written 2026-10-15 after comparing HA Paper with [crosspoint-reader](https://github.com/crosspoint-reader/crosspoint-reader)
(CP below), the reader firmware for the same hardware with field mileage on the X4 Pro. Same freeink-sdk (we are one
commit ahead: SSD1677 VCOM 0x30→0x10), same partition layout, both leave NVS alone. The gaps are in our app layer.

Every phase follows the CLAUDE.md rules: emulator/spec first where behaviour changes, DEVIATIONS entries, `make test`,
emulator build, `pio run -e x4pro`, `make qemu-contract`, a blog note. "HW" = can only be checked on a real X4 Pro.

## Phase 0 — small fixes, before the first hardware flash

| # | What | Why (evidence) | Where | Proof |
|---|---|---|---|---|
| 0.1 | `nextTryMs_ = millis()` instead of `0` on HA restart; uptime from `esp_timer_get_time()`; fix `millis() > 30000` | `int32(now - 0) >= 0` is false from day 24.8 to 49.7: an HA relink in that window never connects (ha_client.cpp:249/261) | `net/ha_client.cpp`, `net/web_server.cpp:270`, `net/wifi_mgr.cpp:472` | host test with injected clock (move backoff math to `core/`) |
| 0.2 | `Serial.setTxTimeoutMs(1)` on the device (not QEMU) | Logs go to USB-Serial/JTAG from four tasks; with no host reading, each line can block 100 ms. CP: `main.cpp:440` "load-bearing 1" | `main.cpp` | HW: latency on battery, no host |
| 0.3 | Touch recovery: power-cycle GT911 (GPIO2 HIGH ~100 ms, `begin()` again) if absent at boot; ACK-probe every 60 s, recover after 3 misses | A software restart doesn't power-cycle the rails (crosspoint-reader#3564, X4 Pro); today a failed probe means no touch until power-off | `hw/x4_board.cpp` | HW: 20× `POST /device/restart` |
| 0.4 | Boot loop out of busy waits: input via GT911 INT / button interrupts, no `delay(1)` loop | Prerequisite for any power saving | `main.cpp`, `hw/x4_board.cpp` | QEMU contract + OTA; HW latency < 150 ms |
| 0.5 | Toolchain 55.03.37 → 55.03.311 (Arduino 3.3.11, IDF 5.5.5), the version CP runs in the field | Fixes for LEDC busy-wait WDT (front light), `NetworkClient::connected()` stale errno (HA WebSocket), Wire, LittleFS races | `firmware/platformio.ini`, `requirements.txt` | full checklist + `make qemu-ota` + size report |

## Phase 1 — diagnostics (so HW problems can be seen without a USB cable)

- Reset-reason ring (last 8 boots: reason, uptime, version, min free heap) in `RTC_NOINIT`, persisted to LittleFS.
- Panic message via `-Wl,--wrap=panic_abort` (CP `lib/hal/HalSystem.cpp`).
- Core dump summary: the `coredump` partition (0xFF0000) and `ESP_COREDUMP_ENABLE_TO_FLASH` already exist; we never read them.
- Panel detection diag (probe verdict, VER bytes, NVS `hw_calib/screenType` read-only). Fix the misleading "(NVS hw_calib)" log in `x4_display.cpp:37-40`.
- Heap: largest free internal block + minimum free heap.
- API: `GET/DELETE /api/v1/diagnostics`, `GET /api/v1/diagnostics/coredump`; "Last crash" card in the console. openapi + emulator stub + contract suite first.
- Proof: ring logic host-tested; QEMU env that aborts after confirming and checks the next boot reports PANIC + summary.

## Phase 2 — staying up for months

- Task watchdog for confirmed images: 30 s, panic on, loop/x4input/x4net subscribed, fed in OTA and HTTPS loops (CP `util/TaskWatchdog.h`). Today only unconfirmed images are guarded.
- Heap guard: refuse TLS/OTA below ~40 KB largest free block (CP measured 60 KiB lost per Wi-Fi session, crosspoint-reader#3564); if it stays low, a maintenance restart in the 03:00–04:00 window when no OTA runs.
- Wi-Fi escalation: after 10 min offline `WiFi.mode(OFF)→STA→begin`; after 60 min, the maintenance restart. Power save off during OTA, upload and HA auth. Jitter on HA backoff.
- Brownout: count consecutive `ESP_RST_BROWNOUT`; from the 2nd, lower TX power and defer gray refreshes during OTA. HW only.
- Proof: QEMU env with a deliberate hang in a confirmed image ends in a TASK_WDT reset visible in diagnostics.

## Phase 3 — power management (biggest change, details in the power section below)

Today "standby" only changes the screen; the chip runs at 240 MHz with busy loops: est. 15–25 h on the 1100 mAh
battery (estimates, to be measured).

| Step | What | Est. battery |
|---|---|---|
| 3.0 | Instrument: `power{source, charging, cpuMhz, wifiPs, mode, nextWake}` in `/status`; log at boot | — |
| 3.1 | Spec in the emulator: pure `powerDecision()` + test vectors (`spec/test-vectors/power/`), setting `powerSave: off/night/standby`, `wakeEvery`, device state `asleep` ("Asleep · wakes HH:MM") | — |
| 3.2 | Awake savings: `esp_pm` 80–240 MHz with a `PerfLock` around TLS/OTA/renders; modem sleep on battery | 1.2–1.7 days |
| 3.3 | Deep sleep at night (opt-in) | ~12 days with 3.5 |
| 3.4 | Deep sleep in standby, timer wake every 15 min, cached BSSID/IP/HA token in RTC memory, 20 s awake cap | ~2 months |
| 3.5 | Automatic light sleep (may need `custom_sdkconfig`; highest risk) | 5–14 days |

Rules that must hold:
- **Never deep-sleep while the image is unconfirmed** (`PENDING_VERIFY`): a wake is a reset, and a reset rolls back. Also not during OTA, in AP/setup mode, within 2 min of an API request, or with unknown battery.
- On external power (charging, USB-JTAG connected, or charged within 30 min and ≥ 4.15 V): full speed, no sleep.
- Always arm a timer wake (≤ 8 h) so a missed wake source can't leave the device off. Wakes: Power (GPIO3), Right (GPIO7), charger STAT (GPIO21). Left (GPIO0) stays out until HW shows it doesn't start download mode.
- Hold GPIO1 (power latch) HIGH through deep sleep, or the X4 Pro cold-boots instead of waking (CP `HalPowerManager.cpp`).
- Touch cannot wake from deep sleep (rail off), same trade-off as CP.
- Re-sync time from the BM8563 after deep sleep (internal RC drifts minutes over 8 h).
- Below 5 % and not charging: "Charge me" face, deep sleep with button/charger wake only.
- QEMU: simulate deep sleep as RTC-save + fake wake cause + `esp_restart()`; test that a pending image refuses to sleep and that the 03:00 wake runs the install path.

## Phase 4 — polish

- Ghosting: count tap-feedback partials at half weight; time-based full refresh (e.g. 4 h). Async gray refresh (CP `displayBufferAsync`): skip, little gain for a dashboard.
- CW2017 recovery can block the input task ~4 s: move battery polling to its own cadence.
- A full battery on USB reads "not charging" (STAT drops; no confirmed VBUS pin): label honestly.
- CI: `pio check -e x4pro` (cppcheck, src only). clang-format needs a one-time reformat commit: owner's call.

## Phase 5 — from the broader CP sweep (app layer)

- Input: CP `src/MappedInputManager.h` classifies long press, swipe and touch-hold, and swallows the release after a
  long press. Compare with our `hw/x4_board.cpp` swipe code and the emulator's input model; adopt what the emulator
  spec allows (spec change first).
- Settings migration: CP `CrossPointSettings.cpp` + `lib/Serialization/PersistableStore.h` keep versioned settings.
  We store settings in NVS/LittleFS with no version field: add one before the first public release, so a later
  firmware can migrate instead of resetting.
- Fonts: CP `lib/EpdFont/scripts/fontconvert.py` does 2-bit glyphs with forced autohint and DEFLATE. Check if 2-bit
  text on our 4-gray panel is worth the flash; our generator is `firmware/scripts/`.
- Dev tooling: CP `scripts/debugging_monitor.py` (colour log monitor with heap plots). Cheap; pairs with Phase 1.

## Investigate further

1. How CP's hosted web flasher is built (source not in the main repo): library, backup, NVS handling, hosting.
2. Other X4 firmwares on GitHub (`gh search repos xteink`) and what each does better.
3. Factory reset and config export/import from the web console without losing the device key.
4. Whether light sleep at night (wake on button/charger) keeps the HA WebSocket usable, vs deep sleep.
5. Translations: CP generates C++ from YAML (`lib/I18n`). Only if the owner wants more than English/Dutch.

## Not taken from CP

- Web flasher: owner chose the CLI (`x4flash.py`), which also makes the stock backup.
- Their unlocker for USB-locked third-party units: it only supports CP/CrossInk; we document the lock and stop.
- Crash reports on SD: we don't mount SD; LittleFS + API instead.

## Hardware test list (first flash)

Panel detection on both controllers · touch after 20 warm restarts · latency on battery without host · currents in
each power mode and deep-sleep floor (< 200 µA) · GPIO0 wake vs download mode · pogo unplug while asleep · brownout
with low battery during OTA · `ESP_RST_BROWNOUT` recorded · SDK VCOM commit vs CP's pin if partials look wrong.
