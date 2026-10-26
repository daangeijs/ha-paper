# Inbound path: mDNS restarts and the idle watch are firmware-only (issue #227)

The firmware restarts its mDNS responder on every connect, DHCP lease event (`ARDUINO_EVENT_WIFI_STA_GOT_IP`, also a
renewal with the same IP) and access-point change, and runs core `InboundWatch`: no web request for 30 min → 3 pings to
the gateway; an answer restarts mDNS only, silence reconnects Wi-Fi. Idle alone never reconnects.

The emulator and the device simulator have no mDNS responder and no Wi-Fi: `/diagnostics` `mdns` and `wifi` are fixed
values there (restarts 0, idle checks 0, bssid `3fa2` while connected). The simulator counts `web.served` and
`last_request_age_s` from its own finished responses; `open` is always 1 and `refused_503` always 0 (no connection cap).

The counters go to a minute `[I][NET] web open … served … 503 … last_req … · mdns up … restarts … · rssi … · bssid …`
line next to the `[I][HEAP]` line rather than into it: the HEAP line is `tools/monitor.py`'s parse contract.
