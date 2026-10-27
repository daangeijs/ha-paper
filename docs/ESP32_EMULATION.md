# ESP32-S3 emulation (no hardware yet)

Status: **prototype working** on Apple Silicon macOS (2026-10-13) and Linux x86_64 (CI). Espressif QEMU boots our platform
(pioarduino Arduino 3.3.11 / ESP-IDF 5.5.5 since 2026-10-15, before that 3.3.7 / 5.5.2; 16 MB DIO flash, 8 MB octal PSRAM, our `partitions.csv`) and
runs NVS, LittleFS, OTA + rollback, lwIP networking, an HTTP server reachable from the Mac and outbound
TCP to the Mac. Display, touch, Wi-Fi, I2C peripherals are not emulated.

## TL;DR verdict

| Feature | Espressif QEMU (free) | Wokwi (paid for our use) | `emulator/` TS app | `env:native` tests |
|---|---|---|---|---|
| Boot / bootloader / partition table / panic+reset | ✅ verified | ✅ | – | – |
| 8 MB octal PSRAM | ✅ verified (needs `is_octal=true`, see below) | ✅ (`psramSize`) | – | – |
| NVS (Preferences) | ✅ verified, persists across runs | ✅ (per session) | – | mock |
| LittleFS | ✅ verified (auto-format, persists) | ✅ | – | – |
| OTA download + write + reboot | ✅ verified (HTTP upload → `app1`) | ✅ (HTTP via gateway) | – | – |
| Rollback (PENDING_VERIFY → invalid → previous app) | ✅ verified | ✅ likely | – | logic only |
| Wi-Fi (STA/AP, provisioning) | ❌ not emulated; `WiFi.mode()` **hangs** | ✅ `Wokwi-GUEST` | UX only | – |
| Networking (lwIP, DNS, TCP, TLS) | ✅ via `open_eth` (vendored driver, `-DX4_QEMU`) | ✅ via Wi-Fi | – | – |
| Web server + REST API from the Mac | ✅ `hostfwd` → `http://127.0.0.1:8080` | ✅ `net.forward` (Private Gateway: Hobby+) | ✅ (mocked) | handlers ✅ |
| HA WebSocket client | ✅ guest reaches host at `10.0.2.2` (run HA/mock on the Mac) | ✅ | mocked | protocol ✅ |
| E-ink SSD1677 (SPI2) | ❌ no GPSPI2 model | ⚠️ only via a custom chip (C/WASM SPI + framebuffer API) | ✅ pixel-exact UX | PGM output |
| GT911 touch / CW2017 / BM8563 (I2C) | ❌ no I2C on `esp32s3` machine | ⚠️ custom chips (I2C API) | ✅ simulated input | – |
| USB-CDC `Serial` (`ARDUINO_USB_CDC_ON_BOOT=1`) | ❌ USB-Serial-JTAG is a stub → output lost; use UART0 | ✅ | – | – |
| Cost / CI | free, GPL, runs headless in CI | VS Code: Hobby+ €8.1/mo; CLI in CI: Pro €20/seat/mo, no commercial use below Pro | free | free |

## 1. Espressif QEMU — what we found

* **Binary**: `qemu-system-xtensa` from [espressif/qemu releases](https://github.com/espressif/qemu/releases)
  (`esp-develop-9.2.2-20260417`, `aarch64-apple-darwin` tarball; also installable with
  `idf_tools.py install qemu-xtensa`, see [IDF QEMU guide](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md)).
  macOS needs Homebrew dylibs: `brew install libgcrypt glib pixman sdl2 libslirp` (without them: `dyld: Library not loaded: libgcrypt.20.dylib`).
  `sim/qemu/run.sh` downloads it into `sim/qemu/.state/qemu` automatically.
* **`-machine esp32s3` peripherals** (source: [hw/xtensa/esp32s3.c](https://github.com/espressif/qemu/blob/esp-develop/hw/xtensa/esp32s3.c)):
  UART0/1, SPI1 + SPI flash (DIO/QIO), PSRAM, cache/MMU, eFuse (file-backed), GPIO, interrupt matrix,
  systimer, TIMG0/1 (WDT), RTC_CNTL (sw reset works), GDMA, SHA/AES/RSA/HMAC/DS/XTS-AES (flash encryption),
  RNG, TWAI, SDMMC, an "RGB" virtual framebuffer (`-display`, QEMU-specific, not a real LCD controller),
  OpenCores Ethernet `open_eth` (QEMU-only MAC). **Not modelled**: Wi-Fi/BT, I2C, GPSPI2/3, LEDC, ADC,
  USB-OTG; USB-Serial-JTAG is an empty stub; RMT/IOMUX are "unimplemented" regions.
* **PSRAM gotcha**: the model defaults to *quad* PSRAM. Our `dio_opi` libs then print
  `octal_psram: PSRAM chip is not connected, or wrong PSRAM line mode` and boot without PSRAM.
  Fix: `-m 8M -global driver=ssi_psram,property=is_octal,value=true` (property found in
  [hw/misc/ssi_psram.c](https://github.com/espressif/qemu/blob/esp-develop/hw/misc/ssi_psram.c)).
* **Console gotcha**: env `x4pro` sets `ARDUINO_USB_CDC_ON_BOOT=1` → `Serial` is USB-Serial-JTAG, which QEMU
  drops. The stock `x4pro` image boots silently (verified). QEMU builds must use `ARDUINO_USB_CDC_ON_BOOT=0`.
* **Networking**: Wi-Fi is not emulated; the supported path is `-nic user,model=open_eth` + IDF's
  `CONFIG_ETH_USE_OPENETH`. The precompiled pioarduino IDF libs are **not** built with it
  (`esp_eth_mac_new_openeth` absent from `libesp_eth.a`; header present but `#if`-guarded). Two options:
  1. **(done)** vendor the 3 driver files from ESP-IDF `release/v5.5` (`esp_eth_mac_openeth.c`, `openeth.h`,
     `esp_openeth.h`, + `esp_eth_phy_generic.c`, Apache-2.0) as a library and compile with
     `-DCONFIG_ETH_USE_OPENETH=1` → `sim/qemu/lib/qemu_openeth`. Works with the stock Arduino libs; everything
     above lwIP (WebServer, AsyncTCP, HTTPClient, WebSockets, mbedTLS) is unchanged.
  2. pioarduino `custom_sdkconfig = CONFIG_ETH_USE_OPENETH=y` rebuilds the IDF libs (slow, needs IDF download).
  Slirp: guest gets `10.0.2.15`, host is `10.0.2.2`, `hostfwd=tcp:127.0.0.1:8080-:80` exposes the web server.
  On S3 the driver reuses the **Wi-Fi MAC interrupt source** → never start Wi-Fi in a QEMU build.
* **Flash image**: `esptool --chip esp32s3 merge-bin --fill-flash-size 16MB` of bootloader@0x0,
  partitions@0x8000, `boot_app0.bin`@0xe000, app@0x10000. The image file is written back by QEMU, so
  NVS/userdata/www/otadata persist between runs (like a real chip). `run.sh --fresh` wipes it.
* **OTA/rollback**: the Arduino bootloader has `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`. Upload → `Update`
  → reboot (`rst:0xc RTC_SW_CPU_RST`) → `app1 PENDING_VERIFY` → `esp_ota_mark_app_invalid_rollback_and_reboot()`
  → back on `app0` — all verified. Note Arduino auto-confirms new images unless `verifyRollbackLater()`
  returns true (our `firmware/src/net/ota.h` already plans that).

## 2. Wokwi

* ESP32-S3 DevKitC board with `flashSize`/`psramSize` attrs, Wi-Fi emulation (`Wokwi-GUEST`), serial,
  [VS Code extension + `wokwi.toml`](https://docs.wokwi.com/vscode/project-config) incl. `[[net.forward]]`
  port forwarding and a bundled Private IoT Gateway (reach `localhost`/LAN, e.g. a real HA).
* [Custom chips API](https://docs.wokwi.com/chips-api/getting-started) (C or any WASM language) has
  SPI device, I2C device, GPIO, UART and **framebuffer** APIs → an SSD1677 (800×480, SPI cmd/data + BUSY pin)
  and GT911 (I2C regs + INT) chip is feasible (~1–2 days each); there is no stock SSD1677/GT911 part.
* [Pricing](https://wokwi.com/pricing): Community free (no VS Code ext, no gateway, non-commercial);
  Hobby €5.6/mo (gateway); Hobby+ €8.1/mo (VS Code ext); Pro €20/seat/mo (CI 2000 min/mo, commercial).
  `wokwi-cli` runs on macOS/Linux with `WOKWI_CLI_TOKEN`.
* Closed source/hosted engine; best fidelity for Wi-Fi provisioning flows. `sim/wokwi/{wokwi.toml,diagram.json}`
  are provided but **untested** (no token in this environment).

## 3. Other options

* **Renode**: Xtensa support exists (Antmicro, for SOF) and a community
  [renode-esp32s3](https://git.xobs.io/xobs/renode-esp32s3) WIP, but no usable S3 peripheral set → not viable.
* **`env:native`** (already in `firmware/platformio.ini`): host build of `src/core` against
  `spec/test-vectors` — fastest loop for config parsing, entity logic, API handlers.
* **`emulator/`** TS app: the UX/rendering reference; no firmware code runs there.

## 4. How to run

Host libraries for the Espressif QEMU build (once):

| Host | Command |
|---|---|
| macOS (arm64 / x86_64) | `brew install libgcrypt glib pixman sdl2 libslirp` |
| Linux / WSL2 (Debian, Ubuntu; x86_64 or arm64) | `sudo apt-get install -y libgcrypt20 libglib2.0-0 libpixman-1-0 libsdl2-2.0-0 libslirp0 xz-utils` (same line as the CI `qemu-firmware` job) |
| Windows | Espressif ships no Windows QEMU build that `run.sh` downloads. Use WSL2 with Ubuntu and follow the Linux line. |

Under WSL2, `127.0.0.1:8080` in a Windows browser reaches the forwarded port (WSL2 localhost forwarding is on by
default). Untested on WSL2 so far; CI runs the Linux path on `ubuntu-latest`.

```sh
sim/qemu/run.sh                                      # build smoke test, boot, serial on stdout (Ctrl-A X quits)
curl http://127.0.0.1:8080/api/status
curl -F firmware=@sim/qemu/.pio/build/qemu/firmware.bin 'http://127.0.0.1:8080/api/ota?fail=1'   # rollback demo
sim/qemu/ota-test.sh                                 # automated: REST + outbound + OTA + rollback + re-OTA (CI-able)
sim/qemu/run.sh --fw firmware/.pio/build/x4pro       # boot any build dir (x4pro is silent: USB-CDC console)
```

Verified serial log (excerpt):

```
[boot] X4 QEMU smoke qemu-smoke-1 | ESP32-S3 rev0 cores=2 | reset=1 | flash=16MB | IDF v5.5.2-729-g87912cd291
[nvs] boot_count=2 (persisted in NVS)
[psram] size=8388608 free=8384788
[psram] 1MiB pattern test ok
[fs] LittleFS total=131072 used=8192 boots.txt=14 bytes
[net] ip=10.0.2.15
[http] listening on :80 (host: http://127.0.0.1:8080)
[net] outbound GET http://10.0.2.2:8123/ -> 200
[ota] upload end 786704 bytes -> ok
rst:0xc (RTC_SW_CPU_RST),boot:0x4 (SPI_FLASH_BOOT)
[ota] running=app1 @0x650000 state=PENDING_VERIFY version=qemu-smoke-2
[ota] self-test FAILED (simulated) -> esp_ota_mark_app_invalid_rollback_and_reboot()
[ota] running=app0 @0x010000 state=UNDEFINED version=qemu-smoke-1
...
[ota] running=app1 @0x650000 state=PENDING_VERIFY version=qemu-smoke-2
[ota] self-test passed -> marked VALID
```

## 5. The *real* firmware in QEMU (`env:x4qemu`, done)

`firmware/platformio.ini [env:x4qemu]` = `x4pro` + `-DX4_QEMU=1 -DARDUINO_USB_CDC_ON_BOOT=0`, `sim/qemu/lib/qemu_openeth`,
`hw/qemu_hw.cpp` instead of `hw/x4_*.cpp`. Seams (all `#if X4_QEMU`, details in
`firmware/DEVIATIONS.md`): `net/wifi_mgr.cpp` starts `open_eth` and reports Wi-Fi "connected to QEMU-ETH" (`netConnected()`
replaces `WiFi.status()` everywhere); null display keeping the last frame; scripted board; no mDNS/SoftAP.
A real device answers at `http://ha-paper-XXXX.local` (XXXX = last 4 hex digits of its MAC, shown on the display); the
QEMU firmware has no mDNS, so use `http://127.0.0.1:8080`.

```sh
make qemu [FRESH=1]                   # build + www.bin + boot → http://127.0.0.1:8080 (console, /api/v1)
cd emulator && npm run fake-ha        # fake HA on :8123 = http://10.0.2.2:8123 for the guest (sign in from the console)
curl -s localhost:8080/__qemu/framebuffer.pgm -o fb.pgm   # what the panel shows (P5 800×480)
curl -X POST 'localhost:8080/__qemu/input?key=next'       # or ?tap=400,240 / ?swipe=-1
make qemu-contract                    # contract suite vs the real firmware: 33 pass, 12 simulator-only skipped
make qemu-ota                         # OTA with HA down → PENDING_VERIFY → valid; crash and hang images → rollback (sim/qemu/ota-fw-test.sh)
make qemu-wdt                         # confirmed image hangs loop() → TWDT armed, reports loopTask → reset → next boot "reset reason TASK_WDT" (sim/qemu/wdt-test.sh; QEMU has no MWDT, see below)
make qemu-reflash                     # PUT screens.yaml + settings, re-flash the five parts like x4flash.py → userdata unchanged (sim/qemu/reflash-test.sh)
make qemu-endurance HOURS=72          # big house (1200 extra entities), a fault every 10 min (HA restart, WebSocket drop, clock jump, link drop via the QEMU monitor, config push), soak.py CSV → endurance.md PASS/FAIL (sim/qemu/endurance.sh, #48)
```

`make qemu-contract` signs in through the fake HA like a user: the firmware does the real OAuth2 + PKCE code exchange,
`auth/current_user`, refresh-token use, `subscribe_entities`/live data, revoke → re-link, unlink + long-lived token.

Found this way (fixed): `verifyRollbackLater()` had C++ linkage so Arduino's weak C default auto-confirmed every OTA
image (no rollback on hardware either); an update that hung with the network up was confirmed after 60 s (health check
now also needs the App loop running, and an unconfirmed image restarts itself after 12 min); unsigned `millis()` wrap made the HA client drop a healthy WebSocket as "silent
for 90 s"; setup page stayed up after linking (Linking → Offline → Connected); after (re)connecting the first HA
snapshot waited a whole "Live data" interval (30 s of "—"); sign-in callback answered 302 instead of
400 for an unknown/used `state` and `auth_error=not_admin` instead of `signin=not_admin`; a revoked key could not be
re-linked by signing in again; `PUT /settings` clamped instead of 422; multipart OTA upload wrote `manifest.json` into the
image; `POST /ha/token` answered 422 instead of 401; early RX frames crashed the vendored `open_eth` driver
(`ethernetif_input`, NULL netif) when the host was already polling the forwarded port.

OTA limitations of QEMU (found 2026-10-14, `sim/qemu/ota-fw-test.sh` avoids the first two):

* **Stale code after a soft reset.** QEMU keeps translated code per flash address across `esp_restart()`. An image
  written over a slot that already ran in the same QEMU process executes pieces of the old image (seen as
  "Panic handler entered multiple times" before `setup()`, with faults at the old image's addresses, e.g.
  `rtc_init+0xc` of v2 while the new image's `rtc_init` is elsewhere). Flash contents and the guest's cached flash
  view are correct. Real chips invalidate the cache on reset. The test power-cycles QEMU (`run.sh --no-refresh`)
  before uploading a broken image into a slot that ran before.
* **No cold boot through an otadata rewrite.** Cold-booting a flash image whose otadata says NEW or PENDING_VERIFY
  (the bootloader must rewrite it) erases the otadata sector and then hangs with no serial output. The same rewrite
  works after a soft reset, which is the normal OTA path. Not investigated further.
* **No timer-group watchdog (found 2026-10-15).** The ESP32-S3 MWDT never counts in QEMU esp-develop-9.2.2-20260417,
  so the task watchdog interrupt never fires. Proof: with loopTask hung, TIMG0's WDT stays configured (`WDTCONFIG0`
  0xb81f8000 = enabled, stage 0 interrupt, stage 1 system reset; 30 s) and `INT_RAW` stays 0 for 60+ s; a bare MWDT1
  set to interrupt at 1 s and reset at 3 s did nothing in 8 s. `make qemu-wdt` therefore checks what QEMU can show:
  the TWDT is armed with loopTask subscribed, after the hang the TWDT's own bookkeeping
  (`esp_task_wdt_print_triggered_tasks`) names loopTask alone, and the test image then takes the QEMU reset path
  (`esp_task_wdt_isr_user_handler` in `hw/qemu_hw.cpp`: TASK_WDT hint + software reset), so the next boot's
  diagnostics report TASK_WDT. The hook exists because QEMU's panic handler does not reset either (`abort()` hangs).
  The timer, the ISR and the panic + core dump path are hardware-only.
* **No RTC watchdog.** The OTA guard (`otaBootGuard()`, net/ota.h) restarts an unconfirmed image via esp_timer; the
  RTC watchdog backstop behind it is only exercised on hardware.

**Debug image for memory corruption (`env:x4qemu_debug`, #39).** `make qemu-contract QEMU_ENV=x4qemu_debug` runs the
suite against an image with extra checks. The prebuilt Arduino libs cannot take sdkconfig changes (comprehensive heap
poisoning needs a lib rebuild), but they already ship FreeRTOS stack canaries + end-of-stack watchpoint, light heap
poisoning (block head/tail canaries, checked on free), `-fstack-protector` and assertions. The debug env adds:
`-fstack-protector-strong` for `src/`; a critical-section tracer (`-Wl,--wrap=xPortEnterCriticalTimeout` /
`vPortExitCritical`, `hw/qemu_debug.cpp`) that checks every spinlock on enter and exit and, on a corrupt one, prints
`[x4dbg] CORRUPT spinlock`, the 72 bytes around it and the last 64 critical-section ops of each core (lock, caller,
owner, count, cycle count; E = entering, A = acquired, X = released), then aborts. An assert inside the real
spinlock code (the usual `spinlock.h:106`/`:142` panic) prints the same rings from the panic path (`net/diag.cpp`).
An `x4dbg` task runs `heap_caps_check_integrity_all()` every 10 s
(abort on failure) and logs internal heap free/min/largest + every task's stack high-water mark every 30 s
(`[X4DBG] heap ok · …`). Gotcha: owner and count are two loads and QEMU can switch vCPUs between them, so a torn read
looks like "FREE with count 1"; the tracer only trips when the pair is unchanged over three re-reads. Also: in QEMU
every assert prints `<cached disabled>` instead of file and function, because `spi_flash_cache_enabled()` reads the
EXTMEM cache-enable bit, which QEMU leaves at 0. That does not mean a flash operation was running; resolve the PC with
addr2line and use the printed line number (`spinlock.h:142` = a free lock with a non-zero count). Don't run
`pio test -e native` while a QEMU run needs its ELF: it wipes the other envs' build dirs.

Debugging: `SIM_QEMU_ARGS="-monitor tcp:127.0.0.1:4555,server,nowait" sim/qemu/run.sh …` then `info registers -a`
(resolve PCs with `xtensa-esp-elf-addr2line -e firmware.elf`), or `-d int,guest_errors -D qemu-d.log` for the first
exception. The Arduino bootloader logs errors only.

Gotchas: firmware that calls `analogRead()` links IDF's ADC self-calibration constructor, which spins on QEMU's missing
SAR ADC before `setup()` (x4qemu does not link InputManager/BatteryMonitor). QEMU keeps real SNTP time, so quiet hours can
be active — the contract run sets `quiet: off`, `fullEvery: 30`, `intervalSec: 5`.

## 6. Recommended combined strategy

1. **`emulator/` TS app** — UX, layouts, e-ink rendering review (fast, visual).
2. **`env:native`** — unit tests for all pure logic (config, entities, severity, diffing, API handlers).
3. **QEMU (`sim/qemu`, free, CI)** — the real firmware: boot, NVS, LittleFS, web console + REST contract suite, HA OAuth +
   WebSocket over `open_eth`, OTA + rollback (`qemu-firmware` job in `.github/workflows/ci.yml`).
4. **Wokwi (optional, Hobby+/Pro)** — only if we want Wi-Fi provisioning / captive portal flows or a
   custom SSD1677/GT911 chip before hardware arrives.
5. Real hardware for: panel waveforms/ghosting, touch feel, power/deep sleep, battery gauge, RF.
