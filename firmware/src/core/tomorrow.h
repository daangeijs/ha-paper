// Quiet face "Tomorrow" row (#328) = emulator src/core/quiet.ts (quietSources, quietTomorrow); vectors
// spec/test-vectors/quiet-tomorrow.json (test_core). Values that stay true overnight, from what the device already keeps
// (the #318 forecast in RTC, the #316 agenda cache, the #317 bin sensors in the mirror): no fetch for the face. Pure.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "core/agenda.h"
#include "core/config.h"
#include "core/strings.h"
#include "core/weather.h"

namespace x4 {
namespace quiet {

// The first weather tile with an entity, agenda / next tile with a calendar, bins tile with a sensor (screen, then
// widget order); screen -1 = none.
struct Ref { int screen = -1, widget = -1; };
struct Sources { Ref weather, agenda, bins; };
Sources sources(const std::vector<Screen>& screens);

// The local day the face points at: the window end's day (today before endHour, else tomorrow). kTodayEnd: always
// today, the glance sleep face's "Today" row (#356).
constexpr int kTodayEnd = 24;
int64_t day(int64_t nowMs, int tz, int endHour);

enum class Kind : uint8_t { Weather, Event, Bins };
struct Item { Kind kind; int icon = -1; std::string bold, text; };   // icon: wx::Icon, -1 = none
struct Row { std::string head; std::vector<Item> items; };           // head "" = no items
struct BinDay { std::string label; int days; };                      // days: bins::kUnknown when unknown
struct In {
  int64_t now = 0;
  int tz = 0, endHour = 7, tonight = 17;
  Lang lang = Lang::En;
  const wx::Forecast* fc = nullptr;            // nullptr = no weather source
  const agenda::Fetch* events = nullptr;       // nullptr = no agenda source or no answer yet
  const std::vector<BinDay>* bins = nullptr;   // nullptr = no bins source
};
// Weather (that day's high / low, its drawing, "rain from 08:00"), the first event not over (timed first, else all-day), the bins
// collected that day ("put out tonight" / "collected tomorrow" / "collected today"), in that order.
Row tomorrow(const In& in);

}  // namespace quiet
}  // namespace x4
