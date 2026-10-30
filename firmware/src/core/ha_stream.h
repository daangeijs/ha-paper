// core/ha_stream: HA `subscribe_entities` events → the entity mirror (#76). Pure (ArduinoJson only), host-tested in
// test/test_ha_stream. Only attributes some reader uses are kept (keepAttr): a real house sends 10–15 attributes per
// entity (icon, attribution, options, last_seen …), all small strings, and malloc keeps blocks up to 4 KB in internal
// RAM (the mirror uses PSRAM, core/psram_alloc.h), two copies deep (EntityAdapter raw, EntityStore).
#pragma once
#include <ArduinoJson.h>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>
#include "core/entity_map.h"

namespace x4 {

// Attribute names read by core/home.cpp and core/entity_map.cpp (list in entities.h). A new reader → add it here.
bool keepAttr(const char* key);
// Per-entity extras (#292): the attribute a history tile charts, kept for that entity only. Replaces the set; true when
// it changed. keepAttrFor: keepAttr, or one of these. setAttrs also keeps a door / window binary_sensor's
// device_class (#331), and a media_player's supported_features (#351).
bool setExtraAttrs(const std::vector<std::pair<std::string, std::string>>& entityAttr);
bool keepAttrFor(const char* entity, const char* key);
// Scalar as text ("" for null, "true"/"false", numbers as JSON); arrays/objects as JSON text.
std::string scalarText(ArduinoJson::JsonVariantConst v);
// Apply one event (a = added, full; c = changed, diff; r = removed) to `mirror`; every touched entity is appended to
// `out` (removed ones as state "unavailable", no attributes).
void applyEntityEvent(ArduinoJson::JsonObjectConst ev, PMap<EntityValue>& mirror, EntityUpdates& out);
// One entry of config/entity_registry/get_entries (#85): options.sensor.display_precision, else the integration's
// suggested_display_precision; -1 when neither (or the entry is null).
int registryPrecision(ArduinoJson::JsonVariantConst entry);

// #81: subscribe_entities again only when nothing is subscribed or the watched set changed. Sets compare by content,
// whatever order the ids were collected in.
bool resubscribeNeeded(const std::set<std::string>& subscribed, size_t liveSubs, const std::set<std::string>& want);
// Log helpers: FNV-1a per id, summed (order-independent); "+a +b -c" with at most `max` ids, then "…".
uint32_t idSetHash(const std::set<std::string>& ids);
std::string idSetDiff(const std::set<std::string>& before, const std::set<std::string>& after, size_t max = 4);

}  // namespace x4
