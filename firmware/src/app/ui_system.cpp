// Settings pages and setup screens: Updates (OTA), Wi-Fi (list, password + on-screen keyboard, connecting, phone),
// Home Assistant (status / link), About, and first-install step 2 (finish in your browser, QR).
#include <algorithm>
#include <cstring>
#include <cctype>
#include <ctime>
#include "app/app_impl.h"
#include "core/json.h"
#include "core/power.h"
#include "core/ota_status.h"
#include "core/logic.h"

namespace x4 {
namespace ui {

static int mid(int top, int h, Font f) { int ch = Canvas::capHeight(f); return top + (h - ch) / 2 + ch; }

bool isSystemTile(const std::string& t) { return t == "ota" || t == "wifi" || t == "ha" || t == "about" || t == "setupWeb"; }

static void stepCircle(Canvas& c, int cx, int cy, int d, const std::string& n, bool done = false, bool cur = false) {
  c.circle(cx, cy, d / 2, done ? Ink::Black : Ink::Paper, cur ? 3 : 2, Ink::Black);
  if (done) c.icon(Icon::Tick14, cx - 7, cy - 7, Ink::Paper);
  else c.textCenter(cx, cy + Canvas::capHeight(B(14)) / 2, n, B(14));
}

static const std::string& host(I& a) { return a.svc.status().hostname; }

// ---------- OTA ----------
// The installed version at B46, else B40; then without the "-g<hash>" of a git-describe build name (About keeps the
// whole name), B46 → B28; the caller ellipsizes what still does not fit.
static void fitVersion(Canvas& c, std::string& v, int& size, int maxW) {
  TextOpts t; t.tracking = -1;
  for (int s : {46, 40}) if (c.textWidth(v, B(s), t) <= maxW) { size = s; return; }
  size_t g = v.rfind("-g");
  if (g != std::string::npos && g + 2 < v.size() && v.find_first_not_of("0123456789abcdef", g + 2) == std::string::npos) v.resize(g);
  for (int s : {46, 40, 34, 28}) { size = s; if (c.textWidth(v, B(s), t) <= maxW) return; }
}

// Status line under the installed version (eink-ha-os#250): title + up to two detail lines, at a fixed place and height.
constexpr int kOtaStatusTop = 14 + 24 + 10 + 46 + 10 + 12, kOtaStatusH = 31 + 4 + 2 * 22;
static int otaLeftW(Rect r) { return r.w - 16 - 270 - 22 - 16; }

Rect otaStatusRect(Rect r) { return rc(r.x + 16, r.y + kOtaStatusTop, otaLeftW(r), kOtaStatusH); }

static OtaLine otaStatusText(I& a) {
  auto& st = a.svc.status();
  if (st.otaChecksOff && st.ota == OtaState::UpToDate) return {a.t(S::otaChecksOff), a.t(S::otaChecksOffText)};
  if (a.otaBlocked) return {a.t(S::otaLowBattery), a.otaMsg};
  if (!a.otaMsg.empty()) return {a.t(S::otaFailed), a.otaMsg};
  if (st.ota == OtaState::Downloading || st.ota == OtaState::Installing)
    return {a.t(S::otaInstalling), st.otaAvailableVersion.empty() ? std::string(a.t(S::otaLocalFile)) : "v" + st.otaAvailableVersion};
  if (st.ota == OtaState::Failed) return {a.t(S::otaFailed), a.t(S::otaNothingChanged)};
  // = GET /ota status order (net/web_server.cpp otaToJson)
  OtaLineIn in;
  in.channel = a.set.otaChannel;
  in.status = st.otaChecking ? "checking" : st.ota == OtaState::Available ? "available"
            : a.otaOffline || st.otaCheckErr != OtaErr::None ? "error"
            : st.otaChecked || st.otaLastCheckEpoch > 0 ? "uptodate" : "idle";
  in.error = a.otaOffline ? OtaErr::Network : st.otaCheckErr;
  in.version = st.otaAvailableVersion;
  in.message = st.otaCheckMsg;
  if (st.otaLastCheckEpoch > 0) {
    time_t t = time_t(st.otaLastCheckEpoch);
    struct tm tm;
    localtime_r(&t, &tm);
    in.checked = pad2(tm.tm_hour) + ":" + pad2(tm.tm_min);
  }
  return otaLine(a.lang, in);
}

void otaStatus(Canvas& c, I& a, Rect r) {
  Rect s = otaStatusRect(r);
  OtaLine l = otaStatusText(a);
  TextOpts tto; tto.maxW = s.w;
  c.text(s.x, baseline(s.y, B(26), 1.2), l.title, B(26), tto);
  c.paragraph(s.x, s.y + 31 + 4, s.w, 22, l.sub, R(18), C(Ink::Black), 2);   // "This build doesn't check…" wraps
}

static void ota(Canvas& c, I& a, Rect r) {
  auto& st = a.svc.status();
  int x0 = r.x + 16, top = r.y + 14, rightW = 270;
  int lx1 = r.x + r.w - 16 - rightW - 22;
  label(c, x0, top, a.t(S::firmware), 20);
  int y = top + 24 + 10;
  {   // eink-ha-os#199: a git-describe build name ("0.1.0-alpha.6-18-gbf929d4") does not fit at B46 beside "installed"
    std::string ver = std::string("v") + X4_FW_VERSION_STR;
    int vs = 0;
    fitVersion(c, ver, vs, lx1 - x0 - 12 - c.textWidth(a.t(S::installed), R(18)));
    TextOpts vt; vt.tracking = -1; vt.maxW = lx1 - x0 - 12 - c.textWidth(a.t(S::installed), R(18));
    int vw = c.text(x0, baseline(y, B(46), 1.0), ver, B(vs), vt);
    c.text(x0 + vw + 12, baseline(y, B(46), 1.0), a.t(S::installed), R(18), C(Ink::Black));
  }
  y += 46 + 10;
  rule(c, x0, y, lx1 - x0, false);
  y += 12 + kOtaStatusH + 10;   // the status line: overlay region otaStatus()
  if (st.ota == OtaState::Available && !st.otaNotes.empty()) {
    TextOpts wn = C(Ink::Black); wn.upper = !sleek();
    c.text(x0, baseline(y, sleek() ? T6(14) : B(18), 1.2), a.t(S::otaWhatsNew), sleek() ? T6(14) : B(18), wn);
    y += 22 + 4;
    for (auto& n : st.otaNotes) {
      if (y + 22 > r.y + r.h - 14) break;
      c.circle(x0 + 3, y + 12, 3, Ink::Black);
      TextOpts nt; nt.maxW = lx1 - x0 - 14;
      c.text(x0 + 14, baseline(y, R(18), 1.2), n, R(18), nt);
      y += 22 + 4;
    }
  }
  // right column
  int rx = r.x + r.w - 16 - rightW;
  rule(c, rx - 22, r.y + 14, r.h - 28, true);
  rx -= 2;
  int ry = top;
  auto seg = [&](const std::string& head, std::vector<std::pair<std::string, std::string>> opts, const std::string& cur, bool chanSeg) {
    if (sleek()) label(c, rx, ry, head, 14);
    else { TextOpts h; h.upper = true; c.text(rx, baseline(ry, B(18), 1.2), head, B(18), h); }
    ry += 22 + 6;
    Rect box = rc(rx, ry, rightW, 44);
    if (sleek()) c.box(box, 22, Ink::Paper); else c.box(box, 8, Ink::Paper, 2, Ink::Black);
    int n = int(opts.size()), w = rightW / n;
    for (int k = 0; k < n; ++k) {
      Rect b = rc(rx + k * w, ry, k == n - 1 ? rightW - k * w : w, 44);
      bool on = opts[k].first == cur;
      if (on && sleek()) c.box(rc(b.x + 3, b.y + 3, b.w - 6, b.h - 6), (b.h - 6) / 2, Ink::Black);
      else if (on) c.box(rc(b.x + (k ? 0 : 2), b.y + 2, b.w - (k ? 0 : 2) - (k == n - 1 ? 2 : 0), b.h - 4), k == 0 || k == n - 1 ? 6 : 0, Ink::Black);
      if (k < n - 1 && !sleek()) c.vline(b.x + b.w - 1, b.y, b.h, 2, Ink::Black);
      c.textCenter(b.x + b.w / 2, mid(b.y, b.h, B(18)), opts[k].second, B(18), C(on ? Ink::Paper : Ink::Black));
      std::string key = opts[k].first;
      if (chanSeg) c.hit(b, [&a, key] { a.otaChannel(key); });
      else c.hit(b, [&a, key] { a.otaAuto(key); });
    }
    ry += 44 + 6;
  };
  seg(a.t(S::otaChannel), {{"stable", a.t(S::chanStable)}, {"beta", a.t(S::chanBeta)}}, a.set.otaChannel, true);
  ry += 6;
  seg(a.t(S::otaAutomatic), {{"off", a.t(S::off)}, {"notify", a.t(S::autoNotify)}, {"night", a.t(S::autoNight)}}, a.set.otaAuto, false);
  std::string hint = a.t(st.otaChecksOff ? S::otaHintOff : a.set.otaAuto == "night" ? S::otaHintNight : a.set.otaAuto == "notify" ? S::otaHintNotify : S::otaHintManual);
  c.paragraph(rx, ry, rightW, 22, hint, R(18), C(Ink::Black), 2);
  bool canInstall = st.ota == OtaState::Available;
  if (st.otaChecksOff && !canInstall) return;   // nothing to check: no "Check for updates" button
  std::string act = canInstall ? a.t(S::otaInstallV, st.otaAvailableVersion) : std::string(a.t(S::otaCheck));
  Rect btn = rc(rx, r.y + r.h - 14 - 22 - 8 - 56, rightW, 56);
  button(c, btn, act, B(20), canInstall, [&a] { a.otaAction(); });
  if (canInstall) c.text(rx, baseline(btn.y + 56 + 8, R(18), 1.2), a.t(S::aboutAMinute), R(18), C(Ink::Black));
}

// ---------- Wi-Fi ----------
static const char* kKb[3][3] = {{"qwertyuiop", "asdfghjkl", "zxcvbnm"}, {"QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"}, {"1234567890", "-/:;()€&@\"", ".,?!'#%*+="}};

static void wifiBars(Canvas& c, int x, int bottom, int rssi) {
  int b = rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
  for (int k = 0; k < 4; ++k) {
    int h = 6 + k * 4;
    Rect r = rc(x + k * 6, bottom - h, 4, h);
    c.fill(r, k < b ? Ink::Black : Ink::Paper);
    c.frame(r, 1, Ink::Black);
  }
}

static void wifiList(Canvas& c, I& a, Rect r) {
  auto& st = a.svc.status();
  bool conn = st.wifi == WifiState::Connected;
  // left status column (290)
  int lx = r.x + 16, lw = 290 - 32, top = r.y + 14;
  rule(c, r.x + 290, r.y + (sleek() ? 14 : 0), r.h - (sleek() ? 28 : 0), true);
  label(c, lx, top, a.t(conn ? S::connected : S::notConnected), 20);
  int y = top + 24 + 8;
  TextOpts tt; tt.maxW = lw;
  c.text(lx, baseline(y, B(28), 1.1), conn ? st.ssid : std::string(a.t(S::pickNetwork)), B(28), tt);
  y += 31 + 8;
  std::vector<std::pair<std::string, std::string>> lines;
  auto nets = a.svc.wifiNetworks();
  if (conn) {
    int rssi = -60; for (auto& n : nets) if (n.ssid == st.ssid) rssi = n.rssi;
    static const S q[] = {S::sigWeak, S::sigFair, S::sigGood, S::sigExcellent};
    int b = rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
    lines = {{a.t(S::kvSignal), a.t(q[b - 1])}, {a.t(S::kvIp), st.ip.empty() ? "—" : st.ip}, {"Home Assistant", a.t(st.ha == HaState::Connected ? S::reachable : S::offline)}};
  } else {
    int saved = 0; for (auto& n : nets) saved += n.saved;
    lines = {{a.t(S::kvStatus), a.t(S::offline)}, {a.t(S::kvSavedNets), std::to_string(saved)}};
  }
  for (auto& l : lines) { kvRow(c, lx, y, lw, l.first, l.second, 18, 4); y += 22 + 4 + 1 + 8; }
  if (conn) button(c, rc(lx, r.y + r.h - 14 - 48 - 8 - 44, lw, 44), a.t(S::disconnect), B(18), false, [&a] { a.wifiDisconnect(); });
  Rect ph = rc(lx, r.y + r.h - 14 - 48, lw, 48);
  btnBox(c, ph, false);
  std::string phl = a.t(S::setupFromPhone);
  int pw = c.textWidth(phl, B(18)) + 26;
  c.icon(Icon::Phone18, ph.x + ph.w / 2 - pw / 2, ph.y + 15);
  c.text(ph.x + ph.w / 2 - pw / 2 + 26, mid(ph.y, ph.h, B(18)), phl, B(18));
  c.hit(ph, [&a] { a.wifiPhone(); });
  // right: networks
  int rx = r.x + 292 + 14, rw = r.x + r.w - 14 - rx, ry = r.y + 10;
  TextOpts up; up.upper = !sleek();
  std::string sl = a.t(a.wScanning ? S::scanning : S::scan);
  int sw = c.textWidth(sl, B(18)) + 32;
  up.maxW = rw - sw - 10;
  c.text(rx, mid(ry, 44, B(20)), a.t(S::wifiNetworks), B(20), up);
  button(c, rc(rx + rw - sw, ry + 2, sw, 40), sl, B(18), false, [&a] { a.wifiScan(); });
  int ny = ry + 44 + 4;
  // the 5 GHz note: R18 on up to two lines at the bottom (eink-ha-os#199, was one R14 line)
  int noteN = std::max(1, Canvas(nullptr).paragraph(0, 0, rw, 22, a.t(S::wifi5g), R(18), TextOpts(), 2));
  int noteTop = r.y + r.h - 8 - noteN * 22;
  int maxRows = (noteTop - 4 - ny) / 54;
  int k = 0;
  for (auto& n : nets) {
    if (k >= maxRows) break;
    Rect row = rc(rx, ny + k * 54, rw, 54);
    c.dottedHLine(rx, row.y, rw, 1, Ink::Black);
    wifiBars(c, rx + 6, row.y + 36, n.rssi);
    std::string tag = conn && n.ssid == st.ssid ? a.t(S::connected) : n.saved ? a.t(S::savedTag) : "";
    int tw = tag.empty() ? 0 : c.textWidth(tag, B(18)) + 12;
    TextOpts nt; nt.maxW = rw - 6 - 24 - 12 - tw - 28;
    Font nf = c.textWidth(n.ssid, B(24)) <= nt.maxW ? B(24) : B(20);   // network names B24, long ones B20 then …
    int w = c.text(rx + 6 + 24 + 12, mid(row.y, 54, nf), n.ssid, nf, nt);
    if (n.secure) c.icon(Icon::Lock16, rx + 6 + 24 + 12 + w + 10, row.y + 19);
    c.textRight(rx + rw, mid(row.y, 54, B(18)), tag, B(18), C(Ink::Black));
    WifiNetwork copy = n;
    c.hit(row, [&a, copy] { a.wifiPick(copy); });
    ++k;
  }
  if (nets.empty()) c.text(rx + 6, ny + 34, a.t(a.wScanning ? S::wifiLooking : S::wifiNone), R(18), C(Ink::Black));
  c.paragraph(rx, noteTop, rw, 22, a.t(S::wifi5g), R(18), C(Ink::Black), 2);
}

static void wifiPw(Canvas& c, I& a, Rect r) {
  int x0 = r.x + 14, x1 = r.x + r.w - 14, y = r.y + 10;
  // header: back, title, show/hide
  Rect back = rc(x0, y, 44, 44);
  btnBox(c, back, false);
  c.icon(Icon::ChevLeft20, back.x + 12, back.y + 12);
  c.hit(back, [&a] { a.wifiCancel(); });
  std::string sl = a.t(a.wShow ? S::hide : S::show);
  int sw = c.textWidth(sl, B(18)) + 28;
  button(c, rc(x1 - sw, y + 2, sw, 40), sl, B(18), false, [&a] { a.wifiKey("SHOW"); });
  TextOpts tt; tt.maxW = x1 - sw - 10 - (x0 + 54);
  c.text(x0 + 54, mid(y, 44, B(20)), a.t(S::pwFor, a.wTarget), B(20), tt);
  y += 44 + 8;
  // field
  Rect f = rc(x0, y, x1 - x0, 48);
  c.frame(f, 2, Ink::Black, 8);
  std::string field;
  if (a.wShow) field = a.wPw;
  else for (size_t i = 0, n = utf8Decode(a.wPw).size(); i < n; ++i) field += "•";
  std::string msg = !a.wMsg.empty() ? a.wMsg : a.wPw.empty() ? std::string(a.t(S::typePw)) : a.t(S::nChars, std::to_string(utf8Decode(a.wPw).size()));
  int mw = c.textWidth(msg, B(18));
  TextOpts ft; ft.tracking = 1; ft.maxW = f.w - 24 - mw - 16;
  int fw = c.text(f.x + 12, mid(f.y, f.h, B(22)), field, B(22), ft);
  c.fill(rc(f.x + 12 + fw + 2, f.y + 11, 2, 26), Ink::Black);
  c.textRight(f.x + f.w - 12, mid(f.y, f.h, B(18)), msg, B(18), C(Ink::Black));
  y += 48 + 8;
  // keyboard: 4 rows, gap 6
  int kbH = r.y + r.h - 10 - y;
  int rowH = (kbH - 3 * 6) / 4;
  int set = a.kb == Kb::Upper ? 1 : a.kb == Kb::Nums ? 2 : 0;
  struct K { std::string label, val; double flex; int size; bool dark; };
  std::vector<std::vector<K>> rows(4);
  for (int k = 0; k < 2; ++k)
    for (auto cp : utf8Decode(kKb[set][k])) {
      std::string s; std::vector<uint32_t> one{cp};
      // encode back to utf-8
      if (cp < 0x80) s = char(cp); else { s += char(0xE0 | (cp >> 12)); s += char(0x80 | ((cp >> 6) & 0x3F)); s += char(0x80 | (cp & 0x3F)); }
      rows[k].push_back({s, s, 1, 20, false});
    }
  rows[2].push_back({"SHIFT", "SHIFT", 1.5, 20, a.kb == Kb::Upper});
  for (auto cp : utf8Decode(kKb[set][2])) { std::string s(1, char(cp)); rows[2].push_back({s, s, 1, 20, false}); }
  rows[2].push_back({"BACK", "BACK", 1.5, 20, false});
  rows[3] = {{a.kb == Kb::Nums ? "abc" : "123", "NUMS", 1.5, 18, false}, {a.t(S::keySpace), "SPACE", 5, 18, false}, {a.t(S::keyConnect), "OK", 2.5, 20, true}};
  for (int ri = 0; ri < 4; ++ri) {
    int inset = ri == 1 ? 30 : 0;
    int rx = x0 + inset, rw = (x1 - x0) - 2 * inset;
    double total = 0; for (auto& k : rows[ri]) total += k.flex;
    int gaps = int(rows[ri].size()) - 1;
    double unit = (rw - gaps * 6) / total;
    double kx = rx;
    int ky = y + ri * (rowH + 6);
    for (auto& k : rows[ri]) {
      int kw = int(unit * k.flex + 0.5);
      Rect kr = rc(int(kx + 0.5), ky, kw, rowH);
      if (sleek()) c.box(kr, 8, k.dark ? Ink::Black : Ink::Paper); else c.box(kr, 6, k.dark ? Ink::Black : Ink::Paper, 2, Ink::Black);
      Ink fg = k.dark ? Ink::Paper : Ink::Black;
      int cx = kr.x + kr.w / 2, cy = kr.y + kr.h / 2;
      if (k.val == "SHIFT") {   // ⇧ drawn as an outlined arrow
        c.fill(rc(cx - 4, cy - 1, 8, 9), fg);
        for (int t = 0; t < 8; ++t) c.fill(rc(cx - t, cy - 9 + t, 2 * t + 1, 1), fg);
      } else if (k.val == "BACK") {   // ⌫
        c.frame(rc(cx - 8, cy - 8, 20, 16), 2, fg, 2);
        for (int t = 0; t < 8; ++t) c.fill(rc(cx - 8 - t, cy - t, 1, 2 * t + 1), fg);
        c.fill(rc(cx - 1, cy - 1, 8, 2), fg);
      } else {
        c.textCenter(cx, mid(kr.y, kr.h, B(k.size)), k.label, B(k.size), C(fg));
      }
      std::string v = k.val;
      c.hit(kr, [&a, v] { a.wifiKey(v); });
      kx += kw + 6;
    }
  }
}

static void wifiConnecting(Canvas& c, I& a, Rect r) {
  int cy = r.y + r.h / 2;
  c.icon(Icon::Wifi44, r.x + r.w / 2 - 22, cy - 22 - 10 - 40);
  c.textCenter(r.x + r.w / 2, cy + 10, a.t(S::connectingTo, a.wTarget), B(28));
  c.textCenter(r.x + r.w / 2, cy + 10 + 10 + 24, a.t(S::connectingNote), R(18), C(Ink::Black));
}

static void wifiPhone(Canvas& c, I& a, Rect r) {
  int x = r.x + 20, cy = r.y + r.h / 2;
  // QR to join the setup network (Wi-Fi QR format)
  c.qr(x, cy - 100, 200, "WIFI:T:nopass;S:HA-Paper-Setup;;");
  int tx = x + 200 + 28, tw = r.x + r.w - 20 - tx;
  int y = cy - 110;
  c.text(tx, baseline(y, B(26), 1.2), a.t(S::phoneTitle), B(26));
  y += 31 + 12;
  const S steps[] = {S::phoneStep1, S::phoneStep2, S::phoneStep3};
  for (int k = 0; k < 3; ++k) {
    stepCircle(c, tx + 13, y + 13, 26, std::to_string(k + 1));
    int n = c.paragraph(tx + 38, y, tw - 38, 24, a.t(steps[k]), R(18));
    y += std::max(26, n * 24) + 12;
  }
  button(c, rc(tx, y + 4, c.textWidth(a.t(S::cancel), B(18)) + 32, 46), a.t(S::cancel), B(18), false, [&a] { a.wifiCancel(); });
}

static void wifi(Canvas& c, I& a, Rect r) {
  switch (a.wview) {
    case WifiView::List: wifiList(c, a, r); break;
    case WifiView::Pw: wifiPw(c, a, r); break;
    case WifiView::Connecting: wifiConnecting(c, a, r); break;
    case WifiView::Phone: wifiPhone(c, a, r); break;
  }
}

// ---------- Home Assistant ----------
static void haTile(Canvas& c, I& a, Rect r) {
  auto& st = a.svc.status();
  bool linked = a.linked();
  if (a.haView == HaView::Link) {
    int x = r.x + 18, y = r.y + 14;
    std::string url = qrBase(a) + "/link?p=" + st.pairingCode;
    c.qr(x + 5, y, 200, url);
    c.textCenter(x + 105, y + 200 + 10 + 16, a.t(S::pairingCode), R(18), C(Ink::Black));
    TextOpts pc; pc.tracking = 6; pc.tabular = true;
    c.textCenter(x + 105, y + 200 + 10 + 17 + 10 + 30, st.pairingCode.empty() ? "····" : st.pairingCode, B(30), pc);
    int tx = x + 210 + 24, tw = r.x + r.w - 18 - tx;
    c.text(tx, baseline(y, B(24), 1.2), a.t(S::linkHa), B(24));
    int noteN = c.paragraph(tx, y + 29 + 6, tw, 22, a.t(S::linkScanNote), R(18), C(Ink::Black), 2);
    static const S st3[][3] = {{S::lnkScan, S::lnkScanWait, S::lnkScanDone}, {S::lnkFind, S::lnkFindWait, S::lnkFindDone},
                               {S::lnkSignIn, S::lnkSignInWait, S::lnkSignInDone}, {S::lnkKey, S::lnkKeyWait, S::lnkKeyDone}};
    int stage = st.ha == HaState::Linking ? 2 : 0;
    int sy = y + 29 + 6 + noteN * 22 + 8, btnTop = r.y + r.h - 14 - 44;
    int rh = (btnTop - 10 - sy) / 4;
    for (int k = 0; k < 4; ++k) {
      int ry = sy + k * rh;
      c.dottedHLine(tx, ry, tw, 1, Ink::Black);
      bool done = stage > k, cur = stage == k;
      stepCircle(c, tx + 15, ry + rh / 2, 30, std::to_string(k + 1), done, cur);
      c.text(tx + 42, ry + rh / 2 - 3, a.t(st3[k][0]), B(18));
      TextOpts so = C(Ink::Black); so.maxW = tw - 42;
      c.text(tx + 42, ry + rh / 2 + 18, a.t(done ? st3[k][2] : st3[k][1]), R(18), so);
    }
    button(c, rc(tx, btnTop, c.textWidth(a.t(S::back), B(18)) + 32, 44), a.t(S::back), B(18), false, [&a] { a.haCancel(); });
    return;
  }
  // status view
  int lx = r.x + 16, lw = 290 - 32, top = r.y + 14;
  rule(c, r.x + 290, r.y + (sleek() ? 14 : 0), r.h - (sleek() ? 28 : 0), true);
  label(c, lx, top, "Home Assistant", 20);
  std::string title = a.t(a.revoked() ? S::keyRevoked : !linked ? S::notLinked : st.ha == HaState::Offline ? S::haOffline : S::connected);
  int y = top + 24 + 8;
  y += 31 * c.paragraph(lx, y, lw, 31, title, B(28)) + 8;   // "Home Assistant offline" wraps to two lines
  std::vector<std::pair<std::string, std::string>> lines;
  if (linked) {
    std::string last = "—";
    if (st.haLastDataEpoch > 0) { time_t t = time_t(st.haLastDataEpoch); struct tm tm; localtime_r(&t, &tm); last = pad2(tm.tm_hour) + ":" + pad2(tm.tm_min); }
    lines = {{a.t(S::kvServer), st.haUrl.empty() ? "—" : st.haUrl}, {a.t(S::kvKey), a.t(S::renewsItself)}, {a.t(S::kvConnection), a.t(st.ha == HaState::Offline ? S::offline : S::connLive)}, {a.t(S::kvLastData), last}};
  } else if (a.revoked()) lines = {{a.t(S::kvWhy), a.t(S::removedInHa)}, {a.t(S::kvData), a.t(S::lastKnownOnly)}, {a.t(S::kvFix), a.t(S::linkPhoneBelow)}};
  else lines = {{a.t(S::kvServer), a.t(S::notSet)}, {a.t(S::kvStatus), a.t(S::noLiveData)}};
  for (auto& l : lines) { kvRow(c, lx, y, lw, l.first, l.second, 18, 4); y += 22 + 4 + 1 + 8; }
  if (a.revoked())   // the other way back: a Home Assistant sign-in in the web console re-links too
    c.paragraph(lx, y, lw, 22, a.t(S::revokedHint, hostOrIp(a)), R(18), C(Ink::Black), 3);
  if (linked) {
    int bw = (lw - 8) / 2, by = r.y + r.h - 14 - 48 - 8 - 44;
    button(c, rc(lx, by, bw, 44), a.t(S::reconnect), B(18), false, [&a] { a.haReconnect(); });
    button(c, rc(lx + bw + 8, by, lw - bw - 8, 44), a.t(S::unlink), B(18), false, [&a] { a.haUnlink(); });
  }
  Rect lb = rc(lx, r.y + r.h - 14 - 48, lw, 48);
  std::string ll = a.t(linked ? S::relinkPhone : S::linkPhone);
  btnBox(c, lb, !linked);
  int w = c.textWidth(ll, B(18)) + 26;
  Ink fg = linked ? Ink::Black : Ink::Paper;
  c.icon(Icon::Phone18, lb.x + lb.w / 2 - w / 2, lb.y + 15, fg);
  c.text(lb.x + lb.w / 2 - w / 2 + 26, mid(lb.y, lb.h, B(18)), ll, B(18), C(fg));
  c.hit(lb, [&a] { a.haOpenLink(); });
  // right: what this display reads
  int rx = r.x + 292 + 16, rw = r.x + r.w - 16 - rx;
  label(c, rx, top, a.t(S::whatReads), 20);
  std::string foot = a.t(S::changeShownAt, hostOrIp(a));
  int footN = std::max(1, Canvas(nullptr).paragraph(0, 0, rw, 22, foot, R(18), TextOpts(), 2));
  int uy = top + 24 + 6, ub = r.y + r.h - 14 - footN * 22 - 6;
  int rh = (ub - uy) / 4;
  int energy = 0;
  for (auto* id : {"sensor.solar_power", "sensor.home_power", "sensor.grid_power", "sensor.battery_power", "sensor.energy_prices", "sensor.home_battery_soc"})
    energy += a.store.get(id) ? 1 : 0;
  int routes = 0;   // route tiles whose sensor HA reports (eink-ha-os#145)
  for (auto& sc : a.cfg.screens)
    for (auto& w : sc.widgets) routes += w.type == "route" && !w.field("entity").empty() && a.store.get(w.field("entity")) ? 1 : 0;
  struct U { S name, src; std::string count; } uses[] = {
      {S::energy, S::useEnergySrc, a.t(S::nSensors, std::to_string(energy))},
      {S::lights, S::useLightsSrc, a.t(S::nLights, std::to_string(a.data.lights.size()))},
      {S::heating, S::useHeatSrc, a.t(S::nRooms, std::to_string(a.data.zones.size()))},
      {S::travel, S::useTravelSrc, a.t(S::nRoutes, std::to_string(routes))}};
  for (int k = 0; k < 4; ++k) {
    int ry = uy + k * rh;
    c.dottedHLine(rx, ry, rw, 1, Ink::Black);
    int cy = ry + rh / 2;
    c.circle(rx + 14, cy, 14, linked ? Ink::Black : Ink::Paper, 2, Ink::Black);
    if (linked) c.icon(Icon::Tick14, rx + 7, cy - 7, Ink::Paper);
    std::string cnt = linked ? uses[k].count : "—";
    TextOpts nmo; nmo.maxW = rw - 40 - c.textWidth(cnt, B(18)) - 12;
    c.text(rx + 40, cy - 3, a.t(uses[k].name), B(20), nmo);
    TextOpts so = C(Ink::Black); so.maxW = rw - 40;
    c.text(rx + 40, cy + 19, a.t(uses[k].src), R(18), so);
    c.textRight(rx + rw, cy - 3, cnt, B(18));
  }
  c.paragraph(rx, r.y + r.h - 14 - footN * 22, rw, 22, foot, R(18), C(Ink::Black), 2);
}

// ---------- About ----------
static void about(Canvas& c, I& a, Rect r) {
  auto& st = a.svc.status();
  int x0 = r.x + 18, rightW = 230, lx1 = r.x + r.w - rightW;
  int top = r.y + 14;
  // device glyph
  c.frame(rc(x0, top, 54, 40), 3, Ink::Black, 6);
  c.frame(rc(x0 + 9, top + 9, 36, 22), 1, Ink::Black, 0);
  TextOpts nt; nt.maxW = lx1 - 18 - (x0 + 68);
  c.text(x0 + 68, top + 22, a.set.deviceName, B(26), nt);
  TextOpts vo = C(Ink::Black); vo.maxW = nt.maxW;
  c.text(x0 + 68, top + 22 + 22, std::string("Xteink X4 Pro · HA Paper v") + X4_FW_VERSION_STR, R(18), vo);
  int y = top + 48 + 10;
  rule(c, x0, y, lx1 - 18 - x0, false);
  uint32_t upMin = a.ms() / 60000;
  std::string uptime = upMin < 60 ? std::to_string(upMin) + " min" : std::to_string(upMin / 60) + " h " + std::to_string(upMin % 60) + " min";
  std::string haS = a.t(a.linked() ? (st.ha == HaState::Offline ? S::offline : S::connected) : a.revoked() ? S::keyRevoked : S::notLinked);
  std::pair<std::string, std::string> facts[] = {
      {"Home Assistant", haS},
      {a.t(S::stepWifi), st.wifi == WifiState::Connected ? st.ssid : a.t(S::notConnected)},
      {a.t(S::battery), batteryLabel(a.board.power().batteryPct, a.board.power().charging, a.board.power().usb)},
      {a.t(S::kvRunningFor), uptime},
      {a.t(S::kvStorage), "—"},
      {a.t(S::kvIp), st.wifi == WifiState::Connected && !st.ip.empty() ? st.ip : "—"},
      {a.t(S::kvScreen), a.t(S::redraws, std::to_string(a.stats.fullRefreshes), std::to_string(a.stats.partialRefreshes))},
      {a.t(S::kvHardware), "ESP32-S3 · 800×480 e-ink"}};
  int gx = x0, gw = (lx1 - 18 - x0 - 24) / 2, gy = y + 2, rowH = (r.y + r.h - 14 - gy) / 4;
  for (int k = 0; k < 8; ++k) {
    int cx = gx + (k % 2) * (gw + 24), cy = gy + (k / 2) * rowH;
    TextOpts kt = C(Ink::Black); kt.upper = !sleek(); kt.tracking = sleek() ? 0 : 1; kt.maxW = gw;
    c.text(cx, cy + rowH / 2 - 6, facts[k].first, sleek() ? T6(13) : B(16), kt);
    TextOpts vt; vt.maxW = gw;
    Font vf = c.textWidth(facts[k].second, B(20)) <= gw ? B(20) : B(18);   // "2 volledig · 0 deels ververst"
    c.text(cx, cy + rowH / 2 + 18, facts[k].second, vf, vt);
    c.dottedHLine(cx, cy + rowH - 1, gw, 1, Ink::Black);
  }
  // right: device actions
  int rx = lx1 + 16, rw = rightW - 32;
  rule(c, lx1, r.y + (sleek() ? 14 : 0), r.h - (sleek() ? 28 : 0), true);
  label(c, rx, top, a.t(S::tabDevice), 20);
  button(c, rc(rx, top + 24 + 10, rw, 48), a.t(S::restart), B(18), false, [&a] { a.restart(); });
  c.paragraph(rx, top + 24 + 10 + 48 + 8, rw, 22, a.t(S::restartNote), R(18), C(Ink::Black), 3);
  std::string hint = a.t(a.resetArm ? S::resetErases : S::resetStartsSetup);
  int hb = r.y + r.h - 14;
  int hl = 3;   // "Wist wifi, Home Assistant-koppeling en alle instellingen." is three R18 lines in 198 px
  button(c, rc(rx, hb - hl * 22 - 10 - 48, rw, 48), a.t(a.resetArm ? S::tapAgain : S::factoryReset), B(18), a.resetArm, [&a] { a.resetTap(); });
  c.paragraph(rx, hb - hl * 22, rw, 22, hint, R(18), C(Ink::Black), 3);
}

// ---------- first install, step 2 ----------
static void setupWeb(Canvas& c, I& a, Rect r) {
  auto& st = a.svc.status();
  std::string ssid = st.ssid.empty() ? a.t(S::swYourWifi) : st.ssid;
  int x = r.x + 22, cy = r.y + r.h / 2;
  int qy = cy - 100 - 18;
  c.qr(x + 5, qy, 200, qrBase(a));
  c.textCenter(x + 105, qy + 200 + 10 + 22, host(a), B(22), [] { TextOpts t; t.tracking = 1; return t; }());
  if (!st.ip.empty()) c.textCenter(x + 105, qy + 200 + 10 + 22 + 26, a.t(S::swOr, st.ip), R(18), C(Ink::Black));
  int tx = x + 210 + 28, tw = r.x + r.w - 22 - tx;
  // eink-ha-os#272: titles only; the block (connected 22+12, title 33+12, 3 rows of 52, 18, button 44) centres on the QR
  const int rowH = 52, blockH = 22 + 12 + 33 + 12 + 3 * rowH + 18 + 44;
  int y = std::max(r.y + 14, cy - blockH / 2);
  c.circle(tx + 11, y + 11, 11, Ink::Black);
  c.icon(Icon::Tick14, tx + 4, y + 4, Ink::Paper);
  TextOpts ct; ct.maxW = tw - 30;
  c.text(tx + 30, y + 17, a.t(S::swConnected, ssid), B(16), ct);
  y += 22 + 12;
  c.text(tx, baseline(y, B(30), 1.1), a.t(S::swTitle), B(30));
  y += 33 + 12;
  std::string steps[] = {a.t(S::swOpen, host(a)), a.t(S::signIn), a.t(S::stepDone)};
  TextOpts stt; stt.maxW = tw - 42;
  for (int k = 0; k < 3; ++k) {
    c.dottedHLine(tx, y, tw, 1, Ink::Black);
    stepCircle(c, tx + 14, y + rowH / 2, 28, std::to_string(k + 1));
    c.text(tx + 42, mid(y, rowH, B(22)), steps[k], B(22), stt);
    y += rowH;
  }
  c.dottedHLine(tx, y, tw, 1, Ink::Black);
  y += 18;
  std::string other = a.t(S::swOtherWifi);
  int bw = c.textWidth(other, B(15)) + 28 + 4;
  Rect b = rc(tx, std::min(y, r.y + r.h - 16 - 44), bw, 44);
  button(c, b, other, B(15), false, [&a] { a.changeWifi(); });
  c.text(b.x + bw + 12, mid(b.y, 44, R(14)), a.t(S::swWaiting), R(14), C(Ink::Black));
}

void systemTile(Canvas& c, I& a, const Widget& w, int, Rect r) {
  tileFrame(c, r);
  if (w.type == "ota") ota(c, a, r);
  else if (w.type == "wifi") wifi(c, a, r);
  else if (w.type == "ha") haTile(c, a, r);
  else if (w.type == "about") about(c, a, r);
  else if (w.type == "setupWeb") setupWeb(c, a, r);
}

}  // namespace ui
}  // namespace x4
