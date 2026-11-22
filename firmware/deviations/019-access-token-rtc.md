# HA access token kept in RTC memory across deep sleep (issue #19)

- Firmware only: the emulator has no deep sleep and no token refresh to skip, so there is no spec or vector for it.
  The pure part is `core/access_cache` (native test `test_access_cache`); the fake HA counts refresh grants
  (`GET /__fake/state` `refresh_grants`) and `sim/qemu/glance-test.sh` checks a timer wake asks none.
- After a refresh, and again when the WebSocket stops before a deep sleep (with the time left: a token refreshed
  before the clock was set, as on the first link in QEMU, is kept too), the access token, its expiry (epoch ms) and a
  hash of HA URL + client id + refresh token sit in an `RTC_NOINIT` record with a checksum (`net/ha_client.cpp`). A
  wake reuses it while more than 2 min is left, the clock has not stepped back more than 60 s since it was obtained,
  and the link is the same. HA's tokens last 30 min, so at
  the 15-min glance interval about every other wake skips `/auth/token`; at 30 min or more none do.
- Fallback: `auth_invalid` on the WebSocket, or a 401 on the HA report, drops the token and the RTC copy; a token that
  came from RTC retries at once (no backoff), so a refused kept token costs one extra connect, not the wake.
- Wiped on: reconnect requests and re-link (`HaClient::restart`), unlink, every reboot through the restart path (OTA,
  factory reset, reboot button, health restart), power loss (RTC RAM cleared; the checksum rejects garbage). Kept on
  deep sleep and on QEMU's simulated sleep (`esp_restart`). Not wiped: the OTA rollback guard's direct `esp_restart`
  (the token stays bound to the same link and expires within 30 min).
- Physical access: RTC slow RAM is readable over JTAG/USB-serial debug like the rest of RAM, which already holds the
  same access token while awake; it never reaches flash, logs (only "N s left") or the API. The refresh token in
  flash stays the long-lived secret, so this is no worse than today.
