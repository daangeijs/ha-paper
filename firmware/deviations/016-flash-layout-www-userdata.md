# Flash layout: `www` + `userdata` (issue #16)

The handoff had one 3.5 MB `littlefs` partition at 0xC90000 for the web console *and* `screens.yaml` /
`settings.json` / `diag.json`. Every USB flash wrote a fresh `littlefs.bin` there, so a re-flash silently reset the
user's screens and settings. Now (`partitions.csv`):

| Partition | Offset / size | Holds | Written by |
|---|---|---|---|
| `www` | 0xC90000 / 0x340000 (3.25 MB) | web console `/www/*.gz` + `openapi.yaml.gz` (`www.bin`) | every flash (`x4flash.py`, browser flasher, `make flash`, release notes' esptool line) |
| `userdata` | 0xFD0000 / 0x20000 (128 KB) | `/screens.yaml`, `/settings.json`, `/diag.json` | only the firmware; formatted on first mount, never imaged |

- Placement: userdata sits directly below coredump (0xFF0000), so both never-flashed data partitions are at the top
  and every flasher write ends at or below 0xFD0000. `www` keeps the old 0xC90000 start, so the five write offsets
  are unchanged; only the last image shrank and was renamed (`littlefs.bin` → `www.bin`). The rename is on purpose:
  an old 3.5 MB `littlefs.bin` written at 0xC90000 would run over userdata. `flasher/` (`writePlan.ts`) and
  `x4flash.py` refuse any part whose erased sectors reach 0xFD0000, and the flasher's `checkOurTable` requires
  userdata at 0xFD0000/0x20000.
- `www` is mounted without format-on-fail (a blank one = fallback setup page); `userdata` is formatted when it does
  not mount. 128 KB = 32 LittleFS blocks; today's files are a few KB (the handoff `screens.yaml` is ~3 KB).
- NVS (0x9000-0xDFFF) and coredump (0xFF0000) did not move.
- Factory reset formats userdata (was: delete `/screens.yaml` + `/settings.json`) and clears HA Paper's NVS
  namespaces; `hw_calib` and `www` stay. `/diag.json` is written back right away from the RTC ring (`diagSave()`),
  because the emulator keeps diagnostics across a factory reset.
- Migration: a device with the old layout loses screens/settings once on its first flash with this layout (the
  partition table changes, NVS does not). No HA Paper device had been flashed when this changed.
- Proof: `make qemu-reflash` (sim/qemu/reflash-test.sh) writes screens.yaml + a setting over the API, re-flashes the
  five parts into the QEMU flash image the way esptool does (4 KB sector erase + write), boots the new build and
  checks the userdata bytes and both files are unchanged.
