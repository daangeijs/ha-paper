#include "net/diag.h"

#include <Arduino.h>
#include <esp_attr.h>
#include <esp_core_dump.h>
#include <esp_heap_caps.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <esp_timer.h>

#include <cstring>
#include <ctime>
#include <mutex>

#include "Logging.h"
#include "core/diag.h"
#include "core/recovery.h"
#include "hw/hw_diag.h"
#include "net/health.h"
#include "net/power.h"
#include "net/storage.h"
#include "net/util.h"
#if X4_QEMU_DEBUG
#include "hw/qemu_debug.h"
#endif

// Panic message capture (crosspoint-reader lib/hal/HalSystem.cpp). Linked with -Wl,--wrap=panic_abort: abort(),
// assert() and esp_system_abort() end here; CPU exceptions don't (the core dump summary covers those).
namespace {
constexpr uint32_t kPanicMagic = 0x50414E49;   // "PANI"
RTC_NOINIT_ATTR char g_panicMsg[x4::diag::kPanicLen];
RTC_NOINIT_ATTR volatile uint32_t g_panicMarker;
}  // namespace

extern "C" {
[[noreturn]] void __real_panic_abort(const char* details);
[[noreturn]] void IRAM_ATTR __wrap_panic_abort(const char* details) {
  // panic context: no libc (strncpy is not IRAM-safe), bounded copy only
  size_t i = 0;
  if (details)
    for (; i < sizeof(g_panicMsg) - 1 && details[i]; i++) g_panicMsg[i] = details[i];
  g_panicMsg[i] = '\0';
  g_panicMarker = kPanicMagic;
#if X4_QEMU_DEBUG
  x4QemuDebugPanicDump();
#endif
  __real_panic_abort(details);
}
}

namespace x4::net {

namespace {

constexpr const char* kFile = "/diag.json";
constexpr uint32_t kTouchEveryMs = 10000;
constexpr uint32_t kSaveEveryMs = 30 * 60 * 1000;
constexpr int64_t kSaneEpoch = 1700000000;

// The ring in RTC memory, guarded by a magic that includes the layout size and a checksum: a cold boot leaves
// random bytes, and an OTA image with another layout must not read the old one as its own.
struct RtcDiag {
  uint32_t magic;
  uint32_t sum;
  diag::Ring ring;
};
constexpr uint32_t kRtcMagic = 0x58344447u ^ static_cast<uint32_t>(sizeof(RtcDiag));   // "X4DG" ^ size
RTC_NOINIT_ATTR RtcDiag g_rtc;

std::mutex g_mu;
const char* g_reason = "UNKNOWN";
bool g_rtcWasValid = false;
uint32_t g_lastTouch = 0, g_lastSave = 0;

uint32_t checksum(const diag::Ring& r) {
  // FNV-1a over the ring bytes
  uint32_t h = 2166136261u;
  const auto* p = reinterpret_cast<const uint8_t*>(&r);
  for (size_t i = 0; i < sizeof r; i++) h = (h ^ p[i]) * 16777619u;
  return h;
}
void seal() {
  g_rtc.sum = checksum(g_rtc.ring);
  g_rtc.magic = kRtcMagic;
}

const char* reasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXT";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    case ESP_RST_USB: return "USB";
    case ESP_RST_JTAG: return "JTAG";
    case ESP_RST_EFUSE: return "EFUSE";
    case ESP_RST_PWR_GLITCH: return "PWR_GLITCH";
    case ESP_RST_CPU_LOCKUP: return "CPU_LOCKUP";
    default: return "UNKNOWN";
  }
}

uint32_t minFreeInternal() { return heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL); }
uint32_t uptimeS() { return static_cast<uint32_t>(esp_timer_get_time() / 1000000); }
int64_t epochNow() {
  const int64_t t = time(nullptr);
  return t > kSaneEpoch ? t : 0;
}

void touchLocked() {
  diag::touch(g_rtc.ring, uptimeS(), minFreeInternal(), epochNow());
  seal();
}

void saveLocked() {
  if (!storage().writeFile(kFile, diag::toJson(g_rtc.ring))) LOG_WRN("DIAG", "could not write %s", kFile);
}

bool coredumpPresent() { return esp_core_dump_image_check() == ESP_OK; }

void coredumpSummary(diag::Coredump& c) {
  if (!coredumpPresent()) return;
  auto* s = static_cast<esp_core_dump_summary_t*>(calloc(1, sizeof(esp_core_dump_summary_t)));
  if (!s) return;
  if (esp_core_dump_get_summary(s) == ESP_OK) {
    c.present = true;
    c.task = std::string(s->exc_task, strnlen(s->exc_task, sizeof s->exc_task));
    c.pc = s->exc_pc;
    c.btDepth = s->exc_bt_info.depth < 16 ? s->exc_bt_info.depth : 16;
    memcpy(c.bt, s->exc_bt_info.bt, sizeof c.bt);
    c.btCorrupted = s->exc_bt_info.corrupted;
    c.excCause = s->ex_info.exc_cause;
    c.excVaddr = s->ex_info.exc_vaddr;
    c.elfSha256 = std::string(reinterpret_cast<const char*>(s->app_elf_sha256), strnlen(reinterpret_cast<const char*>(s->app_elf_sha256), sizeof s->app_elf_sha256));
    char reason[diag::kPanicLen] = {0};
    if (esp_core_dump_get_panic_reason(reason, sizeof reason) == ESP_OK) c.panic = reason;
    size_t addr = 0, size = 0;
    if (esp_core_dump_image_get(&addr, &size) == ESP_OK) c.size = size;
  }
  free(s);
}

}  // namespace

void diagEarlyBoot() {
  std::lock_guard<std::mutex> l(g_mu);
  // QEMU has no deep sleep: net/power.cpp simulates it with esp_restart() and leaves the wake cause in RTC memory
  const esp_reset_reason_t why = powerSimulatedWake() ? ESP_RST_DEEPSLEEP : esp_reset_reason();
  g_reason = reasonName(why);
  // A panic message only belongs to a crash reset; a stale marker after a power-on is noise.
  const bool panicked = g_panicMarker == kPanicMagic && diag::isCrash(g_reason) && why != ESP_RST_POWERON;
  if (panicked) g_panicMsg[sizeof(g_panicMsg) - 1] = '\0';
  g_panicMarker = 0;
  g_rtcWasValid = why != ESP_RST_POWERON && g_rtc.magic == kRtcMagic && diag::valid(g_rtc.ring) && g_rtc.sum == checksum(g_rtc.ring);
  if (!g_rtcWasValid) diag::clear(g_rtc.ring);
  diag::push(g_rtc.ring, g_reason, firmwareVersion(), panicked ? g_panicMsg : nullptr);
  seal();
}

const char* diagResetReason() {
  std::lock_guard<std::mutex> l(g_mu);
  return g_reason;
}

void diagBegin() {
  std::lock_guard<std::mutex> l(g_mu);
  if (!g_rtcWasValid) {
    // RTC memory was lost (power off): the older boots come from the file.
    std::string text;
    diag::Ring older;
    if (storage().readFile(kFile, text) && diag::fromJson(text, older)) diag::appendOlder(g_rtc.ring, older);
  }
  diag::Boot& cur = g_rtc.ring.boots[g_rtc.ring.head];
  // CPU exceptions don't pass panic_abort: take the reason from the core dump written by this crash.
  if (diag::isCrash(cur.reason) && !cur.panic[0] && coredumpPresent()) {
    char reason[diag::kPanicLen] = {0};
    if (esp_core_dump_get_panic_reason(reason, sizeof reason) == ESP_OK) strncpy(cur.panic, reason, sizeof cur.panic - 1);
  }
  touchLocked();
  saveLocked();
  g_lastTouch = g_lastSave = millis();
  const diag::Boot* prev = diag::at(g_rtc.ring, 1);
  if (diag::isCrash(cur.reason))
    LOG_WRN("DIAG", "reset reason %s%s%s · previous boot v%s ran %u s", cur.reason, cur.panic[0] ? " · " : "", cur.panic,
            prev ? prev->version : "?", prev ? static_cast<unsigned>(prev->uptimeS) : 0u);
  else
    LOG_INF("DIAG", "reset reason %s · %u boots kept (%s)", cur.reason, static_cast<unsigned>(g_rtc.ring.count),
            g_rtcWasValid ? "RTC" : "file");
}

void diagLoop() {
  const uint32_t now = millis();
  if (now - g_lastTouch < kTouchEveryMs) return;
  std::lock_guard<std::mutex> l(g_mu);
  g_lastTouch = now;
  touchLocked();
  if (now - g_lastSave >= kSaveEveryMs) {
    g_lastSave = now;
    saveLocked();
  }
}

void diagSave() {
  std::lock_guard<std::mutex> l(g_mu);
  touchLocked();
  saveLocked();
  g_lastSave = millis();
}

std::string diagReportJson() {
  diag::Report rep;
  rep.firmware = firmwareVersion();
  rep.uptimeS = static_cast<uint64_t>(esp_timer_get_time() / 1000000);
  rep.resetReason = g_reason;
  rep.heap.freeInternal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  rep.heap.minFreeInternal = minFreeInternal();
  rep.heap.largestFreeInternal = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  rep.heap.freePsram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  heapLowPoint(rep.heap.lowPoint);
  panelDiag(rep.panel);
  coredumpSummary(rep.core);
  rep.touchRecoveries = touchRecoveries();
  rep.sleepBootsLeft = powerArmBootsLeft();
  rep.sleepArmedBy = powerArmedBy();
  rep.batteryJson = powerBatteryJson();
  powerTrail(rep.trailBeforeBoot, rep.trail);
  std::lock_guard<std::mutex> l(g_mu);
  touchLocked();
  return diag::reportJson(g_rtc.ring, rep);
}

void diagClear() {
  {
    std::lock_guard<std::mutex> l(g_mu);
    diag::clear(g_rtc.ring);
    seal();
    saveLocked();
  }
  if (coredumpPresent()) {
    const esp_err_t e = esp_core_dump_image_erase();
    if (e != ESP_OK) LOG_WRN("DIAG", "core dump erase failed (%d)", static_cast<int>(e));
  }
  LOG_INF("DIAG", "diagnostics cleared");
}

int diagCrashStreak() {
  std::lock_guard<std::mutex> l(g_mu);
  const char* reasons[diag::kBoots];
  int n = 0;
  for (const diag::Boot* b; n < diag::kBoots && (b = diag::at(g_rtc.ring, n)); n++) reasons[n] = b->reason;
  return crashStreak(reasons, n);
}

bool coredumpRange(size_t& offset, size_t& size) {
  const esp_partition_t* p = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, nullptr);
  size_t addr = 0;
  if (!p || !coredumpPresent() || esp_core_dump_image_get(&addr, &size) != ESP_OK) return false;
  if (addr < p->address || addr + size > p->address + p->size) return false;
  offset = addr - p->address;
  return true;
}

bool coredumpRead(size_t offset, void* buf, size_t len) {
  const esp_partition_t* p = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, nullptr);
  return p && esp_partition_read(p, offset, buf, len) == ESP_OK;
}

}  // namespace x4::net
