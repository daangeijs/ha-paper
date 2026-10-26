#include "net/util.h"

#include <esp_random.h>
#include <esp_wifi.h>
#if !X4_QEMU
#include <HWCDC.h>
#endif
#include <mbedtls/base64.h>
#include <mbedtls/sha256.h>

#include <cstdlib>
#include <cstring>
#include <cctype>
#include <cstdio>

#ifndef X4_FW_VERSION
#define X4_FW_VERSION ""
#endif
#ifndef X4_OTA_REPO
#define X4_OTA_REPO "daangeijs/ha-paper"
#endif

namespace x4::net {

void randomBytes(uint8_t* out, size_t n) { esp_fill_random(out, n); }

std::string randomToken(size_t n, const char* alphabet) {
  const size_t m = strlen(alphabet);
  std::string s;
  s.reserve(n);
  while (s.size() < n) {
    uint8_t b;
    randomBytes(&b, 1);
    // rejection sampling → uniform over the alphabet
    if (b >= 256 - (256 % m)) continue;
    s.push_back(alphabet[b % m]);
  }
  return s;
}

std::string hex(const uint8_t* d, size_t n) {
  static const char* k = "0123456789abcdef";
  std::string s(n * 2, '0');
  for (size_t i = 0; i < n; i++) {
    s[2 * i] = k[d[i] >> 4];
    s[2 * i + 1] = k[d[i] & 15];
  }
  return s;
}

void sha256(const uint8_t* d, size_t n, uint8_t out[32]) { mbedtls_sha256(d, n, out, 0); }

std::string sha256Hex(const std::string& s) {
  uint8_t h[32];
  sha256(reinterpret_cast<const uint8_t*>(s.data()), s.size(), h);
  return hex(h, 32);
}

std::string base64Encode(const uint8_t* d, size_t n) {
  size_t olen = 0;
  mbedtls_base64_encode(nullptr, 0, &olen, d, n);
  std::string s(olen, '\0');
  if (mbedtls_base64_encode(reinterpret_cast<unsigned char*>(&s[0]), olen, &olen, d, n) != 0) return {};
  s.resize(olen);
  return s;
}

bool base64Decode(const std::string& in, std::vector<uint8_t>& out) {
  size_t olen = 0;
  mbedtls_base64_decode(nullptr, 0, &olen, reinterpret_cast<const unsigned char*>(in.data()), in.size());
  out.resize(olen);
  if (mbedtls_base64_decode(out.data(), olen, &olen, reinterpret_cast<const unsigned char*>(in.data()), in.size()) != 0)
    return false;
  out.resize(olen);
  return true;
}

std::string base64UrlNoPad(const uint8_t* d, size_t n) {
  std::string s = base64Encode(d, n);
  for (auto& c : s) {
    if (c == '+') c = '-';
    else if (c == '/') c = '_';
  }
  while (!s.empty() && s.back() == '=') s.pop_back();
  return s;
}

std::string urlEncode(const std::string& s) {
  static const char* k = "0123456789ABCDEF";
  std::string o;
  for (unsigned char c : s) {
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o.push_back(c);
    else {
      o.push_back('%');
      o.push_back(k[c >> 4]);
      o.push_back(k[c & 15]);
    }
  }
  return o;
}

bool constantTimeEq(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  uint8_t r = 0;
  for (size_t i = 0; i < a.size(); i++) r |= static_cast<uint8_t>(a[i] ^ b[i]);
  return r == 0;
}

std::string jsonEscape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          snprintf(b, sizeof b, "\\u%04x", c);
          o += b;
        } else {
          o.push_back(static_cast<char>(c));
        }
    }
  }
  return o;
}

std::string errorJson(const std::string& msg) { return "{\"error\":\"" + jsonEscape(msg) + "\"}"; }

bool parseUrl(const std::string& in, Url& out) {
  std::string s = in;
  size_t p = s.find("://");
  if (p == std::string::npos) return false;
  std::string scheme = s.substr(0, p);
  for (auto& c : scheme) c = tolower(c);
  if (scheme == "https" || scheme == "wss") out.tls = true;
  else if (scheme == "http" || scheme == "ws") out.tls = false;
  else return false;
  s = s.substr(p + 3);
  size_t slash = s.find('/');
  std::string hostport = slash == std::string::npos ? s : s.substr(0, slash);
  out.path = slash == std::string::npos ? "/" : s.substr(slash);
  size_t colon = hostport.rfind(':');
  if (colon != std::string::npos && hostport.find(']') == std::string::npos) {
    out.host = hostport.substr(0, colon);
    out.port = static_cast<uint16_t>(atoi(hostport.c_str() + colon + 1));
  } else {
    out.host = hostport;
    out.port = out.tls ? 443 : 80;
  }
  return !out.host.empty() && out.port != 0;
}

std::string normalizeBaseUrl(const std::string& in) {
  std::string s = in;
  while (!s.empty() && (s.back() == '/' || s.back() == ' ')) s.pop_back();
  while (!s.empty() && s.front() == ' ') s.erase(s.begin());
  if (!s.empty() && s.find("://") == std::string::npos) s = "http://" + s;
  return s;
}

static void splitVersion(const std::string& v, int num[3], std::string& pre) {
  std::string s = v;
  if (!s.empty() && (s[0] == 'v' || s[0] == 'V')) s.erase(0, 1);
  size_t dash = s.find('-');
  pre = dash == std::string::npos ? "" : s.substr(dash + 1);
  std::string core = s.substr(0, dash);
  num[0] = num[1] = num[2] = 0;
  int i = 0;
  const char* c = core.c_str();
  while (*c && i < 3) {
    num[i++] = atoi(c);
    while (*c && *c != '.') c++;
    if (*c == '.') c++;
  }
}

int compareVersions(const std::string& a, const std::string& b) {
  int na[3], nb[3];
  std::string pa, pb;
  splitVersion(a, na, pa);
  splitVersion(b, nb, pb);
  for (int i = 0; i < 3; i++)
    if (na[i] != nb[i]) return na[i] < nb[i] ? -1 : 1;
  if (pa == pb) return 0;
  if (pa.empty()) return 1;   // release > pre-release
  if (pb.empty()) return -1;
  return pa < pb ? -1 : 1;    // lexical (beta.10 vs beta.9 caveat; fine for our tags)
}

const char* firmwareVersion() {
  static const char* v = (X4_FW_VERSION[0] != '\0') ? X4_FW_VERSION : "0.0.0-dev";
  return v;
}

const char* otaRepo() {
  static const char* r = (strstr(X4_OTA_REPO, "[YOU]") != nullptr) ? "" : X4_OTA_REPO;
  return r;
}

const char* wifiPsMode() {
  wifi_ps_type_t t;
  if (esp_wifi_get_ps(&t) != ESP_OK) return nullptr;
  return t == WIFI_PS_NONE ? "none" : t == WIFI_PS_MIN_MODEM ? "min" : "max";
}

bool usbHostPlugged() {
#if X4_QEMU
  return false;
#else
  return HWCDC::isPlugged();
#endif
}

}  // namespace x4::net
