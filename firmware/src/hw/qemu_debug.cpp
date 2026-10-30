#if X4_QEMU_DEBUG
#include "hw/qemu_debug.h"

#include <esp_attr.h>
#include <esp_cpu.h>
#include <esp_heap_caps.h>
#include <esp_rom_sys.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <spinlock.h>

#include <cstdlib>
#include <string>

#include "Logging.h"

// Critical-section tracer (eink-ha-os#39). Linked with -Wl,--wrap=xPortEnterCriticalTimeout,--wrap=vPortExitCritical, so every
// call from another object file (FreeRTOS tasks.c/queue.c, newlib locks, drivers, our code) lands here. IRAM + DRAM
// only: these run with the flash cache disabled and inside ISRs.
extern "C" BaseType_t __real_xPortEnterCriticalTimeout(portMUX_TYPE* mux, BaseType_t timeout);
extern "C" void __real_vPortExitCritical(portMUX_TYPE* mux);

namespace {
constexpr int kRing = 64;
struct Op {
  const portMUX_TYPE* lock;
  uint32_t ra, owner, count, ccount;
  char op;   // E / A / X, see the wrappers
};
DRAM_ATTR Op g_ops[2][kRing];
DRAM_ATTR uint32_t g_next[2];   // per core; an ISR nesting in record() just takes the next slot
DRAM_ATTR volatile bool g_tripped;

inline uint32_t IRAM_ATTR caller(void* ra) { return (reinterpret_cast<uint32_t>(ra) & 0x3FFFFFFF) | 0x40000000; }

inline bool IRAM_ATTR badPair(uint32_t o, uint32_t c, uint32_t me) {
  if (o == SPINLOCK_FREE) return c != 0;                  // a free lock always has count 0 (spinlock.h:142)
  if (o == me) return c == 0 || c >= 0xFF;                // ours: nested count 1..254 (spinlock.h:106)
  return o != (CORE_ID_REGVAL_XOR_SWAP ^ me);             // the other core, or garbage
}

// owner and count are two loads: the other core can change the lock between them (a torn read looks like
// FREE + count 1). Only a pair that stays the same over three re-reads 2 µs apart counts as corrupt.
bool IRAM_ATTR corrupt(const portMUX_TYPE* m, uint32_t me) {
  const uint32_t o = m->owner, c = m->count;
  if (!badPair(o, c, me)) return false;
  for (int i = 0; i < 3; ++i) {
    esp_rom_delay_us(2);
    if (m->owner != o || m->count != c) return false;
  }
  return true;
}

void IRAM_ATTR record(int core, const portMUX_TYPE* m, uint32_t ra, char op) {
  Op& e = g_ops[core][g_next[core]++ % kRing];
  e = Op{m, ra, m->owner, m->count, esp_cpu_get_cycle_count(), op};
}

void IRAM_ATTR dump(const portMUX_TYPE* m) {
  const uint32_t* w = reinterpret_cast<const uint32_t*>(reinterpret_cast<uintptr_t>(m) & ~3u) - 8;
  for (int i = 0; i < 18; i += 6)
    esp_rom_printf(DRAM_STR("[x4dbg] 0x%08x: %08x %08x %08x %08x %08x %08x\n"), unsigned(uintptr_t(w + i)),
                   unsigned(w[i]), unsigned(w[i + 1]), unsigned(w[i + 2]), unsigned(w[i + 3]), unsigned(w[i + 4]),
                   unsigned(w[i + 5]));
  for (int c = 0; c < 2; ++c) {
    const uint32_t n = g_next[c];
    esp_rom_printf(DRAM_STR("[x4dbg] core %d: last %d of %u ops (* = lock 0x%08x)\n"), c, kRing, unsigned(n),
                   unsigned(uintptr_t(m)));
    for (uint32_t i = n > kRing ? n - kRing : 0; i < n; ++i) {
      const Op& e = g_ops[c][i % kRing];
      esp_rom_printf(DRAM_STR("[x4dbg] %c%d %c 0x%08x ra=0x%08x owner=%04x count=%u cc=%u\n"), e.lock == m ? '*' : ' ',
                     c, e.op, unsigned(uintptr_t(e.lock)), unsigned(e.ra), unsigned(e.owner & 0xFFFF),
                     unsigned(e.count), unsigned(e.ccount));
    }
  }
}

[[noreturn]] void IRAM_ATTR trip(const portMUX_TYPE* m, uint32_t ra, char op) {
  g_tripped = true;
  esp_rom_printf(DRAM_STR("\n[x4dbg] CORRUPT spinlock 0x%08x owner=%08x count=%08x · core %d %c from 0x%08x\n"),
                 unsigned(uintptr_t(m)), unsigned(m->owner), unsigned(m->count), esp_cpu_get_core_id(), op,
                 unsigned(ra));
  dump(m);
  esp_system_abort("x4dbg: corrupt spinlock");
}
}  // namespace

// E = enter (before), A = acquired (after, interrupts masked), X = exit (after release)
extern "C" BaseType_t IRAM_ATTR __wrap_xPortEnterCriticalTimeout(portMUX_TYPE* mux, BaseType_t timeout) {
  const uint32_t ra = caller(__builtin_return_address(0));
  const int core = esp_cpu_get_core_id();
  if (!g_tripped) {
    record(core, mux, ra, 'E');
    if (corrupt(mux, xt_utils_get_raw_core_id())) trip(mux, ra, 'E');
  }
  const BaseType_t got = __real_xPortEnterCriticalTimeout(mux, timeout);
  if (got == pdPASS && !g_tripped) record(core, mux, ra, 'A');
  return got;
}

extern "C" void IRAM_ATTR __wrap_vPortExitCritical(portMUX_TYPE* mux) {
  const uint32_t ra = caller(__builtin_return_address(0));
  __real_vPortExitCritical(mux);
  if (g_tripped) return;
  const int core = esp_cpu_get_core_id();
  record(core, mux, ra, 'X');
  if (corrupt(mux, xt_utils_get_raw_core_id())) trip(mux, ra, 'X');
}

// Panic path (net/diag.cpp __wrap_panic_abort): an assert inside the real spinlock code never reaches trip(), so
// print the rings there, starring the lock this core was last entering.
extern "C" void IRAM_ATTR x4QemuDebugPanicDump() {
  if (g_tripped) return;
  g_tripped = true;
  const int core = esp_cpu_get_core_id();
  const portMUX_TYPE* m = nullptr;
  for (uint32_t i = g_next[core], k = 0; i > 0 && k < kRing; --i, ++k)
    if (g_ops[core][(i - 1) % kRing].op == 'E') { m = g_ops[core][(i - 1) % kRing].lock; break; }
  esp_rom_printf(DRAM_STR("\n[x4dbg] panic on core %d · last lock entered 0x%08x owner=%08x count=%08x\n"), core,
                 unsigned(uintptr_t(m)), m ? unsigned(m->owner) : 0u, m ? unsigned(m->count) : 0u);
  if (m) dump(m);
}

namespace x4 {
namespace {
void monitorTask(void*) {
  for (uint32_t n = 0;; ++n) {
    vTaskDelay(pdMS_TO_TICKS(10000));
    if (!heap_caps_check_integrity_all(true)) {
      LOG_ERR("X4DBG", "heap integrity check FAILED (details above)");
      abort();
    }
    if (n % 3 != 2) continue;
    const UBaseType_t cap = uxTaskGetNumberOfTasks() + 4;
    auto* st = static_cast<TaskStatus_t*>(malloc(cap * sizeof(TaskStatus_t)));
    if (!st) continue;
    const UBaseType_t got = uxTaskGetSystemState(st, cap, nullptr);
    std::string line;
    for (UBaseType_t i = 0; i < got; ++i) {
      line += ' ';
      line += st[i].pcTaskName;
      line += '=';
      line += std::to_string(st[i].usStackHighWaterMark);
    }
    free(st);
    LOG_INF("X4DBG", "heap ok · internal free %u min %u largest %u · %u crit ops · stack HWM (bytes):%s",
            unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
            unsigned(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)),
            unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)), unsigned(g_next[0] + g_next[1]),
            line.c_str());
  }
}
}  // namespace

void qemuDebugBegin() {
  LOG_WRN("X4DBG", "X4_QEMU_DEBUG: critical-section tracer on, heap check every 10 s, stack HWM every 30 s");
  xTaskCreatePinnedToCore(monitorTask, "x4dbg", 4096, nullptr, 1, nullptr, tskNO_AFFINITY);
}

}  // namespace x4
#endif
