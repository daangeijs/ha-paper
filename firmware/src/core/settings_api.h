// PUT /api/v1/settings key + tz rules (#43); = emulator src/core/settings.ts, spec/test-vectors/settings-put.json.
#pragma once
#include <string>

#include "core/json.h"

namespace x4::settings_api {

extern const char* const kTzError;

// POSIX TZ as newlib tzset() reads it: std offset [dst [offset] ,rule,rule], ≤ 64 chars. IANA names fail
// (PUT also takes "" and a known zone name: core/locale.h validTzSetting, #147).
bool validPosixTz(const std::string& tz);
// "" or the 422 message: unknown top-level / display key, display not an object, bad tz. Checked before any value rule.
// Input only: stored files keep keys this build does not know (#12 rollback rule, core/migrate.h).
std::string putError(const Json& body);

}  // namespace x4::settings_api
