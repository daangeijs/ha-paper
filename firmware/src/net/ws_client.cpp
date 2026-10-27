#include "net/ws_client.h"

#include <Arduino.h>
#include <NetworkClientSecure.h>

#include <algorithm>
#include <cstring>
#include <utility>

#include "Logging.h"
#include "hw/watchdog.h"
#include "net/health.h"
#include "net/tls.h"

namespace x4::net {

bool WsClient::connect(const Url& base, const std::string& path, uint32_t timeoutMs) {
  close();
  if (base.tls && !tlsHeapOk(base.host.c_str())) return false;
  if (base.tls) {
    auto* s = new NetworkClientSecure();
    attachCaBundle(*s);
    c_.reset(s);
  } else {
    c_.reset(new NetworkClient());
  }
  c_->setTimeout(timeoutMs);   // Stream timeout, ms (also bounds blocking writes / TLS handshake)
  bool ok;
  if (base.tls) {
    ok = tlsConnect(static_cast<NetworkClientSecure&>(*c_), base.host.c_str(), base.port, timeoutMs) == 0;
  } else {
    wdt::BlockingCall b("ws connect");   // DNS + TCP connect
    ok = c_->connect(base.host.c_str(), base.port, static_cast<int32_t>(timeoutMs));
  }
  if (!ok) {
    LOG_WRN("WS", "connect %s:%u failed", base.host.c_str(), base.port);
    close();
    return false;
  }
  c_->setNoDelay(true);
  c_->setTimeout(kSendDeadlineMs);   // SO_SNDTIMEO from here on: one blocked write ≤ ~5 s (TLS: ≤ ~10 s, its own loop)
  uint8_t key[16];
  randomBytes(key, sizeof key);
  std::string req = "GET " + path + " HTTP/1.1\r\nHost: " + base.host;
  if (!((base.tls && base.port == 443) || (!base.tls && base.port == 80))) req += ":" + std::to_string(base.port);
  req += "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " +
         base64Encode(key, sizeof key) + "\r\nUser-Agent: HA-Paper/" + firmwareVersion() + "\r\n\r\n";
  c_->write(reinterpret_cast<const uint8_t*>(req.data()), req.size());

  // Read the HTTP response head.
  std::string head;
  const uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    wdt::feedIfSubscribed();
    while (c_->available()) {
      int ch = c_->read();
      if (ch < 0) break;
      head.push_back(static_cast<char>(ch));
      if (head.size() >= 4 && head.compare(head.size() - 4, 4, "\r\n\r\n") == 0) goto done;
      if (head.size() > 4096) break;
    }
    if (!c_->connected()) break;
    delay(5);
  }
done:
  if (head.rfind("HTTP/1.1 101", 0) != 0) {
    LOG_WRN("WS", "upgrade refused: %.40s", head.c_str());
    close();
    return false;
  }
  open_ = true;
  lastRxMs_ = millis();
  rx_.clear();
  frag_.clear();
  skip_ = 0;
  streaming_ = false;
  return true;
}

bool WsClient::connected() { return open_ && c_ && c_->connected(); }

void WsClient::close() {
  if (c_) {
    if (open_ && c_->connected()) {
      const uint8_t code[2] = {0x03, 0xE8};   // 1000 normal
      sendFrame(0x8, code, 2);
    }
    c_->stop();
  }
  c_.reset();
  open_ = false;
  rx_.clear();
  frag_.clear();
  skip_ = 0;
  streaming_ = false;
}

bool WsClient::sendFrame(uint8_t opcode, const uint8_t* data, size_t len) {
  if (!c_ || !c_->connected()) return false;
  uint8_t hdr[14];
  size_t h = 0;
  hdr[h++] = 0x80 | opcode;
  if (len < 126) {
    hdr[h++] = 0x80 | static_cast<uint8_t>(len);
  } else if (len < 65536) {
    hdr[h++] = 0x80 | 126;
    hdr[h++] = static_cast<uint8_t>(len >> 8);
    hdr[h++] = static_cast<uint8_t>(len);
  } else {
    hdr[h++] = 0x80 | 127;
    for (int i = 7; i >= 0; i--) hdr[h++] = static_cast<uint8_t>(static_cast<uint64_t>(len) >> (8 * i));
  }
  uint8_t mask[4];
  randomBytes(mask, 4);
  memcpy(hdr + h, mask, 4);
  h += 4;
  // Each write can block in lwIP / ssl_client for up to the socket timeout without feeding the TWDT (#248): leave it
  // for the frame, stop at the frame deadline and drop the socket; HaClient::loop sees !connected() and reconnects.
  wdt::BlockingCall b("ws send");
  const uint32_t t0 = millis();
  auto stalled = [&](size_t left) {
    if (c_->connected()) LOG_WRN("WS", "write stalled · %u B left · reconnect", unsigned(left));
    open_ = false;   // no close frame on a stalled socket
    c_->stop();
    return false;
  };
  if (c_->write(hdr, h) != h) return stalled(h + len);
  uint8_t buf[256];
  size_t off = 0;
  while (off < len) {
    if (millis() - t0 >= kSendDeadlineMs) return stalled(len - off);
    size_t n = std::min(sizeof buf, len - off);
    for (size_t i = 0; i < n; i++) buf[i] = data[off + i] ^ mask[(off + i) & 3];
    if (c_->write(buf, n) != n) return stalled(len - off);
    off += n;
  }
  return true;
}

bool WsClient::sendText(const std::string& s) {
  return sendFrame(0x1, reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

bool WsClient::ping() { return sendFrame(0x9, nullptr, 0); }

bool WsClient::poll(std::string& msg) {
  if (!c_) return false;
  if (!c_->connected()) {
    open_ = false;
    return false;
  }
  uint8_t buf[2048];
  size_t budget = 64 * 1024;   // don't monopolise the net task
  while (budget && c_->available()) {
    int n = c_->read(buf, std::min(sizeof buf, budget));
    if (n <= 0) break;
    rx_.append(reinterpret_cast<char*>(buf), n);
    budget -= n;
    lastRxMs_ = millis();
    skip();   // a streamed / dropped frame never piles up in rx_
    if (rx_.size() > kMaxMessage + 16) break;
  }
  return parse(msg);
}

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
}  // namespace

void WsClient::skip() {
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
    if (rx_.size() < 2) return;
    const uint8_t* p = reinterpret_cast<const uint8_t*>(rx_.data());
    const uint8_t op = p[0] & 0x0F;
    const bool fin = p[0] & 0x80, masked = p[1] & 0x80;
    uint64_t len = p[1] & 0x7F;
    size_t h = 2;
    if (len == 126) {
      if (rx_.size() < 4) return;
      len = (static_cast<uint64_t>(p[2]) << 8) | p[3];
      h = 4;
    } else if (len == 127) {
      if (rx_.size() < 10) return;
      len = 0;
      for (int i = 0; i < 8; i++) len = (len << 8) | p[2 + i];
      h = 10;
    }
    if (masked) h += 4;   // servers never mask; such a frame only ever gets dropped
    const bool text = op == 0x1 && fin && !masked;
    if (!text && len <= kMaxMessage) return;
    uint32_t id = 0;
    if (text) {
      const size_t peek = static_cast<size_t>(std::min<uint64_t>(len, 24));
      if (rx_.size() < h + peek) return;
      id = peekId(rx_.data() + h, peek);
    }
    const bool over = len > kMaxMessage;
    if (!over && !(id && stream_ && stream_->want(id))) return;   // the normal path
    if (over) LOG_WRN("WS", "frame too large (%llu bytes, id %u) · dropped", static_cast<unsigned long long>(len), unsigned(id));
    rx_.erase(0, h);
    skip_ = skipLen_ = len;
    skipId_ = id;
    streaming_ = !over;
    if (streaming_) stream_->begin(id, len);
    if (!skip_) {   // empty payload
      if (stream_) streaming_ ? stream_->end(id, 0) : stream_->dropped(id, 0);
      streaming_ = false;
    }
  }
}

bool WsClient::parse(std::string& msg) {
  for (;;) {
    skip();
    if (skip_) return false;
    if (rx_.size() < 2) return false;
    const uint8_t* p = reinterpret_cast<const uint8_t*>(rx_.data());
    const bool fin = p[0] & 0x80;
    const uint8_t op = p[0] & 0x0F;
    const bool masked = p[1] & 0x80;
    uint64_t len = p[1] & 0x7F;
    size_t h = 2;
    if (len == 126) {
      if (rx_.size() < 4) return false;
      len = (static_cast<uint64_t>(p[2]) << 8) | p[3];
      h = 4;
    } else if (len == 127) {
      if (rx_.size() < 10) return false;
      len = 0;
      for (int i = 0; i < 8; i++) len = (len << 8) | p[2 + i];
      h = 10;
    }
    if (len > kMaxMessage) {
      LOG_ERR("WS", "frame too large (%llu bytes) — closing", static_cast<unsigned long long>(len));
      close();
      return false;
    }
    uint8_t mask[4] = {0, 0, 0, 0};
    if (masked) {
      if (rx_.size() < h + 4) return false;
      memcpy(mask, p + h, 4);
      h += 4;
    }
    if (rx_.size() < h + len) return false;
    std::string payload = rx_.substr(h, static_cast<size_t>(len));
    rx_.erase(0, h + static_cast<size_t>(len));
    if (masked)
      for (size_t i = 0; i < payload.size(); i++) payload[i] ^= mask[i & 3];

    switch (op) {
      case 0x9:   // ping → pong
        sendFrame(0xA, reinterpret_cast<const uint8_t*>(payload.data()), payload.size());
        continue;
      case 0xA:   // pong
        continue;
      case 0x8:   // close
        LOG_INF("WS", "server closed the connection");
        close();
        return false;
      case 0x0:   // continuation
        if (frag_.size() + payload.size() > kMaxMessage) {
          close();
          return false;
        }
        frag_ += payload;
        if (fin) {
          if (fragOp_ == 0x1) {
            msg.swap(frag_);
            frag_.clear();
            return true;
          }
          frag_.clear();
        }
        continue;
      case 0x1:
      case 0x2:
        if (fin) {
          if (op == 0x1) {
            msg.swap(payload);
            return true;
          }
          continue;   // binary: ignored
        }
        fragOp_ = op;
        frag_ = std::move(payload);
        continue;
      default:
        continue;
    }
  }
}

}  // namespace x4::net
