// RTC record of the Good morning page (#330).
#include "net/morning_rtc.h"

#include <esp_attr.h>
#include "core/glance.h"

namespace x4::net {
namespace {
constexpr uint32_t kMagic = 0x58344d47;   // "X4MG"
struct Rec { uint32_t magic, sum; morning::State s; };
RTC_NOINIT_ATTR Rec g_rec;
uint32_t sumOf(const Rec& r) { return glance::fnv1a(&r.s, sizeof r.s); }
}  // namespace

morning::State morningRtcLoad() {
  if (g_rec.magic != kMagic || g_rec.sum != sumOf(g_rec)) return morning::State();
  return g_rec.s;
}

void morningRtcSave(const morning::State& s) {
  g_rec.s = s;
  g_rec.magic = kMagic;
  g_rec.sum = sumOf(g_rec);
}

}  // namespace x4::net
