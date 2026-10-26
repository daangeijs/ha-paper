#include "app/gfx/style.h"
#include <cmath>
#include "app/gfx/canvas.h"

namespace x4 {

namespace {
Look gLook;
}

Face displayFace(Typeface t) {
  switch (t) {
    case Typeface::Archivo: return Face::ArchivoCond;
    case Typeface::Bricolage: return Face::Bricolage;
    case Typeface::Fraunces: return Face::Fraunces;
    case Typeface::Geist: return Face::Geist;
  }
  return Face::Classic;
}

Face textFace(Typeface t) {
  switch (t) {
    case Typeface::Archivo: return Face::Archivo;
    case Typeface::Bricolage: return Face::Bricolage;
    case Typeface::Fraunces: return Face::Geist;   // Fraunces display + Geist text (DISPLAY_STYLES.md §3)
    case Typeface::Geist: return Face::Geist;
  }
  return Face::Classic;
}

double sizeFactor(Typeface t) {
  switch (t) {
    case Typeface::Archivo: return 1.12;
    case Typeface::Bricolage: return 0.92;
    case Typeface::Fraunces: return 0.95;
    case Typeface::Geist: return 0.92;
  }
  return 1;
}

const Look& activeLook() { return gLook; }
void setActiveLook(const Look& l) { gLook = l; }

Look lookFromSettings(const std::string& style, const std::string& typeface, const std::string& surface) {
  Look l;
  l.sleek = style == "sleek";
  l.typeface = typeface == "bricolage" ? Typeface::Bricolage : typeface == "fraunces" ? Typeface::Fraunces
             : typeface == "geist" ? Typeface::Geist : Typeface::Archivo;
  l.surface = surface == "dots" ? Surface::Dots : Surface::Dither;
  return l;
}

static Font mk(Face f, FontWeight w, int px) { return Font{uint8_t(px), w, f}; }
Font D(int tokenPx) { return mk(displayFace(gLook.typeface), FontWeight::Bold, int(std::lround(tokenPx * sizeFactor(gLook.typeface)))); }
Font DS(int px) { return mk(displayFace(gLook.typeface), FontWeight::Semi, px); }
Font T7(int px) { return mk(textFace(gLook.typeface), FontWeight::Bold, px); }
Font T6(int px) { return mk(textFace(gLook.typeface), FontWeight::Semi, px); }
Font T4(int px) { return mk(textFace(gLook.typeface), FontWeight::Regular, px); }

const FontData* resolveFont(Font f) {
  Face face = f.face;
  if (face == Face::Classic && f.weight != FontWeight::Mono && gLook.sleek && gLook.remapClassicFonts) face = textFace(gLook.typeface);
  return findFont(face, f.weight, f.size);
}

}  // namespace x4
