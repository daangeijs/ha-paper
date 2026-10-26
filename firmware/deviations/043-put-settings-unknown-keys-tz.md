# PUT /settings: unknown keys and tz (issue #43)

- `tz` is a POSIX TZ string (newlib `setenv("TZ")` + `tzset()`), not an IANA name: newlib has no zone database and
  silently runs "Europe/Amsterdam" as UTC. `core/settings_api` checks the newlib grammar (`spec/test-vectors/settings-put.json`);
  anything else is 422 `tz must be a POSIX TZ string like CET-1CEST,M3.5.0,M10.5.0/3`. `null` = unchanged; `""` is 422
  (it used to reset to the default).
- Unknown top-level or `display` keys are 422 `unknown key: <key>` / `unknown key: display.<key>`, checked before any
  value is applied. This is about API input only: stored files (`/settings.json`, NVS) still keep keys this build does
  not know, so an OTA rollback loses nothing (#12, `core/migrate`). `entity_sources` is read-only: sending it back is 422.
- New settings keys = one row in `core/settings_api.cpp` and in the emulator's `SETTINGS_KEYS` / `DISPLAY_KEYS`.
