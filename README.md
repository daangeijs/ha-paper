# HA Paper

Firmware that turns an [Xteink X4 Pro](https://www.xteink.com) e-reader into a Home Assistant dashboard. It replaces
the stock reader firmware. The display links to your Home Assistant with a normal HA sign-in, shows your entities on
e-ink screens you can page through with touch or the buttons, and is configured from a web console on the device
itself. Your stock firmware can be put back at any time from the backup you make before flashing.

Hardware: ESP32-S3, 16 MB flash, 8 MB PSRAM, 4.3" 800×480 e-ink, GT911 touch. Details in
[docs/HARDWARE.md](docs/HARDWARE.md).

## Status

Beta. Everything was built against an emulator and the real firmware in QEMU first; the first flash on a real X4 Pro
was on 2026-10-26. On that unit the backup, the first flash, Wi-Fi, the Home Assistant link and live data worked on the
first try; page changes take about a second and text sizes were raised for the 217 ppi panel. Known open problems:

- Glance mode (deep sleep between refreshes on battery) works in QEMU but is not yet tested on battery on the real
  device. Battery life is not measured yet ([docs/POWER_BUDGET.md](docs/POWER_BUDGET.md) has the plan).
- The browser flasher, `x4flash.py` and `make restore` have not yet been run on the hardware; `make backup` and
  `make flash` have.

Expect bugs. Keep your backup.

## What you need

- An Xteink X4 Pro.
- The magnetic pogo → USB-C adapter that came with it, and a USB-C cable that carries data (charge-only cables show
  no device).
- Home Assistant on the same network, and an HA account that can sign in. An admin account can edit screens and
  settings; any other account gets a view-only console.
- 2.4 GHz Wi-Fi.
- A desktop computer: Chrome or Edge for the browser flasher, or Python 3 for the command-line flasher.

## Safety first

- **Make a full backup before you flash.** It is the only way back to the stock firmware. Every flasher here makes
  one (16 MB; 53 s on our unit) and `make flash` refuses to run without one.
- **Keep the backup private.** The stock firmware stores its Wi-Fi password in plain text, so your backup contains
  it.
- **Never run `esptool erase-flash`, and never write a full-flash image except your own backup.** The NVS partition
  (0x9000–0xDFFF) holds the panel calibration the factory wrote (`hw_calib`). It exists nowhere else. None of the
  flashers write NVS, and releases ship no merged factory image for this reason.
- Check that your unit is not locked before flashing (`make chip-check`, or the browser flasher does it). Units bought
  from xteink.com are unlocked; some third-party units have secure boot or flash encryption burned in and cannot run
  this firmware. Nothing in this project burns eFuses.

## Install

Connect the X4 Pro over USB. No buttons: the flasher resets it into download mode over the cable. If it won't
connect, replug USB and try again. After flashing, replug USB if it doesn't start.

Pick one of three ways. Full details, serial port names per OS and troubleshooting:
[docs/FLASHING.md](docs/FLASHING.md).

**Browser flasher.** Hosted at [hapaper.daangeijs.nl](https://hapaper.daangeijs.nl) (Chrome or Edge on a desktop;
the latest beta or stable release, deployed from each such tag; alpha releases are not hosted). Each GitHub release has `ha-paper-flasher-<version>.zip`: a static page with the firmware inside.
Unzip it and serve the folder over HTTPS, or locally (`python3 -m http.server` in that folder, then open
http://localhost:8000 in Chrome or Edge; Web Serial needs HTTPS or localhost). The page checks the chip, reads the
backup, installs, and then sends your Wi-Fi name and password over the same cable
([Improv Wi-Fi](https://www.improv-wifi.com/serial/)). From a checkout, `make flasher` builds the same site into
`dist/flasher/`.

**Command line, no checkout.** Download all files of a release into one folder, install esptool
(`pip install esptool`), then run `python3 x4flash.py` there (Windows: `py x4flash.py`). It checks the files and the
chip, backs up to `backups/` the first time, and writes the five parts. `python3 x4flash.py restore
backups/x4pro_stock_YYYYMMDD.bin` puts the stock firmware back.

**From the repo** (setup under [Develop](#develop)):

```sh
make chip-check PORT=/dev/cu.usbmodem1101   # not locked?
make backup     PORT=/dev/cu.usbmodem1101   # 16 MB → backups/x4pro_stock_YYYYMMDD.bin (+ .sha256)
make flash      PORT=/dev/cu.usbmodem1101   # bootloader, partitions, otadata, app, web console
make restore    PORT=/dev/cu.usbmodem1101 FILE=backups/x4pro_stock_YYYYMMDD.bin   # back to stock
```

Port names: macOS `/dev/cu.usbmodem*`, Linux `/dev/ttyACM0`, Windows through WSL2 and usbipd. Run a port target
without `PORT` and it prints the first candidate it finds.

Upgrading a display that ran an X4 Home build (this project's old name) changes its address to
`ha-paper-XXXX.local`; see [docs/FLASHING.md](docs/FLASHING.md) §6, *Renamed from X4 Home*.

Re-flashing keeps your Wi-Fi, the Home Assistant link, your screens and your settings: NVS and the `userdata`
partition are never written by any flasher.

For the first install on a new unit there is a step-by-step runbook with pass/abort checks:
[docs/FIRST_FLASH.md](docs/FIRST_FLASH.md).

## Set up

1. **Wi-Fi.** If the browser flasher did not set it, the display shows *Connect to Wi-Fi*. Pick a network on the
   display and type the password, or tap *Set up from phone*, join the open network `HA-Paper-Setup` and follow the
   page that opens (http://192.168.4.1/setup).
2. **Home Assistant.** The display then shows a QR code and its address, `http://ha-paper-XXXX.local` (XXXX = the last
   four hex digits of its MAC), with the IP next to it. Open either one on a device on the same network, or scan the
   QR. Press **Sign in with Home Assistant**. HA is found by mDNS; if not, type its address
   (e.g. `http://homeassistant.local:8123`). You sign in on HA's own page, 2FA included.
3. The display stores only an HA refresh token, encrypted, never your password. It connects and draws Home with live
   data. On first link it fills the default screens with entities it finds in your HA (solar, grid, prices,
   temperatures); the console shows which tiles it filled and which it could not.

`.local` names don't resolve on many Android phones, some Windows setups and across VLANs. Use the IP shown on the
display.

## The web console

Open `http://ha-paper-XXXX.local` and sign in with Home Assistant. It has three tabs:

- **Screens**: edit screens and tiles, with a live preview of what the panel shows.
- **Device settings**: display style, power settings and quiet hours, Wi-Fi, the Home Assistant link, diagnostics (copy the JSON for a bug
  report; it contains your HA URL but no passwords).
- **Advanced**: *Screens as YAML* (the whole layout as one `screens.yaml`, format in
  [spec/SCHEMA.md](spec/SCHEMA.md)), *API* (tokens and the endpoint list), *Device log*.

Buttons: a short Power press puts the display in standby (press again to wake). Hold Power 2 s to turn it off: it
shows *Turned off* and switches off; hold Power about 2 s to turn it on again. On USB it cannot cut its own power, so
it sleeps on that screen until you press Power. Power + Prev held 5 s restarts the display; Power + Next held 5 s
opens the factory reset screen. The small button on the top edge next to the microSD slot is Reset: on battery it
switches the display off; hold Power to start it again.

Power saving modes: *Always live*, *Standby*, and *Glance* (the default): on battery it
shows a calm sleep screen (the date, "Asleep · press to wake", today's weather, next event and bins) and deep-sleeps
until you press a button; it wakes on its own only at midnight and when quiet hours start or end (at most every 8 hours).
After a press it shows the dashboard and stays live for a few minutes. On USB the display is always live. *Quiet hours* (default 23:00–07:00) show "Back at 07:00" with a few
values from your Home page; on battery the display does not wake on its own until then, and a press shows the dashboard.

*Glance* vs *Always live*: e-paper keeps its last picture without power, so a sleeping display still looks on. In
glance the chip is in deep sleep between wakes: no Wi-Fi, no web console, no USB serial, so the device is not on the
network and a computer does not see it. Glance mode has no clock: a sleeping panel cannot tick, and a time that is 40
minutes old reads as a wrong clock, so the sleep screen shows only the date. A wake on its own leaves the front light off.
A press on Power or Right wakes it: the screen stays as it is for
a few seconds while Wi-Fi and Home Assistant connect, then redraws once (no start-up screen). Want a live clock and an
always reachable device on battery? Pick *Always live*, at the cost of battery life.

## API

The device serves a REST API at `http://ha-paper-XXXX.local/api/v1`, described in
[spec/openapi.yaml](spec/openapi.yaml) (the console's *API* page lists the endpoints too).

Create a token in the console under **Advanced › API**. Pick *Read only* or *Read & write*. The token (`x4_…`) is
shown once; the device stores only its SHA-256 hash. These are not Home Assistant tokens. Creating tokens needs an HA
admin sign-in.

```sh
export X4_TOKEN=x4_...
curl -H "Authorization: Bearer $X4_TOKEN" http://ha-paper-a1b2.local/api/v1/status
curl -H "Authorization: Bearer $X4_TOKEN" http://ha-paper-a1b2.local/api/v1/diagnostics   # boots, last crash, heap
```

After 5 failed bearer attempts from one IP within a minute the device answers 429 for 60 s. The API is plain HTTP on
your local network; don't expose it to the internet.

## Updating the firmware (OTA)

The device has two app slots. A new `firmware.bin` is streamed into the inactive slot and hashed while it arrives.
Only a complete image whose SHA-256 matches is selected; otherwise nothing changes. After a restart the new image runs
on probation:

- It is confirmed once it has run 60 s with a network connection and a working UI loop. Home Assistant plays no part,
  so an update sticks whether or not HA is reachable.
- If it crashes or resets before that, the bootloader starts the previous version.
- If it gets no network within 10 minutes, or hangs, a guard timer (12 min) and the RTC watchdog (13 min) restart it
  and the previous version comes back.

Installing is refused below 30 % battery unless the display is charging (HTTP 409).

**Upload over the network (API).** Needs a *Read & write* token:

```sh
curl -X POST -H "Authorization: Bearer $X4_TOKEN" \
  -H "Content-Type: application/octet-stream" --data-binary @firmware.bin \
  "http://ha-paper-a1b2.local/api/v1/ota/upload?sha256=$(shasum -a 256 firmware.bin | cut -d' ' -f1)"
```

(Linux: `sha256sum` instead of `shasum -a 256`.) Answers:

| Code | Meaning |
|---|---|
| 202 | Written and verified. Body `{"status":"rebooting","sha256":"…"}`. The device restarts about 1.5 s later. |
| 409 | Battery below 30 % and not charging, or another upload is running. |
| 422 | SHA-256 mismatch or not a valid image. Nothing changed. |
| 401 / 403 | No token, or a read-only token. |

The `sha256` parameter is optional (also accepted as an `X-SHA256` header), but without it only the image's own
checks apply. A multipart upload with a `firmware` file and the release's `manifest.json` also works; the hash then
comes from the manifest. Use `firmware.bin` from a GitHub release, or `firmware/.pio/build/x4pro/firmware.bin` after
`make build`.

**From the web console.** The console has no firmware upload button yet. *Check for updates* and *Install* exist in
the display's Settings › Updates and in the API (`POST /api/v1/ota/check`, `POST /api/v1/ota`), but see the next
paragraph.

**Automatic updates from GitHub.** The release repository is compiled in as `X4_OTA_REPO` in
`firmware/platformio.ini`. Official builds check `daangeijs/ha-paper`: once a day the device looks at the latest
release (or pre-releases, on the beta channel), and *Check for updates* / *Install* work as above. A fork sets its own
`<owner>/ha-paper`. With the `[YOU]/ha-paper` placeholder (QEMU builds) the device never contacts GitHub:
`GET /api/v1/ota` reports `auto: off` and the display's Updates page says *Update checks off*; new firmware then goes
in by upload or USB.

OTA updates the app, then the web console (its own partition, `www.bin`) once the new app is confirmed; `make flash`
and the flashers write both. Screens and settings are left alone. More detail: [docs/FLASHING.md](docs/FLASHING.md) §6.

## Logs and long-running checks

The device keeps the last ~1000 log lines in PSRAM, plus the last 2 KB of the previous boot (survives a crash or
watchdog reset, not a power-off). Secrets are masked before a line is stored.

- Console: **Advanced › Device log** (live tail, level and tag filter, previous boot, download).
- API: `GET /api/v1/logs` (`?since=<seq>`, `level=W`, `tag=HEAP,EPD`, `boot=previous`).
- Terminal, no cable needed:
  ```sh
  X4_TOKEN=x4_... make logs URL=http://ha-paper-a1b2.local FOLLOW=1     # PREVIOUS=1 for the boot before
  make monitor PORT=/dev/cu.usbmodem1101                               # serial log over USB
  ```
- Soak test over days: `X4_TOKEN=x4_... make soak URL=http://ha-paper-a1b2.local HOURS=168` polls status and
  diagnostics every 5 minutes into `soak/<host>/soak.csv` and writes a daily summary (resets, heap low points,
  battery per day, HA disconnects). A read-only token is enough for `logs` and `soak`.

## Develop

macOS or Linux; Windows through WSL2 (Ubuntu). You need git, Python 3.12+, Node 24 (`.node-version`), GNU make and
bash.

```sh
git clone --recursive https://github.com/daangeijs/ha-paper.git && cd ha-paper
python3 -m venv .venv && .venv/bin/pip install -r firmware/requirements.txt   # pinned PlatformIO, esptool, Pillow
make test
```

| Path | What |
|---|---|
| `firmware/` | PlatformIO firmware, env `x4pro`. `src/core` pure logic (host-tested), `src/app` UI, `src/hw` drivers (via the [freeink-sdk](https://github.com/Free-Ink/freeink-sdk) submodule), `src/net` Wi-Fi, web server, API, HA OAuth + WebSocket, OTA |
| `emulator/` | The behaviour spec: interactive emulator (Vite + React), the on-device web console, a device simulator, a fake HA and the API contract suite |
| `flasher/` | Browser flasher (TypeScript, esptool-js over Web Serial) |
| `sim/` | Espressif QEMU scripts that run the real firmware |
| `spec/` | `openapi.yaml` (device API), `SCHEMA.md` (screens.yaml), `default-screens.yaml`, `test-vectors/` |

**The emulator is the spec.** Behaviour is written in TypeScript in `emulator/` first. Logic that both sides share
(config parsing, paging, power rules, logs, Improv, …) is pinned by JSON files in `spec/test-vectors/`; the firmware's
native tests must produce the same results. Where firmware and emulator differ on purpose, there is one file per topic
in `firmware/deviations/` and `emulator/deviations/` (`make deviations` rebuilds the index).

```sh
cd emulator && npm ci && npm run dev    # interactive emulator: device, side panel, web console
cd emulator && npm run device-sim       # device web UI + API on :8080, fake HA on :8123 (TypeScript simulator)
make test                               # firmware native tests + emulator + flasher + tools
cd emulator && npm run build            # type-check (vitest does not)
make build                              # firmware.bin + www.bin for env x4pro
firmware/tools/render.sh                # render every screen to firmware/test/out/*.png on the host
```

**Real firmware in QEMU.** No display, touch or Wi-Fi are emulated, but boot, NVS, flash, OTA, networking and the web
server are. Setup and limits: [docs/ESP32_EMULATION.md](docs/ESP32_EMULATION.md).

```sh
make qemu            # real firmware → http://127.0.0.1:8080 (FRESH=1 wipes the flash); fake HA: cd emulator && npm run fake-ha
make qemu-contract   # the API contract suite against the firmware in QEMU
make qemu-ota        # upload, PENDING_VERIFY, confirm or roll back
make qemu-reflash    # screens and settings survive a re-flash
make qemu-glance     # simulated deep sleep on "battery"
```

The same contract suite runs against a real display (tests that need the simulator are skipped; `PUT /config` is
restored afterwards):

```sh
cd emulator && DEVICE_URL=http://ha-paper-a1b2.local X4_TOKEN_RW=x4_... npm run test:contract
```

Local builds report version `0.0.0-dev`. `make flash`, `make dist` and `make flasher` stamp the `git describe`
version. `make help` lists every target.

**Releases.** Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`: tests, a build, and a GitHub release with
`firmware.bin`, `manifest.json` (version, SHA-256, size, notes), `www.bin`, the boot parts, `x4flash.py`,
`SHA256SUMS` and the browser flasher zip. Tags with a `-` (`v0.2.0-beta.1`) become pre-releases. Write the tag's section in
[RELEASE_NOTES.md](RELEASE_NOTES.md) first: its bullets are the notes the display shows. Check a release build
locally with `make dist VERSION=0.2.0`.

## Security notes

- The HA refresh token and the Wi-Fi password are AES-256-GCM encrypted in NVS with a key derived from the chip's MAC
  and a unique eFuse ID. A copy of the flash alone doesn't reveal them; someone holding the device can derive the key.
  Flash encryption and secure boot are not enabled.
- API tokens are stored as hashes only. The HA password is never stored or logged.
- Device traffic is plain HTTP on the local network. HA traffic uses your HA URL's scheme (`https://` is verified).
- Anyone with the USB cable can set the Wi-Fi network over Improv, or re-flash the device.

More: [docs/FLASHING.md](docs/FLASHING.md) §7.

## Licence

MIT, see [LICENSE](LICENSE). Third-party components keep their own licences, listed in [NOTICE](NOTICE). Report
security problems privately, see [SECURITY.md](SECURITY.md).
