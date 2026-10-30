#include "core/ws_reader.h"

#include <algorithm>
#include <cstring>
#include <utility>

namespace x4 {

namespace {
// {"id":N at the start of a payload → N, else 0
uint32_t peekId(const char* p, size_t n) {
  static const char kHead[] = "{\"id\":";
  size_t i = 0, k = 0;
  for (; i < n && kHead[k]; ++i) {
    if (p[i] == ' ' && (k == 1 || k == 5)) continue;
    if (p[i] != kHead[k++]) return 0;
  }
  while (i < n && p[i] == ' ') ++i;
  uint32_t id = 0;
  size_t d = i;
  for (; i < n && p[i] >= '0' && p[i] <= '9' && i - d < 9; ++i) id = id * 10 + uint32_t(p[i] - '0');
  return i > d && i < n && (p[i] == ',' || p[i] == ' ' || p[i] == '}') ? id : 0;
}

struct Head {
  bool fin, masked;
  uint8_t op;
  uint64_t len;
  size_t h;   // header bytes incl. mask key
};

// false: not enough bytes for the header yet
bool head(const std::string& rx, Head& f) {
  if (rx.size() < 2) return false;
  const uint8_t* p = reinterpret_cast<const uint8_t*>(rx.data());
  f.fin = p[0] & 0x80;
  f.op = p[0] & 0x0F;
  f.masked = p[1] & 0x80;
  f.len = p[1] & 0x7F;
  f.h = 2;
  if (f.len == 126) {
    if (rx.size() < 4) return false;
    f.len = (static_cast<uint64_t>(p[2]) << 8) | p[3];
    f.h = 4;
  } else if (f.len == 127) {
    if (rx.size() < 10) return false;
    f.len = 0;
    for (int i = 0; i < 8; i++) f.len = (f.len << 8) | p[2 + i];
    f.h = 10;
  }
  if (f.masked) f.h += 4;   // servers never mask; accepted anyway
  return true;
}
}  // namespace

void WsReader::reset() {
  std::string().swap(rx_);
  std::string().swap(frag_);
  skip_ = skipLen_ = 0;
  skipId_ = 0;
  streaming_ = false;
  fragOp_ = 0;
}

size_t WsReader::room() const {
  if (skip_) return kSlack;   // rx_ is empty while a frame streams / drains
  Head f;
  if (!head(rx_, f) || f.len > kMaxMessage) return kSlack;
  const uint64_t total = f.h + f.len;
  if (rx_.size() >= total) return 0;
  return std::max<size_t>(kSlack, static_cast<size_t>(total - rx_.size()));
}

void WsReader::feed(const char* p, size_t n) {
  rx_.append(p, n);
  skip();
}

void WsReader::skip() {
  for (;;) {
    if (skip_) {
      size_t n = static_cast<size_t>(std::min<uint64_t>(skip_, rx_.size()));
      if (!n) return;
      if (streaming_ && stream_) stream_->chunk(rx_.data(), n);
      rx_.erase(0, n);
      skip_ -= n;
      if (skip_) return;
      if (stream_) {
        if (streaming_) stream_->end(skipId_, skipLen_);
        else stream_->dropped(skipId_, skipLen_);
      }
      streaming_ = false;
      continue;
    }
    Head f;
    if (!head(rx_, f)) return;
    const bool text = f.op == 0x1 && f.fin && !f.masked;
    if (!text && f.len <= kMaxMessage) return;
    uint32_t id = 0;
    if (text) {
      const size_t peek = static_cast<size_t>(std::min<uint64_t>(f.len, 24));
      if (rx_.size() < f.h + peek) return;
      id = peekId(rx_.data() + f.h, peek);
    }
    const bool over = f.len > kMaxMessage;
    if (!over && !(id && stream_ && stream_->want(id))) return;   // the normal path
    rx_.erase(0, f.h);
    skip_ = skipLen_ = f.len;
    skipId_ = id;
    streaming_ = !over;
    if (streaming_) stream_->begin(id, f.len);
    if (!skip_) {   // empty payload
      if (stream_) streaming_ ? stream_->end(id, 0) : stream_->dropped(id, 0);
      streaming_ = false;
    }
  }
}

WsReader::Ev WsReader::next(std::string& out) {
  for (;;) {
    skip();
    if (skip_) return Ev::None;
    Head f;
    if (!head(rx_, f)) return Ev::None;
    if (f.len > kMaxMessage) return Ev::TooLarge;   // skip() drops these; only without the header bytes
    if (rx_.size() < f.h + f.len) return Ev::None;
    uint8_t mask[4] = {0, 0, 0, 0};
    if (f.masked) memcpy(mask, rx_.data() + f.h - 4, 4);
    std::string payload = rx_.substr(f.h, static_cast<size_t>(f.len));
    rx_.erase(0, f.h + static_cast<size_t>(f.len));
    if (rx_.empty() && rx_.capacity() > 4 * kSlack) std::string().swap(rx_);   // a big frame's buffer goes back
    if (f.masked)
      for (size_t i = 0; i < payload.size(); i++) payload[i] ^= mask[i & 3];

    switch (f.op) {
      case 0x9:   // ping
        out.swap(payload);
        return Ev::Ping;
      case 0xA:   // pong
        continue;
      case 0x8:
        return Ev::Close;
      case 0x0:   // continuation
        if (frag_.size() + payload.size() > kMaxMessage) {
          std::string().swap(frag_);
          return Ev::TooLarge;
        }
        frag_ += payload;
        if (f.fin) {
          if (fragOp_ == 0x1) {
            out.swap(frag_);
            std::string().swap(frag_);
            return Ev::Text;
          }
          std::string().swap(frag_);
        }
        continue;
      case 0x1:
      case 0x2:
        if (f.fin) {
          if (f.op == 0x1) {
            out.swap(payload);
            return Ev::Text;
          }
          continue;   // binary: ignored
        }
        fragOp_ = f.op;
        frag_ = std::move(payload);
        continue;
      default:
        continue;
    }
  }
}

}  // namespace x4
