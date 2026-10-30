// Bin day tile (#317, emulator components/BinsTile.tsx, data core/bins). 2+ wide: title + TONIGHT / TODAY pill, a bin,
// the soonest bin big with its day line, the later bins along the foot. 1 wide: the soonest bin's name, when, the date
// or "Put out tonight". Classic: uppercase title, square pill, 2 px rule; Modern (on its card): capsule pill, display
// font, dotted rule.
#include "app/app_impl.h"
#include "core/bins.h"

namespace x4 {
namespace ui {

namespace {
// Text in the first size of `sizes` that fits maxW (then the ellipsis of the smallest).
Font fitFont(Canvas& c, const std::string& s, std::initializer_list<int> sizes, bool display, int maxW) {
  Font f = B(16);
  for (int z : sizes) {
    f = display ? D(z) : B(z);
    if (c.textWidth(s, f) <= maxW) break;
  }
  return f;
}

void binIcon(Canvas& c, int x, int y) {   // 40 × 48: handle, lid, hatched body
  c.frame(rc(x + 14, y, 12, 6), 2, Ink::Black);
  c.fill(rc(x, y + 5, 40, 5), Ink::Black);
  c.frame(rc(x + 4, y + 11, 32, 37), 3, Ink::Black);
  c.tone(rc(x + 9, y + 16, 22, 27), 0, Tone::Hatch);
}
}  // namespace

void binsTile(Canvas& c, I& a, const Widget& w, Rect r) {
  const bool sl = sleek();
  const std::string ents = w.field("entities");
  bins::View v = bins::view(bins::inputs(ents, w.field("labels"), a.store), a.now.epochMs, a.now.tz,
                            bins::tonightHour(w.field("tonight")), a.lang);
  const bool known = !v.rows.empty() && a.now.known;
  const std::string empty = ents.empty() ? a.t(S::binsPick) : a.t(S::binsNone);
  const std::string title = !w.field("label").empty() ? w.field("label") : a.t(S::binsTitle);
  const int x0 = r.x + (sl ? 16 : 14), x1 = r.x + r.w - (sl ? 16 : 14);
  if (w.cs < 2) {   // one bin: name / when / date
    const int top = r.y + (sl ? 14 : 12), subTop = r.y + r.h - 12 - 22;
    label(c, x0, top, known ? v.head : title, sl ? 16 : 20, Ink::Black, x1 - x0);
    std::string big = known ? v.big : "—";
    Font bf = fitFont(c, big, {28, 26, 24, 22}, sl, x1 - x0);
    TextOpts bo; bo.maxW = x1 - x0;
    const int vtop = (top + 24 + subTop - 28) / 2;
    c.text(x0, baseline(vtop, bf, 1.0), big, bf, bo);
    std::string sub = known ? v.foot : empty;
    Font sf = c.textWidth(sub, R(18)) <= x1 - x0 ? (v.tonight ? B(18) : R(18)) : (v.tonight ? B(16) : R(16));
    TextOpts so; so.maxW = x1 - x0;
    c.text(x0, baseline(subTop, sf, 1.2), sub, sf, so);
    return;
  }
  const int top = r.y + (sl ? 14 : 10), bottom = r.y + r.h - (sl ? 10 : 9);
  // header (30 px): title, pill right
  int pillW = 0;
  if (known && !v.pill.empty()) {
    TextOpts po = C(Ink::Paper); po.upper = true; po.tracking = 1;
    pillW = c.textWidth(v.pill, B(15), po) + 24;
    Rect p = rc(x1 - pillW, top + 1, pillW, 28);
    c.box(p, sl ? 14 : 4, Ink::Black, 2, Ink::Black);
    c.textCenter(p.x + p.w / 2, p.y + 19, v.pill, B(15), po);
  }
  label(c, x0, top + 3, title, sl ? 16 : 20, Ink::Black, x1 - x0 - (pillW ? pillW + 8 : 0));
  // foot: the later bins, whole items only
  int bodyBot = bottom;
  if (known && v.restFrom < v.rows.size()) {
    const int footTop = bottom - 5 - 18;
    rule(c, x0, footTop - 2, x1 - x0, false);
    const int bl = baseline(footTop + 3, R(16), 1.2);
    int x = x0;
    for (size_t k = v.restFrom; k < v.rows.size(); ++k) {
      const auto& row = v.rows[k];
      const int lw = c.textWidth(row.label, B(16)), dw = c.textWidth(row.shortDate, R(16));
      if (x + lw + 5 + dw > x1) break;
      c.text(x, bl, row.label, B(16));
      c.text(x + lw + 5, bl, row.shortDate, R(16));
      x += lw + 5 + dw + 16;
    }
    bodyBot = footTop - 2 - 4;
  }
  // body: bin + headline + day line
  const int bodyTop = top + 30 + 4, cy = (bodyTop + bodyBot) / 2;
  binIcon(c, x0, cy - 24);
  const int tx = x0 + 40 + 14, tw = x1 - tx;
  std::string head = known ? v.head : "—";
  Font hf = sl ? fitFont(c, head, {30, 26, 24}, true, tw) : fitFont(c, head, {36, 30, 26}, false, tw);   // D <= 30: letters in every face
  TextOpts ho; ho.maxW = tw;
  const int blockTop = cy - 31;
  c.text(tx, baseline(blockTop, hf, 1.0), head, hf, ho);
  std::string line = known ? v.line : empty;
  Font lf = c.textWidth(line, R(18)) <= tw ? R(18) : R(16);
  TextOpts lo; lo.maxW = tw;
  c.text(tx, baseline(blockTop + 40, lf, 1.2), line, lf, lo);
}

}  // namespace ui
}  // namespace x4
