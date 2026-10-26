// Settings › Updates status line (#250) = emulator src/core/otaStatus.ts, spec/test-vectors/ota-status.json:
// "Checking…" while a check runs, then the result with its time, or a failed check in plain words.
#pragma once
#include <string>
#include "core/strings.h"

namespace x4 {

// Why a check failed (GET /api/v1/ota `error`).
enum class OtaErr : uint8_t { None, Memory, Network, Busy, NoReleases, Other };

constexpr int kOtaHttpLowMemory = -100;   // = net/tls.h kHttpLowMemory (TLS heap guard refused, #248)

// A failed GitHub request as the user sees it. code: HTTP status, <= 0 = no answer (connect/TLS/timeout).
OtaErr otaErrOf(int code, bool online);
const char* otaErrName(OtaErr e);         // "memory" … "other"; nullptr for None
OtaErr otaErrFromName(const std::string& s);

struct OtaLineIn {
  std::string status;    // GET /ota status: idle | checking | uptodate | available | blocked | error
  OtaErr error = OtaErr::None;
  std::string version;   // available version, without "v"
  std::string checked;   // local "HH:MM" of the last check, "" = never / clock unknown
  std::string channel;   // "stable" | "beta"
  std::string message;
};
struct OtaLine { std::string title, sub; };

OtaLine otaLine(Lang l, const OtaLineIn& in);

}  // namespace x4
