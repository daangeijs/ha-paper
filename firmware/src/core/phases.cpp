#include "core/phases.h"

#include <algorithm>

namespace x4::phases {

namespace {
const char* wakeName(char w) {
  switch (w) {
    case 't': return "timer";
    case 'b': return "button";
    case 'h': return "charger";
    case 'o': return "other";
    default: return "cold";
  }
}
std::string n(uint32_t v) { return std::to_string(v); }
}  // namespace

Rec measure(const Marks& m, uint32_t total, uint32_t renderMs, uint32_t panelMs) {
  Rec r{};
  r.total = total;
  r.render = renderMs;
  r.panel = panelMs;
  r.mv = -1;
  r.pct = r.raw = -1;
  r.wake = 'c';
  // each mark clamped to [previous end, total]; a mark not reached ends the cut at total
  uint32_t at = 0;
  bool open = false;
  auto cut = [&](uint32_t mark) -> uint32_t {
    if (open) return 0;
    const uint32_t end = mark == kNoMs ? total : std::min(std::max(mark, at), total);
    if (mark == kNoMs) open = true;
    const uint32_t d = end - at;
    at = end;
    return d;
  };
  r.boot = cut(m.bootMs);
  r.wifi = cut(m.wifiMs);
  r.ha = cut(m.haMs);
  if (!open) {
    const uint32_t draw = renderMs + panelMs, after = draw > m.drawAtHaMs ? draw - m.drawAtHaMs : 0;
    const uint32_t rest = total - at;
    r.idle = rest - std::min(rest, after);
  }
  return r;
}

void push(Ring& r, const Rec& rec) {
  if (r.head >= kWakes || r.n > kWakes) r.head = r.n = 0;
  r.recs[r.head] = rec;
  r.head = uint8_t((r.head + 1) % kWakes);
  if (r.n < kWakes) ++r.n;
}

std::string recJson(const Rec& r) {
  return "{\"wake\":\"" + std::string(wakeName(r.wake)) + "\",\"epoch\":" + (r.epoch ? n(r.epoch) : "null") +
         ",\"boot_ms\":" + n(r.boot) + ",\"wifi_ms\":" + n(r.wifi) + ",\"ha_ms\":" + n(r.ha) + ",\"render_ms\":" +
         n(r.render) + ",\"panel_ms\":" + n(r.panel) + ",\"idle_ms\":" + n(r.idle) + ",\"total_ms\":" + n(r.total) +
         ",\"pct\":" + (r.pct >= 0 ? std::to_string(r.pct) : "null") + ",\"raw\":" +
         (r.raw >= 0 ? std::to_string(r.raw) : "null") + ",\"mv\":" + (r.mv >= 0 ? std::to_string(r.mv) : "null") + "}";
}

std::string json(const Rec* running, const Ring& r) {
  std::string o = "{\"boot\":" + (running ? recJson(*running) : std::string("null")) + ",\"wakes\":[";
  const size_t cnt = r.head < kWakes && r.n <= kWakes ? r.n : 0;
  for (size_t k = 0; k < cnt; k++) o += (k ? "," : "") + recJson(r.recs[(r.head + kWakes - 1 - k) % kWakes]);
  return o + "]}";
}

std::string line(const Rec& r) {
  return "boot " + n(r.boot) + " · wifi " + n(r.wifi) + " · ha " + n(r.ha) + " · render " + n(r.render) + " · panel " +
         n(r.panel) + " · idle " + n(r.idle) + " · total " + n(r.total) + " ms";
}

}  // namespace x4::phases
