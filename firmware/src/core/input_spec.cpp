#include "core/input_spec.h"

#include <cstdlib>

namespace x4 {

bool parseInputSpec(const std::string& spec, InputEvent& out) {
  InputEvent e{};
  const auto eq = spec.find('=');
  if (eq == std::string::npos) return false;
  const std::string k = spec.substr(0, eq), v = spec.substr(eq + 1);
  if (k == "tap") {
    const auto c = v.find(',');
    if (c == std::string::npos) return false;
    e.kind = InputEvent::Kind::Tap;
    e.x = static_cast<int16_t>(atoi(v.substr(0, c).c_str()));
    e.y = static_cast<int16_t>(atoi(v.substr(c + 1).c_str()));
  } else if (k == "key") {
    e.kind = InputEvent::Kind::KeyDown;
    if (v == "prev") e.key = Key::Prev;
    else if (v == "next") e.key = Key::Next;
    else if (v == "home") e.key = Key::Home;
    else if (v == "power") e.key = Key::Power;
    else return false;
  } else if (k == "swipe") {
    e.kind = InputEvent::Kind::Swipe;
    e.dir = static_cast<int8_t>(atoi(v.c_str()) < 0 ? -1 : 1);
  } else {
    return false;
  }
  out = e;
  return true;
}

}  // namespace x4
