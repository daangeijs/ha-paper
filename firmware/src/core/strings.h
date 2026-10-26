// UI strings, English and Dutch (#98) = emulator src/core/strings.ts, spec/test-vectors/strings.json. The keys and
// texts live in the generated core/strings_gen.h (emulator `npm run vectors`). Language: HA's get_config `language`.
#pragma once
#include <string>
#include "core/strings_gen.h"

namespace x4 {

enum class Lang : uint8_t { En, Nl };

Lang langOf(const std::string& code);   // any nl variant → Nl, everything else → En
const char* langCode(Lang l);           // "en" | "nl"
const char* tr(Lang l, S key);
// Each "{}" takes the next argument; missing ones stay "{}".
std::string tr(Lang l, S key, const std::string& a, const std::string& b = "{}");
// "Tuesday 13 October" / "Dinsdag 13 oktober"; struct tm numbering (wday 0 = Sunday, month 0 = January).
std::string dateLine(Lang l, int wday, int mday, int month);

}  // namespace x4
