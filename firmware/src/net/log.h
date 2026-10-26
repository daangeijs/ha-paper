// Device log (#200): every LOG_* line (include/Logging.h → x4Log) is redacted (core/log_ring.h redact), printed on
// Serial as `[I][TAG] message` and kept in two rings (core/log_ring.h):
//  * 64 KB in PSRAM, this boot (GET /api/v1/logs);
//  * 2 KB in RTC_NOINIT memory (RTC slow, not heap), which survives esp_restart(), panics, watchdog resets and deep
//    sleep; logBegin() copies it to PSRAM as the previous boot's tail (GET /api/v1/logs?boot=previous).
// Internal RAM: ~40 B of state + the mutex; the line scratch buffers live in the PSRAM block. Without PSRAM only
// Serial and the RTC tail work.
#pragma once
#include <string>

#include "core/log_ring.h"

namespace x4::net {

void logBegin();   // first thing in setup()
// GET /api/v1/logs body. previous = the RTC tail kept from the boot before this one.
std::string logsJson(const logs::Query& q, bool previous);
// Failed heap allocations since the last call (heap_caps failed-alloc callback, counted allocation-free) → one
// `[W][HEAP] alloc failed …` line. Net task, from healthLoop().
void logAllocFailures();

}  // namespace x4::net
