// List from attributes tile (eink-ha-os#332) = emulator src/core/attrList.ts; vectors spec/test-vectors/attr-list.json. Pure:
// times are epoch ms, tz the local UTC offset in minutes. Rows are computed on each draw from the EntityStore.
#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>
#include "core/config.h"
#include "core/entities.h"
#include "core/strings.h"

namespace x4 {
namespace alist {

constexpr int kMaxSubtitle = 3;
constexpr size_t kMaxItems = 10;     // ingest cap (core/ha_stream capList)
constexpr size_t kMaxBytes = 3072;

// fb*: the fallback of a field left at its default, read when the item lacks the field (empty = the tile sets it)
struct Spec { std::string attribute, title, time, fbTitle, fbTime; std::vector<std::string> subtitle, fbSubtitle; };
Spec specOf(const Widget& w);   // defaults: sightings, title, subtitle, ts (eink-ha-os#375); fallbacks species, place distance_km, observed_at
// Config check after the entity (emulator listError); "" = fine. f: the keys as written (numbers as their text).
std::string error(const std::map<std::string, std::string>& f);

struct Rows { int rows; bool oneLine; };
Rows rowsFor(int cs, int rs);   // below 3 columns 2-line rows: 2 / 6; from 3 columns 1-line rows: 4 / 10

std::string ago(const std::string& raw, bool isNum, double num, int64_t nowMs, int tz, Lang l);   // "" = no time

struct Row { std::string title, sub, ago; };
struct View { std::vector<Row> rows; int more = 0; };
View view(const char* value, const Spec& s, int64_t nowMs, int tz, Lang l, int max);   // value: the attribute text

// The keys the HA stream keeps for a config: (entity, attribute) and (entity, "attribution") per attrList tile.
std::vector<std::pair<std::string, std::string>> attrKeys(const Config& c);

}  // namespace alist
}  // namespace x4
