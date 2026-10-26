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
  auto idle = [&](RecoveryAction a) { s = RecoveryState{}; s.armed = keys == 0; return a; };
  const uint32_t elapsed = nowMs - s.since;   // millis() wraps: unsigned
  switch (s.phase) {
    case RecoveryPhase::Idle:
      if (!s.armed) { s.armed = keys == 0; return RecoveryAction::None; }
      if (keys == kCombo) { s.phase = RecoveryPhase::Hold; s.since = nowMs; }
      else if (keys == kRestartCombo) { s.phase = RecoveryPhase::RestartHold; s.since = nowMs; }
      return RecoveryAction::None;
    case RecoveryPhase::RestartHold:
      if (keys != kRestartCombo) { s = RecoveryState{}; return RecoveryAction::None; }
      if (elapsed >= kRestartHoldMs) return idle(RecoveryAction::Restart);   // keys still held: unarmed
      return RecoveryAction::None;
    case RecoveryPhase::Hold:
      if (keys != kCombo) { s = RecoveryState{}; return RecoveryAction::None; }
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
    default: return "none";
  }
}

}  // namespace x4
