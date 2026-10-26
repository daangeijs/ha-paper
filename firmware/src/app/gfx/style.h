// Display style (Classic | Sleek), typeface and card surface: the "look" every painter reads while drawing.
// docs/DISPLAY_STYLES_PLAN.md; values from the original display-styles.tokens.json.
//
// The look is a render-time skin, set by the app before it draws (App::Impl::applyLook). It is global because the
// device has one screen and drawing is synchronous; every App entry point that draws sets it first, so two Apps in
// one process (native tests) do not leak into each other.
#pragma once
#include <cstdint>
#include <string>
#include "app/gfx/font.h"

namespace x4 {

enum class Typeface : uint8_t { Archivo, Bricolage, Fraunces, Geist };
// Card surface (SURF #DEDCD5 has no native panel level; EINK_NOTES.md §1). Owner decision 2026-10-14: build both,
// choose on the real panel. Dither = 25 % level-2 ordered dither (option B; turns white after a B/W partial refresh).
// Dots = 1-in-16 black dots on paper (option D; pure black/white, survives partial refresh).
enum class Surface : uint8_t { Dither, Dots };

// Palette entries without a native panel level. The mapping is one table in canvas.cpp (toneInk()).
//   Surf  = card surface, per Surface above.
//   Track = G2 elements on a card that carry information (ring/dial tracks, future spark and chart bars, "normal"
//           price cells): 25 % black dots on paper (luma ≈ 181 vs G2 168). Pure black/white, so a B/W partial refresh
//           keeps them (solid G2 would turn white; owner decision 6: Sleek stays readable in B/W).
//   Hatch = G1 elements that carry information (past spark/chart bars, cheapest-3 h price bars, high price cells, the
//           light chip's brightness track): 2 px black / 2 px paper diagonal stripes. Issue #38: everything a partial
//           refresh can redraw is black/white; emulator core/panel.ts HATCH draws the same pixels.
enum class Tone : uint8_t { Surf, Track, Hatch };

struct Look {
  bool sleek = false;
  Typeface typeface = Typeface::Archivo;
  Surface surface = Surface::Dither;
  bool remapClassicFonts = true;   // Sleek: Classic B()/R() text (screens with the Classic layout) uses the text face
};

Face displayFace(Typeface t);    // numbers, titles, room names (--fd)
Face textFace(Typeface t);       // everything else (--ft)
double sizeFactor(Typeface t);   // --fk: display sizes are token px × fk, rounded

const Look& activeLook();
void setActiveLook(const Look& l);

// settings strings ↔ enums (DisplaySettings.style / typeface / surface)
Look lookFromSettings(const std::string& style, const std::string& typeface, const std::string& surface);

}  // namespace x4
