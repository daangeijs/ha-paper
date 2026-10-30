// RFC 6455 receive side of net/ws_client (server → client frames), pure so the host tests drive it. The socket shell
// asks room() before every read: it is 0 while a whole frame waits at the front, so rx_ never holds more than one
// frame + kSlack and a server that sends faster than the device parses is held back by TCP, not by the heap (eink-ha-os#374:
// fake HA --tick 1 grew rx_ past 1 MB of PSRAM in 12 s → std::bad_alloc → reboot loop).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace x4 {

// Frames that skip the message buffer (eink-ha-os#269). A text frame whose payload starts with {"id":N, want(N) true, streams to
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

class WsReader {
 public:
  static constexpr size_t kMaxMessage = 512 * 1024;
  static constexpr size_t kSlack = 2048;   // read-ahead past the front frame (one socket read)

  enum class Ev { None, Text, Ping, Close, TooLarge };

  void setStream(WsStream* s) { stream_ = s; }
  void reset();
  // Bytes the reader takes now; 0 = a complete frame is buffered, call next() before reading more.
  size_t room() const;
  void feed(const char* p, size_t n);   // appends, then streams / drops what it can
  // Text: out = message. Ping: out = payload (send a pong). Close / TooLarge: drop the connection. None: need bytes.
  Ev next(std::string& out);
  size_t buffered() const { return rx_.size(); }
  size_t capacity() const { return rx_.capacity() + frag_.capacity(); }

 private:
  void skip();   // stream / drop the frame at the front of rx_
  std::string rx_, frag_;
  WsStream* stream_ = nullptr;
  uint64_t skip_ = 0, skipLen_ = 0;   // payload bytes still to stream / drop
  uint32_t skipId_ = 0;
  bool streaming_ = false;
  uint8_t fragOp_ = 0;
};

}  // namespace x4
