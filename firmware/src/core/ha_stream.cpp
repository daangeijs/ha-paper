#include "core/ha_stream.h"

#include "core/attr_list.h"
#include "core/empty_house.h"

#include <cstring>

namespace x4 {

namespace {
const char* const kAttrs[] = {
    "friendly_name", "unit_of_measurement", "display_precision",                            // every widget
    "today", "raw_today", "prices_today", "prices", "unit", "price_in_cents", "forecast",   // prices, hourly series
    "current_temperature", "temperature", "preset_mode", "temperature_unit",                // climate, weather (eink-ha-os#161)
    "preset_modes",                                                                         // climate: away button (eink-ha-os#148)
    "area_id", "area_name", "brightness", "dimmable", "supported_color_modes",              // lights
    "x4_order",                                                                             // climate, lights
    "departures", "upcoming", "per_hour", "note", "typical",                                // routes (upcoming: eink-ha-os#275)
    "apparent_temperature", "wind_speed", "wind_speed_unit", "wind_bearing", "precipitation_unit",   // weather tile (eink-ha-os#318)
    "media_title", "media_artist", "volume_level",                                          // now playing (eink-ha-os#319)
    "daysTo",                                                                               // bins (eink-ha-os#317; upcoming above)
};

std::vector<std::pair<PStr, PStr>, PsramAlloc<std::pair<PStr, PStr>>>& extras() {
  static std::vector<std::pair<PStr, PStr>, PsramAlloc<std::pair<PStr, PStr>>> v;
  return v;
}

std::vector<std::pair<PStr, PStr>, PsramAlloc<std::pair<PStr, PStr>>>& lists() {
  static std::vector<std::pair<PStr, PStr>, PsramAlloc<std::pair<PStr, PStr>>> v;
  return v;
}

bool replacePairs(std::vector<std::pair<PStr, PStr>, PsramAlloc<std::pair<PStr, PStr>>>& x,
                  const std::vector<std::pair<std::string, std::string>>& entityAttr) {
  bool same = x.size() == entityAttr.size();
  for (size_t i = 0; same && i < x.size(); ++i) same = x[i].first == entityAttr[i].first && x[i].second == entityAttr[i].second;
  if (same) return false;
  x.clear();
  for (auto& e : entityAttr) x.emplace_back(PStr(e.first), PStr(e.second));
  return true;
}

int64_t epochOf(ArduinoJson::JsonVariantConst v) { return v.is<double>() ? static_cast<int64_t>(v.as<double>()) : 0; }

// eink-ha-os#331 Nobody home face: device_class of a door / window binary_sensor only (core/empty_house.h isOpeningClass)
bool openingClass(const char* id, const char* key, ArduinoJson::JsonVariantConst v) {
  return std::strcmp(key, "device_class") == 0 && std::strncmp(id, "binary_sensor.", 14) == 0 && v.is<const char*>() &&
         isOpeningClass(v.as<const char*>());
}

void setAttrs(ArduinoJson::JsonObjectConst a, EntityValue& v, const char* id) {
  for (ArduinoJson::JsonPairConst p : a) {
    const char* k = p.key().c_str();
    if (keepAttrFor(id, k) || openingClass(id, k, p.value())) v.attrs[k] = scalarText(p.value());
    else if (listAttrFor(id, k)) v.attrs[k] = capListText(p.value(), alist::kMaxItems, alist::kMaxBytes);   // eink-ha-os#332
  }
}
}  // namespace

bool keepAttr(const char* key) {
  for (const char* k : kAttrs)
    if (std::strcmp(k, key) == 0) return true;
  return false;
}

bool setExtraAttrs(const std::vector<std::pair<std::string, std::string>>& entityAttr) { return replacePairs(extras(), entityAttr); }
bool setListAttrs(const std::vector<std::pair<std::string, std::string>>& entityAttr) { return replacePairs(lists(), entityAttr); }

bool listAttrFor(const char* entity, const char* key) {
  for (auto& e : lists()) if (e.second == key && e.first == entity) return true;
  return false;
}

std::string capListText(ArduinoJson::JsonVariantConst v, size_t maxItems, size_t maxBytes) {
  if (!v.is<ArduinoJson::JsonArrayConst>()) return scalarText(v);
  std::string out = "[", item;
  size_t n = 0;
  for (ArduinoJson::JsonVariantConst e : v.as<ArduinoJson::JsonArrayConst>()) {
    if (n >= maxItems) break;
    item.clear();
    serializeJson(e, item);
    if (out.size() + 1 + item.size() + (n ? 1 : 0) > maxBytes) break;
    if (n++) out += ',';
    out += item;
  }
  return out + "]";
}

bool keepAttrFor(const char* entity, const char* key) {
  if (keepAttr(key)) return true;
  // eink-ha-os#351: a player's VOLUME_SET bit picks the volume slider; only media players keep it (every entity has one)
  if (std::strcmp(key, "supported_features") == 0 && std::strncmp(entity, "media_player.", 13) == 0) return true;
  for (auto& e : extras()) if (e.second == key && e.first == entity) return true;
  return false;
}

std::string scalarText(ArduinoJson::JsonVariantConst v) {
  if (v.isNull()) return {};
  if (v.is<const char*>()) return v.as<const char*>();
  if (v.is<bool>()) return v.as<bool>() ? "true" : "false";
  std::string s;
  serializeJson(v, s);
  return s;
}

void applyEntityEvent(ArduinoJson::JsonObjectConst ev, PMap<EntityValue>& mirror, EntityUpdates& out) {
  using namespace ArduinoJson;
  for (JsonPairConst kv : ev["a"].as<JsonObjectConst>()) {
    JsonObjectConst o = kv.value().as<JsonObjectConst>();
    EntityValue v;
    v.state = scalarText(o["s"]);
    setAttrs(o["a"], v, kv.key().c_str());
    v.updatedEpoch = epochOf(o["lu"].isNull() ? o["lc"] : o["lu"]);
    mirror[kv.key().c_str()] = v;
    out.emplace_back(kv.key().c_str(), std::move(v));
  }
  for (JsonPairConst kv : ev["c"].as<JsonObjectConst>()) {
    auto it = mirror.find(kv.key().c_str());
    if (it == mirror.end()) continue;
    EntityValue& v = it->second;
    JsonObjectConst plus = kv.value()["+"];
    if (!plus.isNull()) {
      if (!plus["s"].isNull()) v.state = scalarText(plus["s"]);
      setAttrs(plus["a"], v, kv.key().c_str());
      int64_t t = epochOf(plus["lu"].isNull() ? plus["lc"] : plus["lu"]);
      if (t) v.updatedEpoch = t;
    }
    for (JsonVariantConst gone : kv.value()["-"]["a"].as<JsonArrayConst>())
      if (const char* k = gone.as<const char*>()) v.attrs.erase(k);
    out.emplace_back(kv.key().c_str(), v);
  }
  for (JsonVariantConst r : ev["r"].as<JsonArrayConst>()) {
    const char* id = r.as<const char*>();
    if (!id) continue;
    mirror.erase(id);
    EntityValue v;
    v.state = "unavailable";
    out.emplace_back(id, std::move(v));
  }
}

int registryPrecision(ArduinoJson::JsonVariantConst entry) {
  ArduinoJson::JsonVariantConst s = entry["options"]["sensor"];
  for (const char* k : {"display_precision", "suggested_display_precision"}) {
    ArduinoJson::JsonVariantConst p = s[k];
    if (p.is<int>() && p.as<int>() >= 0 && p.as<int>() <= 10) return p.as<int>();
  }
  return -1;
}

bool resubscribeNeeded(const std::set<std::string>& subscribed, size_t liveSubs, const std::set<std::string>& want) {
  return liveSubs == 0 ? !want.empty() : want != subscribed;
}

uint32_t idSetHash(const std::set<std::string>& ids) {
  uint32_t sum = 0;
  for (auto& id : ids) {
    uint32_t h = 2166136261u;
    for (unsigned char c : id) h = (h ^ c) * 16777619u;
    sum += h;
  }
  return sum;
}

std::string idSetDiff(const std::set<std::string>& before, const std::set<std::string>& after, size_t max) {
  std::string out;
  size_t n = 0;
  auto add = [&](char sign, const std::string& id) {
    if (n++ == max) out += out.empty() ? "…" : " …";
    if (n > max) return;
    if (!out.empty()) out += ' ';
    out += sign;
    out += id;
  };
  for (auto& id : after)
    if (!before.count(id)) add('+', id);
  for (auto& id : before)
    if (!after.count(id)) add('-', id);
  return out;
}

}  // namespace x4
