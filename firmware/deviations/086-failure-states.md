# Failure states (#86)

- An entity HA reports as `unavailable` / `unknown` on a stat, gauge or switch tile: no "—" but a 28 px ring (bottom on
  the value baseline) and the word ("Unavailable" / "Unknown"; NL "Niet beschikbaar" / "Onbekend") on the sub line
  (switch: next to the ring; Sleek gauge: the empty track is the mark; Sleek switch: after the label). An entity not
  received at all still shows "—". Our own logical tiles (solar, battery, …) are unchanged.
- HA unreachable: the offline mark in the top bar gets "since hh:mm". The firmware takes the time of the last HA data
  (`haLastDataEpoch`, so nothing before SNTP has set the clock); the emulator its `lastUpdate`.
- `GET /console/state` `entity_gaps` is computed in the main loop once a second from the App's store, so the console
  can lag the panel by up to a second. x4qemu only: `GET /__qemu/regions` returns each region's canvas signature
  (the drawn text), for the contract checks.
  Wi-Fi keyboard, the OTA and recovery faces, the setup steps on the display. Numbers: see eink-ha-os#110 below.
