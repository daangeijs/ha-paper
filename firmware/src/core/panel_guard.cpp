#include "core/panel_guard.h"

namespace x4 {

PanelGuard& panelGuard() {
  static PanelGuard g;
  return g;
}

void PanelGuard::fail(uint32_t waitedMs, const char* what) {
  waitedMs_ = waitedMs;
  what_ = what;
  failed_ = true;
}

std::string PanelGuard::failureText() const {
  if (!failed()) return "";
  std::string s = "BUSY stuck " + std::to_string(waitedMs_.load() / 1000) + " s";
  if (const char* w = what_.load(); w && *w) s += std::string(" (") + w + ")";
  return s;
}

void PanelGuard::reset() {
  failed_ = false;
  logged_ = false;
  waitedMs_ = 0;
  what_ = nullptr;
}

}  // namespace x4
