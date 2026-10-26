# Hardware assumptions ledger

Everything the firmware assumes about the X4 Pro that we have not seen on our own unit (#49). Most pin facts come
from the freeink-sdk `XTEINK_X4_PRO` profile (`firmware/vendor/freeink-sdk/libs/hardware/BoardConfig/include/BoardConfig.h`,
submodule commit e91e34e), whose authors marked many of them "confirmed on hardware". That is their unit, not ours,
so every row starts `unverified`.

How to use it: [FIRST_FLASH.md](FIRST_FLASH.md) step N checks the rows that name it. On first-flash day, set
*Status* to `confirmed`, `wrong: <what is true>` or leave `unverified`, and link the issue for anything wrong. Pins
are summarised in [HARDWARE.md](HARDWARE.md); this file says where the code depends on them.

"SDK" below = the BoardConfig profile above.

## Board, flash, memory

| # | Assumption | Where it lives | How we verify | Step | Status |
|---|---|---|---|---|---|
| A1 | Flash is 16 MB, DIO | `firmware/platformio.ini` (`flash_size`, `flash_mode`), `Makefile` `FLASH_SIZE_BYTES`, `firmware/partitions.csv`, `x4flash.py`, flasher | `esptool flash-id`: `Detected flash size: 16MB` | 2 | unverified |
| A2 | 8 MB octal PSRAM (`memory_type = dio_opi`, `esp32-s3-devkitc1-n16r8`) | `platformio.ini`, `-DBOARD_HAS_PSRAM`; gray planes `hw/x4_display.cpp`; boot check `main.cpp` | `chip-id` `Features:`; boot log `PSRAM <n> KB free`; `/status` `free_psram` | 2, 7, 11 | unverified |
| A3 | Unit is not locked: no secure boot, no flash encryption, USB download enabled | `Makefile` `chip-check`, `firmware/tools/x4flash.py`, `flasher/` | `make chip-check` | 2 | unverified |
| A4 | Stock partition table has NVS at 0x9000, size 0x5000 (ours keeps it there) | `firmware/partitions.csv`; flasher's partition check | parse 0x8000 of the backup with `gen_esp32part.py` | 4 | unverified |
| A5 | OEM `hw_calib/screenType` lives in that NVS; we only read it, never decide on it | `hw/x4_display.cpp` `panelDiag()`; factory reset keeps it | `strings` on the backup's NVS; `/diagnostics` `panel.nvs_screen_type` | 4, 11 | unverified |
| A6 | Stock boots app1; writing `boot_app0.bin` to otadata (0xE000) makes app0 (ours) boot | `Makefile` `flash`, FLASHING §3 | our banner on the first boot | 7 | unverified |
| A7 | GPIO1 is the master rail latch: HIGH keeps the board on when it runs on battery (and powers the touch rail) | SDK `power.latch0 = {1}`; asserted and pad-held (`gpio_hold_en`) from a global constructor in `hw/x4_board.cpp`, before Arduino's init (#225); kept through esp_restart, OTA, panic and watchdog resets | `[I][POWER] latch GPIO1 HIGH · held · asserted N ms after power-on` | 7, 8 | confirmed while running (#225: a boot started by USB stays up on battery after unplugging, 624 s); deep sleep: see A32 |

## Display

| # | Assumption | Where it lives | How we verify | Step | Status |
|---|---|---|---|---|---|
| A8 | SPI: SCLK 12, MOSI 11, CS 13, DC 18, RST 14, BUSY 6 (busy HIGH), 10 MHz | SDK (`XTEINK_DISPLAY_SPI_HZ`); legacy ctor args in `hw/x4_display.cpp` | first full refresh | 8 | unverified |
| A9 | The VER/FLG probe on the display bus picks SSD1677 vs UC8179/UC8279 correctly | `XteinkDetect` (SDK), `hw/x4_display.cpp` `begin()` | `[EPD] controller …` line, `/diagnostics` `panel` | 7, 8, 11 | unverified (one unit = one controller; the other batch stays unverified) |
| A10 | SSD1677 VCOM 0x10 (our SDK commit) gives clean partials; crosspoint pins 0x30 | vendored FreeInkDisplay SSD1677 driver | partials smeared or low contrast → compare | 12 | unverified |
| A11 | A partial refresh only drives B/W: grays redrawn by a partial turn black or white, so partial-drawn content is ink/paper only (#38) | `hw/x4_display.cpp` `partialRefresh()`, `core/panel` rule, `firmware/DEVIATIONS.md` "Black/white only" | photo of a gray area after a partial | 12 | unverified |
| A12 | 2-bit anti-aliased fonts read well at 2 m; Sleek surface `dots` survives partials, `dither` doesn't | `firmware/src/app/gen/fonts*.cpp`, `gfx/canvas.cpp` `toneInk()`; #29 | look from 2 m, both surfaces | 12 | unverified |
| A13 | A full refresh takes ~3 s (far under the 30 s task watchdog) | comment in `main.cpp` before `g_board.begin()`; `hw/watchdog` | stopwatch / video | 8 | unverified |
| A14 | Windowed partial (area < 50 % of the panel, x aligned to 8 px) works on the detected controller | `hw/x4_display.cpp` `X4_EPD_WINDOWED` | minute tick redraws only the clock | 12 | unverified |
| A15 | Panel needs no mount transform (`NO_FLIP`, "pending hardware" in the SDK) | SDK profile | image upright, not mirrored | 8 | unverified |

## Touch and keys

| # | Assumption | Where it lives | How we verify | Step | Status |
|---|---|---|---|---|---|
| A16 | GT911 at 0x5D (alt 0x14) on SDA 39 / SCL 38, 400 kHz, INT 10, RST 4; rail on GPIO2 active-LOW; `swapXY` + `flipY` | SDK `touch`; `hw/x4_board.cpp` | corner taps, on-screen keyboard | 9, 13 | unverified |
| A17 | Driving GPIO2 HIGH for 100 ms really power-cycles the GT911 (I2C pull-ups may back-power it, #4) | `hw/x4_board.cpp` `recoverTouch()`; ACK probe every 60 s, 3 misses | 20 warm restarts, `touch_recoveries` | 7, 13 | unverified |
| A18 | GT911 INT edges arrive (trigger mode comes from its self-loaded OEM config, unknown): armed on both edges, 15 ms poll until one is seen | `hw/x4_board.cpp` `armTouchIrq()`, `kFallbackPollMs`; DEVIATIONS "Main loop / input cadence" | tap latency feels instant | 13 | unverified |
| A19 | Capacitive Home key = GT911 reg 0x814E bit 0x10 | SDK (`hasHomeKey`), InputManager | Home key returns to Home | 13 | unverified |
| A20 | Keys active-LOW with pull-ups: Left GPIO0, Right GPIO7, Power GPIO3; interrupts on both edges | SDK `buttons`; `hw/x4_board.cpp` `attachInterrupt(…, CHANGE)` | one press = one page | 14 | unverified |
| A21 | GPIO0 (Left) held at reset = download mode; therefore not used as a deep-sleep wake | SDK comment; `core/recovery.h` keeps Left out of the reset combo; ROBUSTNESS_PLAN Phase 3 | Left + Reset → ROM loader answers | 14 (wake part: sleep built in #10, untested on hardware, #20) | unverified |
| A22 | Power + Right held together read as both held (no key ghosting) | `core/recovery.h` (`kResetHoldMs` 5 s, `kResetConfirmMs` 10 s), `X4Board::heldKeys()` | reset screen appears, times out | 14 | unverified |

## Power, battery, clock

| # | Assumption | Where it lives | How we verify | Step | Status |
|---|---|---|---|---|---|
| A23 | `Serial.setTxTimeoutMs(1)` stops logging from blocking when no USB host reads (crosspoint's "load-bearing 1") | `main.cpp` after `Serial.begin` | key latency on battery vs USB | 14 | unverified |
| A24 | USB host presence = `HWCDC::isPlugged()` (SOF); there is no VBUS pin (SDK: `usbDetect` unassigned, GPIO10 a "candidate", but GPIO10 is the touch INT) | `net/util.cpp` `usbHostPlugged()`; `core/power.h` `powerSource()` | `/status` `power.source` on computer vs wall charger | 15 | unverified |
| A25 | Charger STAT on GPIO21, HIGH while charging, drops when full | SDK (`batteryChargeStatusActiveHigh`); `hw/x4_board.cpp` `readBattery()` | `power.charging` plugged / unplugged | 15 | unverified |
| A26 | CW2017 at 0x63 on the shared I2C bus; SoC in reg 0x04; the 80-byte BATINFO profile (from the OEM app) fits our cell; recovery: 20 ms between MODE writes, VERSION up to ~1 s, SoC up to ~3 s; poll every 30 s | `core/cw2017.{h,cpp}`, `hw/x4_board.cpp` | `/status` `battery` vs the stock UI; no long freeze at boot | 15 | unverified |
| A27 | Battery is 1100 mAh | ROBUSTNESS_PLAN Phase 3, `emulator/src/core/power.ts` | label on the cell; drain test in POWER_BUDGET | — | unverified |
| A28 | CW2017 VCELL at 0x02/0x03 is a 14-bit big-endian cell voltage, 312.5 µV/LSB (datasheet; vendor/OEM formula `(raw * 5 + 8) >> 4`). Read with every SoC (#73) and fed to `core/power`: charged within 30 min (since boot) and ≥ 4.15 V counts as external power | `core/cw2017.cpp` `cw2017Millivolts()`, `net/power.cpp` `inputs()`, `spec/test-vectors/cw2017-vcell.json` | `/status` `battery_mv` within ~50 mV of a multimeter on the cell; ≈ 4.15-4.2 V full on a charger, falls when unplugged | 15 | implemented, unverified |
| A29 | BM8563 RTC at 0x51 keeps UTC across resets; boot sets the system clock from it | `hw/x4_board.cpp` `begin()`, `writeRtcFromSystemClock()` | second boot logs `clock from BM8563: …` | 7 | unverified |
| A30 | Front light: cool GPIO8, warm GPIO9, LEDC 25 kHz, 10-bit, active HIGH | SDK `frontlight`; `app/app.cpp` `board.setFrontlight()` | brightness and warmth sweep | 16 | unverified |
| A31 | The LEDC busy-wait watchdog bug is gone with platform 55.03.311 | `platformio.ini` platform URL; ROBUSTNESS_PLAN 0.5 | no `TASK_WDT` in `/diagnostics` after dimming | 16 | unverified |
| A32 | Deep sleep floor < 200 µA, with GPIO1 held HIGH through sleep (else a cold boot instead of a wake); touch can't wake (rail off) | ROBUSTNESS_PLAN Phase 3; built in #10: `net/power.cpp` `enterSleep()`, latch hold in `hw/x4_board.cpp` (`gpio_hold_en`) | PPK2, [POWER_BUDGET.md](POWER_BUDGET.md) (#19) | #19, #20 | implemented; **suspect** (#225: on battery, after Power → standby the board came back as POWERON with RTC memory lost, twice, never as DEEPSLEEP). Check: `/logs` `[W][POWER] power was lost while asleep` after the next POWERON, or POST `/device/sleep` 60 s on battery → DEEPSLEEP in `/diagnostics` |
| A33 | A brownout during OTA at low battery is recorded as `ESP_RST_BROWNOUT` | `net/diag.cpp` reason names; response in #8 | controlled low-battery OTA | after #8 | unverified |
| A34 | Unplugging the pogo adapter while asleep does no harm | ROBUSTNESS_PLAN hardware test list | unplug during a glance sleep, then wake (sleep built in #10) | #20 | unverified |
| A35 | Wi-Fi runs with modem sleep `min` on battery, none on USB (#177); off during OTA and HA auth; CPU 80 MHz on battery keeps panel SPI, I2C, UART working (APB stays 80 MHz) | `net/power.cpp`, `net/health.cpp` | log `[POWER] CPU auto · 80 MHz`, `Wi-Fi PS min`; `/status` `power.cpuMhz`, `power.wifiPs`, `power.applied` | 7, 11 | unverified |
| A40 | Power on from fully off (battery only) = hold Power: the button powers the board only while held, until the firmware drives GPIO1 HIGH. Stock does the same ("Hold Power to turn on", a boot gate that measures the hold and powers off a POWERON without the key; strings in the stock dump) | `hw/x4_board.cpp` `powerLatchEarly()` | from off, hold Power ~1-2 s → boot screen; `[I][POWER] latch … asserted N ms after power-on` gives the minimum hold | #225 | unverified; a short press after the #225 power loss did not start it |
| A41 | No long-press power-off: a long Power press only logs `[I][POWER] Power key held N ms`. A real off (latch LOW) needs A40 confirmed first; a deep-sleep "off" needs A32 | `net/power.cpp` `powerLoop()` | hold Power 5 s → standby face, log line, no reset | #225 | decided (#225) |

## Network

| # | Assumption | Where it lives | How we verify | Step | Status |
|---|---|---|---|---|---|
| A39 | HA advertises `_home-assistant._tcp` with `internal_url` on the user's LAN, and multicast reaches the X4 over Wi-Fi (no AP isolation / IGMP snooping drop) | `net/wifi_mgr.cpp` `discoverHa()`; QEMU injects the result instead (#90, DEVIATIONS) | `dns-sd -B/-L` on a laptop vs the X4's `mDNS _home-assistant._tcp → n found` line | 9b | unverified |

## Tooling and USB

| # | Assumption | Where it lives | How we verify | Step | Status |
|---|---|---|---|---|---|
| A36 | Improv answers on the USB console after the post-flash reset; the browser re-finds the port after re-enumeration | `net/improv_serial.cpp`, `flasher/src/main.ts` (step 4) | browser flasher Wi-Fi step | 21 | unverified |
| A37 | esptool resets into the ROM loader over USB-Serial/JTAG by itself; Left + Reset when it doesn't | FLASHING §0 | first `chip-check` | 1, 2 | unverified |
| A38 | The coredump partition (0xFF0000) and `--wrap=panic_abort` capture a real crash on the device | `net/diag.cpp`, `platformio.ini` | only if something crashes: `/diagnostics` `coredump` | 11 | unverified |

Not listed: the microSD slot (GPIO5 power, SDMMC pins) and the IMU. The firmware uses neither.
