// Minimal RFC 6455 client (text frames, fragmentation, ping/pong, close) over NetworkClient(Secure).
// Written instead of links2004/WebSockets because that library hard-caps messages at 15 KB, and Home
// Assistant's subscribe_entities snapshot / render_template results routinely exceed that. Messages are
// assembled in heap (PSRAM for large blocks) up to kMaxMessage by core/ws_reader (frame parsing, backpressure eink-ha-os#374).
#pragma once
#include <NetworkClient.h>

#include <memory>
#include <string>

#include "core/ws_reader.h"
#include "net/util.h"

namespace x4::net {

using x4::WsStream;

class WsClient {
 public:
  static constexpr size_t kMaxMessage = WsReader::kMaxMessage;
  static constexpr uint32_t kSendDeadlineMs = 5000;   // per frame; a stall past it drops the connection (eink-ha-os#248)

  bool connect(const Url& base, const std::string& path, uint32_t timeoutMs = 10000);  // blocking
  bool connected();
  bool sendText(const std::string& s);
  // Non-blocking: reads what is available; returns true when a complete text message was assembled.
  bool poll(std::string& msg);
  void close();
  uint32_t lastRxMs() const { return lastRxMs_; }
  bool ping();
  void setStream(WsStream* s) { stream_ = s; }

 private:
  bool sendFrame(uint8_t opcode, const uint8_t* data, size_t len);
  struct Tap : WsStream {   // forwards to stream_, logs dropped frames
    WsClient* c;
    explicit Tap(WsClient* w) : c(w) {}
    bool want(uint32_t id) override { return c->stream_ && c->stream_->want(id); }
    void begin(uint32_t id, uint64_t len) override { c->stream_->begin(id, len); }
    void chunk(const char* p, size_t n) override { c->stream_->chunk(p, n); }
    void end(uint32_t id, uint64_t len) override { c->stream_->end(id, len); }
    void dropped(uint32_t id, uint64_t len) override;
  };
  std::unique_ptr<NetworkClient> c_;
  WsStream* stream_ = nullptr;
  Tap tap_{this};
  WsReader rx_;
  uint32_t lastRxMs_ = 0;
  bool open_ = false;
};

}  // namespace x4::net
