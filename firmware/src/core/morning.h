// Good morning page (eink-ha-os#330) = emulator src/core/morning.ts; vectors spec/test-vectors/morning.json. The first wake after
// Quiet hours shows today's weather, events and bins for kMs; one press or the timeout hands over to the start page.
// Built from what the tiles already keep (weather forecast, agenda events, bin sensors). Pure: epoch ms, tz in minutes.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "core/agenda.h"
#include "core/config.h"
#include "core/strings.h"
#include "core/tomorrow.h"
#include "core/weather.h"

namespace x4 {
namespace morning {

constexpr int64_t kMs = 20 * 60000;
constexpr int kEvents = 4;   // today's events on the page; later ones are "+N more today"

// Survives deep sleep (net/morning_rtc.cpp). armed: quiet hours seen since the page last went up; until: epoch ms the
// page ends, 0 = not up. No implicit padding (the RTC checksum covers every byte).
struct State {
  uint8_t armed = 0, pad[7] = {};
  int64_t until = 0;
};
static_assert(sizeof(State) == 16, "no padding in the RTC record");
struct Tick { int64_t now; int hour; bool clockKnown; std::string quiet; bool enabled; };
struct Step { State s; bool start = false, end = false; };
// Clock unknown: no change. In the window: armed, page down. Outside, armed: disarmed, and up for kMs when enabled and
// quiet is not "off". Up and until reached: down.
Step step(const State& s, const Tick& t);
inline bool up(const State& s, int64_t now) { return s.until != 0 && now < s.until; }

// The tiles the page reads: the quiet face's Tomorrow row sources (eink-ha-os#328, core/tomorrow.h quiet::sources).

struct Bin { std::string label; int days; };   // days: bins::kUnknown (-1) = unknown
struct In {
  int64_t now; int tz; Lang lang;
  const wx::Forecast* fc;          // nullptr = no tile / none kept yet
  const agenda::Fetch* events;     // nullptr = no tile / no answer yet
  const std::vector<Bin>* bins;    // nullptr = no tile
};
struct Event { std::string time, title; };
struct BinRow { std::string labels, when; };
struct View {
  std::string head, date;
  bool weather = false, hasIcon = false;   // weather row present; its drawing (today's daily entry)
  wx::Icon icon = wx::Icon::Cloud;
  std::string temps, rain;                  // "13° / 6°" or ""; "Rain from 08:00" / "Rain now" / ""
  std::vector<Event> events;
  std::string more;                         // "+2 more today" or ""
  std::vector<BinRow> bins;                 // collected today, then put out tonight
};
View view(const In& in);

}  // namespace morning
}  // namespace x4
