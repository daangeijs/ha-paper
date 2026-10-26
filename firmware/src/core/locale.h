// Clock time zone and price currency from Home Assistant (#147); = emulator src/core/locale.ts,
// spec/test-vectors/locale.json. HA get_config gives an IANA `time_zone` and an ISO 4217 `currency`.
#pragma once
#include <string>

namespace x4::locale {

constexpr const char* kDefaultTz = "CET-1CEST,M3.5.0,M10.5.0/3";   // Europe/Amsterdam, until HA or the user says otherwise

struct Zone { const char* name; const char* posix; };
extern const Zone kZones[];
extern const int kZoneCount;

const char* ianaToPosix(const std::string& zone);   // a table zone → POSIX TZ, else nullptr
bool validTzSetting(const std::string& tz);         // PUT /settings tz: "", a table zone or a POSIX TZ string
// The override (POSIX or a table zone) wins, else HA's zone; "" = neither known, keep the current one.
std::string tzFor(const std::string& override_, const std::string& haZone);

std::string currencySymbol(const std::string& code);   // EUR € · USD $ · GBP £ · else the code; "" → €
void setCurrency(const std::string& symbol);           // the app task sets it; price tiles read it
const std::string& currency();
std::string money(double v);                           // €0.23 · SEK 0.23 (fmtNum, 2 decimals, the number format)
std::string money(double v, const std::string& symbol);

}  // namespace x4::locale
