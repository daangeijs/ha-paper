#include "net/ws_client.h"

#include <Arduino.h>
#include <NetworkClientSecure.h>

#include <algorithm>
#include <cstring>
#include <new>
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
  rx_.reset();
  rx_.setStream(&tap_);
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
  rx_.reset();
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
  // Each write can block in lwIP / ssl_client for up to the socket timeout without feeding the TWDT (eink-ha-os#248): leave it
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

// Reads only while the reader has room (eink-ha-os#374): a complete frame waiting at the front stops the reads, so a server that
// outpaces the device fills TCP windows instead of the heap. HA itself then drops a client whose queue backs up.
bool WsClient::poll(std::string& msg) {
  if (!c_) return false;
  if (!c_->connected()) {
    open_ = false;
    return false;
  }
  uint8_t buf[2048];
  size_t budget = 64 * 1024;   // don't monopolise the net task
  try {
    for (;;) {
      size_t room;
      while (budget && (room = rx_.room()) && c_->available()) {
        int n = c_->read(buf, std::min({sizeof buf, budget, room}));
        if (n <= 0) break;
        rx_.feed(reinterpret_cast<const char*>(buf), static_cast<size_t>(n));   // streamed / dropped frames pass through
        budget -= static_cast<size_t>(n);
        lastRxMs_ = millis();
      }
      switch (rx_.next(msg)) {
        case WsReader::Ev::Text:
          return true;
        case WsReader::Ev::Ping:
          sendFrame(0xA, reinterpret_cast<const uint8_t*>(msg.data()), msg.size());
          msg.clear();
          continue;
        case WsReader::Ev::Close:
          LOG_INF("WS", "server closed the connection");
          close();
          return false;
        case WsReader::Ev::TooLarge:
          LOG_ERR("WS", "message over %u bytes · closing", unsigned(kMaxMessage));
          close();
          return false;
        case WsReader::Ev::None:
          return false;
      }
    }
  } catch (const std::bad_alloc&) {   // never abort the net task on a message: drop the socket, HaClient reconnects
    LOG_ERR("WS", "out of memory · %u B buffered · closing", unsigned(rx_.buffered()));
    open_ = false;
    c_->stop();
    rx_.reset();
    return false;
  }
}

void WsClient::Tap::dropped(uint32_t id, uint64_t len) {
  LOG_WRN("WS", "frame too large (%llu bytes, id %u) · dropped", static_cast<unsigned long long>(len), unsigned(id));
  if (c->stream_) c->stream_->dropped(id, len);
}

}  // namespace x4::net
