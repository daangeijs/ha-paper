// Display impl over freeink EInkDisplay (SSD1677 / UC8179 / UC8279, auto-detected per batch).
//
// The UI renders a 2-bit framebuffer (0 black … 3 white). The panel is 1-bit + an optional gray overlay. Panel-wide
// refreshes (core/epd_sequence.h, eink-ha-os#197) draw the B/W base (white under gray pixels), then — clean/full only, if the
// frame has gray pixels and the controller advertises Overlay grayscale — a dark/light gray overlay pass, after which both controller RAM
// planes are restored to the B/W base (eink-ha-os#201):
//  * fastRefresh: navigation, whole-frame differential FAST (SSD1677 0x22=FC), no flash, B/W only (eink-ha-os#212: grays
//    thresholded as in a partial, no gray pass). After a gray frame the RED plane is seeded so the old grays are
//    redrawn (SSD1677); other controllers take a B/W clean instead.
//  * fullRefresh: the clean, HALF (0x1A=5A, 0x22=D7), one short flash.
//  * redrawLast: FULL (0x22=F7), the multi-flash waveform, POST /display/refresh only.
//  * partialRefresh: windowed fast update (x/w aligned to 8 px); gray pixels are thresholded
//    (dark gray → black, light gray → white) until the next panel-wide refresh.
#pragma once
#include <EInkDisplay.h>

#include "core/epd_sequence.h"
#include "hw/platform.h"

namespace x4 {

class X4Display : public Display {
 public:
  X4Display();
  bool begin();                    // XteinkDetect controller probe + panel init + plane buffers (PSRAM)
  void fullRefresh(const Framebuffer& fb) override { show(fb, EpdKind::Clean); }
  void fastRefresh(const Framebuffer& fb) override { show(fb, EpdKind::Fast); }
  void partialRefresh(const Framebuffer& fb, Rect r) override;
  void sleep() override;

  const uint8_t* lastFrame() const { return last_; }
  void redrawLast();               // one FULL (multi-flash) refresh of the last frame (POST /display/refresh)
  bool graySupported() const { return gray_; }

 private:
  void show(const Framebuffer& fb, EpdKind kind);
  // → epd framebuffer; returns true if any gray pixel. seed: in = gray mask of the frame on the glass, out = RED seed.
  bool toBw(const uint8_t* src, bool grayBase, uint8_t* seed = nullptr);
  void buildMasks(const uint8_t* src);

  EInkDisplay epd_;
  uint8_t* lsb_ = nullptr;
  uint8_t* msb_ = nullptr;
  uint8_t* seed_ = nullptr;        // spare plane: swapped with msb_ before a seeded fast refresh
  const uint8_t* last_ = nullptr;
  bool gray_ = false;
  bool grayShown_ = false;         // the last panel-wide refresh drew grays; msb_ holds their mask
  bool ready_ = false;
};

}  // namespace x4
