// Boot / crash diagnostics: the ring of the last 8 boots and the JSON of GET /api/v1/diagnostics. Pure; the device
// glue (RTC_NOINIT copy, userdata /diag.json, esp_reset_reason, panic hook, core dump) is net/diag.cpp.
// Behaviour spec: emulator/src/core/diag.ts, vectors spec/test-vectors/diag.json.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace x4::diag {

constexpr int kBoots = 8;
constexpr size_t kReasonLen = 12, kVersionLen = 24, kPanicLen = 96;   // C strings, NUL included

// Trivially copyable: lives in RTC_NOINIT memory as is.
struct Boot {
  char reason[kReasonLen];     // esp_reset_reason() name: POWERON, SW, PANIC, TASK_WDT, …
  char version[kVersionLen];   // firmware that ran this boot
  char panic[kPanicLen];       // panic message that caused this boot ("" = none)
  uint32_t uptimeS;            // last update while this boot ran
  uint32_t minFreeHeap;        // lowest free internal heap seen
  int64_t lastSeen;            // Unix time of the last update, 0 = clock unknown
};
struct Ring {
  uint8_t count;               // valid entries
  uint8_t head;                // index of the newest
  Boot boots[kBoots];
};

void clear(Ring& r);                                                          // DELETE /diagnostics
void push(Ring& r, const char* reason, const char* version, const char* panic);   // a new boot (panic may be null)
void touch(Ring& r, uint32_t uptimeS, uint32_t minFreeHeap, int64_t epoch);   // running boot alive; epoch 0 keeps lastSeen
const Boot* at(const Ring& r, int i);                                         // 0 = newest; nullptr past count
bool isCrash(const char* reason);                                             // PANIC, *_WDT, BROWNOUT, CPU_LOCKUP
bool valid(const Ring& r);                                                    // count/head in range, strings terminated

// Persisted form (userdata /diag.json): {"boots":[…]} newest first, same fields as the API.
std::string toJson(const Ring& r);
bool fromJson(const std::string& text, Ring& out);
// Append `older` (e.g. the file copy after a power loss wiped RTC memory) behind the entries already in r.
void appendOlder(Ring& r, const Ring& older);

std::string bootsJson(const Ring& r);       // the API "boots" array
std::string lastCrashJson(const Ring& r);   // the API "last_crash" object or null

// Everything else GET /diagnostics reports (filled by net/diag.cpp from IDF / the panel driver).
// heap.low_point (#198): what was going on when the internal minimum last dropped (net/health.h heapCheckpoint)
struct LowPoint {
  bool set = false;   // false → null
  uint32_t minFreeInternal = 0, minDma = 0, min8bitInt = 0, uptimeS = 0;
  std::string where, lastPath;
  bool ws = false, haReport = false, ota = false, rssiKnown = false;
  int tlsSlots = 0, webOpen = 0, rssi = 0;
};
struct Heap {
  uint32_t freeInternal = 0, minFreeInternal = 0, largestFreeInternal = 0, freePsram = 0;
  LowPoint lowPoint;
};
struct Panel {
  std::string controller = "none";   // driver in use
  std::string source = "none";       // probe | default | none
  bool probed = false;               // verdict/ver/flg valid
  uint8_t verdict = 0;               // freeink DisplayControllerVerdict: 0 primary, 1 ultrachip, 2 inconclusive
  bool promoted = false;
  uint8_t ver[5] = {0};
  uint8_t verBytes = 0;
  uint8_t flg = 0;
  int nvsScreenType = -1;            // OEM hw_calib/screenType, -1 = not set
  std::string failure;               // "" = fine; else why the panel was given up (core/panel_guard, #181)
};
struct Coredump {
  bool present = false;
  std::string task, panic;
  uint32_t pc = 0, excCause = 0, excVaddr = 0;
  uint32_t bt[16] = {0};
  uint32_t btDepth = 0;
  bool btCorrupted = false;
  std::string elfSha256;
  uint32_t size = 0;
};
struct Report {
  std::string firmware;
  uint64_t uptimeS = 0;
  std::string resetReason;
  Heap heap;
  Panel panel;
  Coredump core;
  int64_t touchRecoveries = -1;   // -1 = no touch hardware → null
  int sleepBootsLeft = 0;         // first-boot safety (#10): confirmed boots still needed before deep sleep
  const char* sleepArmedBy = nullptr;   // #231: "uptime" | "boots" | nullptr (not armed)
  std::string batteryJson;        // #231 core/battery_history.h History::json(); empty = null
  std::string trailBeforeBoot;    // #225 power trail: last line when this boot started; empty = null
  std::vector<std::string> trail; // #225 newest lines of /power.txt, oldest first
};
std::string reportJson(const Ring& r, const Report& rep);

}  // namespace x4::diag
