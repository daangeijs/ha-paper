// core/ws_reader (eink-ha-os#374): frame parsing (lengths, mask, ping/close, fragments), streamed and oversized frames (eink-ha-os#269),
// and the backpressure that keeps a firehose server (fake HA --tick 1) from growing the buffer without bound.
#include <unity.h>
#include <string>
#include <vector>
#include "core/ws_reader.h"

using namespace x4;
using Ev = WsReader::Ev;

static std::string frame(uint8_t op, const std::string& p, bool fin = true, const uint8_t* mask = nullptr) {
  std::string f;
  f.push_back(char((fin ? 0x80 : 0) | op));
  const uint8_t m = mask ? 0x80 : 0;
  if (p.size() < 126) {
    f.push_back(char(m | p.size()));
  } else if (p.size() < 65536) {
    f.push_back(char(m | 126));
    f.push_back(char(p.size() >> 8));
    f.push_back(char(p.size()));
  } else {
    f.push_back(char(m | 127));
    for (int i = 7; i >= 0; i--) f.push_back(char(uint64_t(p.size()) >> (8 * i)));
  }
  if (!mask) return f + p;
  f.append(reinterpret_cast<const char*>(mask), 4);
  for (size_t i = 0; i < p.size(); i++) f.push_back(char(p[i] ^ mask[i & 3]));
  return f;
}
static std::string text(const std::string& p) { return frame(0x1, p); }

struct Rec : WsStream {
  uint32_t wantId = 0;
  std::string got;
  std::vector<std::string> log;
  bool want(uint32_t id) override { return id == wantId; }
  void begin(uint32_t id, uint64_t len) override { log.push_back("begin " + std::to_string(id) + " " + std::to_string(len)); }
  void chunk(const char* p, size_t n) override { got.append(p, n); }
  void end(uint32_t id, uint64_t len) override { log.push_back("end " + std::to_string(id) + " " + std::to_string(len)); }
  void dropped(uint32_t id, uint64_t len) override { log.push_back("drop " + std::to_string(id) + " " + std::to_string(len)); }
};

// Feeds `wire` the way WsClient::poll does (room()-sized reads of at most 2048 B), returns every text message.
static std::vector<std::string> pump(WsReader& r, const std::string& wire, size_t step = 2048, size_t* peak = nullptr) {
  std::vector<std::string> out;
  size_t off = 0;
  std::string msg;
  for (;;) {
    size_t room;
    while (off < wire.size() && (room = r.room())) {
      size_t n = std::min({step, room, wire.size() - off});
      r.feed(wire.data() + off, n);
      off += n;
      if (peak && r.buffered() > *peak) *peak = r.buffered();
    }
    Ev e = r.next(msg);
    if (e == Ev::Text) { out.push_back(msg); continue; }
    if (e == Ev::Ping) { out.push_back("ping:" + msg); continue; }
    if (e == Ev::Close) { out.push_back("close"); continue; }
    if (e == Ev::TooLarge) { out.push_back("toolarge"); continue; }
    if (off >= wire.size()) return out;
  }
}

static void test_lengths_mask_control() {
  WsReader r;
  const uint8_t mask[4] = {0x12, 0x34, 0x56, 0x78};
  std::string big(70000, 'b'), mid(300, 'm');
  std::string wire = text("hi") + text(mid) + text(big) + frame(0x9, "pp") + frame(0xA, "") + frame(0x2, "bin") +
                     frame(0x1, "masked", true, mask) + frame(0x8, "\x03\xe8");
  auto out = pump(r, wire);
  TEST_ASSERT_EQUAL(6, out.size());
  TEST_ASSERT_EQUAL_STRING("hi", out[0].c_str());
  TEST_ASSERT_TRUE(out[1] == mid);
  TEST_ASSERT_TRUE(out[2] == big);
  TEST_ASSERT_EQUAL_STRING("ping:pp", out[3].c_str());
  TEST_ASSERT_EQUAL_STRING("masked", out[4].c_str());
  TEST_ASSERT_EQUAL_STRING("close", out[5].c_str());
}

static void test_byte_at_a_time_and_fragments() {
  WsReader r;
  std::string wire = frame(0x1, "{\"a\":", false) + frame(0x9, "") + frame(0x0, "1", false) + frame(0x0, "}") + text("x");
  auto out = pump(r, wire, 1);
  TEST_ASSERT_EQUAL(3, out.size());
  TEST_ASSERT_EQUAL_STRING("ping:", out[0].c_str());
  TEST_ASSERT_EQUAL_STRING("{\"a\":1}", out[1].c_str());
  TEST_ASSERT_EQUAL_STRING("x", out[2].c_str());
}

static void test_fragment_overflow() {
  WsReader r;
  std::string half(WsReader::kMaxMessage / 2 + 1, 'f');
  auto out = pump(r, frame(0x1, half, false) + frame(0x0, half, true) + text("after"));
  TEST_ASSERT_EQUAL_STRING("toolarge", out.at(0).c_str());
}

static void test_stream_and_drop() {
  WsReader r;
  Rec rec;
  rec.wantId = 7;
  r.setStream(&rec);
  std::string streamed = "{\"id\":7,\"type\":\"result\",\"result\":[" + std::string(100000, '1') + "]}";
  std::string over(WsReader::kMaxMessage + 1, 'o');
  size_t peak = 0;
  auto out = pump(r, text("{\"id\":3,\"x\":1}") + text(streamed) + text(over) + text("tail"), 2048, &peak);
  TEST_ASSERT_EQUAL(2, out.size());
  TEST_ASSERT_EQUAL_STRING("{\"id\":3,\"x\":1}", out[0].c_str());
  TEST_ASSERT_EQUAL_STRING("tail", out[1].c_str());
  TEST_ASSERT_TRUE(rec.got == streamed);
  TEST_ASSERT_EQUAL(3, rec.log.size());
  TEST_ASSERT_EQUAL_STRING(("begin 7 " + std::to_string(streamed.size())).c_str(), rec.log[0].c_str());
  TEST_ASSERT_EQUAL_STRING(("end 7 " + std::to_string(streamed.size())).c_str(), rec.log[1].c_str());
  TEST_ASSERT_EQUAL_STRING(("drop 0 " + std::to_string(over.size())).c_str(), rec.log[2].c_str());
  TEST_ASSERT_LESS_OR_EQUAL(2 * WsReader::kSlack, peak);   // streamed / dropped frames never pile up
}

// eink-ha-os#374: the server writes faster than the device parses. Before, poll() appended 64 KB per call while the caller took
// 8 messages: rx_ passed 1 MB in 12 s on QEMU. Now the buffer holds at most one frame + kSlack.
static void test_firehose_is_bounded() {
  WsReader r;
  std::string ev = "{\"type\":\"event\",\"event\":{\"c\":{\"sensor.power\":{\"+\":{\"s\":\"1234\",\"lc\":1.0}}}},\"id\":2}";
  std::string wire;
  for (int i = 0; i < 20000; i++) wire += text(ev);
  wire += text(std::string(WsReader::kMaxMessage, 'L'));   // the largest allowed frame
  for (int i = 0; i < 100; i++) wire += text(ev);
  size_t off = 0, got = 0, peak = 0, capPeak = 0;
  std::string msg;
  while (off < wire.size() || got < 20101) {
    size_t budget = 64 * 1024, room;   // one poll: reads while there is room, then one message
    while (budget && off < wire.size() && (room = r.room())) {
      size_t n = std::min({size_t(2048), budget, room, wire.size() - off});
      r.feed(wire.data() + off, n);
      off += n;
      budget -= n;
      peak = std::max(peak, r.buffered());
      capPeak = std::max(capPeak, r.capacity());
    }
    for (int i = 0; i < 8 && r.next(msg) == Ev::Text; i++) got++;   // HaClient::loop: 8 messages per pass
  }
  TEST_ASSERT_EQUAL(20101, got);
  TEST_ASSERT_LESS_OR_EQUAL(WsReader::kMaxMessage + 4 + 10 + WsReader::kSlack, peak);
  TEST_ASSERT_LESS_OR_EQUAL(2 * (WsReader::kMaxMessage + 4 * 1024), capPeak);
  TEST_ASSERT_LESS_OR_EQUAL(16 * 1024, r.capacity());   // the big frame's buffer went back
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_lengths_mask_control);
  RUN_TEST(test_byte_at_a_time_and_fragments);
  RUN_TEST(test_fragment_overflow);
  RUN_TEST(test_stream_and_drop);
  RUN_TEST(test_firehose_is_bounded);
  return UNITY_END();
}
