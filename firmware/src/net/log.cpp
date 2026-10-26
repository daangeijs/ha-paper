#include "net/log.h"

#include <Arduino.h>
#include <esp_attr.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <mutex>

#include "Logging.h"

namespace x4::net {

namespace {

constexpr size_t kFmt = 256;                  // one formatted line (longer lines are cut)
constexpr size_t kRed = kFmt + 64;            // redacted: "***" may be longer than the value it hides
constexpr int64_t kSaneEpoch = 1700000000;

// RTC slow memory, not heap. The magic includes the layout size: another image's layout is not read as ours.
struct RtcTail {
  uint32_t magic;
  logs::Hdr h;
  uint8_t data[logs::kTailCap];
};
constexpr uint32_t kTailMagic = 0x58344C47u ^ static_cast<uint32_t>(sizeof(RtcTail));   // "X4LG" ^ size
RTC_NOINIT_ATTR RtcTail g_tail;

std::mutex g_mu;
logs::Hdr g_hdr, g_prevHdr;
uint8_t* g_block = nullptr;   // PSRAM: ring | previous tail | format scratch | redact scratch
uint8_t *g_ring = nullptr, *g_prev = nullptr;
char *g_fmt = nullptr, *g_red = nullptr;

std::atomic<uint32_t> g_failCount{0}, g_failSize{0}, g_failCaps{0}, g_failMax{0};
uint32_t g_failLogged = 0;
bool g_tailReady = false;   // logBegin() took the previous boot's tail out of RTC memory

void IRAM_ATTR onAllocFailed(size_t size, uint32_t caps, const char*) {
  // inside the allocator's failure path: no allocation, no lock, no log
  g_failCount.fetch_add(1, std::memory_order_relaxed);
  g_failSize.store(uint32_t(size), std::memory_order_relaxed);
  g_failCaps.store(caps, std::memory_order_relaxed);
  if (size > g_failMax.load(std::memory_order_relaxed)) g_failMax.store(uint32_t(size), std::memory_order_relaxed);
}

void emit(char level, const char* tag, const char* msg, size_t n) {
  char pre[24];
  const int k = snprintf(pre, sizeof pre, "[%c][%s] ", level, tag);
  Serial.write(reinterpret_cast<const uint8_t*>(pre), size_t(k) < sizeof pre ? size_t(k) : sizeof pre - 1);
  Serial.write(reinterpret_cast<const uint8_t*>(msg), n);
  Serial.write('\n');
}

}  // namespace

void logBegin() {
  g_block = static_cast<uint8_t*>(heap_caps_malloc(logs::kCap + logs::kTailCap + kFmt + kRed, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  logs::Ring tail(&g_tail.h, g_tail.data);
  const bool kept = g_tail.magic == kTailMagic && tail.valid(logs::kTailCap);
  {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_block) {
      g_ring = g_block;
      g_prev = g_ring + logs::kCap;
      g_fmt = reinterpret_cast<char*>(g_prev + logs::kTailCap);
      g_red = g_fmt + kFmt;
      if (kept) {
        g_prevHdr = g_tail.h;
        std::memcpy(g_prev, g_tail.data, logs::kTailCap);
      } else {
        logs::Ring(&g_prevHdr, g_prev).init(logs::kTailCap);
      }
      logs::Ring(&g_hdr, g_ring).init(logs::kCap);
    }
    tail.init(logs::kTailCap);
    g_tail.magic = kTailMagic;
    g_tailReady = true;
  }
  heap_caps_register_failed_alloc_callback(onAllocFailed);
  if (!g_block) LOG_ERR("LOG", "no PSRAM for the log ring · GET /logs stays empty");
  else LOG_INF("LOG", "ring %u KB in PSRAM · previous boot: %u lines kept", unsigned(logs::kCap / 1024), kept ? unsigned(g_prevHdr.count) : 0u);
}

std::string logsJson(const logs::Query& q, bool previous) {
  std::string out;
  std::lock_guard<std::mutex> l(g_mu);
  logs::Hdr empty{logs::kTailCap, 0, 0, 1, 0};
  uint8_t none = 0;
  if (!g_block) logs::Ring(&empty, &none).queryJson(q, previous ? "previous" : "current", out);
  else if (previous) logs::Ring(&g_prevHdr, g_prev).queryJson(q, "previous", out);
  else logs::Ring(&g_hdr, g_ring).queryJson(q, "current", out);
  return out;
}

void logAllocFailures() {
  const uint32_t n = g_failCount.load(std::memory_order_relaxed);
  if (n == g_failLogged) return;
  const uint32_t caps = g_failCaps.load(std::memory_order_relaxed);
  LOG_WRN("HEAP", "alloc failed x%u · last %u B caps 0x%x%s%s%s · biggest %u B · internal largest %u B", unsigned(n - g_failLogged),
          unsigned(g_failSize.load(std::memory_order_relaxed)), unsigned(caps), caps & MALLOC_CAP_INTERNAL ? " internal" : "",
          caps & MALLOC_CAP_SPIRAM ? " psram" : "", caps & MALLOC_CAP_DMA ? " dma" : "", unsigned(g_failMax.exchange(0)),
          unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
  g_failLogged = n;
}

}  // namespace x4::net

using namespace x4;

void x4Log(char level, const char* tag, const char* fmt, ...) {
  if (xPortInIsrContext()) return;
  va_list ap;
  va_start(ap, fmt);
  if (!net::g_block) {   // before logBegin() or without PSRAM: stack buffers, Serial + RTC tail
    char raw[160], red[192];
    int n = vsnprintf(raw, sizeof raw, fmt, ap);
    va_end(ap);
    n = n < 0 ? 0 : n >= int(sizeof raw) ? int(sizeof raw) - 1 : n;
    const size_t m = logs::redact(raw, size_t(n), red, sizeof red);
    std::lock_guard<std::mutex> l(net::g_mu);
    net::emit(level, tag, red, m);
    if (net::g_tailReady)
      logs::Ring(&net::g_tail.h, net::g_tail.data).push(millis(), 0, level, tag, std::string_view(red, m));
    return;
  }
  std::lock_guard<std::mutex> l(net::g_mu);
  int n = vsnprintf(net::g_fmt, net::kFmt, fmt, ap);
  va_end(ap);
  n = n < 0 ? 0 : n >= int(net::kFmt) ? int(net::kFmt) - 1 : n;
  const size_t m = logs::redact(net::g_fmt, size_t(n), net::g_red, net::kRed);
  net::emit(level, tag, net::g_red, m);
  const time_t t = time(nullptr);
  const uint32_t ms = millis(), epoch = t > net::kSaneEpoch ? uint32_t(t) : 0;
  const std::string_view msg(net::g_red, m);
  logs::Ring(&net::g_hdr, net::g_ring).push(ms, epoch, level, tag, msg);
  logs::Ring(&net::g_tail.h, net::g_tail.data).push(ms, epoch, level, tag, msg);
}
