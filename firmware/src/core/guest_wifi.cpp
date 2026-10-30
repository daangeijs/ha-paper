// Guest Wi-Fi tile (eink-ha-os#329), emulator src/core/guestWifi.ts.
#include "core/guest_wifi.h"
#include <algorithm>
#include <cstring>
#include <mutex>

namespace x4 {
namespace guest {

std::string wifiEscape(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c == '\\' || c == ';' || c == ',' || c == ':' || c == '"') out += '\\';
    out += c;
  }
  return out;
}

std::string payload(const std::string& ssid, const std::string& password, const std::string& security, bool hidden) {
  std::string p = "WIFI:T:" + security + ";S:" + wifiEscape(ssid) + ";";
  if (security != "nopass") p += "P:" + wifiEscape(password) + ";";
  if (hidden) p += "H:true;";
  return p + ";";
}

namespace {
const char* kHex = "0123456789ABCDEF";
void pct(std::string& out, unsigned char b) { out += '%'; out += kHex[b >> 4]; out += kHex[b & 15]; }
int hexv(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}
// JS /\s/ on one UTF-8 character starting at s[i] (length len): ASCII whitespace, NBSP, the Unicode spaces, BOM.
bool jsSpace(const std::string& s, size_t i, size_t len) {
  unsigned char c = s[i];
  if (len == 1) return c == ' ' || (c >= 9 && c <= 13);
  uint32_t cp = 0;
  if (len == 2) cp = ((c & 0x1F) << 6) | (s[i + 1] & 0x3F);
  else if (len == 3) cp = ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F);
  else return false;
  return cp == 0xA0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp == 0x2028 || cp == 0x2029 || cp == 0x202F ||
         cp == 0x205F || cp == 0x3000 || cp == 0xFEFF;
}
size_t charLen(unsigned char c) { return c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 1; }
}  // namespace

std::string fieldEncode(const std::string& v) {
  std::string out;
  for (size_t i = 0; i < v.size();) {
    size_t n = std::min(charLen(v[i]), v.size() - i);
    const bool edge = (i == 0 || i + n == v.size()) && jsSpace(v, i, n);
    const unsigned char c = v[i];
    if (edge || (n == 1 && (c < 0x20 || c == 0x7f || c == '%' || c == ',' || c == '{' || c == '}')))
      for (size_t k = 0; k < n; ++k) pct(out, v[i + k]);
    else out.append(v, i, n);
    i += n;
  }
  bool digits = !out.empty();
  for (char c : out) digits = digits && c >= '0' && c <= '9';
  if (digits) { std::string head; pct(head, out[0]); out = head + out.substr(1); }
  return out;
}

std::string fieldDecode(const std::string& v) {
  std::string out;
  for (size_t i = 0; i < v.size(); ++i) {
    if (v[i] == '%' && i + 2 < v.size() && hexv(v[i + 1]) >= 0 && hexv(v[i + 2]) >= 0) {
      const char b = char(hexv(v[i + 1]) * 16 + hexv(v[i + 2]));
      if (b) out += b;
      i += 2;
    } else out += v[i];
  }
  return out;
}

bool encode(const std::string& payload, QrMatrix& m) {
  static std::mutex mu;
  static std::string last;
  static QrMatrix lastM;
  static bool lastOk = false;
  std::lock_guard<std::mutex> l(mu);
  if (last.empty() || payload != last) { last = payload; lastOk = encodeQr(payload, lastM, kMaxVersion); }
  if (lastOk) m = lastM;
  return lastOk;
}

bool validSecurity(const std::string& s) { return s == "WPA" || s == "WEP" || s == "nopass"; }

bool pwDomain(const std::string& id) {
  const size_t dot = id.find('.');
  const std::string d = dot == std::string::npos ? std::string() : id.substr(0, dot);
  return d == "input_text" || d == "text" || d == "sensor";
}

View view(const std::string& ssid, const std::string& password, const std::string& security, const std::string& hidden,
          const std::string& pwEntity, const char* pwState) {
  View v;
  v.ssid = fieldDecode(ssid);
  const std::string sec = validSecurity(security) ? security : "WPA";
  v.open = sec == "nopass";
  const bool live = pwState && *pwState && std::strcmp(pwState, "unavailable") != 0 && std::strcmp(pwState, "unknown") != 0;
  v.password = v.open ? std::string() : !pwEntity.empty() ? (live ? std::string(pwState) : std::string()) : fieldDecode(password);
  if (v.ssid.empty() || (!v.open && pwEntity.empty() && v.password.empty())) { v.status = Status::Pick; return v; }
  if (!v.open && !pwEntity.empty() && !live) { v.status = Status::Wait; return v; }
  v.payload = payload(v.ssid, v.password, sec, hidden == "true");
  QrMatrix m;
  v.status = encode(v.payload, m) ? Status::Ok : Status::Long;
  return v;
}

Layout layout(int w, int h, int cs, int rs, int n) {
  const int B = 2;
  Layout L;
  L.kind = cs < 2 ? Kind::Qr : (rs >= 2 && cs < 4) ? Kind::Stack : Kind::Side;
  if (L.kind == Kind::Stack) {
    const int ty = h - 10 - kTextH;
    L.zs = std::min(w - 2 * B, ty - B);
    L.zx = (w - L.zs) / 2; L.zy = B;
    L.hasText = true; L.tx = 14; L.ty = ty; L.tw = w - 28;
  } else if (L.kind == Kind::Side) {
    L.zs = h - 2 * B; L.zx = B; L.zy = B;
    L.hasText = true; L.tx = L.zx + L.zs; L.ty = (h - kTextH) / 2; L.tw = w - 14 - L.tx;
  } else {
    L.zs = std::min(w, h) - 2 * B;
    L.zx = (w - L.zs) / 2; L.zy = (h - L.zs) / 2;
  }
  L.px = n > 0 ? L.zs / (n + 2 * kQuiet) : 0;
  const int off = (L.zs - L.px * n) / 2;
  L.qx = L.zx + off; L.qy = L.zy + off;
  return L;
}

}  // namespace guest
}  // namespace x4
