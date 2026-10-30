#include "hw/x4_display.h"

#include <BoardConfig.h>
#include <XteinkDetect.h>
#include <esp_heap_caps.h>
#include <nvs.h>

#include <cstring>
#include <utility>

#include "Logging.h"
#include "core/panel_guard.h"
#include "hw/hw_diag.h"
#include "hw/watchdog.h"

#ifndef X4_EPD_WINDOWED
#define X4_EPD_WINDOWED 1   // 0 = partials use a whole-frame differential FAST refresh instead of a window
#endif

namespace x4 {

namespace {
constexpr int kBwRow = kScreenW / 8;     // 100 bytes
constexpr int kSrcRow = kScreenW / 4;    // 200 bytes

// 2-bit → per-pixel lookup for one source byte (4 px, MSB first): returns 4 output bits (MSB first).
// BW bit: 1 = white (SDK convention, clearScreen(0xFF) = white).
uint8_t bwNibble(uint8_t b, bool grayBase) {
  uint8_t out = 0;
  for (int i = 0; i < 4; i++) {
    const uint8_t v = (b >> (6 - 2 * i)) & 3;
    const bool white = grayBase ? (v != 0) : (v >= 2);   // grayBase: grays white under the overlay
    out = static_cast<uint8_t>((out << 1) | (white ? 1 : 0));
  }
  return out;
}

// Gate in front of the SDK's BUSY wait (eink-ha-os#181): bounded, feeds the task watchdog, skips the bus once the panel failed.
// UC8179/UC8279 (idle-high): one tick first, as the SDK does, for the command to raise BUSY_N. Returns true when the
// SDK's own wait may run (it then finds BUSY released and returns at once).
bool gateBusy(freeink::EpdBus* bus, freeink::BusyPolarity p, const char* tag) {
  if (panelGuard().failed()) return false;
  if (p == freeink::BusyPolarity::UcIdleHigh) delay(1);
  const bool ok = panelGuard().wait([bus] { return bus->isBusy(); }, [] { return static_cast<uint32_t>(millis()); },
                                    [] {
                                      delay(1);
                                      wdt::feedIfSubscribed();
                                    },
                                    tag ? tag : "busy");
  if (panelGuard().takeFailureLog())
    LOG_ERR("EPD", "!!! panel BUSY never released · %s · panel marked failed, no more panel I/O until restart",
            panelGuard().failureText().c_str());
  return ok;
}
const char* controllerName() {
  using C = BoardConfig::DisplayController;
  switch (BoardConfig::ACTIVE.displayController) {
    case C::SSD1677: return "SSD1677";
    case C::UC8179: return "UC8179";
    case C::UC8279: return "UC8279";
    case C::UC8253: return "UC8253";
    default: return "other";
  }
}
}  // namespace

void panelDiag(diag::Panel& out) {
  out.failure = panelGuard().failureText();
  const auto& d = freeink::getXteinkDisplayProbeDiag();
  out.controller = controllerName();
  out.source = d.valid ? "probe" : "default";
  out.probed = d.valid;
  out.verdict = d.verdict;
  out.promoted = d.promoted;
  memcpy(out.ver, d.ver, sizeof out.ver);
  out.verBytes = d.verBytesRead;
  out.flg = d.flg;
  // OEM panel id, read only (never written, never decides: XteinkDetect.h). Missing namespace/key → null.
  nvs_handle_t h;
  uint8_t st = 0;
  if (nvs_open("hw_calib", NVS_READONLY, &h) == ESP_OK) {
    if (nvs_get_u8(h, "screenType", &st) == ESP_OK) out.nvsScreenType = st;
    nvs_close(h);
  }
}

X4Display::X4Display() : epd_(12, 11, 13, 18, 14, 6) {}   // legacy pin args; begin() uses BoardConfig

bool X4Display::begin() {
  const bool promoted = freeink::applyXteinkDisplayController();
  const auto& diag = freeink::getXteinkDisplayProbeDiag();
  // The live VER/FLG probe on the display bus decides; NVS hw_calib/screenType is only logged by the SDK.
  if (diag.valid) {
    LOG_INF("EPD", "controller %s · VER probe: %02X %02X %02X %02X %02X FLG %02X · %s", controllerName(), diag.ver[0],
            diag.ver[1], diag.ver[2], diag.ver[3], diag.ver[4], diag.flg,
            promoted ? "UltraChip, promoted from SSD1677" : "no UltraChip answer, SSD1677 kept");
  } else {
    LOG_INF("EPD", "controller %s · profile default (no probe in this build)", controllerName());
  }
  epd_.begin();
  if (panelGuard().failed()) return false;   // gateBusy logged it; main.cpp logs "display init FAILED"
  if (!epd_.framebufferReady()) {
    LOG_ERR("EPD", "framebuffer allocation failed");
    return false;
  }
  const size_t plane = static_cast<size_t>(kBwRow) * kScreenH;
  // Gray overlay planes + the RED seed plane (3 × 48 KB) live in PSRAM. Without them we run B/W only: buildMasks() is
  // never reached because every gray path checks gray_. The seed goes to the panel the same way as the gray planes.
  lsb_ = static_cast<uint8_t*>(heap_caps_malloc(plane, MALLOC_CAP_SPIRAM));
  msb_ = static_cast<uint8_t*>(heap_caps_malloc(plane, MALLOC_CAP_SPIRAM));
  seed_ = static_cast<uint8_t*>(heap_caps_malloc(plane, MALLOC_CAP_SPIRAM));
  if (!lsb_ || !msb_ || !seed_) {
    LOG_ERR("EPD", "PSRAM gray planes unavailable (%u B free PSRAM) · falling back to B/W",
            static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
    heap_caps_free(lsb_);
    heap_caps_free(msb_);
    heap_caps_free(seed_);
    lsb_ = msb_ = seed_ = nullptr;
  }
  gray_ = lsb_ && msb_ && seed_ && epd_.grayscaleCapabilities(freeink::GrayscaleMode::Overlay).supported();
  LOG_INF("EPD", "%ux%u · 4-gray overlay %s", epd_.getDisplayWidth(), epd_.getDisplayHeight(),
          gray_ ? "supported" : "not supported (B/W)");
  ready_ = true;
  return true;
}

bool X4Display::toBw(const uint8_t* src, bool grayBase, uint8_t* seed) {
  uint8_t* dst = epd_.getFrameBuffer();   // holds the base on the glass until overwritten
  bool anyGray = false;
  const size_t n = static_cast<size_t>(kSrcRow) * kScreenH;
  for (size_t i = 0, o = 0; i < n; i += 2, o++) {
    const uint8_t a = src[i], b = src[i + 1];
    const uint8_t v = static_cast<uint8_t>((bwNibble(a, grayBase) << 4) | bwNibble(b, grayBase));
    if (seed) seed[o] = redSeedByte(dst[o], v, seed[o]);
    dst[o] = v;
    if (!anyGray) {
      // any 01 or 10 pair → gray
      for (int k = 0; k < 4 && !anyGray; k++) {
        uint8_t va = (a >> (2 * k)) & 3, vb = (b >> (2 * k)) & 3;
        anyGray = va == 1 || va == 2 || vb == 1 || vb == 2;
      }
    }
  }
  return anyGray;
}

// Overlay masks in (LSB, MSB): dark gray (1) = (1,1), light gray (2) = (0,1), black/white = (0,0).
void X4Display::buildMasks(const uint8_t* src) {
  const size_t n = static_cast<size_t>(kSrcRow) * kScreenH;
  for (size_t i = 0, o = 0; i < n; i += 2, o++) {
    uint8_t l = 0, m = 0;
    for (int half = 0; half < 2; half++) {
      const uint8_t b = src[i + half];
      for (int k = 0; k < 4; k++) {
        const uint8_t v = (b >> (6 - 2 * k)) & 3;
        l = static_cast<uint8_t>((l << 1) | (v == 1 ? 1 : 0));
        m = static_cast<uint8_t>((m << 1) | ((v == 1 || v == 2) ? 1 : 0));
      }
    }
    lsb_[o] = l;
    msb_[o] = m;
  }
}

void X4Display::show(const Framebuffer& fb, EpdKind kind) {
  if (!ready_ || !fb.data) return;
  last_ = fb.data;   // kept for preview.png even when the panel failed
  if (panelGuard().failed()) return;
  const bool ssd1677 = BoardConfig::ACTIVE.displayController == BoardConfig::DisplayController::SSD1677;
  // Grays on the glass: a fast refresh would not touch them (core/epd_sequence.h). SSD1677 seeds RED from their mask;
  // the UltraChip controllers take a clean, B/W like the fast it stands in for (eink-ha-os#212).
  const bool bwOnly = kind == EpdKind::Fast;
  const bool seed = bwOnly && grayShown_ && ssd1677;
  if (bwOnly && grayShown_ && !ssd1677) kind = EpdKind::Clean;
  if (seed) std::swap(msb_, seed_);   // seed_ = mask of the grays on the glass, turned into the RED seed by toBw
  const uint32_t t0 = millis();
  // Fast is B/W only (eink-ha-os#212): thresholded like a partial, no gray pass; a Clean / Full draws grays white + the overlay
  const bool grayBase = gray_ && !bwOnly;
  const bool anyGray = toBw(fb.data, grayBase, seed ? seed_ : nullptr);
  const bool withGray = grayBase && grayPassFor(kind, anyGray);
  if (withGray) buildMasks(fb.data);
  const uint32_t t1 = millis();
  // After the gray pass both RAM planes hold the B/W base again, so the next partial only drives its own pixels (eink-ha-os#201)
  epdSequence(epd_, kind, epd_.getFrameBuffer(), lsb_, msb_, withGray, ssd1677, seed ? seed_ : nullptr);
  grayShown_ = withGray;
  static const char* const kName[] = {"fast", "clean", "full"};
  LOG_INF("EPD", "%s refresh %u ms · bw %u ms%s%s%s", kName[static_cast<int>(kind)],
          static_cast<unsigned>(millis() - t1), static_cast<unsigned>(t1 - t0), withGray ? " · gray pass" : "",
          bwOnly && anyGray ? " · grays thresholded" : "", seed ? " · red seeded" : "");
}

void X4Display::partialRefresh(const Framebuffer& fb, Rect r) {
  if (!ready_ || !fb.data) return;
  last_ = fb.data;
  if (panelGuard().failed()) return;
  int x0 = r.x < 0 ? 0 : r.x, y0 = r.y < 0 ? 0 : r.y;
  int x1 = r.x + r.w > kScreenW ? kScreenW : r.x + r.w, y1 = r.y + r.h > kScreenH ? kScreenH : r.y + r.h;
  if (x1 <= x0 || y1 <= y0) return;
  toBw(fb.data, false);
#if X4_EPD_WINDOWED
  x0 &= ~7;
  x1 = (x1 + 7) & ~7;
  if (x1 > kScreenW) x1 = kScreenW;
  if ((x1 - x0) * (y1 - y0) * 2 < kScreenW * kScreenH) {
    epd_.displayWindow(static_cast<uint16_t>(x0), static_cast<uint16_t>(y0), static_cast<uint16_t>(x1 - x0),
                       static_cast<uint16_t>(y1 - y0));
    return;
  }
#endif
  epd_.displayBuffer(EInkDisplay::FAST_REFRESH);   // large area: whole-frame differential, no flash
}

void X4Display::redrawLast() {
  if (!last_) return;
  Framebuffer fb{const_cast<uint8_t*>(last_)};
  show(fb, EpdKind::Full);
}

void X4Display::sleep() {
  if (!ready_ || panelGuard().failed()) return;
  epd_.deepSleep();   // controller RAM is discarded; the driver forces a clean first paint after wake
}

}  // namespace x4

// Linker wraps (platformio.ini -Wl,--wrap): every call from the SDK drivers into these EpdBus waits lands here first.
// Calls inside EpdBus.cpp are not wrapped, so waitBusy(tag) → waitBusy(p, tag) passes the gate once.
using freeink::BusyPolarity;
using freeink::EpdBus;
extern "C" {
void __real__ZN7freeink6EpdBus8waitBusyEPKc(EpdBus* bus, const char* tag);
void __real__ZN7freeink6EpdBus8waitBusyENS_12BusyPolarityEPKc(EpdBus* bus, BusyPolarity p, const char* tag);
void __real__ZN7freeink6EpdBus19waitRefreshCompleteEPKc(EpdBus* bus, const char* tag);

void __wrap__ZN7freeink6EpdBus8waitBusyEPKc(EpdBus* bus, const char* tag) {
  if (x4::gateBusy(bus, bus->busyPolarity(), tag)) __real__ZN7freeink6EpdBus8waitBusyEPKc(bus, tag);
}
void __wrap__ZN7freeink6EpdBus8waitBusyENS_12BusyPolarityEPKc(EpdBus* bus, BusyPolarity p, const char* tag) {
  if (x4::gateBusy(bus, p, tag)) __real__ZN7freeink6EpdBus8waitBusyENS_12BusyPolarityEPKc(bus, p, tag);
}
// SSD1677's completion edge can trail the gate by microseconds, so the SDK's ISR wait (≤ 30 s) may still block: it runs
// outside the task watchdog.
void __wrap__ZN7freeink6EpdBus19waitRefreshCompleteEPKc(EpdBus* bus, const char* tag) {
  if (!x4::gateBusy(bus, bus->busyPolarity(), tag)) return;
  x4::wdt::BlockingCall b("EPD refresh");
  __real__ZN7freeink6EpdBus19waitRefreshCompleteEPKc(bus, tag);
}
}
