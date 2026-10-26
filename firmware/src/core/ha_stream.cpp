#include "core/ha_stream.h"

#include <cstring>

namespace x4 {

namespace {
const char* const kAttrs[] = {
    "friendly_name", "unit_of_measurement", "display_precision",                            // every widget
    "today", "raw_today", "prices_today", "prices", "unit", "price_in_cents", "forecast",   // prices, hourly series
    "current_temperature", "temperature", "preset_mode", "temperature_unit",                // climate, weather (#161)
    "preset_modes",                                                                         // climate: away button (#148)
    "area_id", "area_name", "brightness", "dimmable", "supported_color_modes",              // lights
    "x4_order",                                                                             // climate, lights
    "departures", "per_hour", "note", "typical",                                            // routes
};

int64_t epochOf(ArduinoJson::JsonVariantConst v) { return v.is<double>() ? static_cast<int64_t>(v.as<double>()) : 0; }

void setAttrs(ArduinoJson::JsonObjectConst a, EntityValue& v) {
  for (ArduinoJson::JsonPairConst p : a)
    if (keepAttr(p.key().c_str())) v.attrs[p.key().c_str()] = scalarText(p.value());
}
}  // namespace

bool keepAttr(const char* key) {
  for (const char* k : kAttrs)
    if (std::strcmp(k, key) == 0) return true;
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
    setAttrs(o["a"], v);
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
      setAttrs(plus["a"], v);
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
