// Net-task health (docs/ROBUSTNESS_PLAN.md phase 2): heap guard before TLS, the maintenance restart (Wi-Fi offline
// too long, heap fragmented for 30 min → 03:00–04:00), Wi-Fi power save off during long transfers. The decisions
// (thresholds, timing) are in core/net_policy, host-tested.
#pragma once
#include <cstdint>

#include "core/diag.h"

namespace x4::net {

uint32_t heapLargestFree();   // internal RAM: largest free block (what one TLS handshake needs in one piece)
uint32_t heapMinFree();       // internal RAM: lowest free total since boot
uint32_t heapFreeInternal();  // internal RAM: free total now

// false (and logged) when internal RAM is below core kTlsMinFreeInternal / kTlsMinLargestBlock (kTlsMin*Pooled while
// the TLS reserve has two slots free, #149): the caller fails this attempt and backs off instead of crashing
// mid-handshake. `what` = host, for the log.
bool tlsHeapOk(const char* what);

// No OTA download/upload running, the running image is confirmed (a reset of a PENDING_VERIFY image rolls back),
// and no restart is already queued.
bool maintenanceRestartAllowed();
void maintenanceRestart(const char* why);   // via Hub::restartPending → pump() → Board::restart() (light off)

void healthLoop();   // net task: heap watch every 10 s, `[I][HEAP] free … largest …` log line every 60 s

// Heap low point (#198, #200): any task, after something that may have used a lot of internal RAM. When the internal
// minimum since boot dropped >= 512 B below the last low point: `[W][HEAP] low point …` with what was going on
// (`where` = this checkpoint, WebSocket, TLS slots, HA report push, OTA, open web requests, last API path, RSSI), kept
// for GET /diagnostics heap.low_point. Allocation-free.
void heapCheckpoint(const char* where);
void heapLowPoint(diag::LowPoint& out);
void heapRequestOpen(const char* path);   // web server: an API request starts / its connection closes
void heapRequestClosed();
void heapReportInFlight(bool on);         // ha_report: POST /api/states running

// Wi-Fi power save (modem sleep) off while held; nests across tasks. When the last one ends, the power rules' mode
// (wifiPsSet) returns, or the mode from before the first one if the rules set none yet. No-op when Wi-Fi is not
// started; under X4_QEMU only the hold count is kept.
void wifiPsOffAcquire();
void wifiPsOffRelease();
// Power rules (#177): modem sleep min or none. Re-applied when the driver drifted (a Wi-Fi restart resets it).
// A hold wins: false = held, applied when it ends.
bool wifiPsSet(bool modemSleep);
bool wifiPsHeld();
struct WifiPsOff {
  WifiPsOff() { wifiPsOffAcquire(); }
  ~WifiPsOff() { wifiPsOffRelease(); }
  WifiPsOff(const WifiPsOff&) = delete;
  WifiPsOff& operator=(const WifiPsOff&) = delete;
};

}  // namespace x4::net
