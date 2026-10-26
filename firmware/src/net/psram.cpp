#include "net/psram.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <atomic>
#include <new>

namespace {
// One slot per task inside a scope (#160: one global owner let the web and net tasks restore each other's state).
// A slot's task is claimed by CAS; only that task touches its depth.
struct Slot {
  std::atomic<TaskHandle_t> task{nullptr};
  uint32_t depth = 0;
};
Slot g_slots[4];

Slot* slotOf(TaskHandle_t t) {
  if (!t) return nullptr;   // before the scheduler: never matches a free slot
  for (Slot& s : g_slots)
    if (s.task.load(std::memory_order_relaxed) == t) return &s;
  return nullptr;
}
}  // namespace

namespace x4::net {
PsramScope::PsramScope() {
  TaskHandle_t me = xTaskGetCurrentTaskHandle();
  Slot* s = slotOf(me);
  for (Slot* c = g_slots; !s && me && c != g_slots + 4; ++c) {
    TaskHandle_t none = nullptr;
    if (c->task.compare_exchange_strong(none, me)) s = c;
  }
  if (s) ++s->depth;
  slot_ = s;   // null: every slot taken, this scope allocates internal RAM as before
}
PsramScope::~PsramScope() {
  Slot* s = static_cast<Slot*>(slot_);
  if (s && --s->depth == 0) s->task.store(nullptr);
}
}  // namespace x4::net

// Replaces libstdc++'s operator new (new[] and the nothrow forms call this one). Outside a scope: plain malloc, as before.
void* operator new(size_t n) {
  void* p = nullptr;
  if (slotOf(xTaskGetCurrentTaskHandle()))
    p = heap_caps_malloc(n ? n : 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!p) p = malloc(n ? n : 1);
  if (!p) throw std::bad_alloc();
  return p;
}
