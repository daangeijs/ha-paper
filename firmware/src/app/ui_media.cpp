// Now playing tile (#319, emulator Device.tsx MediaTile): header (name, volume, state pill or ★ on a 1-wide tile), title
// + artist, inline favorites on a 2-high tile, transport + volume buttons; ★ swaps the body for the favorites picker.
// Only title, artist, state and volume are drawn, so the region signature (and the panel) changes only with those.
// A player with VOLUME_SET (#351) gets a volume slider instead of − / +: its own region, so a new level is a partial of
// the bar alone.
#include <cmath>
#include "app/app_impl.h"

namespace x4 {
namespace ui {

namespace {
constexpr int kBtn = 48, kCellGap = 6;
enum class Glyph : uint8_t { Prev, Next, Play, Pause, Minus, Plus, Star };
struct Pt { float x, y; };

// even-odd scanline fill at pixel centres; points in a 24 × 24 box around (ox, oy)
void poly(Canvas& c, int ox, int oy, const Pt* p, int n, Ink ink) {
  for (int y = 0; y < 24; ++y) {
    float yc = y + 0.5f, xs[12];
    int k = 0;
    for (int i = 0; i < n && k < 12; ++i) {
      Pt a = p[i], b = p[(i + 1) % n];
      if ((a.y <= yc) == (b.y <= yc)) continue;
      xs[k++] = a.x + (yc - a.y) * (b.x - a.x) / (b.y - a.y);
    }
    for (int i = 1; i < k; ++i) for (int j = i; j > 0 && xs[j - 1] > xs[j]; --j) std::swap(xs[j - 1], xs[j]);
    for (int i = 0; i + 1 < k; i += 2) {
      int x0 = int(std::ceil(xs[i] - 0.5f)), x1 = int(std::floor(xs[i + 1] - 0.5f));
      if (x1 >= x0) c.hline(ox + x0, oy + y, x1 - x0 + 1, 1, ink);
    }
  }
}

// the emulator's 24-unit SVG paths, drawn 1:1 centred on (cx, cy)
void glyph(Canvas& c, Glyph g, int cx, int cy, Ink ink) {
  const int ox = cx - 12, oy = cy - 12;
  auto bar = [&](int x, int y, int w, int h) { c.fill(rc(ox + x, oy + y, w, h), ink); };
  static const Pt kPrev[] = {{20, 5}, {20, 19}, {10, 12}}, kNext[] = {{4, 5}, {14, 12}, {4, 19}}, kPlay[] = {{7, 4}, {20, 12}, {7, 20}};
  static const Pt kStar[] = {{12, 2}, {14.9f, 8.6f}, {22, 9.2f}, {16.6f, 13.9f}, {18.2f, 20.9f}, {12, 17.3f}, {5.8f, 21}, {7.4f, 14}, {2, 9.2f}, {9.1f, 8.6f}};
  switch (g) {
    case Glyph::Prev: bar(6, 5, 3, 14); poly(c, ox, oy, kPrev, 3, ink); break;
    case Glyph::Next: poly(c, ox, oy, kNext, 3, ink); bar(15, 5, 3, 14); break;
    case Glyph::Play: poly(c, ox, oy, kPlay, 3, ink); break;
    case Glyph::Pause: bar(6, 5, 4, 14); bar(14, 5, 4, 14); break;
    case Glyph::Minus: bar(5, 11, 14, 3); break;
    case Glyph::Plus: bar(5, 11, 14, 3); bar(11, 5, 3, 14); break;
    case Glyph::Star: poly(c, ox, oy, kStar, 10, ink); break;
  }
}

int midBl(int top, int h, Font f) { int ch = Canvas::capHeight(f); return top + (h - ch) / 2 + ch; }

void glyphBtn(Canvas& c, Rect b, Glyph g, bool dark, std::function<void()> fn) {
  btnBox(c, b, dark, 8);
  glyph(c, g, b.x + b.w / 2, b.y + b.h / 2, dark ? Ink::Paper : Ink::Black);
  c.hit(b, std::move(fn));
}

void cell(Canvas& c, Rect b, const std::string& s, bool center, std::function<void()> fn) {
  btnBox(c, b, false, 8);
  TextOpts o; o.maxW = b.w - 20;
  if (center) c.textCenter(b.x + b.w / 2, midBl(b.y, b.h, B(22)), s, B(22), o);
  else c.text(b.x + 10, midBl(b.y, b.h, B(18)), s, B(18), o);
  c.hit(b, std::move(fn));
}

S phaseWord(media::Phase p) {
  switch (p) {
    case media::Phase::Playing: return S::mediaPlaying;
    case media::Phase::Paused: return S::mediaPaused;
    case media::Phase::Buffering: return S::mediaLoading;
    case media::Phase::Off: return S::off;
    default: return S::idle;
  }
}
}  // namespace

void mediaTile(Canvas& c, I& a, const Widget& w, int i, Rect r) {
  using namespace media;
  const std::string id = w.field("entity");
  const EntityValue* raw = a.store.get(id);
  const View v = view(raw);
  const std::vector<Favorite> favs = favoritesOf(w);
  const int cs = std::max(1, int(w.cs)), rs = std::max(1, int(w.rs));
  const Layout L = layout(cs, rs, int(favs.size()));
  const std::string key = a.mediaKey(i);
  const int x0 = r.x + 14, x1 = r.x + r.w - 14, W = x1 - x0;
  const bool narrow = cs < 2;
  auto fav = [&a, &w](int k) { Action act = action(w, Target::Fav, k); return [&a, act] { a.mediaRun(act, true); }; };

  if (a.mediaPick == key && !favs.empty()) {   // picker: favorites row-major, × last
    const int top = r.y + 8, H = r.h - 16;
    const int ch = (H - (L.pickRows - 1) * kCellGap) / L.pickRows, cw = (W - (L.pickCols - 1) * kCellGap) / L.pickCols;
    for (int k = 0; k <= L.pickShown; ++k) {
      Rect b = rc(x0 + (k % L.pickCols) * (cw + kCellGap), top + (k / L.pickCols) * (ch + kCellGap), cw, ch);
      if (k < L.pickShown) cell(c, b, favs[k].label, false, fav(k));
      else cell(c, b, "×", true, [&a] { a.mediaPicker(""); });
    }
    return;
  }

  // header: name · volume · state pill (a 1-wide tile with favorites: ★ instead of the pill)
  const int top = r.y + 12;
  int right = x1;
  if (narrow && L.star) {
    Rect s = rc(x1 - 32, r.y + 8, 32, 32);
    glyphBtn(c, s, Glyph::Star, false, [&a, key] { a.mediaPicker(key); });
    right = s.x - 8;
  } else if (v.gap == EntityGap::None) {
    const bool on = v.phase == Phase::Playing || v.phase == Phase::Buffering;
    TextOpts o = C(on ? Ink::Paper : Ink::Black); o.upper = true;
    const std::string word = a.t(phaseWord(v.phase));
    const int pw = c.textWidth(word, B(14), o) + 16;
    Rect p = rc(right - pw, top, pw, 24);
    c.box(p, 7, on ? Ink::Black : Ink::Paper, 2, Ink::Black);
    c.textCenter(p.x + pw / 2, midBl(p.y, p.h, B(14)), word, B(14), o);
    right = p.x - 8;
  }
  const bool slider = L.volume && v.slider;   // #351: the bar is region v<i> (mediaVolume), the % on it
  if (L.volume && !slider) {
    TextOpts o; o.tabular = true;
    right -= c.textRight(right, baseline(top, R(18), 1.33), v.vol < 0 ? std::string("—") : std::to_string(v.vol) + "%", R(18), o) + 8;
  }
  label(c, x0, top, w.field("label").empty() ? friendlyName(id, raw) : w.field("label"), 20, Ink::Black, right - x0);

  // title + artist, or the gap ring
  int y = top + 24 + 8;
  if (v.gap != EntityGap::None) {
    gapRing(c, x0, y + 32);
    TextOpts go; go.maxW = W - 36;
    c.text(x0 + 36, y + 18 + Canvas::capHeight(R(16)) / 2, gapText(a, v.gap), R(16), go);
    y += 34;
  } else {
    const int ts = rs > 1 ? 34 : 28;
    TextOpts o; o.maxW = W;
    c.text(x0, baseline(y, B(ts), 1.15), v.title.empty() ? std::string(a.t(S::mediaNothing)) : v.title, B(ts), o);
    y += int(ts * 1.15);
    c.text(x0, baseline(y, R(18), 22.0 / 18), v.artist, R(18), o);
    y += 22;
  }

  // transport, volume, ★
  const int by = r.y + r.h - 12 - kBtn, g = narrow ? 6 : 8;
  const bool playing = v.phase == Phase::Playing || v.phase == Phase::Buffering;
  auto run = [&a, &w](Target t) { Action act = action(w, t); return [&a, act] { a.mediaRun(act, false); }; };
  int bx = x0;
  glyphBtn(c, rc(bx, by, kBtn, kBtn), Glyph::Prev, false, run(Target::Prev)); bx += kBtn + g;
  glyphBtn(c, rc(bx, by, kBtn, kBtn), playing ? Glyph::Pause : Glyph::Play, true, run(Target::Play)); bx += kBtn + g;
  glyphBtn(c, rc(bx, by, kBtn, kBtn), Glyph::Next, false, run(Target::Next)); bx += kBtn + g;
  if (L.volume && !slider) {
    bx += 8 + g;
    glyphBtn(c, rc(bx, by, kBtn, kBtn), Glyph::Minus, false, run(Target::Down)); bx += kBtn + g;
    glyphBtn(c, rc(bx, by, kBtn, kBtn), Glyph::Plus, false, run(Target::Up));
  }
  if (!narrow && L.star) glyphBtn(c, rc(x1 - kBtn, by, kBtn, kBtn), Glyph::Star, false, [&a, key] { a.mediaPicker(key); });

  // inline favorites (2 high): up to 4 rows between the artist and the buttons
  if (L.inlineShown) {
    const int lt = y + 12, lb = by - 10;
    const int ch = std::min(44, (lb - lt - 3 * kCellGap) / 4), cw = (W - (L.inlineCols - 1) * kCellGap) / L.inlineCols;
    for (int k = 0; k < L.inlineShown; ++k)
      cell(c, rc(x0 + (k % L.inlineCols) * (cw + kCellGap), lt + (k / L.inlineCols) * (ch + kCellGap), cw, ch), favs[k].label, false, fav(k));
  }
}

Rect mediaVolumeRect(I& a, const Widget& w, int i, Rect r) {
  using namespace media;
  const int cs = std::max(1, int(w.cs)), rs = std::max(1, int(w.rs));
  const int nFav = int(favoritesOf(w).size());
  const Layout L = layout(cs, rs, nFav);
  if (!L.volume || !view(a.store.get(w.field("entity"))).slider || (a.mediaPick == a.mediaKey(i) && nFav > 0)) return rc(0, 0, 0, 0);
  const int g = 8, x0 = r.x + 14, x1 = r.x + r.w - 14;
  const int bx = x0 + 3 * (kBtn + g) + 8 + g, right = L.star ? x1 - kBtn - g : x1;   // where − / + start; up to ★
  return rc(bx, r.y + r.h - 12 - kBtn, std::max(0, right - bx), kBtn);
}

// The bar: paper track (Classic outlined, Modern pill) filled black to the level (Modern: at least a circle); the % at the free end (black on
// paper below 55 %, paper on black from 55 %). Its own region over the tile: the card surface first.
void mediaVolume(Canvas& c, I& a, const Widget& w, Rect tile, Rect bar) {
  const std::string id = w.field("entity");
  auto ov = a.mediaVolOv.find(id);
  const int pct = ov != a.mediaVolOv.end() ? ov->second.pct : media::view(a.store.get(id)).vol;
  tileFrame(c, tile);   // clipped to the bar
  btnBox(c, bar, false, 8);
  if (pct > 0) {
    int fw = (bar.w * pct + 50) / 100;
    if (sleek()) fw = std::max(fw, int(bar.h));   // Modern: a pill, at least a full circle
    c.box(rc(bar.x, bar.y, fw, bar.h), std::min(sleek() ? bar.h / 2 : 8, fw / 2), Ink::Black);
  }
  const std::string t = pct < 0 ? std::string("—") : std::to_string(pct) + "%";
  const int bl = midBl(bar.y, bar.h, B(18));
  TextOpts o = C(pct >= 55 ? Ink::Paper : Ink::Black); o.tabular = true;
  if (pct >= 55) c.text(bar.x + 12, bl, t, B(18), o);
  else c.textRight(bar.x + bar.w - 12, bl, t, B(18), o);
  c.slider(bar, [&a, &w, bar] { a.mediaVolume(w, media::volumeAt(a.touchX, bar.x, bar.w)); });
}

}  // namespace ui
}  // namespace x4
