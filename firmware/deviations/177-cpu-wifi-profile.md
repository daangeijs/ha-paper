# CPU profile and Wi-Fi power save applied (issue #177)

- ROBUSTNESS_PLAN 3.2 says `esp_pm` 80–240 MHz with a `PerfLock` around TLS / OTA / renders. The Arduino libs of
  pioarduino 55.03.311 ship `# CONFIG_PM_ENABLE is not set`, so `esp_pm_configure` has nothing to configure. Instead
  `cpuProfile` picks a fixed clock with `setCpuFrequencyMhz`: `full` = 240 MHz, `auto` = 80 MHz (`core/power`
  `cpuMhzFor`, emulator `CPU_MHZ`). 80 MHz is the lowest clock with APB at 80 MHz: UART, SPI to the panel, I2C, LEDC
  and Wi-Fi keep their clocks, so switching from the main loop is safe while another task is mid-transfer. No
  PerfLock: renders and the HA state burst run at 80 MHz on battery. Light sleep (3.5) is still not built.
- Applied by `net/power.cpp` once a second in live mode only. A glance wake keeps the boot defaults (240 MHz, modem
  sleep `min`): it lasts seconds and is mostly TLS.
- Wi-Fi PS goes through `wifiPsSet` (`net/health.cpp`). A `WifiPsOff` hold (OTA, HA token refresh, TLS handshake)
  wins; the rules' mode is stored and set when the last hold ends (before #177 the hold restored the mode from before
  it). Re-applied every check, because a Wi-Fi restart resets the driver to Arduino's default `min`.
- `/status` `power.applied {cpuMhz, wifiPs, psOffHeld}` (new) shows what the rules set; `power.cpuMhz` / `power.wifiPs`
  stay the readings. QEMU has no clocks or radio: `applied` is tracked and logged (`[qemu] CPU auto · 80 MHz …`), the
  calls are skipped, `power.cpuMhz` reads what QEMU reports.
- Simulator: `power.cpuMhz` / `power.wifiPs` equal `applied` (`wifiPs` reads `none` during an OTA, `psOffHeld` true).
