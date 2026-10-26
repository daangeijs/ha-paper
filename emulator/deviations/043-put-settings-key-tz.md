# PUT /settings key and tz check (issue #43)

- Device sim and the in-browser emulator reject unknown keys (`unknown key: …`) via `settingsPutError()`, same text as
  the firmware. The sim validates `tz` against the newlib POSIX grammar; the in-browser emulator has no clock zone, so a
  valid `tz` is accepted and not kept. `display.otaAuto` (firmware-only, Settings › Updates) is accepted and checked so
  a firmware GET body round-trips.
