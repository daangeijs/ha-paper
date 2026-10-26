// core/improv: Improv Wi-Fi serial frames (spec/test-vectors/improv.json, shared with flasher/src/improv.ts) and the
// device session the USB console glue (net/improv_serial.cpp) runs.
#include <unity.h>

#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "core/improv.h"
#include "core/json.h"

#ifndef X4_REPO_ROOT
#define X4_REPO_ROOT "."
#endif

using namespace x4;
using namespace x4::improv;
using Bytes = std::vector<uint8_t>;

void setUp() {}
void tearDown() {}

static Json g_v;

static Bytes unhex(const std::string& h) {
  Bytes b;
  for (size_t i = 0; i + 1 < h.size(); i += 2) b.push_back(uint8_t(std::stoi(h.substr(i, 2), nullptr, 16)));
  return b;
}

static std::string hex(const Bytes& b) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (uint8_t x : b) {
    s += d[x >> 4];
    s += d[x & 15];
  }
  return s;
}

static void test_load_vectors() {
  std::ifstream f(std::string(X4_REPO_ROOT) + "/spec/test-vectors/improv.json", std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  TEST_ASSERT_TRUE_MESSAGE(parseJson(ss.str(), g_v), "spec/test-vectors/improv.json missing or invalid");
}

static void test_frames_match_vectors() {
  int n = 0;
  for (auto& c : g_v.get("frames")->arr) {
    const std::string name = c.get("name")->str;
    Bytes f = frame(uint8_t(c.get("type")->num), unhex(c.get("data")->str));
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("hex")->str.c_str(), hex(f).c_str(), name.c_str());
    Parser p;   // and back
    Parser::Result r = Parser::Result::None;
    for (uint8_t b : f)
      if ((r = p.feed(b)) != Parser::Result::None) break;
    TEST_ASSERT_TRUE_MESSAGE(r == Parser::Result::Packet, name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.get("data")->str.c_str(), hex(p.packet().data).c_str(), name.c_str());
    ++n;
  }
  TEST_ASSERT_EQUAL_INT(9, n);
  // the builders produce the vector frames
  TEST_ASSERT_EQUAL_STRING(g_v.get("frames")->arr[2].get("hex")->str.c_str(), hex(stateFrame(State::Ready)).c_str());
  TEST_ASSERT_EQUAL_STRING(g_v.get("frames")->arr[5].get("hex")->str.c_str(), hex(errorFrame(Error::UnableToConnect)).c_str());
  TEST_ASSERT_EQUAL_STRING(g_v.get("frames")->arr[0].get("hex")->str.c_str(), hex(rpcFrame(kGetState, {})).c_str());
  TEST_ASSERT_EQUAL_STRING(g_v.get("frames")->arr[7].get("hex")->str.c_str(),
                           hex(resultFrame(kGetInfo, {"HA Paper", "0.2.0", "xteink-x4-pro/esp32-s3", "ha-paper-1a2b"})).c_str());
  TEST_ASSERT_EQUAL_STRING(g_v.get("frames")->arr[8].get("hex")->str.c_str(), hex(resultFrame(kGetNetworks, {})).c_str());
}

static void test_streams_skip_log_text() {
  for (auto& c : g_v.get("streams")->arr) {
    Parser p;
    std::vector<std::string> got;
    for (uint8_t b : unhex(c.get("hex")->str))
      if (p.feed(b) == Parser::Result::Packet) got.push_back(std::to_string(p.packet().type) + ":" + hex(p.packet().data));
    auto& want = c.get("packets")->arr;
    TEST_ASSERT_EQUAL_INT(int(want.size()), int(got.size()));
    for (size_t i = 0; i < want.size(); i++)
      TEST_ASSERT_EQUAL_STRING((std::to_string(int(want[i].get("type")->num)) + ":" + want[i].get("data")->str).c_str(), got[i].c_str());
  }
}

static void test_bad_frames() {
  for (auto& c : g_v.get("bad")->arr) {
    const std::string name = c.get("name")->str;
    Parser p;
    bool packet = false, checksum = false;
    for (uint8_t b : unhex(c.get("hex")->str)) {
      auto r = p.feed(b);
      packet |= r == Parser::Result::Packet;
      checksum |= r == Parser::Result::BadChecksum;
    }
    TEST_ASSERT_FALSE_MESSAGE(packet, name.c_str());
    TEST_ASSERT_EQUAL_MESSAGE(c.get("checksum_error")->b, checksum, name.c_str());
    // the parser recovers: a good frame right after still parses
    auto good = stateFrame(State::Ready);
    Parser::Result r = Parser::Result::None;
    for (uint8_t b : good)
      if ((r = p.feed(b)) != Parser::Result::None) break;
    if (c.get("checksum_error")->b || name.rfind("version", 0) == 0) TEST_ASSERT_TRUE_MESSAGE(r == Parser::Result::Packet, name.c_str());
  }
}

static void test_rpc_vectors() {
  for (auto& c : g_v.get("rpcs")->arr) {
    const std::string name = c.get("name")->str;
    uint8_t cmd = 0;
    Bytes payload;
    const Json* valid = c.get("valid");
    const bool ok = parseRpc(unhex(c.get("data")->str), cmd, payload);
    if (valid && !valid->b) {
      TEST_ASSERT_FALSE_MESSAGE(ok, name.c_str());
      continue;
    }
    TEST_ASSERT_TRUE_MESSAGE(ok, name.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(c.get("command")->num), cmd, name.c_str());
    std::vector<std::string> s;
    const Json* want = c.get("strings");
    const bool sok = parseStrings(payload, s);
    if (want->isNull()) {
      TEST_ASSERT_FALSE_MESSAGE(sok, name.c_str());
      continue;
    }
    TEST_ASSERT_TRUE_MESSAGE(sok, name.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(want->arr.size()), int(s.size()), name.c_str());
    for (size_t i = 0; i < s.size(); i++) TEST_ASSERT_EQUAL_STRING_MESSAGE(want->arr[i].str.c_str(), s[i].c_str(), name.c_str());
  }
}

static void test_result_cut_to_255() {
  const std::string big(300, 'a');
  Bytes f = resultFrame(kGetInfo, {big, "x"});
  TEST_ASSERT_EQUAL_UINT8(255, f[8]);                // data length byte
  TEST_ASSERT_EQUAL_UINT8(253, f[10]);               // payload length
  TEST_ASSERT_EQUAL_UINT8(252, f[11]);               // first string cut, second dropped
  TEST_ASSERT_EQUAL_size_t(6 + 3 + 255 + 2, f.size());
}

// ---------- device session ----------
struct Sim {
  Device dev{{"0.2.0", "xteink-x4-pro/esp32-s3", "ha-paper-1a2b"}};
  bool online = false;
  std::vector<std::string> urls;
  Request req;
  std::vector<Packet> sent;
  void send(const Bytes& f) {
    Bytes out;
    req = {};
    for (uint8_t b : f) {
      Request r = dev.feed(b, online, urls, out);
      if (r.kind != Request::Kind::None) req = r;
    }
    collect(out);
  }
  void collect(const Bytes& out) {
    sent.clear();
    Parser p;
    for (uint8_t b : out)
      if (p.feed(b) == Parser::Result::Packet) sent.push_back(p.packet());
    TEST_ASSERT_EQUAL_UINT8('\n', out.empty() ? '\n' : out.back());
  }
  std::string at(size_t i) const { return i < sent.size() ? std::to_string(sent[i].type) + ":" + hex(sent[i].data) : "-"; }
};

static std::string strs(uint8_t cmd, const std::vector<std::string>& s) {
  Bytes f = resultFrame(cmd, s);
  return "4:" + hex(Bytes(f.begin() + 9, f.end() - 2));
}

static void test_session_state_and_info() {
  Sim s;
  s.send(rpcFrame(kGetState, {}));
  TEST_ASSERT_EQUAL_INT(2, int(s.sent.size()));
  TEST_ASSERT_EQUAL_STRING("2:00", s.at(0).c_str());   // RPC → error state "none" first
  TEST_ASSERT_EQUAL_STRING("1:02", s.at(1).c_str());   // Ready
  s.send(rpcFrame(kGetInfo, {}));
  TEST_ASSERT_EQUAL_STRING(strs(kGetInfo, {"HA Paper", "0.2.0", "xteink-x4-pro/esp32-s3", "ha-paper-1a2b"}).c_str(), s.at(1).c_str());
  s.online = true;
  s.urls = {"http://ha-paper-1a2b.local/", "http://192.168.1.23/"};
  s.send(rpcFrame(kGetState, {}));
  TEST_ASSERT_EQUAL_INT(3, int(s.sent.size()));
  TEST_ASSERT_EQUAL_STRING("1:04", s.at(1).c_str());
  TEST_ASSERT_EQUAL_STRING(strs(kWifiSettings, s.urls).c_str(), s.at(2).c_str());
  s.send(rpcFrame(kNetworkState, {}));
  TEST_ASSERT_EQUAL_STRING(strs(kNetworkState, {"3", s.urls[0], s.urls[1]}).c_str(), s.at(1).c_str());
  s.send(rpcFrame(kHostname, {}));
  TEST_ASSERT_EQUAL_STRING(strs(kHostname, {"ha-paper-1a2b"}).c_str(), s.at(1).c_str());
  s.send(rpcFrame(kHostname, {'a', 'b'}));
  TEST_ASSERT_EQUAL_STRING("2:05", s.at(0).c_str());
  TEST_ASSERT_EQUAL_INT(1, int(s.sent.size()));
}

static void test_session_wifi_ok_and_fail() {
  Sim s;
  Bytes payload{12};
  for (char c : std::string("MyWirelessAP")) payload.push_back(uint8_t(c));
  payload.push_back(16);
  for (char c : std::string("mysecurepassword")) payload.push_back(uint8_t(c));
  s.send(rpcFrame(kWifiSettings, payload));
  TEST_ASSERT_TRUE(s.req.kind == Request::Kind::Connect);
  TEST_ASSERT_EQUAL_STRING("MyWirelessAP", s.req.ssid.c_str());
  TEST_ASSERT_EQUAL_STRING("mysecurepassword", s.req.password.c_str());
  TEST_ASSERT_EQUAL_STRING("1:03", s.at(1).c_str());   // Provisioning
  s.send(rpcFrame(kGetState, {}));                      // asked again while joining
  TEST_ASSERT_EQUAL_STRING("1:03", s.at(1).c_str());
  Bytes out;
  s.dev.connectResult(false, {}, out);
  s.collect(out);
  TEST_ASSERT_EQUAL_STRING("2:03", s.at(0).c_str());   // unable to connect
  TEST_ASSERT_EQUAL_STRING("1:02", s.at(1).c_str());   // Ready again
  TEST_ASSERT_FALSE(s.dev.provisioning());
  s.send(rpcFrame(kWifiSettings, payload));
  out.clear();
  s.dev.connectResult(true, {"http://ha-paper-1a2b.local/"}, out);
  s.collect(out);
  TEST_ASSERT_EQUAL_STRING("1:04", s.at(0).c_str());
  TEST_ASSERT_EQUAL_STRING(strs(kWifiSettings, {"http://ha-paper-1a2b.local/"}).c_str(), s.at(1).c_str());
}

static void test_session_errors() {
  Sim s;
  s.send(rpcFrame(0x42, {}));
  TEST_ASSERT_EQUAL_STRING("2:02", s.at(0).c_str());   // unknown command
  TEST_ASSERT_EQUAL_INT(1, int(s.sent.size()));
  s.send(rpcFrame(kWifiSettings, {0, 0}));               // empty SSID
  TEST_ASSERT_EQUAL_STRING("2:01", s.at(0).c_str());
  TEST_ASSERT_TRUE(s.req.kind == Request::Kind::None);
  TEST_ASSERT_FALSE(s.dev.provisioning());
  s.send(rpcFrame(kWifiSettings, {5, 'a'}));             // string runs past the payload
  TEST_ASSERT_EQUAL_STRING("2:01", s.at(0).c_str());
  Bytes bad = rpcFrame(kGetState, {});
  bad[bad.size() - 2] ^= 0x01;
  s.send(bad);
  TEST_ASSERT_EQUAL_STRING("2:01", s.at(0).c_str());   // bad checksum → invalid RPC
  s.send(frame(kRpc, {kGetState, 3}));                   // length byte says 3, no payload
  TEST_ASSERT_EQUAL_STRING("2:01", s.at(0).c_str());
  s.send(stateFrame(State::Ready));                      // not an RPC: ignored
  TEST_ASSERT_EQUAL_INT(0, int(s.sent.size()));
}

static void test_session_scan() {
  Sim s;
  s.send(rpcFrame(kGetNetworks, {}));
  TEST_ASSERT_TRUE(s.req.kind == Request::Kind::Scan);
  TEST_ASSERT_EQUAL_INT(1, int(s.sent.size()));
  Bytes out;
  s.dev.scanResult({{"Home", -61, true}, {"Guest", -80, false}}, out);
  s.collect(out);
  TEST_ASSERT_EQUAL_INT(3, int(s.sent.size()));
  TEST_ASSERT_EQUAL_STRING(strs(kGetNetworks, {"Home", "-61", "YES"}).c_str(), s.at(0).c_str());
  TEST_ASSERT_EQUAL_STRING(strs(kGetNetworks, {"Guest", "-80", "NO"}).c_str(), s.at(1).c_str());
  TEST_ASSERT_EQUAL_STRING(strs(kGetNetworks, {}).c_str(), s.at(2).c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_load_vectors);
  RUN_TEST(test_frames_match_vectors);
  RUN_TEST(test_streams_skip_log_text);
  RUN_TEST(test_bad_frames);
  RUN_TEST(test_rpc_vectors);
  RUN_TEST(test_result_cut_to_255);
  RUN_TEST(test_session_state_and_info);
  RUN_TEST(test_session_wifi_ok_and_fail);
  RUN_TEST(test_session_errors);
  RUN_TEST(test_session_scan);
  return UNITY_END();
}
