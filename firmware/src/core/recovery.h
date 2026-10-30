// Hardware-key factory reset and crash-loop recovery (issue eink-ha-os#21), a 1:1 port of emulator/src/core/recovery.ts.
// Pure; checked against spec/test-vectors/recovery.json.
//
// Hold Power + Right (nothing else) 5 s → confirmation screen. Release every key, then Right alone resets; any other
// key, Home or a touch cancels; 10 s without an answer cancels. Left is never in the combo: held at reset it is the
// GPIO0 download-mode strap. After the screen goes away all keys must be released before a new hold counts.
// Hold Power + Left (nothing else) 5 s → Restart (eink-ha-os#226); a software restart does not sample the GPIO0 strap.
// Power alone (eink-ha-os#258): released before 2 s → Press (standby / wake); held 2 s → Off, while still held. Power + Right /
// Left within the 2 s turns into those holds. Counts only after Power was released once since boot (the power-on hold).
#pragma once
#include <cstdint>

namespace x4 {

constexpr uint32_t kResetHoldMs = 5000;
constexpr uint32_t kResetConfirmMs = 10000;
constexpr uint32_t kRestartHoldMs = 5000;
constexpr uint32_t kPowerOffHoldMs = 2000;
constexpr int kCrashLoopBoots = 3;   // crash resets in a row, newest first → offer the reset screen at boot

// Sample bits: keys held now, or pressed since the last sample.
constexpr uint8_t kKeyPower = 1, kKeyRight = 2, kKeyLeft = 4, kKeyOther = 8;   // Other = Home key or a touch

enum class RecoveryPhase : uint8_t { Idle, Hold, RestartHold, PowerHold, Confirm };
enum class RecoveryAction : uint8_t { None, Show, Reset, Cancel, Timeout, Restart, Press, Off };

struct RecoveryState {
  RecoveryPhase phase = RecoveryPhase::Idle;
  uint32_t since = 0;    // ms: hold start / screen shown
  bool armed = true;     // Idle: all keys released since the last screen; Confirm: released since it was shown
  bool crash = false;    // Confirm: offered at boot after a crash loop (wording only)
  bool powerArmed = false;   // Power released since boot: a Power-alone hold counts
};

RecoveryState recoveryOffer(uint32_t nowMs);   // boot after a crash loop: the confirmation screen straight away
RecoveryAction recoveryStep(RecoveryState& s, uint32_t nowMs, uint8_t keys);

// Crash resets in a row at the top of the boot ring, reasons newest first. BROWNOUT breaks the streak (a reset
// cannot fix a flat battery).
int crashStreak(const char* const* reasonsNewestFirst, int n);
inline bool isCrashLoop(const char* const* reasons, int n) { return crashStreak(reasons, n) >= kCrashLoopBoots; }

const char* recoveryPhaseName(RecoveryPhase p);     // idle | hold | rhold | phold | confirm
const char* recoveryActionName(RecoveryAction a);   // none | show | reset | cancel | timeout | restart | press | off

}  // namespace x4
