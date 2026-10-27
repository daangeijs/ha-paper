#include "net/storage.h"

#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>

#include <cctype>
#include <initializer_list>

#include "Logging.h"
#include "core/logic.h"
#include "core/migrate.h"
#include "hw/watchdog.h"
#include "net/secret_box.h"
#include "net/util.h"

namespace x4::net {

namespace {
constexpr const char* kNsWifi = "x4wifi";
constexpr const char* kNsHa = "x4ha";
constexpr const char* kNsTok = "x4tok";
constexpr const char* kNsDev = "x4dev";
constexpr const char* kNsOta = "x4ota";
constexpr const char* kAllNs[] = {kNsWifi, kNsHa, kNsTok, kNsDev, kNsOta};
}  // namespace

Storage& storage() {
  static Storage s;
  return s;
}

namespace {
fs::LittleFSFS g_www;
}  // namespace

bool Storage::begin() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  // Mount without formatting first so a format (blank partition on first flash, or corruption) is visible in the log.
  // Either way we keep booting: settings and screens fall back to defaults.
  fsOk_ = LittleFS.begin(false, "/littlefs", 10, "userdata");
  if (!fsOk_) {
    LOG_WRN("STORE", "userdata mount failed · formatting (expected once after the first flash with this layout)");
    fsOk_ = LittleFS.begin(true, "/littlefs", 10, "userdata");
    if (fsOk_) LOG_WRN("STORE", "userdata formatted · %u KB", unsigned(LittleFS.totalBytes() / 1024));
    else LOG_ERR("STORE", "!!! userdata format FAILED · running without files (defaults)");
  }
  // www is only ever written by a flasher (www.bin); never format it: a blank one means the fallback setup page.
  wwwOk_ = g_www.begin(false, "/www", 5, "www");
  if (!wwwOk_) LOG_WRN("STORE", "www partition not mounted (no www.bin flashed?) · fallback web page");
  migrate();
  return fsOk_;
}

// The one migration entry point (issue #12). Upgrades step by step, never down: after an OTA rollback the newer data
// is read as far as this firmware understands it and nothing is written back.
void Storage::migrate() {
  using namespace x4::migrate;
  std::lock_guard<std::recursive_mutex> l(mu_);
  // NVS: one schema number for all HA Paper namespaces. Missing = 0 (install from before #12, or blank NVS).
  int64_t dev = getI64(kNsDev, "schema", 0);
  Status ds = schemaStatus(dev > 1000000 ? -1 : static_cast<int>(dev), kDeviceSchema);
  if (ds == Status::Upgrade) {
    // Device steps go here, one per version (dev → dev + 1). 0 → 1: same keys, only stamped.
    putI64(kNsDev, "schema", kDeviceSchema);
  }
  if (ds == Status::Newer || ds == Status::Unknown)
    LOG_WRN("STORE", "NVS schema %lld is not this firmware's %d (OTA rollback?) · reading, not writing", static_cast<long long>(dev), kDeviceSchema);

  std::string json;
  Result rs;
  if (readFile("/settings.json", json)) {
    rs = migrateSettings(json);
    if (rs.status == Status::Upgrade && !writeFile("/settings.json", rs.text))
      LOG_ERR("STORE", "settings.json upgrade %d → %d not written · retried next boot", rs.from, rs.version);
    if (rs.status == Status::Newer || rs.status == Status::Unknown)
      LOG_WRN("STORE", "settings.json schema %d is not this firmware's %d · reading known keys, not writing", rs.from, kSettingsSchema);
  }
  LOG_INF("STORE", "schema · NVS %lld (%s) · settings.json %d (%s)", static_cast<long long>(dev), statusName(ds), rs.from,
          json.empty() ? "no file" : statusName(rs.status));
}

fs::FS& Storage::www() { return g_www; }

std::string Storage::getString(const char* ns, const char* key, const std::string& def) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  Preferences p;
  if (!p.begin(ns, true)) return def;
  std::string v = p.isKey(key) ? std::string(p.getString(key, "").c_str()) : def;
  p.end();
  return v;
}

void Storage::putString(const char* ns, const char* key, const std::string& v) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  Preferences p;
  if (!p.begin(ns, false)) return;
  p.putString(key, v.c_str());
  p.end();
}

int64_t Storage::getI64(const char* ns, const char* key, int64_t def) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  Preferences p;
  if (!p.begin(ns, true)) return def;
  int64_t v = p.getLong64(key, def);
  p.end();
  return v;
}

void Storage::putI64(const char* ns, const char* key, int64_t v) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  Preferences p;
  if (!p.begin(ns, false)) return;
  p.putLong64(key, v);
  p.end();
}

bool Storage::loadWifi(WifiCreds& out) {
  out.ssid = getString(kNsWifi, "ssid");
  if (out.ssid.empty()) return false;
  std::string sealed = getString(kNsWifi, "pw");
  out.password.clear();
  if (!sealed.empty() && !SecretBox::open(sealed, out.password)) {
    LOG_WRN("STORE", "Wi-Fi password could not be decrypted (different chip?)");
    return false;
  }
  return true;
}

void Storage::saveWifi(const WifiCreds& c) {
  putString(kNsWifi, "ssid", c.ssid);
  putString(kNsWifi, "pw", c.password.empty() ? std::string() : SecretBox::seal(c.password));
}

void Storage::clearWifi() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  Preferences p;
  if (p.begin(kNsWifi, false)) {
    p.clear();
    p.end();
  }
}

bool Storage::loadHa(HaLink& out) {
  out = HaLink{};
  out.url = getString(kNsHa, "url");
  out.kind = getString(kNsHa, "kind");
  out.clientId = getString(kNsHa, "cid");
  out.user = getString(kNsHa, "user");
  std::string sealed = getString(kNsHa, "sec");
  if (out.kind.empty() || sealed.empty()) {
    out.kind.clear();
    return false;
  }
  if (!SecretBox::open(sealed, out.secret)) {
    LOG_WRN("STORE", "HA key could not be decrypted");
    out.kind.clear();
    return false;
  }
  return true;
}

void Storage::saveHa(const HaLink& link) {
  putString(kNsHa, "url", link.url);
  putString(kNsHa, "kind", link.kind);
  putString(kNsHa, "cid", link.clientId);
  putString(kNsHa, "user", link.user);
  putString(kNsHa, "sec", SecretBox::seal(link.secret));
}

void Storage::clearHa() {
  std::string url = haUrl();
  std::lock_guard<std::recursive_mutex> l(mu_);
  Preferences p;
  if (p.begin(kNsHa, false)) {
    p.clear();
    if (!url.empty()) p.putString("url", url.c_str());
    p.end();
  }
}

void Storage::saveHaUrl(const std::string& url) { putString(kNsHa, "url", url); }
std::string Storage::haUrl() { return getString(kNsHa, "url"); }

std::string Storage::loadTokensJson() { return getString(kNsTok, "list", "[]"); }
void Storage::saveTokensJson(const std::string& json) { putString(kNsTok, "list", json); }

std::string Storage::installId() {
  std::string id = getString(kNsDev, "iid");
  if (id.empty()) {
    id = randomToken(12, "abcdefghijklmnopqrstuvwxyz0123456789");
    putString(kNsDev, "iid", id);
  }
  return id;
}

bool Storage::readFile(const char* path, std::string& out) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  if (!fsOk_) return false;
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  out.clear();
  out.reserve(f.size());
  uint8_t buf[512];
  while (f.available()) {
    int n = f.read(buf, sizeof buf);
    if (n <= 0) break;
    out.append(reinterpret_cast<char*>(buf), n);
  }
  f.close();
  return true;
}

bool Storage::writeFile(const char* path, const std::string& data) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  if (!fsOk_) return false;
  std::string tmp = std::string(path) + ".tmp";
  wdt::feedIfSubscribed();   // also called from web handlers (async_tcp is subscribed, hw/watchdog.h)
  File f = LittleFS.open(tmp.c_str(), "w");
  if (!f) return false;
  size_t n = f.write(reinterpret_cast<const uint8_t*>(data.data()), data.size());
  f.close();
  wdt::feedIfSubscribed();
  if (n != data.size()) {
    LittleFS.remove(tmp.c_str());
    return false;
  }
  LittleFS.remove(path);
  return LittleFS.rename(tmp.c_str(), path);
}

std::string Storage::settingsToJson(const DisplaySettings& s) {
  JsonDocument d;
  d["brightness"] = s.brightness;
  d["warmth"] = s.warmth;
  d["lightTimeout"] = s.lightTimeout;
  d["quiet"] = s.quiet;
  d["returnHome"] = s.returnHome;
  d["standby"] = s.standby;
  d["clock"] = s.clock;
  d["intervalSec"] = s.intervalSec;
  d["fullEvery"] = s.fullEvery;
  d["cleanEvery"] = s.cleanEvery;
  d["otaAuto"] = s.otaAuto;
  d["style"] = s.style;
  d["typeface"] = s.typeface;
  d["surface"] = s.surface;
  d["haReport"] = s.haReport;
  d["powerSave"] = s.powerSave;
  d["wakeEvery"] = s.wakeEvery;
  d["liveMin"] = s.liveMin;
  d["debugInput"] = s.debugInput;
  std::string out;
  serializeJson(d, out);
  return out;
}

bool Storage::settingsFromJson(const std::string& json, DisplaySettings& s, std::string* err, bool strict) {
  JsonDocument d;
  if (deserializeJson(d, json)) {
    if (err) *err = "invalid JSON";
    return false;
  }
  if (!d.is<JsonObject>()) {
    if (err) *err = "expected an object";
    return false;
  }
  auto clampInt = [](int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; };
  if (strict) {
    // PUT /settings: same rules (and 422 messages) as the emulator's mergeSettings(); stored files stay lenient.
    auto fail = [err](const char* m) { if (err) *err = m; return false; };
    auto intIn = [&](const char* k, int lo, int hi) {
      JsonVariant v = d[k];
      return v.isNull() || (v.is<int>() && v.as<int>() >= lo && v.as<int>() <= hi);
    };
    auto strIn = [&](const char* k, std::initializer_list<const char*> ok) {
      JsonVariant v = d[k];
      if (v.isNull()) return true;
      std::string x = v.is<const char*>() ? v.as<const char*>() : (v.is<int>() ? std::to_string(v.as<int>()) : "?");
      for (auto* o : ok) if (x == o) return true;
      return false;
    };
    if (!intIn("brightness", 0, 100)) return fail("brightness must be 0–100");
    if (!intIn("warmth", 0, 100)) return fail("warmth must be 0–100");
    if (!d["lightTimeout"].isNull() && !(d["lightTimeout"].is<int>() && validLightTimeout(d["lightTimeout"].as<int>())))
      return fail("lightTimeout must be 0, 30, 60, 120 or 300");
    if (!d["quiet"].isNull() && !(d["quiet"].is<const char*>() && validQuiet(d["quiet"].as<const char*>())))
      return fail("quiet must be \"off\" or \"HH-HH\"");
    if (!strIn("returnHome", {"never", "1", "5", "15"})) return fail("returnHome must be never, 1, 5 or 15");
    if (!strIn("standby", {"never", "10", "30", "60"})) return fail("standby must be never, 10, 30 or 60");
    if (!strIn("clock", {"24", "12"})) return fail("clock must be \"24\" or \"12\"");
    if (!d["intervalSec"].isNull() && !(d["intervalSec"].is<int>() && (d["intervalSec"].as<int>() == 5 || d["intervalSec"].as<int>() == 10 ||
                                                                      d["intervalSec"].as<int>() == 30 || d["intervalSec"].as<int>() == 60)))
      return fail("intervalSec must be 5, 10, 30 or 60");
    if (!intIn("fullEvery", 1, 30)) return fail("fullEvery must be 1–30");
    if (!d["cleanEvery"].isNull() && !(d["cleanEvery"].is<int>() && (d["cleanEvery"].as<int>() == 30 || d["cleanEvery"].as<int>() == 60 ||
                                                                    d["cleanEvery"].as<int>() == 120)))
      return fail("cleanEvery must be 30, 60 or 120");
    if (!strIn("otaAuto", {"off", "notify", "night"})) return fail("otaAuto must be off, notify or night");
    if (!strIn("style", {"classic", "sleek"})) return fail("style must be classic or sleek");
    if (!strIn("typeface", {"archivo", "bricolage", "fraunces", "geist"})) return fail("typeface must be archivo, bricolage, fraunces or geist");
    if (!strIn("surface", {"dither", "dots"})) return fail("surface must be dither or dots");
    if (!d["haReport"].isNull() && !d["haReport"].is<bool>()) return fail("haReport must be true or false");
    if (!d["debugInput"].isNull() && !d["debugInput"].is<bool>()) return fail("debugInput must be true or false");
    if (!strIn("powerSave", {"off", "standby", "glance"})) return fail("powerSave must be off, standby or glance");
    auto oneOf = [&](const char* k, std::initializer_list<int> ok) {
      JsonVariant v = d[k];
      if (v.isNull()) return true;
      if (!v.is<int>()) return false;
      for (int o : ok) if (v.as<int>() == o) return true;
      return false;
    };
    if (!oneOf("wakeEvery", {15, 30, 60})) return fail("wakeEvery must be 15, 30 or 60");
    if (!oneOf("liveMin", {1, 3, 5, 10})) return fail("liveMin must be 1, 3, 5 or 10");
  }
  if (d["brightness"].is<int>()) s.brightness = static_cast<uint8_t>(clampInt(d["brightness"].as<int>(), 0, 100));
  if (d["warmth"].is<int>()) s.warmth = static_cast<uint8_t>(clampInt(d["warmth"].as<int>(), 0, 100));
  if (d["lightTimeout"].is<int>() && validLightTimeout(d["lightTimeout"].as<int>())) s.lightTimeout = d["lightTimeout"].as<int>();
  if (d["quiet"].is<const char*>() && validQuiet(d["quiet"].as<const char*>())) s.quiet = d["quiet"].as<const char*>();   // #295; `night` is a rollback's
  if (d["returnHome"].is<const char*>()) s.returnHome = d["returnHome"].as<const char*>();
  if (d["standby"].is<const char*>()) s.standby = d["standby"].as<const char*>();
  if (d["clock"].is<const char*>()) s.clock = d["clock"].as<const char*>();
  if (d["intervalSec"].is<int>()) s.intervalSec = clampInt(d["intervalSec"].as<int>(), 5, 3600);
  if (d["fullEvery"].is<int>()) s.fullEvery = clampInt(d["fullEvery"].as<int>(), 1, 100);
  if (d["cleanEvery"].is<int>()) { int c = d["cleanEvery"].as<int>(); if (c == 30 || c == 60 || c == 120) s.cleanEvery = c; }
  if (d["otaAuto"].is<const char*>()) {
    std::string a = d["otaAuto"].as<const char*>();
    if (a == "off" || a == "notify" || a == "night") s.otaAuto = a;
  }
  auto pick = [&](const char* k, std::initializer_list<const char*> ok, std::string& out) {   // stored file: ignore unknown
    if (!d[k].is<const char*>()) return;
    std::string v = d[k].as<const char*>();
    for (auto* o : ok) if (v == o) { out = v; return; }
  };
  pick("style", {"classic", "sleek"}, s.style);
  pick("typeface", {"archivo", "bricolage", "fraunces", "geist"}, s.typeface);
  pick("surface", {"dither", "dots"}, s.surface);
  if (d["haReport"].is<bool>()) s.haReport = d["haReport"].as<bool>();
  if (d["debugInput"].is<bool>()) s.debugInput = d["debugInput"].as<bool>();
  pick("powerSave", {"off", "standby", "glance"}, s.powerSave);
  if (d["wakeEvery"].is<int>()) { int w = d["wakeEvery"].as<int>(); if (w == 15 || w == 30 || w == 60) s.wakeEvery = w; }
  if (d["liveMin"].is<int>()) { int l = d["liveMin"].as<int>(); if (l == 1 || l == 3 || l == 5 || l == 10) s.liveMin = l; }
  return true;
}

bool Storage::loadSettings(DisplaySettings& out) {
  std::string json;
  if (!readFile("/settings.json", json)) return false;
  return settingsFromJson(json, out);
}

// Merged into the stored object (core persistSettings): keys this firmware does not know, and a newer schema, stay.
void Storage::saveSettings(const DisplaySettings& s) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  std::string stored;
  bool have = readFile("/settings.json", stored);
  writeFile("/settings.json", x4::migrate::persistSettings(have ? &stored : nullptr, settingsToJson(s)));
}

void Storage::factoryReset() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  for (const char* ns : kAllNs) {
    Preferences p;
    if (p.begin(ns, false)) {
      p.clear();
      p.end();
    }
  }
  // userdata holds only HA Paper files (screens, settings, diag): format it whole. /diag.json is not a setting
  // (emulator: diag survives a factory reset); the caller writes it back from RTC memory (diagSave()).
  if (fsOk_ && !LittleFS.format()) LOG_ERR("STORE", "userdata format FAILED");
  putI64(kNsDev, "schema", x4::migrate::kDeviceSchema);   // empty NVS of this firmware's schema
  LOG_WRN("STORE", "factory reset: HA Paper NVS namespaces erased, userdata formatted (hw_calib kept)");
}

}  // namespace x4::net
