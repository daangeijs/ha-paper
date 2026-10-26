// Small 2-bit canvas. Two backends in one class: raster into a Framebuffer, and/or record every draw op as text
// (region signature) and collect touch targets. Same layout code drives both, so a region's signature is exactly
// what it would draw.
#pragma once
#include <functional>
#include <string>
#include <vector>
#include "app/gen/icons.h"
#include "app/gfx/font.h"
#include "app/gfx/style.h"
#include "hw/platform.h"

namespace x4 {

inline Rect rc(int x, int y, int w, int h) { return Rect{int16_t(x), int16_t(y), int16_t(w), int16_t(h)}; }
inline bool contains(Rect r, int x, int y) { return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }
inline bool intersects(Rect a, Rect b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

enum class Ink : uint8_t { Black = 0, G1 = 1, G2 = 2, Paper = 3 };

struct Font {
  uint8_t size = 16;
  FontWeight weight = FontWeight::Bold;
  Face face = Face::Classic;
};
inline Font B(int s) { return Font{uint8_t(s), FontWeight::Bold}; }
inline Font R(int s) { return Font{uint8_t(s), FontWeight::Regular}; }
inline Font M(int s) { return Font{uint8_t(s), FontWeight::Mono}; }
// Sleek fonts in the active typeface (gfx/style.h). D = display face 700 at token px × fk (rounded); DS = display face
// 600, not scaled (units beside a value); T7/T6/T4 = text face 700/600/400.
Font D(int tokenPx);
Font DS(int px);
Font T7(int px);
Font T6(int px);
Font T4(int px);
// The font a request actually renders with (Classic requests are remapped to the Sleek text face while the active look
// says so), nearest size within that face.
const FontData* resolveFont(Font f);

struct TextOpts {
  Ink color = Ink::Black;
  int tracking = 0;        // extra px between glyphs (CSS letter-spacing, may be negative)
  bool tabular = false;    // digits use the widest digit advance
  bool upper = false;      // ASCII uppercase transform
  int maxW = 0;            // > 0: ellipsis when wider
  bool strike = false;     // line-through
  bool dotted = false;     // dotted underline (pending setpoint)
};
inline TextOpts C(Ink c) { TextOpts o; o.color = c; return o; }

struct Hit { Rect r; std::function<void()> fn; std::string region; };

class Canvas {
 public:
  // A framebuffer whose allocation failed (no PSRAM and no 96 KB of internal heap) behaves like none: draws no-op.
  explicit Canvas(Framebuffer* fb = nullptr) : fb_(fb && fb->data ? fb : nullptr) {}
  void setRecord(std::string* rec) { rec_ = rec; }
  // cppcheck-suppress danglingLifetime ; a Canvas is a per-draw local, the hit list outlives it (App::Impl::signatures)
  void setHits(std::vector<Hit>* hits, const std::string& region) { hits_ = hits; region_ = region; }
  void setClip(Rect r) { clip_ = r; }
  void resetClip() { clip_ = Rect{0, 0, kScreenW, kScreenH}; }

  // primitives
  void fill(Rect r, Ink c);
  void frame(Rect r, int bw, Ink c, int radius = 0);                    // outline only
  void box(Rect r, int radius, Ink fillC, int bw = 0, Ink border = Ink::Black);
  void dashedFrame(Rect r, int bw, Ink c, int radius, int dash = 6, int gapLen = 5);
  void hline(int x, int y, int w, int th, Ink c) { fill(Rect{int16_t(x), int16_t(y), int16_t(w), int16_t(th)}, c); }
  void vline(int x, int y, int h, int th, Ink c) { fill(Rect{int16_t(x), int16_t(y), int16_t(th), int16_t(h)}, c); }
  void dottedHLine(int x, int y, int w, int th, Ink c);
  void dottedVLine(int x, int y, int h, int th, Ink c);
  void circle(int cx, int cy, int r, Ink fillC, int bw = 0, Ink border = Ink::Black);
  // palette entries without a native level (gfx/style.h Tone): rounded rect / circle / pill filled with the pattern
  void tone(Rect r, int radius, Tone t);
  // circular arc, stroke `stroke` px, round caps; angles in degrees, 0 = 3 o'clock, clockwise. sweep >= 360 = ring.
  void arc(int cx, int cy, double radius, double stroke, double fromDeg, double sweepDeg, Ink c);
  void arcTone(int cx, int cy, double radius, double stroke, double fromDeg, double sweepDeg, Tone t);
  void invert(Rect r);
  void icon(Icon i, int x, int y, Ink c = Ink::Black);
  void qr(int x, int y, int px, const std::string& text);   // px = target size; modules are integer-scaled

  // text (baseline positioning); returns advance width
  int text(int x, int baseline, const std::string& s, Font f, const TextOpts& o = TextOpts());
  int textWidth(const std::string& s, Font f, const TextOpts& o = TextOpts()) const;
  int textRight(int right, int baseline, const std::string& s, Font f, const TextOpts& o = TextOpts());
  int textCenter(int cx, int baseline, const std::string& s, Font f, const TextOpts& o = TextOpts());
  // top-aligned helper: baseline = top + capTop(f)
  static int ascent(Font f);    // px from line top to baseline (≈ font ascent)
  static int capHeight(Font f); // height of 'H'
  // wraps words into lines no wider than w; returns number of lines drawn
  int paragraph(int x, int top, int w, int lineH, const std::string& s, Font f, const TextOpts& o = TextOpts(), int maxLines = 0);

  void hit(Rect r, std::function<void()> fn);

  // Pixels drawn in G1/G2 (outside the Sleek card surface) since start: the B/W-only lint (issue #38, test_app).
  static uint32_t grayPuts;

 private:
  void rec(const char* fmt, ...);
  void put(int x, int y, Ink c, int alpha);   // alpha 0..3 over current pixel
  Ink get(int x, int y) const;
  bool inClip(int x, int y) const {
    return x >= clip_.x && y >= clip_.y && x < clip_.x + clip_.w && y < clip_.y + clip_.h && x >= 0 && y >= 0 && x < kScreenW && y < kScreenH;
  }
  void span(int y, int x0, int x1, Ink c);   // solid, clipped, byte-wise
  void rrectCoverage(Rect r, int radius, int inset, Ink c, bool ring, int bw);
  std::string fitText(const std::string& s, Font f, const TextOpts& o) const;
  void arcImpl(int cx, int cy, double radius, double stroke, double fromDeg, double sweepDeg, Ink c, int tone);
  void surfKnockout(int x, int baseline, int tw, const std::string& s, const FontData* d, const TextOpts& o);

  Framebuffer* fb_;
  std::string* rec_ = nullptr;
  std::vector<Hit>* hits_ = nullptr;
  std::string region_;
  Rect clip_{0, 0, kScreenW, kScreenH};
  bool surf_ = false;
  struct SurfArea { Rect r; int radius; };
  std::vector<SurfArea> surfs_;   // Tone::Surf fills on this canvas: small text knocks their texture out (issue #28)
};

// UTF-8 → code points
std::vector<uint32_t> utf8Decode(const std::string& s);
std::string utf8Upper(const std::string& s);

}  // namespace x4
