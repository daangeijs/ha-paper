// Guest Wi-Fi tile (eink-ha-os#329, emulator components/GuestWifiTile.tsx, data core/guest_wifi). The QR code in its white quiet
// zone (Modern: a white rounded square on the card), the network and password in large type: under the code on a
// 2×2, beside it on a 2×1 or 4-wide tile, the code alone on a 1-wide tile. Pure black modules, whole px per module.
// The signature records a hash of the modules, never the payload.
#include "app/app_impl.h"
#include "core/guest_wifi.h"
#include <vector>

namespace x4 {
namespace ui {

namespace {
Font fitBold(Canvas& c, const std::string& s, int maxW) {
  for (int z : {28, 24, 20, 18}) if (c.textWidth(s, B(z)) <= maxW) return B(z);
  return B(16);
}
// Greedy word wrap into at most 3 lines no wider than maxW (the last one ellipsized), each centred on cx.
void centered(Canvas& c, int cx, int cy, int maxW, const std::string& s, Font f) {
  std::vector<std::string> lines;
  std::string cur;
  size_t i = 0;
  while (i < s.size()) {
    size_t j = s.find(' ', i);
    if (j == std::string::npos) j = s.size();
    const std::string word = s.substr(i, j - i), next = cur.empty() ? word : cur + " " + word;
    if (!cur.empty() && c.textWidth(next, f) > maxW && lines.size() < 2) { lines.push_back(cur); cur = word; }
    else cur = next;
    i = j + 1;
  }
  if (!cur.empty()) lines.push_back(cur);
  const int lh = 22, top = cy - int(lines.size()) * lh / 2;
  TextOpts o; o.maxW = maxW;
  for (size_t k = 0; k < lines.size(); ++k) c.textCenter(cx, baseline(top + int(k) * lh, f, double(lh) / f.size), lines[k], f, o);
}
}  // namespace

void guestTile(Canvas& c, I& a, const Widget& w, Rect r) {
  const std::string ent = w.field("password_entity");
  const EntityValue* pv = ent.empty() ? nullptr : a.store.get(ent);
  const std::string pws = pv ? std::string(pv->state.c_str()) : std::string();
  guest::View v = guest::view(w.field("ssid"), w.field("password"), w.field("security"), w.field("hidden"), ent,
                              pv ? pws.c_str() : nullptr);
  QrMatrix m;
  const bool qr = v.status == guest::Status::Ok && guest::encode(v.payload, m);
  const guest::Layout L = guest::layout(r.w, r.h, w.cs, w.rs, qr ? m.size : 0);
  const int zx = r.x + L.zx, zy = r.y + L.zy;
  if (qr) {
    if (sleek()) c.box(rc(zx, zy, L.zs, L.zs), 18, Ink::Paper);
    c.qrModules(r.x + L.qx, r.y + L.qy, L.px, m);
  } else {
    const S msg = v.status == guest::Status::Pick ? S::guestPick : v.status == guest::Status::Wait ? S::guestWait : S::guestLong;
    centered(c, zx + L.zs / 2, zy + L.zs / 2, L.zs - 16, a.t(msg), B(18));
  }
  if (!L.hasText) return;
  const int x = r.x + L.tx, tw = L.tw;
  struct Row { S cap; std::string val; bool soft; };
  const Row rows[2] = {{S::guestNetwork, v.ssid.empty() ? std::string("—") : v.ssid, false},
                       {S::guestPassword, v.open ? a.t(S::guestOpen) : v.password.empty() ? std::string("—") : v.password, v.open}};
  for (int k = 0; k < 2; ++k) {
    const int top = r.y + L.ty + k * guest::kRowNext;
    TextOpts co; co.maxW = tw;
    c.text(x, baseline(top, R(16), 18.0 / 16), a.t(rows[k].cap), R(16), co);
    const Font f = rows[k].soft ? (c.textWidth(rows[k].val, R(26)) <= tw ? R(26) : R(18)) : fitBold(c, rows[k].val, tw);
    TextOpts vo; vo.maxW = tw;
    c.text(x, baseline(top + guest::kRowValue, f, 34.0 / f.size), rows[k].val, f, vo);
  }
}

}  // namespace ui
}  // namespace x4
