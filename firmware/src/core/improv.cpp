#include "core/improv.h"

#include <algorithm>

namespace x4::improv {

namespace {
constexpr char kHeader[] = "IMPROV";
constexpr size_t kHeaderLen = 6;
constexpr size_t kMaxPayload = 253;   // data length byte (255) minus command and payload length
}  // namespace

std::vector<uint8_t> frame(uint8_t type, const std::vector<uint8_t>& data) {
  std::vector<uint8_t> f(kHeader, kHeader + kHeaderLen);
  f.push_back(kVersion);
  f.push_back(type);
  f.push_back(uint8_t(data.size()));
  f.insert(f.end(), data.begin(), data.end());
  uint8_t sum = 0;
  for (uint8_t b : f) sum += b;
  f.push_back(sum);
  f.push_back('\n');
  return f;
}

std::vector<uint8_t> stateFrame(State s) { return frame(kCurrentState, {uint8_t(s)}); }
std::vector<uint8_t> errorFrame(Error e) { return frame(kErrorState, {uint8_t(e)}); }

std::vector<uint8_t> rpcFrame(uint8_t command, const std::vector<uint8_t>& payload) {
  std::vector<uint8_t> d{command, uint8_t(payload.size())};
  d.insert(d.end(), payload.begin(), payload.end());
  return frame(kRpc, d);
}

std::vector<uint8_t> resultFrame(uint8_t command, const std::vector<std::string>& strings) {
  std::vector<uint8_t> p;
  for (auto& s : strings) {
    if (p.size() + 1 > kMaxPayload) break;
    const size_t n = std::min(s.size(), kMaxPayload - p.size() - 1);
    p.push_back(uint8_t(n));
    p.insert(p.end(), s.begin(), s.begin() + n);
  }
  std::vector<uint8_t> d{command, uint8_t(p.size())};
  d.insert(d.end(), p.begin(), p.end());
  return frame(kRpcResult, d);
}

Parser::Result Parser::feed(uint8_t b) {
  const size_t i = buf_.size();
  bool ok;
  if (i < kHeaderLen) ok = b == uint8_t(kHeader[i]);
  else if (i == kHeaderLen) ok = b == kVersion;
  else ok = true;
  if (!ok) {
    buf_.clear();
    if (b == uint8_t(kHeader[0])) buf_.push_back(b);
    return Result::None;
  }
  if (i < kHeaderLen + 3 || i < kHeaderLen + 3 + size_t(buf_[kHeaderLen + 2])) {
    buf_.push_back(b);
    return Result::None;
  }
  // b is the checksum
  uint8_t sum = 0;
  for (uint8_t x : buf_) sum += x;
  const bool good = sum == b;
  if (good) {
    pkt_.type = buf_[kHeaderLen + 1];
    pkt_.data.assign(buf_.begin() + kHeaderLen + 3, buf_.end());
  }
  buf_.clear();
  return good ? Result::Packet : Result::BadChecksum;
}

bool parseRpc(const std::vector<uint8_t>& data, uint8_t& command, std::vector<uint8_t>& payload) {
  if (data.size() < 2 || size_t(data[1]) != data.size() - 2) return false;
  command = data[0];
  payload.assign(data.begin() + 2, data.end());
  return true;
}

bool parseStrings(const std::vector<uint8_t>& payload, std::vector<std::string>& out) {
  out.clear();
  size_t i = 0;
  while (i < payload.size()) {
    const size_t n = payload[i++];
    if (n > payload.size() - i) return false;
    out.emplace_back(payload.begin() + i, payload.begin() + i + n);
    i += n;
  }
  return true;
}

Request Device::feed(uint8_t b, bool online, const std::vector<std::string>& urls, std::vector<uint8_t>& out) {
  switch (parser_.feed(b)) {
    case Parser::Result::BadChecksum: {
      auto f = errorFrame(Error::InvalidRpc);
      out.insert(out.end(), f.begin(), f.end());
      return {};
    }
    case Parser::Result::Packet:
      if (parser_.packet().type == kRpc) return rpc(parser_.packet(), online, urls, out);
      return {};
    default:
      return {};
  }
}

Request Device::rpc(const Packet& p, bool online, const std::vector<std::string>& urls, std::vector<uint8_t>& out) {
  Request req;
  std::vector<std::vector<uint8_t>> reply;
  Error err = Error::None;
  uint8_t cmd = 0;
  std::vector<uint8_t> payload;
  std::vector<std::string> args;
  const State now = provisioning_ ? State::Provisioning : online ? State::Provisioned : State::Ready;
  if (!parseRpc(p.data, cmd, payload)) {
    err = Error::InvalidRpc;
  } else {
    switch (cmd) {
      case kWifiSettings:
        if (!parseStrings(payload, args) || args.size() != 2 || args[0].empty()) {
          err = Error::InvalidRpc;
          break;
        }
        provisioning_ = true;
        reply.push_back(stateFrame(State::Provisioning));
        req.kind = Request::Kind::Connect;
        req.ssid = std::move(args[0]);
        req.password = std::move(args[1]);
        break;
      case kGetState:
        reply.push_back(stateFrame(now));
        if (now == State::Provisioned) reply.push_back(resultFrame(kWifiSettings, urls));
        break;
      case kGetInfo:
        reply.push_back(resultFrame(kGetInfo, {"HA Paper", info_.version, info_.chip, info_.name}));
        break;
      case kGetNetworks:
        req.kind = Request::Kind::Scan;
        break;
      case kHostname:   // derived from the MAC (net/wifi_mgr.h): read-only
        if (payload.empty()) reply.push_back(resultFrame(kHostname, {info_.name}));
        else err = Error::BadHostname;
        break;
      case kDeviceName:
        if (payload.empty()) reply.push_back(resultFrame(kDeviceName, {info_.name}));
        else err = Error::UnknownRpc;
        break;
      case kNetworkState: {
        std::vector<std::string> s{std::to_string(0x02 | (online ? 0x01 : 0x00))};   // supports Wi-Fi | online
        if (online) s.insert(s.end(), urls.begin(), urls.end());
        reply.push_back(resultFrame(kNetworkState, s));
        break;
      }
      default:
        err = Error::UnknownRpc;
    }
  }
  auto e = errorFrame(err);
  out.insert(out.end(), e.begin(), e.end());
  if (err == Error::None)
    for (auto& f : reply) out.insert(out.end(), f.begin(), f.end());
  return req;
}

void Device::connectResult(bool ok, const std::vector<std::string>& urls, std::vector<uint8_t>& out) {
  provisioning_ = false;
  std::vector<uint8_t> a, b;
  if (ok) {
    a = stateFrame(State::Provisioned);
    b = resultFrame(kWifiSettings, urls);
  } else {
    a = errorFrame(Error::UnableToConnect);
    b = stateFrame(State::Ready);
  }
  out.insert(out.end(), a.begin(), a.end());
  out.insert(out.end(), b.begin(), b.end());
}

void Device::scanResult(const std::vector<Network>& nets, std::vector<uint8_t>& out) {
  for (auto& n : nets) {
    auto f = resultFrame(kGetNetworks, {n.ssid, std::to_string(n.rssi), n.secure ? "YES" : "NO"});
    out.insert(out.end(), f.begin(), f.end());
  }
  auto end = resultFrame(kGetNetworks, {});
  out.insert(out.end(), end.begin(), end.end());
}

}  // namespace x4::improv
