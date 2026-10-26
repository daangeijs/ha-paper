# Device health as Home Assistant entities (issue #32)

- `net/ha_report.cpp` POSTs `/api/states/<entity_id>` with the display's HA access token, over one keep-alive
  connection per push (`net/tls.h` `httpPostJsonEach`). HA's WebSocket API has no set-state command, so the open
  socket can't carry it. Entities, order and timing: `core/ha_report` = emulator `src/core/haReport.ts`,
  `spec/test-vectors/ha-report.json`. Runs on the net task; a push blocks the WebSocket loop for its duration
  (7 small POSTs on a LAN, 8 s timeout each).
- HA allows `POST /api/states` for admin users only. The console suggests a non-admin "X4 display" user for the
  display's "Advanced" key: such a display gets 401, logs it once and stops until the next connect. Visible in
  GET /status `ha_report` (`state: not_admin`) and the console's Device tab (PM decision 2026-10-16).
- Not persisted by HA, no `unique_id` (no rename/area in the HA UI). A WebSocket reconnect (also after an HA
  restart) pushes again; the 60 s minimum gap still applies.
- `wifi_signal` is left out under QEMU (Ethernet, `wifiRssi()` false); timestamps are left out until SNTP has set the
  clock. "Uptime" is reported as `last_boot` (a timestamp, like HA System Monitor), so the history doesn't change
  every push.
- Toggle `display.haReport` (default true) is a new settings key, no schema bump (#12). Only in GET/PUT /settings
  and the web console's Settings card; no tile on the device's Settings screens.
