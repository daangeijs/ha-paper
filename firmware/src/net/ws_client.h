// Minimal RFC 6455 client (text frames, fragmentation, ping/pong, close) over NetworkClient(Secure).
// Written instead of links2004/WebSockets because that library hard-caps messages at 15 KB, and Home
// Assistant's subscribe_entities snapshot / render_template results routinely exceed that. Messages are
// assembled in heap (PSRAM for large blocks) up to kMaxMessage.
#pragma once
#include <NetworkClient.h>

#include <memory>
#include <string>

#include "net/util.h"

namespace x4::net {

// Frames that skip the message buffer (#269). A text frame whose payload starts with {"id":N, want(N) true, streams to
// chunk() as it arrives (no copy of the frame); any frame over kMaxMessage is read and thrown away (dropped()) instead
// of closing the socket.
struct WsStream {
  virtual ~WsStream() = default;
  virtual bool want(uint32_t id) = 0;
  virtual void begin(uint32_t id, uint64_t len) = 0;
  virtual void chunk(const char* p, size_t n) = 0;
  virtual void end(uint32_t id, uint64_t len) = 0;
  virtual void dropped(uint32_t id, uint64_t len) = 0;   // id 0 = not a result frame
};

class WsClient {
 public:
  static constexpr size_t kMaxMessage = 512 * 1024;
  static constexpr uint32_t kSendDeadlineMs = 5000;   // per frame; a stall past it drops the connection (#248)

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
  bool parse(std::string& msg);
  void skip();   // stream / drop the frame at the front of rx_
  std::unique_ptr<NetworkClient> c_;
  WsStream* stream_ = nullptr;
  uint64_t skip_ = 0, skipLen_ = 0;   // payload bytes still to stream / drop
  uint32_t skipId_ = 0;
  bool streaming_ = false;
  std::string rx_, frag_;
  uint8_t fragOp_ = 0;
  uint32_t lastRxMs_ = 0;
  bool open_ = false;
};

}  // namespace x4::net
