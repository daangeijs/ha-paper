#include "core/settings_api.h"

#include "core/locale.h"

namespace x4::settings_api {

const char* const kTzError =
    "tz must be \"\", a known zone like Europe/Amsterdam or a POSIX TZ string like CET-1CEST,M3.5.0,M10.5.0/3";

namespace {

// A new setting = one row here and one in emulator src/core/settings.ts (SETTINGS_KEYS / DISPLAY_KEYS).
const char* const kKeys[] = {"display", "ota_channel", "tz", "name", "entities"};
const char* const kDisplayKeys[] = {"brightness", "warmth", "lightTimeout", "quiet",      "returnHome", "standby", "clock",   "intervalSec",
                                    "fullEvery",  "cleanEvery", "otaAuto", "style",      "typeface", "surface", "haReport",
                                    "powerSave",  "wakeEvery", "liveMin",   // glance (#10)
                                    "debugInput"};                         // #214

template <size_t N>
bool known(const char* const (&table)[N], const std::string& k) {
  for (auto* t : table) if (k == t) return true;
  return false;
}

struct TzParser {
  const std::string& s;
  size_t i = 0;

  char at() const { return i < s.size() ? s[i] : '\0'; }
  static bool digit(char c) { return c >= '0' && c <= '9'; }
  static bool alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

  bool num(int lo, int hi, size_t maxDigits) {
    size_t j = i;
    int v = 0;
    while (j < s.size() && j - i < maxDigits && digit(s[j])) v = v * 10 + (s[j++] - '0');
    if (j == i || v < lo || v > hi) return false;
    i = j;
    return true;
  }
  bool name() {
    size_t j = i;
    if (at() == '<') {
      ++j;
      while (j < s.size() && (alpha(s[j]) || digit(s[j]) || s[j] == '+' || s[j] == '-')) ++j;
      size_t n = j - i - 1;
      if (j >= s.size() || s[j] != '>' || n < 3 || n > 10) return false;
      i = j + 1;
      return true;
    }
    while (j < s.size() && alpha(s[j])) ++j;
    if (j - i < 3 || j - i > 10) return false;
    i = j;
    return true;
  }
  bool hms(int maxH) {
    if (!num(0, maxH, 3)) return false;
    for (int k = 0; k < 2 && at() == ':'; ++k) {
      ++i;
      if (!num(0, 59, 2)) return false;
    }
    return true;
  }
  bool offset() {
    if (at() == '+' || at() == '-') ++i;
    return hms(24);
  }
  bool rule() {
    if (at() != ',') return false;
    ++i;
    if (at() == 'J') {
      ++i;
      if (!num(1, 365, 3)) return false;
    } else if (at() == 'M') {
      ++i;
      if (!num(1, 12, 2) || at() != '.') return false;
      ++i;
      if (!num(1, 5, 1) || at() != '.') return false;
      ++i;
      if (!num(0, 6, 1)) return false;
    } else if (!num(0, 365, 3)) {
      return false;
    }
    if (at() == '/') {
      ++i;
      if (!hms(167)) return false;
    }
    return true;
  }
};

}  // namespace

bool validPosixTz(const std::string& tz) {
  if (tz.size() > 64) return false;
  TzParser p{tz};
  if (!p.name() || !p.offset()) return false;
  if (p.i == tz.size()) return true;
  if (!p.name()) return false;
  if (p.at() != ',' && !p.offset()) return false;
  return p.rule() && p.rule() && p.i == tz.size();
}

std::string putError(const Json& body) {
  for (auto& kv : body.obj)
    if (!known(kKeys, kv.first)) return "unknown key: " + kv.first;
  const Json* d = body.get("display");
  if (d && !d->isNull()) {
    if (!d->isObj()) return "display must be an object";
    for (auto& kv : d->obj)
      if (!known(kDisplayKeys, kv.first)) return "unknown key: display." + kv.first;
  }
  const Json* tz = body.get("tz");
  if (tz && !tz->isNull() && !(tz->isStr() && locale::validTzSetting(tz->str))) return kTzError;   // #147
  return "";
}

}  // namespace x4::settings_api
