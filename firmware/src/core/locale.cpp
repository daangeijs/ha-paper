#include "core/locale.h"

#include <cctype>

#include "core/logic.h"
#include "core/settings_api.h"

namespace x4::locale {

namespace {
constexpr const char* kCet = "CET-1CEST,M3.5.0,M10.5.0/3";
constexpr const char* kEet = "EET-2EEST,M3.5.0/3,M10.5.0/4";
constexpr const char* kWet = "WET0WEST,M3.5.0/1,M10.5.0";
constexpr const char* kUk = "GMT0BST,M3.5.0/1,M10.5.0";
constexpr const char* kUsE = "EST5EDT,M3.2.0,M11.1.0";
constexpr const char* kUsC = "CST6CDT,M3.2.0,M11.1.0";
constexpr const char* kUsM = "MST7MDT,M3.2.0,M11.1.0";
constexpr const char* kUsP = "PST8PDT,M3.2.0,M11.1.0";
constexpr const char* kAuE = "AEST-10AEDT,M10.1.0,M4.1.0/3";
std::string gCurrency = "€";
}  // namespace

// The zones HA users pick most; the device has no zone database. Same rows as locale.json `zones`.
const Zone kZones[] = {
    {"UTC", "UTC0"}, {"Etc/UTC", "UTC0"}, {"GMT", "GMT0"}, {"Etc/GMT", "GMT0"}, {"Atlantic/Reykjavik", "GMT0"},
    {"Europe/London", kUk}, {"Europe/Guernsey", kUk}, {"Europe/Isle_of_Man", kUk}, {"Europe/Jersey", kUk},
    {"Europe/Dublin", "GMT0IST,M3.5.0/1,M10.5.0"}, {"Europe/Lisbon", kWet}, {"Atlantic/Canary", kWet},
    {"Atlantic/Madeira", kWet}, {"Atlantic/Faroe", kWet}, {"Europe/Amsterdam", kCet}, {"Europe/Andorra", kCet},
    {"Europe/Belgrade", kCet}, {"Europe/Berlin", kCet}, {"Europe/Bratislava", kCet}, {"Europe/Brussels", kCet},
    {"Europe/Budapest", kCet}, {"Europe/Copenhagen", kCet}, {"Europe/Gibraltar", kCet}, {"Europe/Ljubljana", kCet},
    {"Europe/Luxembourg", kCet}, {"Europe/Madrid", kCet}, {"Europe/Malta", kCet}, {"Europe/Monaco", kCet},
    {"Europe/Oslo", kCet}, {"Europe/Paris", kCet}, {"Europe/Podgorica", kCet}, {"Europe/Prague", kCet},
    {"Europe/Rome", kCet}, {"Europe/San_Marino", kCet}, {"Europe/Sarajevo", kCet}, {"Europe/Skopje", kCet},
    {"Europe/Stockholm", kCet}, {"Europe/Tirane", kCet}, {"Europe/Vaduz", kCet}, {"Europe/Vatican", kCet},
    {"Europe/Vienna", kCet}, {"Europe/Warsaw", kCet}, {"Europe/Zagreb", kCet}, {"Europe/Zurich", kCet},
    {"Arctic/Longyearbyen", kCet}, {"Europe/Athens", kEet}, {"Europe/Bucharest", kEet}, {"Europe/Helsinki", kEet},
    {"Europe/Kiev", kEet}, {"Europe/Kyiv", kEet}, {"Europe/Mariehamn", kEet}, {"Europe/Riga", kEet},
    {"Europe/Sofia", kEet}, {"Europe/Tallinn", kEet}, {"Europe/Vilnius", kEet}, {"Asia/Nicosia", kEet},
    {"Europe/Chisinau", "EET-2EEST,M3.5.0,M10.5.0/3"}, {"Europe/Kaliningrad", "EET-2"},
    {"Europe/Istanbul", "<+03>-3"}, {"Europe/Minsk", "<+03>-3"}, {"Europe/Moscow", "MSK-3"},
    {"America/New_York", kUsE}, {"America/Detroit", kUsE}, {"America/Toronto", kUsE},
    {"America/Indiana/Indianapolis", kUsE}, {"US/Eastern", kUsE}, {"America/Chicago", kUsC},
    {"America/Winnipeg", kUsC}, {"US/Central", kUsC}, {"America/Denver", kUsM}, {"America/Edmonton", kUsM},
    {"America/Boise", kUsM}, {"US/Mountain", kUsM}, {"America/Phoenix", "MST7"}, {"US/Arizona", "MST7"},
    {"America/Los_Angeles", kUsP}, {"America/Vancouver", kUsP}, {"US/Pacific", kUsP},
    {"America/Anchorage", "AKST9AKDT,M3.2.0,M11.1.0"}, {"US/Alaska", "AKST9AKDT,M3.2.0,M11.1.0"},
    {"Pacific/Honolulu", "HST10"}, {"US/Hawaii", "HST10"}, {"America/Halifax", "AST4ADT,M3.2.0,M11.1.0"},
    {"America/St_Johns", "NST3:30NDT,M3.2.0,M11.1.0"}, {"America/Mexico_City", "CST6"},
    {"America/Sao_Paulo", "<-03>3"}, {"America/Argentina/Buenos_Aires", "<-03>3"}, {"Asia/Dubai", "<+04>-4"},
    {"Asia/Kolkata", "IST-5:30"}, {"Asia/Bangkok", "<+07>-7"}, {"Asia/Singapore", "<+08>-8"},
    {"Asia/Hong_Kong", "HKT-8"}, {"Asia/Shanghai", "CST-8"}, {"Asia/Tokyo", "JST-9"}, {"Asia/Seoul", "KST-9"},
    {"Asia/Jerusalem", "IST-2IDT,M3.4.4/26,M10.5.0"}, {"Africa/Cairo", "EET-2EEST,M4.5.5/0,M10.5.4/24"},
    {"Africa/Johannesburg", "SAST-2"}, {"Africa/Lagos", "WAT-1"}, {"Africa/Nairobi", "EAT-3"},
    {"Australia/Sydney", kAuE}, {"Australia/Melbourne", kAuE}, {"Australia/Canberra", kAuE},
    {"Australia/Hobart", kAuE}, {"Australia/Brisbane", "AEST-10"},
    {"Australia/Adelaide", "ACST-9:30ACDT,M10.1.0,M4.1.0/3"}, {"Australia/Darwin", "ACST-9:30"},
    {"Australia/Perth", "AWST-8"}, {"Pacific/Auckland", "NZST-12NZDT,M9.5.0,M4.1.0/3"},
};
const int kZoneCount = int(sizeof(kZones) / sizeof(kZones[0]));

const char* ianaToPosix(const std::string& zone) {
  for (const Zone& z : kZones)
    if (zone == z.name) return z.posix;
  return nullptr;
}

bool validTzSetting(const std::string& tz) { return tz.empty() || ianaToPosix(tz) || settings_api::validPosixTz(tz); }

std::string tzFor(const std::string& override_, const std::string& haZone) {
  const char* p = nullptr;
  if (!override_.empty()) {
    if (settings_api::validPosixTz(override_)) return override_;
    p = ianaToPosix(override_);
  } else if (!haZone.empty()) {
    p = ianaToPosix(haZone);
  }
  return p ? p : "";
}

std::string currencySymbol(const std::string& code) {
  if (code.empty() || code == "EUR") return "€";
  if (code == "USD") return "$";
  if (code == "GBP") return "£";
  std::string u = code;
  for (char& ch : u) ch = char(std::toupper(static_cast<unsigned char>(ch)));
  return u;
}

void setCurrency(const std::string& symbol) { gCurrency = symbol.empty() ? "€" : symbol; }
const std::string& currency() { return gCurrency; }

std::string money(double v, const std::string& sym) {
  bool letter = !sym.empty() && std::isalpha(static_cast<unsigned char>(sym[0]));
  return sym + (letter ? " " : "") + fmtNum(v, "", 2);
}
std::string money(double v) { return money(v, gCurrency); }

}  // namespace x4::locale
