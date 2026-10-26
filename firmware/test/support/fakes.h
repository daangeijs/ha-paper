// Host fakes for the UI runtime: Display (PGM/PNG snapshots), Board (scripted clock/input), Services (records calls).
// Header-only so every test binary (pio test -e native) and tools/render_host can include it.
#pragma once
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <vector>
#include <algorithm>
#include "app/services.h"
#include "core/entities.h"
#include "hw/platform.h"

namespace x4 {
namespace fake {

inline uint8_t gray(const Framebuffer& fb, int x, int y) {
  size_t i = size_t(y) * kScreenW + x;
  static const uint8_t lv[4] = {0x11, 0x55, 0xA8, 0xEC};   // ink, gray1, gray2, paper (tokens.json)
  return lv[(fb.data[i >> 2] >> (6 - 2 * (i & 3))) & 3];
}

inline bool writePgm(const Framebuffer& fb, const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  std::fprintf(f, "P5\n%d %d\n255\n", kScreenW, kScreenH);
  for (int y = 0; y < kScreenH; ++y)
    for (int x = 0; x < kScreenW; ++x) std::fputc(gray(fb, x, y), f);
  std::fclose(f);
  return true;
}

// Minimal PNG (8-bit gray, stored/uncompressed deflate) — no zlib needed.
inline uint32_t crc32(const uint8_t* d, size_t n, uint32_t c = 0xFFFFFFFFu) {
  for (size_t i = 0; i < n; ++i) { c ^= d[i]; for (int k = 0; k < 8; ++k) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1))); }
  return c;
}
inline bool writePng(const Framebuffer& fb, const std::string& path) {
  std::vector<uint8_t> raw;
  raw.reserve(size_t(kScreenH) * (kScreenW + 1));
  for (int y = 0; y < kScreenH; ++y) { raw.push_back(0); for (int x = 0; x < kScreenW; ++x) raw.push_back(gray(fb, x, y)); }
  std::vector<uint8_t> z = {0x78, 0x01};
  uint32_t a = 1, b = 0;
  for (uint8_t v : raw) { a = (a + v) % 65521; b = (b + a) % 65521; }
  for (size_t off = 0; off < raw.size();) {
    size_t n = std::min<size_t>(65535, raw.size() - off);
    z.push_back(off + n == raw.size() ? 1 : 0);
    z.push_back(n & 0xFF); z.push_back(n >> 8); z.push_back(~n & 0xFF); z.push_back((~n >> 8) & 0xFF);
    z.insert(z.end(), raw.begin() + off, raw.begin() + off + n);
    off += n;
  }
  uint32_t ad = (b << 16) | a;
  for (int s = 24; s >= 0; s -= 8) z.push_back((ad >> s) & 0xFF);
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  auto be32 = [&](uint32_t v) { uint8_t q[4] = {uint8_t(v >> 24), uint8_t(v >> 16), uint8_t(v >> 8), uint8_t(v)}; std::fwrite(q, 1, 4, f); };
  auto chunk = [&](const char* type, const std::vector<uint8_t>& data) {
    be32(uint32_t(data.size()));
    std::vector<uint8_t> td(type, type + 4); td.insert(td.end(), data.begin(), data.end());
    std::fwrite(td.data(), 1, td.size(), f);
    be32(crc32(td.data(), td.size()) ^ 0xFFFFFFFFu);
  };
  static const uint8_t sig[8] = {0x89, 'P', 'N', 'G', 13, 10, 26, 10};
  std::fwrite(sig, 1, 8, f);
  std::vector<uint8_t> ihdr = {0, 0, uint8_t(kScreenW >> 8), uint8_t(kScreenW & 0xFF), 0, 0, uint8_t(kScreenH >> 8), uint8_t(kScreenH & 0xFF), 8, 0, 0, 0, 0};
  chunk("IHDR", ihdr);
  chunk("IDAT", z);
  chunk("IEND", {});
  std::fclose(f);
  return true;
}

struct RefreshEvent { bool full; Rect r; bool fast = false; };   // full = clean; fast = navigation (#197)

class FakeDisplay : public Display {
 public:
  std::vector<RefreshEvent> events;
  std::vector<uint8_t> last;   // copy of the framebuffer at the last refresh
  void fullRefresh(const Framebuffer& fb) override { events.push_back({true, {0, 0, kScreenW, kScreenH}}); snap(fb); }
  void fastRefresh(const Framebuffer& fb) override { events.push_back({false, {0, 0, kScreenW, kScreenH}, true}); snap(fb); }
  void partialRefresh(const Framebuffer& fb, Rect r) override { events.push_back({false, r}); snap(fb); }
  void sleep() override {}
  int fulls() const { int n = 0; for (auto& e : events) n += e.full; return n; }
  int fasts() const { int n = 0; for (auto& e : events) n += e.fast; return n; }
  int partials() const { int n = 0; for (auto& e : events) n += !e.full && !e.fast; return n; }
  void clear() { events.clear(); }
  bool save(const std::string& path) const {
    Framebuffer fb{const_cast<uint8_t*>(last.data())};
    if (last.empty()) return false;
    bool png = path.size() > 4 && path.substr(path.size() - 4) == ".png";
    return png ? writePng(fb, path) : writePgm(fb, path);
  }
 private:
  void snap(const Framebuffer& fb) { last.assign(fb.data, fb.data + Framebuffer::kBytes); }
};

class FakeBoard : public Board {
 public:
  uint32_t now = 1000;
  int64_t epoch = 0;          // set by tests (UTC; tests run with TZ=UTC)
  uint8_t battery = 76;
  uint8_t light = 0, warmth = 0;
  bool restarted = false;
  uint8_t held = 0;           // keys held (core/recovery.h bits)
  std::deque<InputEvent> queue;
  bool pollInput(InputEvent& out) override { if (queue.empty()) return false; out = queue.front(); queue.pop_front(); return true; }
  void setFrontlight(uint8_t b, uint8_t w) override { light = b; warmth = w; }
  PowerInfo power() override { return {battery, false, false}; }
  uint32_t millis() override { return now; }
  int64_t epochSeconds() override { return epoch ? epoch + (now - 1000) / 1000 : 0; }
  void restart() override { restarted = true; }
  int powerOffs = 0;
  void powerOff() override { ++powerOffs; }
  uint8_t heldKeys() override { return held; }
  void tap(int x, int y) { InputEvent e{}; e.kind = InputEvent::Kind::Tap; e.x = int16_t(x); e.y = int16_t(y); queue.push_back(e); }
  void key(Key k) { InputEvent e{}; e.kind = InputEvent::Kind::KeyDown; e.key = k; queue.push_back(e); }
  void swipe(int dir) { InputEvent e{}; e.kind = InputEvent::Kind::Swipe; e.dir = int8_t(dir); queue.push_back(e); }
};

struct Call { std::string domain, service, json; };

class FakeServices : public Services {
 public:
  NetStatus st;
  std::vector<Call> calls;
  std::vector<WifiNetwork> nets = {{"HomeNet", -48, true, false}, {"HomeNet-Guest", -58, true, false}, {"Phone hotspot", -66, true, false},
                                   {"Neighbour-2G", -74, true, false}, {"Open-Cafe", -82, false, false}};
  std::string lastSsid, lastPw;
  int scans = 0, otaChecks = 0, otaInstalls = 0, resets = 0, softAps = 0, disconnects = 0, forgets = 0, haReconnects = 0, haUnlinks = 0;
  const NetStatus& status() override { return st; }
  void wifiScan() override { ++scans; }
  std::vector<WifiNetwork> wifiNetworks() override { return nets; }
  void wifiConnect(const std::string& s, const std::string& p) override { lastSsid = s; lastPw = p; st.wifi = WifiState::Connecting; }
  void startSoftAp() override { ++softAps; }
  void wifiDisconnect() override { ++disconnects; st.wifi = WifiState::Offline; st.ip.clear(); }
  void wifiForget(const std::string&) override { ++forgets; }
  void haReconnect() override { ++haReconnects; }
  void haUnlink() override { ++haUnlinks; st.ha = HaState::NeverLinked; }
  void callService(const std::string& d, const std::string& s, const std::string& j) override { calls.push_back({d, s, j}); }
  void otaCheck() override { ++otaChecks; }
  void otaInstall() override { ++otaInstalls; }
  void factoryReset() override { ++resets; }
  void linked() {
    st.wifi = WifiState::Connected; st.ssid = "HomeNet"; st.ip = "192.168.1.42"; st.ha = HaState::Connected;
    st.haUrl = "homeassistant.local:8123"; st.pairingCode = "4F7K";
  }
};

}  // namespace fake
}  // namespace x4
