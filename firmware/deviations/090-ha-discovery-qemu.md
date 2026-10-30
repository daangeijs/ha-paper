# HA discovery under QEMU: injected result (issue #90)

- x4qemu has no mDNS (`startMdns()` returns early: slirp has no multicast, and the IDF responder only binds the
  predefined Wi-Fi/ETH netifs, not `ETH_QEMU`). `discoverHa()` is split into the browse and
  `WifiMgr::applyDiscovered(urls)` (normalize, dedupe, `Hub::haDiscovered`). `POST /api/v1/debug/ha-discovered
  {"urls":[…]}` exists only in x4qemu (not in `spec/openapi.yaml`), calls `applyDiscovered` and logs
  `[I][HA] discovered (injected): …`, never the `[WIFI] mDNS` line. `make qemu-contract` tests what consumes the
  result (`checkDiscovered`): `console/state.home_assistant.discovered`, `server` = the first one when nothing is
  stored (the link page's "Found … on your network"), a dead first answer → 502 and nothing stored, a later browse
  not replacing a stored address. Untested in QEMU: the multicast query, the TXT parse and the `internal_url` →
  `base_url` → `<address>:<port>` order. That is FIRST_FLASH step 9b (A39).
- Changed with eink-ha-os#54: discovery no longer saves the first answer as the HA URL. It is offered (`console/state`
  `home_assistant.server` on an unlinked display = typed/stored, else the first discovered, like the simulator) and
  stored only once `POST /auth/ha/start` probed it as Home Assistant. Before, it was saved unchecked, and the console
  only showed it after a restart (`link.url` is loaded from storage at boot). `onConnected()` skips the browse while
  something is discovered, as it did once the old auto-save had stored it.
