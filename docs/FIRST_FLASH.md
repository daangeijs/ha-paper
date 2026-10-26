# First flash runbook (X4 Pro)

The script for the first time HA Paper goes onto a real X4 Pro (#45). Nothing in this repo has run on the hardware
yet, so every step says what we expect, how to tell it worked, and when to stop. Each step points at the assumptions
it checks in [HARDWARE_ASSUMPTIONS.md](HARDWARE_ASSUMPTIONS.md) (A1, A2, …). Current measurements have their own plan:
[POWER_BUDGET.md](POWER_BUDGET.md).

Background, not repeated here: [FLASHING.md](FLASHING.md) (ports, download mode, partition layout, OTA),
[HARDWARE.md](HARDWARE.md) (pins), [ROBUSTNESS_PLAN.md](ROBUSTNESS_PLAN.md) "Hardware test list".

Two rules for the whole day:

- **Never run `esptool erase-flash`, and never write anything at 0x0 except your own verified backup.** NVS
  (0x9000-0xDFFF) holds the OEM `hw_calib` namespace, which exists nowhere else.
- **One change at a time.** Power save defaults to *glance*: on battery, after 3 armed boots, the display deep-sleeps
  between refreshes. It stays awake on USB or charging, during setup and for 2 min after an API call. Step 10b turns
  it off for the day. If a step fails, stop, capture, and decide before going on.
- **`make monitor` holds the serial port.** Close it (Ctrl-C) before every esptool, `make flash`, restore or Improv
  step (6, 14.2, 19-21).

What to capture: everything goes into `backups/firstflash/` (gitignored, like `backups/`). Serial logs as
`NN-name.log`, API answers as `NN-name.json`, photos as `NN-name.jpg`, with NN the step number.

## 0. Before you start

```sh
export PORT=/dev/cu.usbmodem1101        # step 1 finds the real name
mkdir -p backups/firstflash
git describe --tags --dirty | tee backups/firstflash/00-version.txt
make test && make build
```

- Charge the X4 Pro on the stock firmware until it shows ≥ 50 %. OTA needs ≥ 30 % or charging.
- With the stock firmware still on: photograph the screen, note the stock firmware version and the battery % the
  stock UI shows (step 15 compares against it). Note the time.
- Have: pogo → USB-C adapter, a data USB-C cable, Home Assistant reachable on the same Wi-Fi, a phone for photos and
  slow-motion video, a stopwatch.

Pass: `make test` green, `make build` produced `firmware/.pio/build/x4pro/firmware.bin` and `www.bin`, version is
not `-dirty` (or you know why). `make build` stamps `0.0.0-dev`; `make flash` rebuilds with the `git describe`
version, and that is what the banner in step 7 shows. Abort: don't flash a build whose tests fail.

## 1. Find the port (A37)

```sh
ls /dev/cu.usbmodem*          # plug in, run, unplug, run again: the one that disappears is the display
```

Expected: one new `/dev/cu.usbmodem…` (Linux: `/dev/ttyACM0`, USB id `303a:1001`). Set `PORT` to it.

Pass: the device appears. Abort: nothing appears → the cable is charge-only or the pogo adapter is not seated; try
another cable. Still nothing → put it in download mode (hold Left, press Reset, release Left) and look again. Still
nothing → stop; a USB-locked unit looks like this (FLASHING §1).

## 2. Chip check (A1, A2, A3)

```sh
make chip-check PORT=$PORT 2>&1 | tee backups/firstflash/02-chip.log
.venv/bin/esptool --chip esp32s3 -p $PORT flash-id 2>&1 | tee -a backups/firstflash/02-chip.log
```

Expected:

- `Chip type:` names an ESP32-S3, **not** `… in Secure Download Mode`.
- `Features:` lists Wi-Fi, BLE, 240 MHz and, if the PSRAM is in the chip package, `Embedded PSRAM 8MB`. If no
  embedded PSRAM is listed, write that down; step 7 checks PSRAM from the firmware side.
- `Secure Boot: Disabled` and `Flash Encryption: Disabled`.
- `Detected flash size: 16MB`.

Pass: all four. Abort: secure boot or flash encryption enabled, secure download mode, or a flash size other than
16MB → **do not flash**. Our backup size, partition table and flashers all assume 16 MB.

## 3. Back up the full 16 MB

```sh
make backup PORT=$PORT 2>&1 | tee backups/firstflash/03-backup.log
```

Expected: about 3 minutes, then a SHA-256 line and `Backup OK: backups/x4pro_stock_YYYYMMDD.bin`. The file is
read-only and exactly 16777216 bytes.

Pass: `Backup OK`, size 16777216. Abort: *Failed to connect* → download mode (hold Left, press Reset) and rerun.
A read that stops halfway leaves only a `.part` file: delete it and rerun. Never go to step 6 without a backup.

## 4. Verify the backup (A4, A5)

A backup we can't restore is worse than none: we would trust it. Check it four ways while the chip still holds the
stock image. Set `B` to the file from step 3.

```sh
B=backups/x4pro_stock_YYYYMMDD.bin
# a. the chip hashes its own flash and compares it with the file
.venv/bin/esptool --chip esp32s3 -p $PORT verify-flash 0x0 $B
# b. an independent second read must be byte-identical (the chip sits in the ROM loader: nothing writes flash)
.venv/bin/esptool --chip esp32s3 -p $PORT -b 921600 read-flash 0 0x1000000 backups/firstflash/04-second-read.bin
cmp $B backups/firstflash/04-second-read.bin && echo IDENTICAL
# c. the stock partition table: NVS must be at 0x9000, size 0x5000 (20K), like ours
dd if=$B of=backups/firstflash/04-ptable.bin bs=4096 skip=8 count=1 2>/dev/null
python3 ~/.platformio/packages/framework-arduinoespressif32/tools/gen_esp32part.py backups/firstflash/04-ptable.bin \
  | tee backups/firstflash/04-ptable.csv
# d. the OEM panel id is in that NVS
dd if=$B bs=4096 skip=9 count=5 2>/dev/null | strings | grep -E "hw_calib|screenType"
```

Expected: a. `Verification successful (digest matched).` b. `IDENTICAL`. c. a CSV with a line starting
`nvs,data,nvs,0x9000,20K` (plus the stock `otadata`, `app0`, `app1`, …). d. `hw_calib` and `screenType` printed.

Pass: a, b and c. d missing is not a stop: the firmware probes the panel on the bus and never reads NVS to decide;
write it down for A5. Abort: a or b fails → the read is not trustworthy; delete both files, try another cable or
port, back up again. c shows NVS anywhere else or another size → **stop**: our partition table would put otadata
or app0 over the stock NVS, and both flashers assume 0x9000/0x5000.

Then copy `$B` and `$B.sha256` off this computer (two places). Delete `04-second-read.bin`.

## 5. Stock reference (optional, for #19)

While the stock firmware is still on, take the stock currents from [POWER_BUDGET.md](POWER_BUDGET.md) §4 (idle,
page turn, the stock sleep mode). They are the only stock floor we can compare our deep sleep against. Skip if you
have no meter today.

## 6. Flash HA Paper

```sh
make flash PORT=$PORT 2>&1 | tee backups/firstflash/06-flash.log
```

Expected: PlatformIO writes bootloader (0x0), partition table (0x8000), `boot_app0.bin` (0xE000), app (0x10000), each
ending with `Hash of data verified.`; then `uploadfs` writes `www.bin` at 0xC90000, also `Hash of data verified.`;
last line `Flashed HA Paper <version>`.

Pass: five `Hash of data verified.` lines, no write between 0x9000 and 0xDFFF in the log (grep the offsets).
Abort: *Failed to connect* → download mode, rerun. A write that fails halfway → don't unplug, rerun `make flash`
(it rewrites all parts). Anything in the log written at 0x9000-0xDFFF → stop and restore (step 20).

## 7. First boot log (A2, A6, A7, A9, A29, A35)

```sh
make monitor PORT=$PORT 2>&1 | tee backups/firstflash/07-boot.log      # press Reset if it didn't start
```

Expected, in this order (other lines in between):

```
[I][MAIN] HA Paper <version> · X4 Pro
[I][MAIN] power · CPU 240 MHz · Wi-Fi PS min · USB host yes
[I][MAIN] PSRAM <n> KB free · heap <n> KB free
[I][BOARD] clock from BM8563: … UTC          or  [W][BOARD] BM8563 time not set (waiting for NTP)
[I][EPD] controller <SSD1677|UC8179|UC8279> · VER probe: .. .. .. .. .. FLG .. · <verdict>
[I][EPD] 800x480 · 4-gray overlay supported
[I][POWER] wake: … first-boot safety: N boot(s) left
```

`<verdict>` is one of `UltraChip, promoted from SSD1677`, `no UltraChip answer, SSD1677 kept` or
`profile default (no probe in this build)`.

Pass: the firmware runs (stock booted app1; `boot_app0.bin` reset otadata so app0 runs): our banner appears, or, if
the monitor missed it (early lines are dropped while the host re-enumerates after a reset), `/status` `firmware`
shows the version and `/diagnostics` one boot (steps 9-11). Only once (no boot loop), PSRAM ≈ 8000 KB free, a
controller line, `4-gray overlay supported`. `[W][BOARD] GT911 not found,
cycling touch rail` followed by `GT911 recovered` is acceptable; write it down (A17).

Abort / decide:

- `!!! PSRAM NOT FOUND` → the `dio_opi` memory type is wrong for this unit (A2). The firmware runs B/W-only; carry on
  to get diagnostics, then file a bug before anything else.
- No image, and about 20 s after the controller line `!!! panel BUSY never released · BUSY stuck 20 s (…) · panel
  marked failed` followed by `!!! display init FAILED` → panel dead to us (A7, A8): it never releases BUSY. The
  display does not reset: `/status` shows `"panel": "failed"`, `/diagnostics` `panel.failure` says which wait stuck,
  and the web console keeps working (every refresh is skipped until the next boot). Capture the log, then restore
  (step 20). A `TASK_WDT` boot loop with `waitBusy` in the backtrace is now a firmware bug: file it.
- `[W][BOARD] BM8563 RTC not found` → I2C bus problem; touch and battery share that bus (A16, A26). Capture and go on.
- The banner repeats (boot loop) → after 3 crash resets the display offers the factory-reset screen; don't press
  Right. Capture the log with `make monitor-pio` (decodes the backtrace), then restore (step 20).

## 8. Panel: first full refresh (A8, A9, A13, A15)

Watch the panel during the boot above. Film it.

Expected: one full refresh (black/white flashes), then the *SETUP · Connect to Wi-Fi (1/2)* screen, upright and not
mirrored, the boot face's grays smooth.

Pass: readable, upright, full refresh done in a few seconds (stopwatch from the first flash to a still image;
`main.cpp` assumes ~3 s, well under the 30 s task watchdog). Write down the controller from step 7: we have one
unit, so the other controller batch stays unverified.
Abort: blank panel with a good `[EPD]` line → press Reset once; still blank → capture, steps 9-11, restore.
Mirrored or upside down → not an abort; note it for A15 (the SDK profile has `NO_FLIP`, "pending hardware").

## 9. Wi-Fi on the display (A16)

Improv needs the browser flasher's Wi-Fi step, which only runs after its own install; it gets tested in step 21.
Here, use the display itself: pick your network on the screen and type the password on the on-screen keyboard. That
doubles as the first touch test. Keep the monitor running through step 17, except where a step needs the port.

Expected log:

```
[I][WIFI] connecting to "<ssid>"
[I][WIFI] connected · <ssid> · <ip>
[I][WIFI] mDNS ha-paper-XXXX.local + _http._tcp
```

and the display switches to *Finish in your browser (2/2)* with a QR code, `ha-paper-XXXX.local` and the IP.

Pass: connected within ~30 s, screen 2/2 shown. Abort: touch doesn't respond → skip to *Set up from phone* (SoftAP
`HA-Paper-Setup`, FLASHING §4) and record it for step 13. `connect … failed` with the right password → note the
reason, try once more, then SoftAP.

## 9b. The display finds Home Assistant by mDNS (A39)

QEMU has no multicast, so this is the only test of the real `_home-assistant._tcp` browse (#90). Laptop on the same
Wi-Fi/VLAN as the X4; HA's zeroconf integration on (it is part of `default_config`). Do it before signing in.

```sh
dns-sd -B _home-assistant._tcp local.     # Linux: avahi-browse -rt _home-assistant._tcp
#   expect one instance (HA's location name); Ctrl-C
dns-sd -L "<instance name>" _home-assistant._tcp local.
#   note TXT internal_url and base_url: the X4 takes internal_url, else base_url, else <address>:<port>
dns-sd -B _http._tcp local.               # the X4 itself: expect ha-paper-XXXX
```

1. Fresh display, no HA address stored. After step 9's `connected` line, within ~5 s:
   ```
   [I][WIFI] mDNS _home-assistant._tcp → 1 found · http://<internal_url>
   ```
   ```sh
   curl -s $X4/api/v1/console/state | jq .home_assistant
   #   discovered: ["<internal_url, normalized>"], server: the same address
   ```
   The link page reads "Found <address> on your network".
2. On demand (open while the display is not linked): `curl -s -X POST $X4/api/v1/ha/discover` → `202
   {"status":"searching"}`; the log line repeats ~3 s later.
3. Negative: turn HA's zeroconf off (or put the laptop and HA on another VLAN), `POST /api/v1/ha/discover` again.
   Expect `→ 0 found`, `discovered: []`; the link page asks for the address and a typed one works.

Pass: step 1 shows HA's `internal_url` and the link page offers it. The address is stored only after sign-in starts
and it answered as HA (#54). Record, don't abort: `→ 0 found` while `dns-sd` on the laptop sees HA means multicast
doesn't reach the X4 (AP isolation, IGMP snooping, mesh nodes). Note the router model at A39 and type the URL in
step 10.

## 10. Home Assistant sign-in and an API token

```sh
export X4=http://ha-paper-XXXX.local     # or http://<ip>
```

Open `$X4` (or scan the QR), **Sign in with Home Assistant**, log in on HA's own page. Then in the web console create
an API token with write scope and `export X4_TOKEN=x4_…` (shown once).

Expected log: `[I][HA] WebSocket auth_ok`, `[I][HA] subscribe_entities: <n> entities in <m> chunks`, and on a first
link `[I][HA] no screens.yaml yet: asking HA what to show` then `[I][HA] screens from HA: …`. The display redraws once
to Home with live values.

Pass: Home shows real numbers within a minute; values change when they change in HA. Abort: HA not found by mDNS →
type its URL. OAuth fails → try the long-lived token fallback (`POST /api/v1/ha/token`, FLASHING §4) to separate an
OAuth problem from a network one. Neither works → capture `/console/state` and the log, stop here for HA, carry on
with steps 11-16 (they don't need HA).

## 10b. Power save off

On the display: Settings › Power › Power save: **Off**. Otherwise, on battery, the display deep-sleeps after 3 boots
and stops answering `curl` and the monitor in steps 13-17.

Way out if it already sleeps: hold Right through the boot screen (press Reset or Power while holding Right, keep it down for the first 3 s). It stays
awake for 10 minutes; set Power save Off in that window.

Pass: unplugged for 5 minutes, `/status` still answers.

## 11. Capture status and diagnostics (A2, A5, A9, A35)

```sh
curl -s -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/status      | tee backups/firstflash/11-status.json
curl -s -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/diagnostics | tee backups/firstflash/11-diag.json
```

Expected: `/status` with `battery` > 0, `power.source` `usb`, `power.cpuMhz` 240, `free_psram` ≈ 8 MB,
`heap_largest_block` above 20480 and `free_heap` above 65536 (the TLS guard). `/diagnostics` with `panel.source` `probe`, a `panel.controller`,
`panel.nvs_screen_type` (compare with step 4d), `boots[0].reason` `POWERON`, `SW`, `USB` or `EXT` (esptool or
Reset key; not crashes), `last_crash` null,
`touch_recoveries` 0 (or 1, see step 7).

Pass: as above. Abort: `last_crash` not null on a fresh flash → copy `panic` and `coredump`, fetch
`/api/v1/diagnostics/coredump` into `11-core.bin`, decode with `esp-coredump info_corefile -c 11-core.bin
firmware/.pio/build/x4pro/firmware.elf`, file it before going on.

## 12. Display quality (A10, A11, A12, A14)

Leave Home on screen for 15 minutes. Then flip through all pages with the keys.

Check and photograph:

- Minute tick: the clock changes with a partial refresh (no full flash), only the clock area redraws.
- After 30+ minutes: one scheduled "clean screen" full refresh at :00 or :30.
- Ghosting after ~10 page turns: faint traces of the previous page?
- Grays: anything that was gray (boot face) and later got a partial — did it stay gray or go black/white? (#38
  assumes it breaks; the rule holds either way, but we want to know.)
- 2-bit text and the Sleek card surface from 2 m: compare `dither` and `dots` (Settings › Display style, #29).
- Partials that look smeared or low-contrast → note it: the SDK sets SSD1677 VCOM 0x10, crosspoint uses 0x30 (A10).

Pass: clock partials clean, no ghosting you'd notice from 2 m. This step has no abort; it produces photos and
notes for #29 and A10-A12.

## 13. Touch (A16-A19)

1. Tap the four corners of a page with buttons there (e.g. Settings): the right control reacts, and inverts first
   (tap feedback). A tap that hits the mirrored control means `swapXY`/`flipY` is wrong.
2. Swipe left/right: a short, slightly diagonal swipe (about 100 × 60 px) should page.
3. The capacitive Home key returns to Home.
4. 20 warm restarts (#4, ROBUSTNESS_PLAN 0.3):

```sh
for i in $(seq 1 20); do
  curl -s -X POST -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/device/restart; sleep 45
  curl -s -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/diagnostics | jq -c '{i:'$i', touch:.touch_recoveries, reason:.reset_reason}'
done | tee backups/firstflash/13-restarts.jsonl
```

After every few restarts, tap something. Pass: touch works after all 20; `touch_recoveries` is 0 or 1 per boot and
every recovery logs `GT911 recovered`. Abort: `GT911 still absent after rail cycle` and dead touch → 100 ms on GPIO2
is not a real power cycle (A17, maybe the I2C pull-ups back-power the GT911). Power off and on: if touch returns, the
finding is confirmed. File it on #4; keys still work, so continue.

## 14. Buttons and latency on battery (A20-A23)

1. Left = previous page, Right = next page, Power = its action. One press = one page; no double steps.
2. Close `make monitor`. Hold Left and press Reset: the display must enter download mode. Check with
   `.venv/bin/esptool --chip esp32s3 -p $PORT --before no-reset chip-id` (answers only from the ROM loader; the panel
   keeps its last image). Press Reset alone to leave it.
3. Unplug USB. Press Right and film it in slow motion: time from the press to the panel starting to change. Do the
   same on USB. ROBUSTNESS_PLAN 0.4 targets < 150 ms; 0.2 (`Serial.setTxTimeoutMs(1)`) exists so logging without a
   host doesn't add 100 ms per line.
4. Hold Power + Right for 5 s: the factory-reset screen appears. **Press nothing** and wait 10 s: it must cancel by
   itself.

Pass: all four; latency on battery not visibly worse than on USB. Abort: a key that never registers → note the key
and GPIO, continue (touch covers navigation). The reset screen not timing out → don't touch Right; power-cycle.

## 15. Battery and charging (A24-A28)

```sh
for i in 1 2 3; do curl -s -H "Authorization: Bearer $X4_TOKEN" $X4/api/v1/status | jq -c '{battery, battery_mv, power}'; sleep 35; done
```

Run it three times: on USB, unplugged, and plugged into a wall charger (no data lines).

Expected:

| Situation | `battery` | `power.source` | `power.charging` |
|---|---|---|---|
| USB to a computer, battery not full | ≈ stock reading from step 0 | `usb` | `true` |
| Unplugged | same ± 1-2 % | `battery` | `false` |
| Wall charger, battery not full | same | `usb` | `true` |

STAT and the gauge are read every 30 s, so allow one interval after plugging. Pass: `battery` within ~10 points of
what stock showed, and it moves by at most a point or two between reads. Abort: `battery` stuck at 0 or 100, or wild
jumps → the CW2017 profile or recovery is off (A26). Don't trust the 30 % OTA guard until fixed: do step 18 on USB.
A full battery on a wall charger reading `battery` is known (no VBUS pin, A24): note it, not a failure.
`battery_mv` (A28): 3300-4250 and rising on a charger; ~4150-4200 when full. `null` or a value outside that → the
VCELL decode is off: note the raw value and leave glance mode off until #73 is reopened.

## 16. Front light (A30, A31)

Settings › Display: raise brightness in steps to 100 %, then move warmth from cool to warm.

Pass: light follows each step without flicker, warmth moves the right way (GPIO8 cool, GPIO9 warm). Afterwards
`/diagnostics` shows no new boot (the LEDC busy-wait watchdog bug is fixed in the toolchain we use, A31).
Abort: a `TASK_WDT` reset while dimming → capture, set brightness to 0, file it.

## 17. Network soak (overnight, on USB)

```sh
make monitor PORT=$PORT ARGS="--csv backups/firstflash/17-heap.csv" 2>&1 | tee backups/firstflash/17-soak.log
```

Restart your router once (note how long until `[I][WIFI] connected` and Home has live values again), then leave it
overnight.

Pass: reconnects by itself; in the CSV the `largest` column doesn't trend down; `/diagnostics` shows one boot. Abort:
`[W][HEAP] … TLS refused` lines, or a heap that falls steadily → file it with the CSV.

## 18. OTA by LAN upload (rollback path)

Build a second image that differs only in version, then upload it:

```sh
make firmware VERSION=0.0.0-ff.ota
F=firmware/.pio/build/x4pro/firmware.bin
curl -s -X POST -H "Authorization: Bearer $X4_TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @$F "$X4/api/v1/ota/upload?sha256=$(shasum -a 256 $F | cut -d' ' -f1)"
```

Expected: `202` with `{"status":"rebooting",…}`; log `[I][OTA] uploaded image OK (<n> bytes) · restarting`, then
`[W][OTA] running v0.0.0-ff.ota from app1 · ESP_OTA_IMG_PENDING_VERIFY`, `[W][MAIN] unconfirmed OTA image · rollback
guard armed`, and after ~60 s with Wi-Fi up `[I][OTA] health check passed (…) · esp_ota_mark_app_valid_cancel_rollback()`.

Then:

1. Same upload with a wrong `sha256=` (flip one hex digit) → `422`, nothing changes, `/status` still `0.0.0-ff.ota`.
2. Restart once: it still runs `0.0.0-ff.ota` (confirmed images stay).
3. Optional rollback check, only after 1-2 pass: build an image that resets before confirming and upload it the same
   way: `PLATFORMIO_BUILD_FLAGS=-DX4_TEST_CRASH_ON_BOOT make firmware VERSION=0.0.0-ff.crash`. Expected: it logs
   `X4_TEST_CRASH_ON_BOOT · resetting…`, the bootloader goes back to `0.0.0-ff.ota`. Rebuild without the flag
   afterwards (`make firmware`) so the crash image isn't left in `.pio`.

Pass: upload, confirm, 422 on a bad hash, rollback (if run). Abort: the device doesn't come back within ~13 minutes
(10 min without network, 12 min hang guard, 13 min RTC watchdog) → USB: `make flash` puts a known image back (NVS untouched), then capture `/diagnostics`.

## 19. A USB re-flash keeps Wi-Fi, HA and screens

Close `make monitor` first.

```sh
make flash PORT=$PORT 2>&1 | tee backups/firstflash/19-reflash.log
```

Pass: after the reset the display comes back on Wi-Fi, linked to HA, with the same screens and settings, without
setup. This is the hardware check of "NVS and userdata are never written" (FLASHING §3; QEMU covers it as
`make qemu-reflash`). Abort: setup screen again → something wrote NVS or userdata: stop, capture the log, restore.

## 20. Restore the stock firmware

Close `make monitor` first.

```sh
make restore PORT=$PORT FILE=$B 2>&1 | tee backups/firstflash/20-restore.log
.venv/bin/esptool --chip esp32s3 -p $PORT verify-flash 0x0 $B
```

Then press Reset.

Expected: the size check and `$B.sha256` pass, the write ends with `Hash of data verified.`, verify says
`Verification successful (digest matched).`, the stock reader boots with its own UI, battery reading and settings.

Pass: stock boots and behaves as in step 0. Abort: `verify-flash` mismatch → write again; still mismatching →
stop and keep the device in download mode until we know why. Stock doesn't boot after a matching verify → try the
second copy of the backup; report.

Restoring writes the stock NVS back: HA Paper's Wi-Fi and HA link are gone after this (they lived in NVS). That is
what step 21 needs.

## 20b. Restore with the release script (#20)

The path a release user takes. Download mode, then:

```sh
make dist
python3 dist/x4flash.py restore $B 2>&1 | tee backups/firstflash/20b-restore.log
.venv/bin/esptool --chip esp32s3 -p $PORT verify-flash 0x0 $B
```

Pass and abort as in step 20.

## 21. Second install through the browser flasher, with Improv (#20, A36)

The end-to-end path a new owner takes, timed like [TESTERS.md](TESTERS.md).

```sh
make flasher ALLOW_DIRTY=1                       # or a release's ha-paper-flasher-<version>.zip
python3 -m http.server -d dist/flasher 8000      # localhost counts as a secure context for Web Serial
```

Close `make monitor` (Improv needs the port). Open `http://localhost:8000` in Chrome, start the timer, download mode, **Connect**, tick "I already have a full
backup", **Install**, then page step 4 **Wi-Fi** sends the network over Improv.

Expected: the page finds the display again after its post-flash reset, lists networks, and links to
`http://ha-paper-XXXX.local` and the IP once joined.

Pass: Wi-Fi joined over Improv without touching the display; total time to the first dashboard written down.
Abort: the page says the display did not answer → note how long after the reset (A36), set up Wi-Fi on the display
instead, finish the run.

## 22. Wrap-up

- Fill the *Status* column in [HARDWARE_ASSUMPTIONS.md](HARDWARE_ASSUMPTIONS.md): `confirmed`, `wrong` (with what is
  true) or still `unverified`.
- One issue per failure, with the step number and the files from `backups/firstflash/`.
- Not on day one: brownout during OTA (#8) and the current measurements in [POWER_BUDGET.md](POWER_BUDGET.md).
- Day two (optional): Power save back to *glance*, on battery. Check deep sleep and wake on a key (A21, A32) and pogo
  unplug while asleep (A34); [POWER_BUDGET.md](POWER_BUDGET.md) has the plan.
