# Power trail in /power.txt and the Power key stages (issue #225)

- The firmware keeps a power trail in userdata `/power.txt` (core/power_trail.h, 32 lines max): `awake`,
  `sleep <reason>`, and per Power press `key <ms> <mV> <usb>` (before the App acts), `standby drawn <ms>` and
  `keyup <held ms>`. A POWERON boot logs the newest lines in `power-on after running · last trail: …`.
  GET /diagnostics `power_trail` shows them; the emulator has no power path and returns `before_boot: null, lines: []`.
- Power → standby turns the frontlight off, waits 50 ms, then runs the full refresh (the emulator draws at once). This
  tests whether the frontlight change and the refresh load together cut the supply on battery.
- A Power press costs up to three small flash writes (key, standby drawn, keyup). Diagnostic build behaviour; to be
  reduced once #225 has its answer.
