// Device health → Home Assistant entities (eink-ha-os#32): battery, charging, Wi-Fi signal, last full refresh, last boot,
// firmware, reset reason as POST /api/states/<entity_id> with the display's own HA key (the WebSocket API has no
// set-state command). What and when: core/ha_report (emulator src/core/haReport.ts). HA keeps these states in memory
// only; a WebSocket reconnect (also after an HA restart) pushes them again. HA allows POST /api/states for admins only:
// a 401/403 stops reporting until the next connect. Off with settings display.haReport = false.
// State for GET /status `ha_report`: Hub::haReportState / haReportEpoch.
#pragma once

namespace x4::net {

void haReportLoop();   // net task, after haClient().loop()

}  // namespace x4::net
