// Panel-wide refresh sequences over an EInkDisplay-like panel (hw/x4_display.cpp), pure so the host test can run them
// against a model of the SSD1677's two RAM planes and the glass (test/test_epd_sequence).
//
// Kinds (eink-ha-os#197, vendored Ssd1677Driver defaults, the stock X4 sequences):
//  * Fast  = FAST_REFRESH: 0x22=FC, RED (0x26) is the old frame, only pixels where BW (0x24) != RED are driven. No flash.
//    B/W only since eink-ha-os#212: no gray pass (~500 ms on the X4 Pro); the caller thresholds the frame like a partial (dark gray
//    black, light gray white) and the next Clean brings the grays back.
//  * Clean = HALF_REFRESH: 0x1A=5A, 0x22=D7, BYPASS_RED, every pixel driven to BW. One short flash.
//  * Full  = FULL_REFRESH: 0x22=F7, the multi-flash OTP waveform. Manual POST /display/refresh only.
// Every kind ends with both planes = the B/W base (the driver's single-buffer resync).
//
// Gray overlay (Clean / Full only): after the base, the gray LSB plane goes to 0x24 and MSB to 0x26 and the gray LUT darkens the pixels that
// are white in the base. The SDK's cleanupGrayscaleBuffers restores only 0x26; resyncBw rewrites 0x24 with the base, or
// the next windowed partial drives every pixel outside its window to the LSB plane (eink-ha-os#201). So after any sequence both
// planes hold the base: what is on the glass, grays counted as white.
//
// That rule hides the grays from the next Fast: a pixel that is gray on the glass is white in RED. If it is white (or
// gray) in the next frame too, BW == RED, Fast leaves it alone, and the gray stays, or the overlay darkens it twice.
// redSeed: before a Fast that follows a gray frame (a Clean), 0x26 gets NOT(new base) at the pixels gray on the glass, so each of
// them takes one full B/W transition to its new base value; the other pixels keep the old frame (redSeedByte).
// UC8179/UC8279 cleanups restore both planes themselves, so the hw layer sets resyncBw and redSeed for SSD1677 only.
#pragma once
#include <cstdint>

namespace x4 {

enum class EpdKind { Fast, Clean, Full };

// A Fast never runs the gray pass (eink-ha-os#212): the frame goes out thresholded and the glass is pure B/W afterwards.
inline bool grayPassFor(EpdKind kind, bool anyGray) { return anyGray && kind != EpdKind::Fast; }

// RED byte before a Fast: the old base where the glass shows B/W, NOT(new base) where it shows gray (grayMask bit 1).
inline uint8_t redSeedByte(uint8_t oldBase, uint8_t newBase, uint8_t grayMask) {
  return static_cast<uint8_t>((oldBase & ~grayMask) | (~newBase & grayMask));
}

template <class Epd>
void epdSequence(Epd& e, EpdKind kind, const uint8_t* bw, const uint8_t* lsb, const uint8_t* msb, bool grayPass,
                 bool resyncBw, const uint8_t* redSeed = nullptr) {
  if (kind == EpdKind::Fast) {
    if (redSeed) e.copyGrayscaleMsbBuffers(redSeed);   // 0x26 = seed (plain RAM write, no refresh)
    e.displayBuffer(Epd::FAST_REFRESH);
  } else {
    e.displayBuffer(kind == EpdKind::Clean ? Epd::HALF_REFRESH : Epd::FULL_REFRESH);
  }
  // base (grays white) now in 0x24 and 0x26
  if (!grayPassFor(kind, grayPass)) return;
  e.copyGrayscaleBuffers(lsb, msb);     // 0x24 = LSB, 0x26 = MSB
  e.displayGrayBuffer();
  e.cleanupGrayscaleBuffers(bw);        // 0x26 = base
  if (resyncBw) e.copyGrayscaleLsbBuffers(bw);   // 0x24 = base (plain RAM write, no refresh)
}

}  // namespace x4
