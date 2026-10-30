# Empty-house sleep and the Nobody home face (issue #331)

- No tile on the display's Settings › Power page: it holds 8 cells already (powerSave 2×2, quiet 2, wakeEvery,
  liveMin). `display.emptyHouse` is set in the web console (Device › Power, below Live after a press) or over the API.
  The console offers Off, `zone.home` and HA's on/off entities from the entity list (binary_sensor, input_boolean;
  zone and group are not in that list, so another zone or a group is API only).
- The facts on the face come from entities the display already holds, no extra fetch: inside = the mapped inside
  thermometer (`sensor.living_temperature`), doors / windows = `binary_sensor`s with device_class door, window, opening
  or garage_door, alarm = the first `alarm_control_panel`. A door or alarm shows only when some screen has a tile for it
  (the display subscribes to config entities). The firmware reads its whole entity store; the emulator reads the
  entities on its screens. Ingest keeps `device_class` only for those four binary_sensor classes (`core/ha_stream.cpp`).
- The face redraws on every empty-house wake (one full refresh per 2 h): "Next update ~HH:MM" changes
  each time ("Updated HH:MM" was dropped in #333). Inside temperature changes alone would not wake it more often.
- The 2 h wait is cut at the start of quiet hours (so the quiet face goes up on time) and at the 03:00 OTA window; it
  does not add the glance backoff on top. Presence unknown (HA unreachable, state unknown / unavailable) counts as
  someone home: the normal interval.
- `power_trail.empty_house_sleeps` counts since power-on in RTC memory, not in `/power.txt`: the trail writes one
  `sleep empty house` line per run of them (no flash write per wake).
- Good morning page (#330): when nobody is home at the end of quiet hours (glance, source set), the page is skipped
  (disarmed, log `MORNING skipped · nobody home`) and the display goes to empty-house sleep. While asleep with nobody
  home, the Nobody home face wins over a page that is still up.
- The optional "HA automation shortens the next wake" from the issue is not built (doc idea only).
