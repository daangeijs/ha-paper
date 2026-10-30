// Inbound path counters (eink-ha-os#227): web server, mDNS responder, Wi-Fi AP. Overnight the .local name stopped resolving
// while the device kept pushing to HA; these tell "name gone" from "nothing reaches the device".
// web*: AsyncTCP task. The rest: net task. netStatsFill: any task.
#pragma once
#include <cstdint>

#include "core/diag.h"

namespace x4::net {

void webOpened();    // a connection got a request object
void webDone();      // the gate token released: connection closed, or an API handler started (its onDisconnect replaces it)
void webRefused();   // 503 at the connection cap
uint32_t webServed();

void mdnsStarted(bool up, const char* reason);   // reason nullptr = first start this boot, else a restart
void mdnsAnnounced();                            // eink-ha-os#376: an init / re-bind / repair posted a probe + announce
void mdnsSample(const char* host, bool v4);      // eink-ha-os#376: the responder's hostname ("" = none) + STA IPv4 pcb up
void wifiSample(bool rssiKnown, int rssi, const uint8_t* bssid);   // bssid nullptr = not associated
void idleChecked(bool reconnected);              // core InboundWatch ran a gateway check

void netStatsFill(diag::Net& n);   // GET /diagnostics web, mdns, wifi
void netStatsLog();                // one [I][NET] line (net task, once a minute)

}  // namespace x4::net
