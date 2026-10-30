# Failure states (#86)

- The emulator's mock HA has `sensor.garden_temperature` as `unavailable` so the ring state can be seen. The switch tile
  still draws its toggle when the state is unknown; the firmware hides it (older difference, unchanged).
- Number format (eink-ha-os#110, `src/core/format.ts` `numFormatOf`/`setNumFormat`): the browser emulator has no HA profile, so
  its number format follows `haLang` only (Dutch "2,1 kW"). The device simulator asks `frontend/get_user_data`
  (`language`) like the firmware and keeps `number_format` in its state file; the fake HA serves it
  (`POST /__fake/language {number_format}`).
