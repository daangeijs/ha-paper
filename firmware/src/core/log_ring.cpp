#include "core/log_ring.h"

#include <cstring>

namespace x4::logs {

namespace {

struct Rec {   // on-buffer header, kHdr bytes
  uint32_t seq, ms, epoch;
  uint8_t level, tagLen;
  uint16_t msgLen;
};
static_assert(sizeof(Rec) == kHdr, "record header layout");

bool isAlnum(int c) { return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
bool isHex(int c) { return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f'); }
bool isJwt(int c) { return isAlnum(c) || c == '_' || c == '.' || c == '-'; }
bool inSet(const char* set, int c) { return c != 0 && std::strchr(set, c) != nullptr; }
constexpr const char* kSep = " \t:=\"'";
constexpr const char* kDelim = " \t\r\n,;&\"'<>(){}[]";
constexpr const char* kKeys[] = {"password", "passwd", "secret", "token", "bearer", "cookie", "session"};
int rank(char l) { return l == 'E' ? 0 : l == 'W' ? 1 : 2; }

bool startsCi(const char* s, size_t n, size_t i, const char* k) {
  for (size_t j = 0; k[j]; j++) {
    if (i + j >= n) return false;
    char c = s[i + j];
    if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    if (c != k[j]) return false;
  }
  return true;
}

void appendJsonStr(std::string& o, const char* s, size_t n) {
  o += '"';
  for (size_t i = 0; i < n; i++) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          static const char hex[] = "0123456789abcdef";
          o += "\\u00";
          o += hex[c >> 4];
          o += hex[c & 15];
        } else {
          o += char(c);
        }
    }
  }
  o += '"';
}

bool tagMatch(const std::string& tags, const char* tag, size_t n) {
  if (tags.empty()) return true;
  char up[kTagMax + 3];
  up[0] = ',';
  for (size_t i = 0; i < n; i++) up[i + 1] = (tag[i] >= 'a' && tag[i] <= 'z') ? char(tag[i] - 'a' + 'A') : tag[i];
  up[n + 1] = ',';
  return tags.find(std::string_view(up, n + 2)) != std::string::npos;
}

}  // namespace

size_t cutUtf8(std::string_view s, size_t max) {
  if (s.size() <= max) return s.size();
  size_t n = max;
  while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) n--;
  return n;
}

size_t redact(const char* s, size_t n, char* out, size_t cap) {
  size_t o = 0;
  auto put = [&](const char* p, size_t k) {
    for (size_t j = 0; j < k && o < cap; j++) out[o++] = p[j];
  };
  size_t i = 0;
  while (i < n) {
    bool done = false;
    for (const char* k : kKeys) {
      if (!startsCi(s, n, i, k)) continue;
      size_t j = i + std::strlen(k);
      bool colon = false, any = false;
      while (j < n && inSet(kSep, s[j])) {
        colon = colon || s[j] == ':' || s[j] == '=';
        any = true;
        j++;
      }
      const bool ok = std::strcmp(k, "bearer") == 0 ? any : colon;
      size_t v = j;
      while (v < n && !inSet(kDelim, s[v])) v++;
      if (ok && v > j) {
        put(s + i, j - i);
        put("***", 3);
        i = v;
        done = true;
        break;
      }
    }
    if (done) continue;
    const bool wordStart = i == 0 || !isAlnum(s[i - 1]);
    if (wordStart && n - i >= 3 && std::memcmp(s + i, "eyJ", 3) == 0) {
      size_t j = i + 3;
      while (j < n && isJwt(s[j])) j++;
      if (j - i - 3 >= 8) { put("eyJ***", 6); i = j; continue; }
    }
    if (wordStart && n - i >= 3 && std::memcmp(s + i, "x4_", 3) == 0) {
      size_t j = i + 3;
      while (j < n && isAlnum(s[j])) j++;
      if (j - i - 3 >= 20) { put("x4_***", 6); i = j; continue; }
    }
    if (wordStart && isHex(s[i])) {
      size_t j = i;
      while (j < n && isHex(s[j])) j++;
      if (j - i >= 32 && !(j < n && isAlnum(s[j]))) put("***", 3);
      else put(s + i, j - i);
      i = j;
      continue;
    }
    put(s + i, 1);
    i++;
  }
  return o;
}

std::string redact(std::string_view in) {
  std::string out(in.size() * 2 + 8, '\0');   // a value shorter than "***" grows the text
  out.resize(redact(in.data(), in.size(), &out[0], out.size()));
  return out;
}

bool parseQuery(const char* since, const char* level, const char* tag, const char* limit, Query& q, std::string& err) {
  auto num = [](const char* s, uint64_t& v) {
    const size_t n = std::strlen(s);
    if (n < 1 || n > 10) return false;
    v = 0;
    for (size_t i = 0; i < n; i++) {
      if (s[i] < '0' || s[i] > '9') return false;
      v = v * 10 + uint64_t(s[i] - '0');
    }
    return true;
  };
  q = Query();
  uint64_t v = 0;
  if (since && *since) {
    if (!num(since, v) || v > 0xFFFFFFFFull) { err = "since must be a line number"; return false; }
    q.since = uint32_t(v);
  }
  if (level && *level) {
    const char c = level[1] ? 0 : (level[0] >= 'a' && level[0] <= 'z') ? char(level[0] - 'a' + 'A') : level[0];
    if (c != 'E' && c != 'W' && c != 'I') { err = "level must be E, W or I"; return false; }
    q.level = c;
  }
  if (tag && *tag) {
    std::string cur;
    auto flush = [&] {
      size_t a = 0, b = cur.size();
      while (a < b && (cur[a] == ' ' || cur[a] == '\t')) a++;
      while (b > a && (cur[b - 1] == ' ' || cur[b - 1] == '\t')) b--;
      if (b > a) q.tags += (q.tags.empty() ? "," : "") + cur.substr(a, b - a) + ",";
      cur.clear();
    };
    for (const char* p = tag; *p; p++) {
      if (*p == ',') flush();
      else cur += (*p >= 'a' && *p <= 'z') ? char(*p - 'a' + 'A') : *p;
    }
    flush();
  }
  if (limit && *limit) {
    if (!num(limit, v) || v < 1 || v > uint64_t(kLimitMax)) { err = "limit must be 1 to " + std::to_string(kLimitMax); return false; }
    q.limit = int(v);
  }
  return true;
}

void Ring::init(uint32_t cap) { *h_ = Hdr{cap, 0, 0, 1, 0}; }

void Ring::copyOut(uint32_t off, void* dst, uint32_t n) const {
  const uint32_t first = h_->cap - off < n ? h_->cap - off : n;
  std::memcpy(dst, d_ + off, first);
  if (n > first) std::memcpy(static_cast<uint8_t*>(dst) + first, d_, n - first);
}

void Ring::copyIn(uint32_t off, const void* src, uint32_t n) {
  const uint32_t first = h_->cap - off < n ? h_->cap - off : n;
  std::memcpy(d_ + off, src, first);
  if (n > first) std::memcpy(d_, static_cast<const uint8_t*>(src) + first, n - first);
}

uint32_t Ring::recSize(uint32_t off) const {
  Rec r;
  copyOut(off, &r, kHdr);
  return kHdr + r.tagLen + r.msgLen;
}

bool Ring::valid(uint32_t cap) const {
  const Hdr& h = *h_;
  if (h.cap != cap || h.head >= cap || h.used > cap || h.count > cap / kHdr || h.next == 0) return false;
  uint32_t off = h.head, sum = 0, seq = 0;
  for (uint32_t i = 0; i < h.count; i++) {
    if (h.used - sum < kHdr) return false;
    Rec r;
    copyOut(off, &r, kHdr);
    const uint32_t size = kHdr + r.tagLen + r.msgLen;
    if (r.tagLen > kTagMax || r.msgLen > kMsgMax || size > h.used - sum) return false;
    if (r.level != 'E' && r.level != 'W' && r.level != 'I') return false;
    if (i && r.seq != seq + 1) return false;
    seq = r.seq;
    sum += size;
    off = (off + size) % cap;
  }
  return sum == h.used && (h.count == 0 || seq + 1 == h.next);
}

void Ring::push(uint32_t ms, uint32_t epoch, char level, std::string_view tag, std::string_view msg) {
  const uint32_t tl = uint32_t(cutUtf8(tag, kTagMax)), ml = uint32_t(cutUtf8(msg, kMsgMax));
  const uint32_t size = kHdr + tl + ml;
  Hdr& h = *h_;
  if (size > h.cap) return;
  while (h.count && h.used + size > h.cap) {
    const uint32_t s = recSize(h.head);
    h.head = (h.head + s) % h.cap;
    h.used -= s;
    h.count--;
  }
  const Rec r{h.next, ms, epoch, uint8_t(level), uint8_t(tl), uint16_t(ml)};
  uint32_t off = (h.head + h.used) % h.cap;
  copyIn(off, &r, kHdr);
  off = (off + kHdr) % h.cap;
  copyIn(off, tag.data(), tl);
  off = (off + tl) % h.cap;
  copyIn(off, msg.data(), ml);
  h.used += size;
  h.count++;
  h.next++;
}

void Ring::queryJson(const Query& q, const char* boot, std::string& out) const {
  const Hdr& h = *h_;
  uint32_t first = h.next, seq = h.next - 1;
  bool more = false;
  const size_t start = out.size();
  out.reserve(start + h.used + h.count * 56 + 96);   // JSON keys per line; one block (PSRAM on the device when large)
  std::string& lines = out;
  int n = 0;
  uint32_t off = h.head;
  for (uint32_t i = 0; i < h.count; i++) {
    Rec r;
    copyOut(off, &r, kHdr);
    const uint32_t size = kHdr + r.tagLen + r.msgLen;
    if (i == 0) first = r.seq;
    char text[kTagMax + kMsgMax];
    copyOut((off + kHdr) % h.cap, text, r.tagLen + r.msgLen);
    off = (off + size) % h.cap;
    if (r.seq <= q.since) continue;
    if (q.level && rank(char(r.level)) > rank(q.level)) continue;
    if (!tagMatch(q.tags, text, r.tagLen)) continue;
    lines += n ? ",{\"seq\":" : "{\"seq\":";
    lines += std::to_string(r.seq);
    lines += ",\"ms\":";
    lines += std::to_string(r.ms);
    lines += ",\"epoch\":";
    lines += r.epoch ? std::to_string(r.epoch) : "null";
    lines += ",\"level\":\"";
    lines += char(r.level);
    lines += "\",\"tag\":";
    appendJsonStr(lines, text, r.tagLen);
    lines += ",\"msg\":";
    appendJsonStr(lines, text + r.tagLen, r.msgLen);
    lines += '}';
    if (++n >= q.limit) {
      seq = r.seq;
      more = i + 1 < h.count;
      break;
    }
  }
  std::string head = "{\"boot\":\"";
  head += boot;
  head += "\",\"seq\":" + std::to_string(seq) + ",\"first\":" + std::to_string(first);
  head += ",\"dropped\":";
  head += q.since > 0 && uint64_t(q.since) + 1 < first ? "true" : "false";
  head += ",\"more\":";
  head += more ? "true" : "false";
  head += ",\"lines\":[";
  out.insert(start, head);
  out += "]}";
}

}  // namespace x4::logs
