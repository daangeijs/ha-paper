#include "core/ha_address.h"

#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <vector>

#include "core/json.h"

namespace x4::ha_address {

namespace {

constexpr const char* kNotAddress = "That is not an address. Try homeassistant.local:8123.";
constexpr const char* kNotHere =
    "Home Assistant can’t be at that address (loopback or link-local). Try homeassistant.local:8123.";
constexpr int kDefaultPort = 8123;

std::string lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

// "scheme://" at the start (JS /^([a-z][a-z0-9+.-]*):\/\//i): its length incl. "://", else 0.
size_t schemeLen(const std::string& s, std::string& scheme) {
  if (s.empty() || !std::isalpha(static_cast<unsigned char>(s[0]))) return 0;
  size_t i = 1;
  while (i < s.size() && (std::isalnum(static_cast<unsigned char>(s[i])) || s[i] == '+' || s[i] == '.' || s[i] == '-')) ++i;
  if (s.compare(i, 3, "://") != 0) return 0;
  scheme = lower(s.substr(0, i));
  return i + 3;
}

bool hostChar(char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == '-'; }
bool v6Char(char c) { return std::isxdigit(static_cast<unsigned char>(c)) || c == ':' || c == '.'; }

std::string origin(const std::string& scheme, const std::string& host, int port) {
  const int def = scheme == "https" ? 443 : 80;
  return scheme + "://" + host + (port && port != def ? ":" + std::to_string(port) : "");
}

std::vector<std::string> split(const std::string& s, const std::string& sep) {
  std::vector<std::string> out;
  size_t a = 0;
  for (size_t b; (b = s.find(sep, a)) != std::string::npos; a = b + sep.size()) out.push_back(s.substr(a, b - a));
  out.push_back(s.substr(a));
  return out;
}

bool allDigits(const std::string& s, size_t from, bool hex) {
  for (size_t i = from; i < s.size(); ++i) {
    const int c = static_cast<unsigned char>(s[i]);
    if (!(hex ? std::isxdigit(c) : std::isdigit(c))) return false;
  }
  return true;
}

int digitValue(char c) { return std::isdigit(static_cast<unsigned char>(c)) ? c - '0' : std::tolower(c) - 'a' + 10; }

// lwip / inet_aton IPv4: 1–4 parts, each decimal, 0x hex or 0 octal ("127.1", "0x7f.0.0.1", "2130706433").
// false = not an IPv4 address (then it is a name).
bool ipv4(const std::string& h, uint32_t& addr) {
  const auto parts = split(h, ".");
  if (parts.size() > 4) return false;
  uint64_t a = 0;
  for (size_t i = 0; i < parts.size(); ++i) {
    const std::string& p = parts[i];
    uint64_t v = 0;
    int base = 10;
    size_t from = 0;
    if (p.size() >= 2 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
      base = 16, from = 2;
      if (!allDigits(p, 2, true)) return false;
    } else if (!p.empty() && p[0] == '0') {
      base = 8;
      for (char c : p)
        if (c < '0' || c > '7') return false;
    } else if (p.empty() || !allDigits(p, 0, false)) {
      return false;
    }
    const bool last = i + 1 == parts.size();
    const uint64_t room = last ? uint64_t(1) << (8 * (4 - i)) : 256;
    for (size_t k = from; k < p.size() && v < room; ++k) v = v * base + digitValue(p[k]);
    if (v >= room) return false;
    a += last ? v : v << (8 * (3 - i));
  }
  addr = static_cast<uint32_t>(a);
  return true;
}

// IPv6 between the brackets → 8 groups (with ::, a trailing dotted IPv4). false = not one.
bool ipv6Groups(const std::string& s, std::vector<uint32_t>& out) {
  if (s.empty()) return true;
  const auto ps = split(s, ":");
  for (size_t i = 0; i < ps.size(); ++i) {
    const std::string& p = ps[i];
    if (i + 1 == ps.size() && p.find('.') != std::string::npos) {
      const auto b = split(p, ".");
      if (b.size() != 4) return false;
      uint32_t v[4];
      for (int k = 0; k < 4; ++k) {
        if (b[k].empty() || b[k].size() > 3 || !allDigits(b[k], 0, false)) return false;
        v[k] = std::atoi(b[k].c_str());
        if (v[k] > 255) return false;
      }
      out.push_back(v[0] * 256 + v[1]);
      out.push_back(v[2] * 256 + v[3]);
    } else {
      if (p.empty() || p.size() > 4 || !allDigits(p, 0, true)) return false;
      out.push_back(std::strtoul(p.c_str(), nullptr, 16));
    }
  }
  return true;
}

bool ipv6(const std::string& h, std::vector<uint32_t>& g) {
  const auto halves = split(h, "::");
  if (halves.size() > 2) return false;
  std::vector<uint32_t> a, b;
  if (!ipv6Groups(halves[0], a) || (halves.size() == 2 && !ipv6Groups(halves[1], b))) return false;
  if (halves.size() == 1) {
    g = a;
    return a.size() == 8;
  }
  if (a.size() + b.size() > 7) return false;
  g = a;
  g.resize(8 - b.size(), 0);
  g.insert(g.end(), b.begin(), b.end());
  return true;
}

bool localV4(uint32_t a) { return (a >> 24) == 127 || (a >> 24) == 0 || (a >> 16) == 0xa9fe; }

// Loopback (127/8, 0/8, ::1, ::, localhost) or link-local (169.254/16, fe80::/10): never HA for the display (#75).
bool localOnly(std::string h) {
  if (!h.empty() && h.back() == '.') h.pop_back();
  const std::string tld = ".localhost";
  if (h == "localhost" || (h.size() > tld.size() && h.compare(h.size() - tld.size(), tld.size(), tld) == 0)) return true;
  if (!h.empty() && h[0] == '[') {
    std::vector<uint32_t> g;
    if (!ipv6(h.substr(1, h.size() - 2), g)) return false;
    bool zero5 = true;
    for (int i = 0; i < 5; ++i) zero5 = zero5 && g[i] == 0;
    if (zero5 && g[5] == 0 && g[6] == 0 && g[7] <= 1) return true;   // ::1, ::
    if ((g[0] & 0xffc0) == 0xfe80) return true;
    return zero5 && g[5] == 0xffff && localV4(g[6] << 16 | g[7]);    // ::ffff:a.b.c.d
  }
  uint32_t a;
  return ipv4(h, a) && localV4(a);
}

bool isHa(const Answer& a) { return a.status == 200 && isHaProviders(a.body); }

}  // namespace

Parsed parse(const std::string& input) {
  Parsed p;
  std::string s = trim(input);
  if (s.empty()) {
    p.error = "Enter the Home Assistant address.";
    return p;
  }
  std::string scheme;
  if (size_t n = schemeLen(s, scheme)) {
    if (scheme != "http" && scheme != "https") {
      p.error = "Use an http or https address, like homeassistant.local:8123.";
      return p;
    }
    s.erase(0, n);
  }
  size_t cut = s.find_first_of("/?#");
  if (cut != std::string::npos) s.erase(cut);
  // host: [a-z0-9._-]+ or [v6]; then optional :1–5 digits
  size_t i = 0;
  if (!s.empty() && s[0] == '[') {
    i = 1;
    while (i < s.size() && v6Char(s[i])) ++i;
    if (i == 1 || i >= s.size() || s[i] != ']') {
      p.error = kNotAddress;
      return p;
    }
    ++i;
  } else {
    while (i < s.size() && hostChar(s[i])) ++i;
    if (i == 0) {
      p.error = kNotAddress;
      return p;
    }
  }
  const std::string host = lower(s.substr(0, i));
  if (localOnly(host)) {
    p.error = kNotHere;
    return p;
  }
  int port = 0;
  bool hasPort = false;
  if (i < s.size()) {
    const std::string digits = s.substr(i + 1);
    bool ok = s[i] == ':' && !digits.empty() && digits.size() <= 5;
    for (char c : digits) ok = ok && std::isdigit(static_cast<unsigned char>(c));
    if (ok) port = std::atoi(digits.c_str());
    if (!ok || port < 1 || port > 65535) {
      p.error = kNotAddress;
      return p;
    }
    hasPort = true;
  }
  // The other scheme keeps only HA's own 8123; another port belongs to the typed scheme (a proxy, #75).
  const int altPort = port == kDefaultPort ? port : 0;
  if (!scheme.empty()) {
    p.url = origin(scheme, host, port);
    p.alt = origin(scheme == "http" ? "https" : "http", host, altPort);
    p.typed = true;
  } else {
    p.url = origin("http", host, hasPort ? port : kDefaultPort);
    p.alt = origin("https", host, altPort);
  }
  return p;
}

bool isHaProviders(const std::string& body) {
  Json j;
  if (!parseJson(body, j)) return false;
  const Json* list = j.isArr() ? &j : j.isObj() ? j.get("providers") : nullptr;
  if (!list || !list->isArr() || list->arr.empty()) return false;
  for (auto& p : list->arr) {
    const Json* t = p.isObj() ? p.get("type") : nullptr;
    if (!t || !t->isStr()) return false;
  }
  return true;
}

std::string originOf(const std::string& location) {
  const std::string s = trim(location);
  std::string scheme;
  size_t n = schemeLen(s, scheme);
  if (!n || (scheme != "http" && scheme != "https")) return {};
  size_t end = s.find_first_of("/?#", n);
  std::string hp = s.substr(n, end == std::string::npos ? std::string::npos : end - n);
  if (hp.empty()) return {};
  hp = lower(hp);
  const std::string def = scheme == "https" ? ":443" : ":80";
  if (hp.size() > def.size() && hp.compare(hp.size() - def.size(), def.size(), def) == 0) hp.erase(hp.size() - def.size());
  return scheme + "://" + hp;
}

Resolved resolve(const std::string& input, const std::function<Answer(const std::string& url)>& probe) {
  Resolved r;
  Parsed a = parse(input);
  if (!a.error.empty()) {
    r.status = 422;
    r.error = a.error;
    return r;
  }
  const Answer first = probe(a.url);
  if (isHa(first)) {
    r.url = a.url;
    return r;
  }
  // Only the https upgrade of the same host and port is followed (#75); any other redirect is refused.
  const std::string moved = first.status >= 300 && first.status < 400 ? originOf(first.location) : std::string();
  const bool upgrade = a.url.rfind("http://", 0) == 0 && moved == "https://" + a.url.substr(7);
  const std::string next = upgrade ? moved : a.alt;
  if (isHa(probe(next))) {
    if (a.typed && next.rfind("http://", 0) == 0 && a.url.rfind("https://", 0) == 0) {
      r.status = 422;
      r.error = "Home Assistant answers at " + next + ", not over https. Use that address.";
      return r;
    }
    r.url = next;
    return r;
  }
  if (first.status <= 0) {
    r.status = 502;
    r.error = "The display can’t reach " + a.url + ". Check the address and that Home Assistant is running.";
  } else if (!moved.empty() && !upgrade && moved != a.url) {
    r.status = 422;
    r.error = a.url + " redirects to another address. Enter the Home Assistant address itself.";
  } else {
    r.status = 422;
    r.error = a.url + " answers, but it is not Home Assistant.";
  }
  return r;
}

}  // namespace x4::ha_address
