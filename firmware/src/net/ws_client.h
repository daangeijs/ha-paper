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

 private:
  bool sendFrame(uint8_t opcode, const uint8_t* data, size_t len);
  bool parse(std::string& msg);
  std::unique_ptr<NetworkClient> c_;
  std::string rx_, frag_;
  uint8_t fragOp_ = 0;
  uint32_t lastRxMs_ = 0;
  bool open_ = false;
};

}  // namespace x4::net
