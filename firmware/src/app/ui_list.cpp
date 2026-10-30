// List from attributes tile (eink-ha-os#332, emulator components/ListTile.tsx, rows from core/attr_list). Header: the label.
// Below 3 columns two lines per row (title bold + ago right, the subtitle under it, 50 px pitch); from 3 columns one
// line per row (title column 40 %, subtitle, ago right, 28 px pitch). Dotted rules between rows. Foot: the entity's
// attribution left, "+N more" right. Classic: uppercase label; Modern (on its card): sentence case. Titles use
// FULL-charset sizes (<= 30 px) so é ë ü draw.
#include "app/app_impl.h"
#include "core/attr_list.h"
#include "core/home.h"

namespace x4 {
namespace ui {

namespace {
const int kPitch2 = 50, kPitch1 = 28;

struct ListData { alist::View v; std::string label, empty, attribution; alist::Rows L; };

ListData listData(I& a, const Widget& w) {
  ListData d;
  const std::string id = w.field("entity");
  const EntityValue* e = a.store.get(id);
  const alist::Spec s = alist::specOf(w);
  d.L = alist::rowsFor(w.cs, w.rs);
  d.label = !w.field("label").empty() ? w.field("label") : friendlyName(id, e);
  const bool gap = !e || e->state == "unavailable" || e->state == "unknown";
  if (!gap) {
    auto it = e->attrs.find(s.attribute.c_str());
    if (a.now.known) d.v = alist::view(it == e->attrs.end() ? nullptr : it->second.c_str(), s, a.now.epochMs, a.now.tz, a.lang, d.L.rows);
    auto at = e->attrs.find("attribution");
    if (at != e->attrs.end()) d.attribution = at->second.c_str();
  }
  if (d.v.rows.empty()) d.empty = gap || !a.now.known ? a.t(S::noDataYet) : !w.field("empty").empty() ? w.field("empty") : a.t(S::listEmpty);
  return d;
}
}  // namespace

void listTile(Canvas& c, I& a, const Widget& w, Rect r) {
  const bool sl = sleek();
  const int x0 = r.x + (sl ? 18 : 14), x1 = r.x + r.w - (sl ? 18 : 14), top = r.y + (sl ? 14 : 10), bot = r.y + r.h - (sl ? 10 : 8);
  const ListData d = listData(a, w);
  Font lf = sl ? T6(16) : B(20);
  TextOpts lo; lo.upper = !sl; lo.maxW = x1 - x0;
  c.text(x0, baseline(top, lf, 24.0 / (sl ? 16 : 20)), d.label, lf, lo);
  int y = top + 24 + 6;
  Font tf = sl ? T7(18) : B(19), sf = sl ? T4(15) : R(16), ff = sl ? T4(14) : R(14);
  if (!d.empty.empty()) {
    TextOpts o; o.maxW = x1 - x0;
    c.text(x0, y + 20, d.empty, sl ? T4(17) : R(19), o);
  }
  for (size_t i = 0; i < d.v.rows.size(); ++i) {
    const alist::Row& row = d.v.rows[i];
    if (i) c.dottedHLine(x0, y, x1 - x0, 2, Ink::Black);
    TextOpts ao; ao.tabular = true;
    const int aw = row.ago.empty() ? 0 : c.textWidth(row.ago, sf, ao);
    if (d.L.oneLine) {
      const int bl = y + 20, tw = (x1 - x0) * 2 / 5, sx = x0 + tw + 10;
      TextOpts to; to.maxW = tw;
      c.text(x0, bl, row.title, tf, to);
      TextOpts so; so.maxW = std::max(0, x1 - sx - (aw ? aw + 10 : 0));
      if (!row.sub.empty()) c.text(sx, bl, row.sub, sf, so);
      if (aw) c.textRight(x1, bl, row.ago, sf, ao);
      y += kPitch1;
      continue;
    }
    TextOpts to; to.maxW = std::max(0, x1 - x0 - (aw ? aw + 8 : 0));
    c.text(x0, y + 22, row.title, tf, to);
    if (aw) c.textRight(x1, y + 22, row.ago, sf, ao);
    TextOpts so; so.maxW = x1 - x0;
    if (!row.sub.empty()) c.text(x0, y + 43, row.sub, sf, so);
    y += kPitch2;
  }
  if (d.attribution.empty() && !d.v.more) return;
  const std::string more = d.v.more ? a.t(S::listMore, std::to_string(d.v.more)) : std::string();
  Font mf = sl ? T7(14) : B(14);
  const int mw = more.empty() ? 0 : c.textWidth(more, mf);
  if (mw) c.textRight(x1, bot - 4, more, mf);
  TextOpts fo; fo.maxW = std::max(0, x1 - x0 - (mw ? mw + 8 : 0));
  if (!d.attribution.empty()) c.text(x0, bot - 4, d.attribution, ff, fo);
}

std::string listValue(I& a, const Widget& w) {   // GET /screens/{id}/values: "Klapekster · 1 h ago"
  const ListData d = listData(a, w);
  if (d.v.rows.empty()) return "—";
  const alist::Row& r = d.v.rows[0];
  return r.title + (r.ago.empty() ? "" : " · " + r.ago);
}

}  // namespace ui
}  // namespace x4
