// Power profile switching on the device (#249): when a plug / unplug changes the CPU clock and Wi-Fi modem sleep the
// power rules (core/power.h) apply. Pure; glue in net/power.cpp. The emulator applies each decision at once and has no
// recent-charge memory (chargedAgoMin is always null there): firmware/deviations/249-power-profile-switch.md.
#pragma once
#include <cstdint>

#include "core/power.h"

namespace x4 {

constexpr uint32_t kProfileSettleMs = 2000;   // a new profile must hold this long before it is applied (USB flapping)

// PowerInputs.chargedAgoMin: minutes since the charger STAT pin was last seen on (#73). Unplugging a USB host forgets it:
// the cable that charged is gone, so a full cell (≥ 4.15 V) must not keep the external profile for 30 more minutes.
// A charger without data lines never shows a USB host and keeps the 30-minute rule.
struct ChargeMemory {
  void step(bool charging, bool usb, uint32_t nowMs);
  double agoMin(uint32_t nowMs) const;   // < 0 = not since boot (or since the last USB unplug)
  bool seen = false;
  bool usbPrev = false;
  uint32_t ms = 0;
};

struct PowerProfile {
  bool external = false;
  CpuProfile cpu = CpuProfile::Full;
  WifiPs ps = WifiPs::None;
  bool operator==(const PowerProfile& o) const { return external == o.external && cpu == o.cpu && ps == o.ps; }
  bool operator!=(const PowerProfile& o) const { return !(*this == o); }
};
PowerProfile profileOf(const PowerDecision& d);

// The profile in force: the first one at once, a change once the new one held kProfileSettleMs.
class ProfileGate {
 public:
  bool step(const PowerProfile& want, uint32_t nowMs);   // true = applied() changed (first call included)
  const PowerProfile& applied() const { return applied_; }
  bool settling() const { return pending_; }              // a different profile is waiting: no deep sleep yet
 private:
  PowerProfile applied_, next_;
  bool have_ = false, pending_ = false;
  uint32_t since_ = 0;
};

}  // namespace x4
