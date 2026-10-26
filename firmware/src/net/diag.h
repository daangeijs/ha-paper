// Boot / crash diagnostics on the device (ROBUSTNESS_PLAN Phase 1, GET/DELETE /api/v1/diagnostics).
//  * The ring of the last 8 boots (core/diag.h) lives in RTC_NOINIT memory, which survives esp_restart(), panics and
//    watchdog resets, and is copied to /diag.json on the userdata partition, which survives power loss and re-flash.
//  * The panic message is caught in a --wrap of panic_abort (platformio.ini) into RTC memory; the next boot attaches
//    it to its ring entry.
//  * The ELF core dump in the coredump partition (0xFF0000) is summarised on request and can be downloaded raw.
#pragma once
#include <cstddef>
#include <string>

namespace x4::net {

void diagEarlyBoot();          // first thing in setup(): reset reason, RTC ring, captured panic message
void diagBegin();              // after storage().begin(): merge /diag.json after a power loss, save
void diagLoop();               // from loop(): refresh the running boot every 10 s, save it every 30 min
void diagSave();               // write /diag.json now (after factory reset formatted userdata)
std::string diagReportJson();  // GET /api/v1/diagnostics
void diagClear();              // DELETE /api/v1/diagnostics: ring + core dump image
const char* diagResetReason();   // esp_reset_reason() name of this boot: POWERON, SW, PANIC, TASK_WDT, …
int diagCrashStreak();         // crash resets in a row up to this boot (core/recovery.h crashStreak)
bool coredumpRange(size_t& offset, size_t& size);                          // within the coredump partition
bool coredumpRead(size_t offset, void* buf, size_t len);                   // partition-relative

}  // namespace x4::net
