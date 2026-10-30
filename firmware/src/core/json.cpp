#include "core/json.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <cstdint>

namespace x4 {

const Json* Json::get(const std::string& key) const {
  if (type != Type::Object) return nullptr;
  for (auto& kv : obj) if (kv.first == key) return &kv.second;
  return nullptr;
}

namespace {

void skipWs(const std::string& t, size_t& p) {
  while (p < t.size() && (t[p] == ' ' || t[p] == '\t' || t[p] == '\n' || t[p] == '\r')) ++p;
}

void putUtf8(std::string& o, uint32_t cp) {
  if (cp < 0x80) o += char(cp);
  else if (cp < 0x800) { o += char(0xC0 | (cp >> 6)); o += char(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) { o += char(0xE0 | (cp >> 12)); o += char(0x80 | ((cp >> 6) & 0x3F)); o += char(0x80 | (cp & 0x3F)); }
  else { o += char(0xF0 | (cp >> 18)); o += char(0x80 | ((cp >> 12) & 0x3F)); o += char(0x80 | ((cp >> 6) & 0x3F)); o += char(0x80 | (cp & 0x3F)); }
}

bool hex4(const std::string& t, size_t p, uint32_t& v) {
  if (p + 4 > t.size()) return false;
  v = 0;
  for (size_t i = p; i < p + 4; ++i) {
    char c = t[i]; v <<= 4;
    if (c >= '0' && c <= '9') v |= c - '0';
    else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
    else return false;
  }
  return true;
}

bool parseValue(const std::string& t, size_t& p, Json& out, int depth);

bool parseNumber(const std::string& t, size_t& p, Json& out) {
  size_t s = p;
  if (p < t.size() && t[p] == '-') ++p;
  if (p >= t.size()) return false;
  if (t[p] == '0') ++p;
  else if (t[p] >= '1' && t[p] <= '9') { while (p < t.size() && isdigit((unsigned char)t[p])) ++p; }
  else return false;
  if (p < t.size() && t[p] == '.') { ++p; size_t d = p; while (p < t.size() && isdigit((unsigned char)t[p])) ++p; if (p == d) return false; }
  if (p < t.size() && (t[p] == 'e' || t[p] == 'E')) {
    ++p; if (p < t.size() && (t[p] == '+' || t[p] == '-')) ++p;
    size_t d = p; while (p < t.size() && isdigit((unsigned char)t[p])) ++p; if (p == d) return false;
  }
  out.type = Json::Type::Number;
  out.num = std::strtod(t.substr(s, p - s).c_str(), nullptr);
  return true;
}

bool parseValue(const std::string& t, size_t& p, Json& out, int depth) {
  if (depth > 32) return false;
  skipWs(t, p);
  if (p >= t.size()) return false;
  char c = t[p];
  if (c == '"') { out.type = Json::Type::String; return parseJsonString(t, p, out.str); }
  if (c == '{') {
    out.type = Json::Type::Object; ++p; skipWs(t, p);
    if (p < t.size() && t[p] == '}') { ++p; return true; }
    for (;;) {
      skipWs(t, p);
      if (p >= t.size() || t[p] != '"') return false;
      std::string k; if (!parseJsonString(t, p, k)) return false;
      skipWs(t, p); if (p >= t.size() || t[p] != ':') return false; ++p;
      Json v; if (!parseValue(t, p, v, depth + 1)) return false;
      auto it = out.obj.begin();
      while (it != out.obj.end() && it->first != k) ++it;
      if (it != out.obj.end()) it->second = std::move(v);   // duplicate key: last wins
      else out.obj.emplace_back(std::move(k), std::move(v));
      skipWs(t, p); if (p >= t.size()) return false;
      if (t[p] == ',') { ++p; continue; }
      if (t[p] == '}') { ++p; return true; }
      return false;
    }
  }
  if (c == '[') {
    out.type = Json::Type::Array; ++p; skipWs(t, p);
    if (p < t.size() && t[p] == ']') { ++p; return true; }
    for (;;) {
      Json v; if (!parseValue(t, p, v, depth + 1)) return false;
      out.arr.push_back(std::move(v));
      skipWs(t, p); if (p >= t.size()) return false;
      if (t[p] == ',') { ++p; continue; }
      if (t[p] == ']') { ++p; return true; }
      return false;
    }
  }
  if (t.compare(p, 4, "true") == 0) { out.type = Json::Type::Bool; out.b = true; p += 4; return true; }
  if (t.compare(p, 5, "false") == 0) { out.type = Json::Type::Bool; out.b = false; p += 5; return true; }
  if (t.compare(p, 4, "null") == 0) { out.type = Json::Type::Null; p += 4; return true; }
  return parseNumber(t, p, out);
}

}  // namespace

bool parseJsonString(const std::string& t, size_t& p, std::string& out) {
  if (p >= t.size() || t[p] != '"') return false;
  ++p; out.clear();
  while (p < t.size()) {
    unsigned char c = t[p];
    if (c == '"') { ++p; return true; }
    if (c < 0x20) return false;
    if (c != '\\') { out += char(c); ++p; continue; }
    if (++p >= t.size()) return false;
    char e = t[p++];
    switch (e) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u': {
        uint32_t v; if (!hex4(t, p, v)) return false; p += 4;
        if (v >= 0xD800 && v < 0xDC00 && p + 6 <= t.size() && t[p] == '\\' && t[p + 1] == 'u') {
          uint32_t lo; if (hex4(t, p + 2, lo) && lo >= 0xDC00 && lo < 0xE000) { p += 6; v = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00); }
        }
        putUtf8(out, v);
        break;
      }
      default: return false;
    }
  }
  return false;
}

bool parseJson(const std::string& text, Json& out) {
  size_t p = 0;
  out = Json();
  if (!parseValue(text, p, out, 0)) return false;
  skipWs(text, p);
  return p == text.size();
}

std::string jsonQuote(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\b': o += "\\b"; break;
      case '\f': o += "\\f"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += char(c);
    }
  }
  return o + "\"";
}

std::string jsNumber(double v) {
  if (std::isnan(v)) return "NaN";
  if (std::isinf(v)) return v < 0 ? "-Infinity" : "Infinity";
  if (v == 0) return "0";
  char b[40];
  if (std::fabs(v) < 1e21 && v == std::floor(v)) { std::snprintf(b, sizeof b, "%.0f", v); return b; }
  for (int prec = 1; prec <= 17; ++prec) {
    std::snprintf(b, sizeof b, "%.*g", prec, v);
    if (std::strtod(b, nullptr) == v) break;
  }
  std::string s = b;
  auto e = s.find('e');
  if (e != std::string::npos) {   // JS style exponent: 1e+21, 1.5e-7
    std::string mant = s.substr(0, e), ex = s.substr(e + 1);
    int n = std::atoi(ex.c_str());
    if (n >= -6 && n < 21) {      // JS prints these without exponent
      std::snprintf(b, sizeof b, "%.*f", n < 0 ? 17 - n > 20 ? 20 : 17 - n : 0, v);
      s = b;
      if (s.find('.') != std::string::npos) { while (s.back() == '0') s.pop_back(); if (s.back() == '.') s.pop_back(); }
      return s;
    }
    return mant + "e" + (n >= 0 ? "+" : "-") + std::to_string(n < 0 ? -n : n);
  }
  return s;
}

std::string toFixed(double v, int digits) {
  if (std::isnan(v)) return "NaN";
  bool neg = v < 0;
  double a = neg ? -v : v;
  if (a >= 1e21) return jsNumber(v);
  // exact decimal expansion of the double, then round half up by hand: a < 1e21 → ≤ 21 + 1 + 60 chars
  char buf[96];
  std::snprintf(buf, sizeof buf, "%.60f", a);
  std::string s = buf;
  size_t dot = s.find('.');
  std::string ip = s.substr(0, dot), fp = s.substr(dot + 1);
  std::string keep = ip + fp.substr(0, digits);
  bool up = fp.size() > size_t(digits) && fp[digits] >= '5';
  if (up) {
    int i = int(keep.size()) - 1;
    while (i >= 0) { if (keep[i] == '9') { keep[i] = '0'; --i; } else { keep[i]++; break; } }
    if (i < 0) keep = "1" + keep;
  }
  std::string intPart = keep.substr(0, keep.size() - digits);
  std::string frac = keep.substr(keep.size() - digits);
  size_t nz = intPart.find_first_not_of('0');
  intPart = nz == std::string::npos ? "0" : intPart.substr(nz);
  std::string r = digits > 0 ? intPart + "." + frac : intPart;
  return neg ? "-" + r : r;   // JS keeps the sign: (-0.04).toFixed(1) === "-0.0"
}

double jsRound(double v) { return std::floor(v + 0.5); }

}  // namespace x4
