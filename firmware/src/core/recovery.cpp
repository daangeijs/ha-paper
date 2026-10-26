#include "core/recovery.h"

#include <cstring>
#include <initializer_list>

namespace x4 {

namespace {
constexpr uint8_t kCombo = kKeyPower | kKeyRight;
constexpr uint8_t kRestartCombo = kKeyPower | kKeyLeft;
}

RecoveryState recoveryOffer(uint32_t nowMs) {
  RecoveryState s;
  s.phase = RecoveryPhase::Confirm; s.since = nowMs; s.armed = false; s.crash = true;
  return s;
}

RecoveryAction recoveryStep(RecoveryState& s, uint32_t nowMs, uint8_t keys) {
  const bool wasPowerArmed = s.powerArmed;
  const bool powerArmed = s.powerArmed || !(keys & kKeyPower);
  s.powerArmed = powerArmed;
  auto idle = [&](RecoveryAction a) { s = RecoveryState{}; s.armed = keys == 0; s.powerArmed = powerArmed; return a; };
  auto reset = [&]() { s = RecoveryState{}; s.powerArmed = powerArmed; return RecoveryAction::None; };
  auto at = [&](RecoveryPhase p) { s.phase = p; s.since = nowMs; s.armed = true; s.crash = false; return RecoveryAction::None; };
  const uint32_t elapsed = nowMs - s.since;   // millis() wraps: unsigned
  switch (s.phase) {
    case RecoveryPhase::Idle:
      if (!s.armed) { s.armed = keys == 0; return RecoveryAction::None; }
      if (keys == kCombo) return at(RecoveryPhase::Hold);
      if (keys == kRestartCombo) return at(RecoveryPhase::RestartHold);
      if (keys == kKeyPower && wasPowerArmed) return at(RecoveryPhase::PowerHold);
      return RecoveryAction::None;
    case RecoveryPhase::PowerHold:
      if (keys == 0) return idle(RecoveryAction::Press);   // released before 2 s: a short press
      if (keys == kCombo) return at(RecoveryPhase::Hold);
      if (keys == kRestartCombo) return at(RecoveryPhase::RestartHold);
      if (keys != kKeyPower) return reset();
      if (elapsed >= kPowerOffHoldMs) return idle(RecoveryAction::Off);   // still held: unarmed, the key-up does nothing
      return RecoveryAction::None;
    case RecoveryPhase::RestartHold:
      if (keys != kRestartCombo) return reset();
      if (elapsed >= kRestartHoldMs) return idle(RecoveryAction::Restart);   // keys still held: unarmed
      return RecoveryAction::None;
    case RecoveryPhase::Hold:
      if (keys != kCombo) return reset();
      if (elapsed >= kResetHoldMs) {
        s.phase = RecoveryPhase::Confirm; s.since = nowMs; s.armed = false; s.crash = false;
        return RecoveryAction::Show;
      }
      return RecoveryAction::None;
    case RecoveryPhase::Confirm:
      if (elapsed >= kResetConfirmMs) return idle(RecoveryAction::Timeout);
      if (!s.armed) { s.armed = keys == 0; return RecoveryAction::None; }
      if (keys == kKeyRight) return idle(RecoveryAction::Reset);
      if (keys != 0) return idle(RecoveryAction::Cancel);
      return RecoveryAction::None;
  }
  return RecoveryAction::None;
}

int crashStreak(const char* const* reasons, int n) {
  int k = 0;
  for (; k < n; k++) {
    bool loop = false;
    for (const char* c : {"PANIC", "INT_WDT", "TASK_WDT", "WDT", "CPU_LOCKUP"})
      if (strcmp(reasons[k], c) == 0) loop = true;
    if (!loop) break;
  }
  return k;
}

const char* recoveryPhaseName(RecoveryPhase p) {
  switch (p) {
    case RecoveryPhase::Hold: return "hold";
    case RecoveryPhase::RestartHold: return "rhold";
    case RecoveryPhase::PowerHold: return "phold";
    case RecoveryPhase::Confirm: return "confirm";
    default: return "idle";
  }
}

const char* recoveryActionName(RecoveryAction a) {
  switch (a) {
    case RecoveryAction::Show: return "show";
    case RecoveryAction::Reset: return "reset";
    case RecoveryAction::Cancel: return "cancel";
    case RecoveryAction::Timeout: return "timeout";
    case RecoveryAction::Restart: return "restart";
    case RecoveryAction::Press: return "press";
    case RecoveryAction::Off: return "off";
    default: return "none";
  }
}

}  // namespace x4
