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
  if (c_->write(hdr, h) != h) return false;
  uint8_t buf[256];
  size_t off = 0;
  while (off < len) {
    size_t n = std::min(sizeof buf, len - off);
    for (size_t i = 0; i < n; i++) buf[i] = data[off + i] ^ mask[(off + i) & 3];
    if (c_->write(buf, n) != n) return false;
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
    if (rx_.size() > kMaxMessage + 16) break;
  }
  return parse(msg);
}

bool WsClient::parse(std::string& msg) {
  for (;;) {
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
