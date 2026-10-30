// Improv Wi-Fi over serial (https://www.improv-wifi.com/serial/, eink-ha-os#31): the web flasher sends Wi-Fi credentials over the
// USB console right after installing, so nobody has to join the setup hotspot. Pure frame parser/builder and the
// device-side session; net/improv_serial.cpp moves the bytes. Frames share the port with log text: the parser skips
// everything that is not "IMPROV" + version 1. Vectors: spec/test-vectors/improv.json (flasher/src/improv.ts too).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace x4::improv {

constexpr uint8_t kVersion = 1;
enum Type : uint8_t { kCurrentState = 0x01, kErrorState = 0x02, kRpc = 0x03, kRpcResult = 0x04 };
enum Command : uint8_t {
  kWifiSettings = 0x01, kGetState = 0x02, kGetInfo = 0x03, kGetNetworks = 0x04, kHostname = 0x05, kDeviceName = 0x06,
  kNetworkState = 0x07,
};
enum class State : uint8_t { Stopped = 0x00, Ready = 0x02, Provisioning = 0x03, Provisioned = 0x04 };
enum class Error : uint8_t { None = 0x00, InvalidRpc = 0x01, UnknownRpc = 0x02, UnableToConnect = 0x03, BadHostname = 0x05, Unknown = 0xFF };

// "IMPROV" 1 type len data… checksum '\n'. checksum = sum of every byte before it, mod 256. The '\n' keeps the
// frame from gluing onto the next log line in a terminal; parsers ignore it.
std::vector<uint8_t> frame(uint8_t type, const std::vector<uint8_t>& data);
std::vector<uint8_t> stateFrame(State s);
std::vector<uint8_t> errorFrame(Error e);
// RPC result: command, total length, then each string as length + bytes. Whatever does not fit the 253-byte payload
// is cut.
std::vector<uint8_t> resultFrame(uint8_t command, const std::vector<std::string>& strings);
// RPC command (client → device; the device never sends one, the tests and vectors do).
std::vector<uint8_t> rpcFrame(uint8_t command, const std::vector<uint8_t>& payload);

struct Packet {
  uint8_t type = 0;
  std::vector<uint8_t> data;
};

// Byte-at-a-time stream parser. Resyncs on any byte that breaks the header, version or checksum.
class Parser {
 public:
  enum class Result : uint8_t { None, Packet, BadChecksum };
  Result feed(uint8_t b);
  const Packet& packet() const { return pkt_; }   // valid after Result::Packet until the next feed()

 private:
  std::vector<uint8_t> buf_;
  Packet pkt_;
};

// RPC data: command, payload length, payload. False when the length byte does not match.
bool parseRpc(const std::vector<uint8_t>& data, uint8_t& command, std::vector<uint8_t>& payload);
// Payload of length-prefixed strings (Wi-Fi settings: ssid, password). False unless it is exactly that.
bool parseStrings(const std::vector<uint8_t>& payload, std::vector<std::string>& out);

struct Info {
  std::string version;   // firmware version
  std::string chip;      // "xteink-x4-pro/esp32-s3"
  std::string name;      // hostname, ha-paper-XXXX
};

struct Network {
  std::string ssid;
  int rssi = 0;
  bool secure = false;
};

// What the caller must do after feed(): join a network (net task) or scan, then report back.
struct Request {
  enum class Kind : uint8_t { None, Connect, Scan } kind = Kind::None;
  std::string ssid, password;   // Connect; the password is never logged
};

// Device side. Not thread-safe: the glue serialises feed() (loop task) and the results (net task).
class Device {
 public:
  explicit Device(Info info) : info_(std::move(info)) {}
  // One received byte. online/urls = Wi-Fi now (answers "get state" with Provisioned + the URLs).
  // Frames to send are appended to out (write them in one go so log lines can't split them).
  Request feed(uint8_t b, bool online, const std::vector<std::string>& urls, std::vector<uint8_t>& out);
  void connectResult(bool ok, const std::vector<std::string>& urls, std::vector<uint8_t>& out);
  void scanResult(const std::vector<Network>& nets, std::vector<uint8_t>& out);
  bool provisioning() const { return provisioning_; }

 private:
  Request rpc(const Packet& p, bool online, const std::vector<std::string>& urls, std::vector<uint8_t>& out);
  Info info_;
  Parser parser_;
  bool provisioning_ = false;
};

}  // namespace x4::improv
