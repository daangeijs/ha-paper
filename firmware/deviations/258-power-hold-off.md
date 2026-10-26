# Power hold turns the board off (issue #258)

- Power alone is now decided by `core/recovery` (phase `phold`): released before 2 s = a short press (standby / wake),
  held 2 s = off. The short press acts on the release, not on the KeyDown as before, so a hold never draws the standby
  face first. A KeyDown already released when the loop sees it (remote `key=power`, a very short press) counts as press
  plus release in one pass. The emulator's Power click acts at once (it has no key-up).
- A Power hold counts only after Power was released once since boot: the hold that switched the board on is still down
  when the firmware starts (#225 trail: `keyup 2537` after a power-on).
- Off on the device: "Turned off" face (full refresh), panel deep-sleep command, trail line `off <ms>`, then
  `X4Board::powerOff()` waits for Power to be released (≤ 10 s; holding Power powers the board), logs
  `[I][POWER] off by Power hold · latch released`, drives GPIO1 LOW. Still alive 1 s later (USB) → deep sleep with
  only Power as wake, latch held LOW, so unplugging switches it off. The emulator shows the face and boots on Power.
- QEMU has no latch: `QemuBoard::powerOff()` logs and returns; the App keeps the face, ignores everything but a Power
  press, which restarts the device.
- The power trail verdict after an `off` line is `none` (asked for), not `lost-awake`.
