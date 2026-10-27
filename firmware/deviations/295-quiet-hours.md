# Quiet hours (issue #295)

Firmware side of emulator DEVIATIONS 295 (quiet hours replace night mode and "Sleep at night").

- `core/logic.h`: `quietBackAt`, `quietTiles`, `peekOnBoot`, `validQuiet`, `quietFromNight` (vectors
  `spec/test-vectors/quiet.json`); `frontlightPct` lost its night input, `lightWakeConsumes` takes the quiet face.
  `core/power`: input `quiet`, reason `"quiet"`; `PowerSave::Night` removed. `core/migrate`: settings schema 2.
- `/settings.json` keeps the old `night` key after the upgrade (a rolled-back firmware reads it); this firmware neither
  reads nor writes it. A file that could not be upgraded (newer or unknown schema) has no `quiet`: the default 23-07.
- App: the quiet face is region `quiet` (no `time` region), drawn before standby, Classic look in both styles. Values:
  `ui::quietRows` = each tile's `tileValue` and its tile label, taken when the face goes up (`QuietSnap`, three short
  string pairs on the heap).
- Boot peek: `main.cpp` hands `net::powerWakeName()` to `App::setBootWake`; every wake but `timer` opens with a 60 s
  peek. That includes software resets (an OTA reboot, a crash), not only a power-on: the light follows its timeout,
  so a 03:00 auto-install reboot lights the panel for up to a minute. QEMU's power-on after a Power hold is a software
  restart, so it peeks too.
- `"Back at 07:00"` is drawn in Bold 52 (the largest Classic size with letters; 76 px and up hold digits only); the
  emulator uses 52 px to match.
