# Power profile switch on plug / unplug (issue #249)

- Unplugging a USB host forgets the "charged within 30 min and ≥ 4.15 V counts as external power" memory (#73,
  `core/power_profile.h` `ChargeMemory`). Before, a device unplugged with a full cell kept 240 MHz and Wi-Fi PS none
  for up to 30 min while `/status` already said battery. A charger without data lines still keeps the 30-minute rule.
  The emulator never had the rule (`chargedAgoMin` is always null there), so it matches the emulator better now.
- A profile change (external / CPU / Wi-Fi PS) is applied once it held 2 s (`kProfileSettleMs`); the first one at
  boot at once. While a change waits, no deep sleep ("stays awake: power source settling"). The emulator applies
  each decision at once.
- One log line per applied change: `[POWER] profile <battery|external> · CPU N MHz · Wi-Fi PS <none|min> (<reason>)`,
  replacing the separate `CPU …` and `Wi-Fi PS …` lines of #177.
- QEMU: `POST /__qemu/power` takes `charging=1` and `mv=N` (cell mV, default 3950) for the contract test.
