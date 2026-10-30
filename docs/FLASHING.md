# Flashing HA Paper on the Xteink X4 Pro

Works from macOS, Linux and Windows. Hardware facts: [HARDWARE.md](HARDWARE.md).

## Flash from the browser

A static page in `flasher/` (Vite + TypeScript, [esptool-js](https://github.com/espressif/esptool-js) over Web
Serial) does what `x4flash.py` does, without Python. It needs Chrome, Edge or another Chromium browser on a desktop
computer and an `https://` page (or `localhost`); Firefox, Safari and phones have no Web Serial.
Hosted copy: [hapaper.daangeijs.nl](https://hapaper.daangeijs.nl), the latest beta or stable release.

The page doubles as the landing page for people who are not developers: what HA Paper is, four screen renders, what
you need, the four install steps, what to do after installing, and a
restore section. The checks and offsets below sit in a collapsed *Technical details* section. The screen images are
committed 2-bit PNGs in `flasher/src/screens/` (5-12 KB each); `make flasher-screens` re-renders the UI and refreshes
them.

1. Connect the X4 Pro (cable from §0). No buttons: the page resets it into download mode over USB.
2. **Connect**: pick the Espressif device. The page reads the secure boot and flash encryption eFuses and stops if
   either is on, or if it can't read them.
3. **Read backup**: reads all 16 MB in 256 KB chunks, checks each chunk against the chip's own MD5, and saves
   `x4pro_stock_YYYYMMDD.bin` plus a `.sha256` file. Ticking "I already have a full backup" skips this.
4. **Install**: re-checks the bundled files against `SHA256SUMS` and `manifest.json`, checks that the partition table
   already on the display keeps NVS at 0x9000 (0x5000 bytes), asks once, then writes the five parts at their own
   offsets. NVS (0x9000-0xDFFF) and userdata (0xFD0000-0xFEFFFF) are never written; the page refuses any write
   plan that would erase a sector in either.
5. **Wi-Fi** (page step 4): after the display restarts, the page sends the Wi-Fi name and password over the same
   USB cable ([Improv Wi-Fi serial](https://www.improv-wifi.com/serial/)): it lists the networks the display sees,
   sends the name and password, and links to `http://ha-paper-XXXX.local` and the IP once the display has joined. If the display doesn't answer, join Wi-Fi on the
   display instead (§4).
6. **Restore** takes a 16 MB backup (and its `.sha256`, if picked) and writes it at 0x0.

Hosting: `make flasher` builds `dist/` and then the site into `dist/flasher/`, with the release files in
`dist/flasher/firmware/` (GitHub release assets can't be fetched from a page: no CORS headers).
Upload that folder to any static HTTPS host; it uses relative URLs only. `make flasher-site` packages an existing
`dist/` without rebuilding; it fails if `dist/` was built from another commit than the current `git describe`, and
refuses a `-dirty` version unless `ALLOW_DIRTY=1`. Each GitHub release also has the same folder as `ha-paper-flasher-<version>.zip`.
The release workflow deploys that folder (plus a `CNAME`) to GitHub Pages of `daangeijs/ha-paper` on every beta and
stable tag; alpha tags and the private repo never deploy. One-time setup: Settings → Pages → Source "GitHub Actions"
and custom domain `hapaper.daangeijs.nl`; DNS `CNAME hapaper → daangeijs.github.io`.
Development: `cd flasher && npm ci && npm test && npm run dev` (copy a `make flasher` `firmware/` folder into
`flasher/public/firmware/` to have files to install). Not yet tried on a real X4 Pro (as of 2026-10-16; #20).

## Flash a release (no repo checkout)

Each GitHub release ships `x4flash.py` next to the firmware files. You need Python 3 and esptool
(`pip install esptool`; Windows: `py -m pip install esptool`) and the cable from §0.

- macOS without `python3`: run `xcode-select --install` (or install Python from python.org).
- `pip` refuses with *externally-managed-environment* (Homebrew Python, recent Debian/Ubuntu): use a venv in the
  release folder: `python3 -m venv x4env && x4env/bin/pip install esptool`, then `x4env/bin/python x4flash.py`.
- Display not found at all: check §1 (some third-party units have USB download locked).

1. Download all files of the release into one folder.
2. Connect the X4 Pro over USB. No buttons needed.
3. In that folder: `python3 x4flash.py` (Windows: `py x4flash.py`).

The script checks the files against `SHA256SUMS`, finds the display (Espressif USB id; pass `--port` if it finds
none or several, §0 has the port names), stops if secure boot or flash encryption is on, reads a full 16 MB backup
into `backups/` the first time, asks once, then writes the five parts at their own offsets. NVS and userdata are never
written: saved Wi-Fi, the Home Assistant link, the OEM panel id, your screens and your settings survive. Keep the backup; `python3 x4flash.py restore
backups/x4pro_stock_YYYYMMDD.bin` puts the stock firmware back. Then continue with *First boot* (§4).

Everything below is the developer path and runs from the repo root.

## 0. What you need

| | |
|---|---|
| Cable | The magnetic **pogo → USB-C adapter** that came with the X4 Pro, plus a **data** USB-C cable (charge-only cables enumerate nothing). |
| Repo | `git clone --recursive <repo-url>` (freeink-sdk is a submodule). Already cloned without it: `git submodule update --init --recursive`. |
| Python | 3.12 (CI) or newer: `python3 -m venv .venv && .venv/bin/pip install -r firmware/requirements.txt` (once; exact PlatformIO, esptool, Pillow and fontTools pins). Windows without WSL: `py -m venv .venv` then `.venv\Scripts\pip install -r firmware\requirements.txt`. |
| Node | 24, the version in `.node-version` (CI uses the same file). Needed for the web console (`emulator/`). |
| Shell | GNU make + bash. macOS and Linux have both; on Windows use WSL2 (Ubuntu). |

**Serial port names:**

| Host | Port | Notes |
|---|---|---|
| macOS | `/dev/cu.usbmodem*` | `ls /dev/cu.usbmodem*` (plug/unplug to see which one appears). Use the `cu.` device, not `tty.`. |
| Linux | `/dev/ttyACM0` (USB-Serial/JTAG, `303a:1001`) | Your user needs the `dialout` group (`uucp` on Arch): `sudo usermod -aG dialout $USER`, then log out and in. If the port flaps, ModemManager may be probing it: stop it or add a udev rule `ATTRS{idVendor}=="303a", ENV{ID_MM_DEVICE_IGNORE}="1"`. |
| Windows + WSL2 | `/dev/ttyACM0` inside WSL | Install [usbipd-win](https://github.com/dorssel/usbipd-win), then in an admin PowerShell: `usbipd list`, `usbipd bind --busid <id>`, `usbipd attach --wsl --busid <id> --auto-attach`. `--auto-attach` matters: the chip re-enumerates when esptool resets it into download mode. Not yet tried on hardware. |
| Windows native | `COM3`, `COM5`, … (Device Manager → Ports) | No `make`; run esptool directly: `py -m pip install esptool==5.5.0`, then `py -m esptool --chip esp32s3 -p COM5 …` with the esptool lines of the Makefile targets (`backup`, `restore`, `chip-check`). |

A port target run without `PORT` prints the first candidate it finds (`/dev/cu.usbmodem*`, `/dev/ttyACM*`, `/dev/ttyUSB*`).
Examples below use `/dev/cu.usbmodem1101`; substitute yours.

Download mode needs no buttons: esptool resets the ESP32-S3 into the ROM bootloader over its USB-Serial/JTAG port
(verified on the X4 Pro with `make flash` and the browser flasher, 2026-10-26). If a command says *"Failed to
connect"* / *"No serial data received"*: close other serial monitors, replug USB and run it again. Button fallback
(not verified on our unit): Reset is the small button on the top edge next to the microSD slot; press Reset while
holding Prev (left side, GPIO0, the boot strap), then release Prev: the chip should start in download mode. If the
firmware hangs and USB won't connect, see [#225](https://github.com/daangeijs/eink-ha-os/issues/225) and
[#244](https://github.com/daangeijs/eink-ha-os/issues/244).

## 1. Check the unit is not locked

```sh
make chip-check PORT=/dev/cu.usbmodem1101
```

Shows `chip-id` and `get-security-info`. Units bought from xteink.com are unlocked. Some third-party (AliExpress)
X3/X4 units have USB download disabled or secure boot / flash encryption burned into eFuses — the X4 Pro's status
is undocumented. **Do not flash** if the output shows:

- `Secure Boot: Enabled` or `Flash Encryption: Enabled` (look at the "Flags"/key purposes lines), or
- esptool cannot connect at all, even after a replug (USB download may be disabled by eFuse).

eFuses are one-way; nothing in this project burns any.

## 2. Back up the stock firmware (always)

```sh
make backup PORT=/dev/cu.usbmodem1101
```

Reads the full 16 MB flash to `backups/x4pro_stock_<YYYYMMDD>.bin` (+ `.sha256`, read-only), ~3 minutes.
It refuses to overwrite an existing file. Keep this file somewhere safe and private: it is the only way back to the
stock reader (stock boots `app1` at 0x7F0000 with its own partition table; HA Paper replaces that table). Its NVS also
holds the stock firmware's Wi-Fi password in plain text.

## 3. Build and flash

```sh
make build                                   # firmware.bin + www.bin (runs npm build:device-ui)
make flash PORT=/dev/cu.usbmodem1101         # bootloader, partitions, otadata, app, then www (web console)
make monitor PORT=/dev/cu.usbmodem1101       # serial log (Ctrl-C to quit)
```

`make flash` refuses to run until a backup exists in `backups/` (override with `FORCE=1`). It uses
`pio run -t upload` (bootloader 0x0, partition table 0x8000, `boot_app0.bin` → otadata 0xE000 so `app0` boots,
app 0x10000) and `pio run -t uploadfs` (`www.bin` → www 0xC90000). The NVS partition (0x9000) is **not** erased: it
keeps the OEM `hw_calib/screenType` value, which exists nowhere else. The firmware only logs it; a display-bus probe
decides the panel controller.

`make monitor` runs `firmware/tools/monitor.py` (needs only pyserial, which esptool brings): host timestamps, `[E]` red
and `[W]` yellow, Improv Wi-Fi frames as one `[IMPROV] state ready` line instead of binary noise, and it waits and
reconnects when the port disappears on a reset or re-flash. Pass options with `ARGS=`: `--tag HA,NET` shows only those
tags; `--csv heap.csv` appends free / minimum / largest internal heap from the `[I][HEAP]` line the firmware logs once a
minute (soak tests). It does not decode panic backtraces: use `make monitor-pio` for that.

`x4flash.py` (release path above, source `firmware/tools/x4flash.py`) writes the same separate parts and keeps NVS too.

> **Never run `esptool erase-flash` and never write a full-flash image (anything written at 0x0 that covers NVS at
> 0x9000), except when restoring your own backup (§5).** Either wipes NVS, including the OEM `hw_calib` panel id that
> exists nowhere else. That is also why releases have no merged "factory image".

Partition layout (`firmware/partitions.csv`): nvs 0x9000 · otadata 0xE000 · app0 0x10000 (6.25 MB) ·
app1 0x650000 (6.25 MB) · www 0xC90000 (3.25 MB LittleFS: web console, `www.bin`) · userdata 0xFD0000 (128 KB
LittleFS: `screens.yaml`, `settings.json`, `diag.json`) · coredump 0xFF0000.

**Screens and settings survive a re-flash.** No flasher (`x4flash.py`, the browser flasher, `make flash`, the
manual esptool line in the release notes) writes userdata: the firmware formats it on its first boot and only the
firmware writes it after that. So a re-flash replaces the app and the web console and keeps your `screens.yaml`,
display settings and the boot history (`GET /api/v1/diagnostics`), just as it keeps Wi-Fi and the HA link in NVS.
*Factory reset* on the display (or `POST /api/v1/device/factory-reset`) erases userdata and HA Paper's NVS
namespaces, and keeps `hw_calib` and the boot history. Tested in QEMU: `make qemu-reflash`.

Builds from before this layout (`littlefs.bin`, one 3.5 MB partition at 0xC90000) kept screens and settings in the
same image as the web console, so the first flash with the split layout starts with default screens and settings
once. Don't mix files from two releases: an old `littlefs.bin` written at 0xC90000 would run over userdata, which
is why the image is now called `www.bin` and both flashers refuse anything that reaches 0xFD0000.

## 4. First boot

1. The panel does one full refresh; the serial log shows the controller probe (SSD1677 / UC8179 / UC8279).
2. **No Wi-Fi saved** → display shows *SETUP · Connect to Wi-Fi (1/2)*. The browser flasher's step 4 sends the
   Wi-Fi name and password over the USB cable ([Improv Wi-Fi serial](https://www.improv-wifi.com/serial/) on the
   console, 115200 baud). A serial monitor (`make monitor`) holds the port, so close it before step 4. Without
   Improv, either
   - pick a network on the display and type the password on the on-screen keyboard, or
   - tap *Set up from phone*: join the open Wi-Fi **HA-Paper-Setup** with your phone; the captive portal opens
     `http://192.168.4.1/setup` (otherwise browse there). Pick the network, enter the password. The phone may
     lose the page for a moment while the display switches radio channel — that is expected. The hotspot turns
     off ~8 s after the display joined your Wi-Fi; rejoin your home Wi-Fi.
3. Display shows *Finish in your browser (2/2)* with a QR code and its hostname `ha-paper-XXXX.local` (XXXX = last
   4 hex digits of the chip's MAC, so two displays on one network don't collide), plus the IP as fallback.
4. Open the `http://ha-paper-XXXX.local` address shown on the display, or `http://<ip address>` (shown next to it
   and on the System screen; your router's DHCP list has it too), or scan the QR (it carries a one-time
   4-character pairing code, valid 10 min) → **Sign in with Home Assistant**. Home Assistant is found via mDNS (`_home-assistant._tcp`); if not, enter
   its address. Sign in on Home Assistant's own page (2FA works) with your own account. The display's key has
   that account's HA rights. For a key with fewer rights, link with a separate non-admin HA user (e.g. "X4 display")
   and then sign in again with an admin account to edit ("Advanced" on the link page).
5. The display links (stores only the HA refresh token, encrypted), connects the WebSocket and redraws once to
   Home with live data; the same sign-in opens the configurator (view-only for a non-admin HA user).

Fallback without OAuth: the setup page also accepts a Home Assistant **long-lived access token**
(`POST /api/v1/ha/token`).

If the web console was not flashed (no Node at build time) the device serves a minimal built-in setup page that
covers steps 2–5; the REST API is complete either way.

## 5. Restore the stock firmware

```sh
make restore PORT=/dev/cu.usbmodem1101 FILE=backups/x4pro_stock_20261013.bin
```

Checks the file is exactly 16 MB (and its `.sha256` if present), writes it at 0x0. Replug USB if it doesn't start.
Equivalent manual command: `.venv/bin/esptool --chip esp32s3 -p PORT write-flash 0x0 backups/x4pro_stock_….bin`.

## 6. Releasing an update (OTA)

1. Release repository: `firmware/platformio.ini` → `-DX4_OTA_REPO=\"daangeijs/ha-paper\"` for official builds; a fork
   sets its own `<owner>/ha-paper`. With the `[YOU]/ha-paper` placeholder (`x4qemu` builds) update checks are off:
   no daily check, `GET /api/v1/ota` reports `auto: off`, `repo: ""` and "Update checks are off in this build…",
   `POST /api/v1/ota` returns 409, and the display's Updates page says "Update checks off". Upload still works.
   QEMU and CI never call api.github.com. The repository must be public (or the device would
   need a token for release assets).
2. Tag and push:
   ```sh
   git tag v0.4.0 && git push origin v0.4.0           # stable
   git tag v0.4.1-beta.1 && git push origin v0.4.1-beta.1   # pre-release → "beta" channel only
   ```
   Any tag with a `-` (`-alpha.1`, `-beta.1`, `-rc.1`) is published as a GitHub pre-release. Tags containing `alpha`
   get an "untested on hardware" warning at the top of the release notes. Check a release build locally first with
   `make dist VERSION=0.4.0` (the workflow additionally checks the version string is stamped into `firmware.bin`).
3. `.github/workflows/release.yml` runs the native + emulator tests, builds with `X4_FW_VERSION=0.4.0`, and
   publishes `firmware.bin`, `manifest.json` (`{version, sha256, size, notes[], www}`; `www` = `{path, size, sha256}`
   of `www.bin`; notes = the bullets of the tag's
   `## 0.4.0` section in `RELEASE_NOTES.md`, ≤ 6 of ≤ 34 characters, or the release fails), `www.bin`, `bootloader.bin`, `partitions.bin`, `boot_app0.bin`,
   `x4flash.py` (USB flasher), `SHA256SUMS` and `ha-paper-flasher-<version>.zip` (browser flasher site with these files).
4. Devices check `GET https://api.github.com/repos/<owner>/ha-paper/releases/latest` (stable) or `/releases`
   (beta) at most once a day (unauthenticated GitHub API: 60 requests/hour per IP), or when you press
   *Check now* / `POST /api/v1/ota/check`. Installing needs ≥ 30 % battery (or charging).
5. Install = stream `firmware.bin` into the inactive slot while hashing it; SHA-256 and size must match
   `manifest.json`, otherwise nothing changes. Then reboot into the new slot in `PENDING_VERIFY`.
6. Rollback: the new image is confirmed (`esp_ota_mark_app_valid_cancel_rollback`) once it has run for 60 s with
   the network up (Wi-Fi/IP) and the UI loop running. Home Assistant plays no part, so an update sticks whether or not
   HA is linked or reachable. If it crashes or resets before that, the bootloader boots the previous image; if it hangs
   or gets no network within 10 minutes (hang guard 12 min, RTC watchdog ~13 min), a guard timer restarts it and the bootloader rolls back (the RTC watchdog is
   the backstop). Tested in QEMU: `make qemu-ota`.
7. Web console (#350): `www.bin` carries `version.txt` (the build's version). Once the new image is confirmed (step 6,
   never before, so a rolled-back app never keeps a newer console), a display whose console version differs from its
   firmware fetches release `v<version>`, checks `manifest.json` `www`, and streams `www.bin` into the `www` partition
   (0xC90000–0xFD0000 only; NVS and userdata are never touched) with SHA-256 and size checks. It tries right after the
   update, after every check, otherwise every 6 h; while the console is offline (a failed or interrupted write) every
   10 min and on every reconnect. The download runs in small steps on the network task; firmware installs and uploads
   answer "try again in a minute" until it is done. While the console is out of date or being written, `/` shows a
   status page (the old console stays at `/?console=old`); a failed write keeps that page up until the next attempt.
   `GET /api/v1/ota` reports `www {version, sha256, current, state, message}`.

Local upload without GitHub (two steps: firmware first, then the console once the display is back and confirmed, about
a minute after the restart):
`curl -X POST -H "Authorization: Bearer $X4_TOKEN" --data-binary @firmware.bin -H "Content-Type: application/octet-stream" "http://ha-paper-XXXX.local/api/v1/ota/upload?sha256=$(sha256sum firmware.bin | cut -d' ' -f1)"`
`curl -X POST -H "Authorization: Bearer $X4_TOKEN" --data-binary @www.bin -H "Content-Type: application/octet-stream" "http://ha-paper-XXXX.local/api/v1/ota/upload-www?sha256=$(sha256sum www.bin | cut -d' ' -f1)"`
(macOS: `shasum -a 256` instead of `sha256sum`; `http://<ip address>` works in place of the `.local` name). `make flash`
and the web flasher write both as before; userdata (screens, settings) is never touched.

**Renamed from X4 Home (#217).** A display that ran an X4 Home build gets the new names after the upgrade: mDNS/DHCP
hostname `ha-paper-XXXX.local` (was `x4-home-XXXX.local`; same XXXX, the IP is unchanged), setup hotspot
`HA-Paper-Setup`, and the health entities in Home Assistant become `sensor.ha_paper_XXXX_…` (the old
`sensor.x4_home_XXXX_…` ones stop updating; delete them in HA). Wi-Fi, the HA link, API tokens, screens and settings
are kept: NVS namespaces, settings files, the `/api/v1` paths and the `x4_` token prefix did not change. A display
whose name was never set now shows *HA Paper*.

## 7. Security notes / limitations

- **Secrets at rest** (HA refresh token, Wi-Fi password) are AES-256-GCM encrypted in NVS with a key derived
  (HMAC-SHA256) from the chip's base MAC and eFuse `OPTIONAL_UNIQUE_ID`. A copy of the flash alone does not reveal
  them, but anyone holding the device can read those eFuses (`esptool read-mac`, `espefuse summary`) and derive the
  key. Real protection needs flash encryption + secure boot (custom sdkconfig, irreversible eFuse burns) — not done.
  The Arduino core has no NVS encryption, hence the app-level scheme.
- **API tokens** are stored as SHA-256 hashes only (shown once at creation). Failed bearer auth: 5 per IP per
  minute, then 429 for 60 s.
- **HTTP only**, local network: the session cookie is `HttpOnly; SameSite=Lax` (12 h) but not `Secure`, and
  traffic between browser and display is unencrypted. HA traffic uses whatever scheme your HA URL has (`https://`
  verified against the built-in Mozilla CA bundle).
- **Improv Wi-Fi** on the USB console is always on: whoever holds the cable can set the Wi-Fi network (they could
  also re-flash). The password is not logged; it is saved like any other Wi-Fi join.
- **SoftAP** `HA-Paper-Setup` is open while no Wi-Fi is saved; it only offers Wi-Fi setup. Setup endpoints are open
  until the display is linked to Home Assistant; afterwards they need an admin session.
- Factory reset erases only HA Paper's NVS namespaces and files; the OEM `hw_calib` namespace is kept.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `make backup` / `flash`: *Failed to connect* | Replug USB and retry. Close other serial monitors. Try another cable/port. |
| Display stays blank after flashing | Replug USB. Check `make monitor`: the `[EPD]` probe line; an unknown controller batch falls back to SSD1677. |
| `ha-paper-XXXX.local` doesn't open | Check the exact name on the display (XXXX differs per unit). `.local` names fail on many Android phones, some Windows setups and guest/VLAN networks (mDNS does not cross them): use the IP shown on the device. |
| Linux: `Permission denied: '/dev/ttyACM0'` | Add yourself to `dialout` (§0) and log in again. |
| WSL2: no `/dev/ttyACM0` | `usbipd attach --wsl --busid <id> --auto-attach` from Windows (§0); it detaches when the cable is replugged. |
| Console says "View only" | That HA user is not an admin: the display is linked and you can look, but editing needs an admin. Use **Sign in as an admin**. |
| Display shows "Key revoked" | The refresh token was revoked in HA (Profile → Security) or unused for 90 days: sign in again from the web console. |

## 9. Soak test (watch a display for days)

`X4_TOKEN=x4_… make soak URL=http://ha-paper-XXXX.local [HOURS=168] [INTERVAL=300]` runs `firmware/tools/soak.py`:
every 5 minutes it reads `/api/v1/status` and `/api/v1/diagnostics` with a read token (web console › Advanced › API; the
token comes from `X4_TOKEN` only and is never printed) and appends a row to `soak/<host>/soak.csv`: uptime, heap
free / lowest / largest block, battery and power source, HA link, `ha_report` state, reset reason. Reboots are found
from uptime and the boot ring and logged with their reset reasons. `summary-YYYY-MM-DD.md` next to it is rewritten
after every poll: resets by reason, minimum heap per 6 h, battery %/day on battery, HA disconnects, and the times the
display did not answer, as *asleep* (it woke with reset reason `DEEPSLEEP`) or *down*. With a `.local` name in `URL` each poll
also checks the name and the IP separately (`name_dns`, `ip_tcp`, `ip_http`, `name_http`; `IP=` sets a fallback
address until the name resolves once), so "the name stopped resolving" is told apart from "nothing reaches the
display" (#227); the column meanings are in the script's docstring. The same command works against
`npm run device-sim` (`URL=http://127.0.0.1:8080`) and `make qemu`; `python3 firmware/tools/soak.py --summarize
soak/<host>/soak.csv` re-prints the summaries.
