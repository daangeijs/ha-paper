// Bin day tile (#317) = emulator src/core/bins.ts; vectors spec/test-vectors/bins.json. Pure: times are epoch ms, tz the
// local UTC offset in minutes. Computed on each draw from the EntityStore; nothing is kept.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "core/entities.h"
#include "core/strings.h"

namespace x4 {
namespace bins {

constexpr int kMaxBins = 6;
constexpr int kTonightDefault = 17;   // from this local hour the day before: "put out tonight"
constexpr int kUnknown = -1;

// Days from the local today to the next collection, kUnknown when none. The first source giving a day >= today wins:
// a date state (ISO, or DD-MM-YYYY), a whole-number state (days to), attr daysTo, attr upcoming (JSON list of dates
// or {date}). unavailable / unknown -> kUnknown.
int days(const std::string& state, const char* daysTo, const char* upcoming, int64_t nowMs, int tz);   // nullptr = no attr
int days(const EntityValue* v, int64_t nowMs, int tz);

struct Row { std::string label, when, date, shortDate; int days = 0; };   // when: Today / Tomorrow / in N days
struct View {
  std::vector<Row> rows;                  // soonest first, config order on a tie, unknown left out
  std::string head, big = "—", line, foot, pill;
  bool tonight = false;
  size_t restFrom = 0;                    // rows[restFrom..]: the later bins
};
struct In { std::string label; const EntityValue* v; };
View view(const std::vector<In>& bins, int64_t nowMs, int tz, int tonightHour, Lang lang);

// The tile's config: entities (in order) with their label (labels item, else HA friendly_name, else the id); tonight.
std::vector<In> inputs(const std::string& entities, const std::string& labels, const EntityStore& store);
int tonightHour(const std::string& field);   // "" -> kTonightDefault

}  // namespace bins
}  // namespace x4
