#include "core/power_profile.h"

namespace x4 {

void ChargeMemory::step(bool charging, bool usb, uint32_t nowMs) {
  if (usbPrev && !usb) seen = false;
  usbPrev = usb;
  if (charging) { seen = true; ms = nowMs; }
}

double ChargeMemory::agoMin(uint32_t nowMs) const { return seen ? (nowMs - ms) / 60000.0 : -1; }

PowerProfile profileOf(const PowerDecision& d) { return {d.external, d.cpuProfile, d.wifiPs}; }

bool ProfileGate::step(const PowerProfile& want, uint32_t nowMs) {
  if (!have_) { have_ = true; applied_ = want; return true; }
  if (want == applied_) { pending_ = false; return false; }
  if (!pending_ || want != next_) { pending_ = true; next_ = want; since_ = nowMs; return false; }
  if (nowMs - since_ < kProfileSettleMs) return false;
  applied_ = want;
  pending_ = false;
  return true;
}

}  // namespace x4
