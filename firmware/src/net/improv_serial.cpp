#include "net/improv_serial.h"

#include <Arduino.h>

#include <mutex>
#include <string>
#include <vector>

#include "Logging.h"
#include "core/improv.h"
#include "net/hub.h"
#include "net/util.h"
#include "net/wifi_mgr.h"

namespace x4::net {

namespace {
std::mutex g_mu;   // feed() on the loop task, results on the net task
improv::Device* g_dev = nullptr;
constexpr int kMaxBytesPerPoll = 512;

improv::Device& dev() {
  if (!g_dev) g_dev = new improv::Device({firmwareVersion(), "xteink-x4-pro/esp32-s3", hostname()});
  return *g_dev;
}

std::vector<std::string> urls() {
  std::string ip;
  {
    std::lock_guard<std::recursive_mutex> l(hub().mu);
    if (hub().status.wifi == WifiState::Connected) ip = hub().status.ip;
  }
  std::vector<std::string> u{"http://" + hostnameLocal() + "/"};
  if (!ip.empty()) u.push_back("http://" + ip + "/");
  return u;
}

// One frame per write() where possible: HWCDC holds its tx lock per call, so log lines from other tasks land between
// frames, not inside one. With setTxTimeoutMs(1) a write can come back short or empty (lock busy, host slow): retry
// briefly; a frame lost anyway is recovered by the flasher asking again.
void send(const std::vector<uint8_t>& out) {
  size_t done = 0;
  for (int tries = 0; done < out.size() && tries < 50; tries++) {
    const size_t w = Serial.write(out.data() + done, out.size() - done);
    if (w == 0) delay(1);
    done += w;
  }
}

void join(const std::string& ssid, const std::string& password) {
  wifiMgr().connect(ssid, password, [](bool ok, const std::string&) {
    std::vector<uint8_t> out;
    {
      std::lock_guard<std::mutex> l(g_mu);
      dev().connectResult(ok, ok ? urls() : std::vector<std::string>{}, out);
    }
    LOG_INF("IMPROV", "join %s", ok ? "ok" : "failed");
    send(out);
  });
}

void scan() {
  std::vector<improv::Network> nets;
  for (auto& n : wifiMgr().scanNow())
    if (!n.ssid.empty()) nets.push_back({n.ssid, n.rssi, n.secure});
  std::vector<uint8_t> out;
  {
    std::lock_guard<std::mutex> l(g_mu);
    dev().scanResult(nets, out);
  }
  send(out);
}
}  // namespace

void improvPoll() {
  if (Serial.available() <= 0) return;
  const bool online = netConnected();
  const std::vector<std::string> u = online ? urls() : std::vector<std::string>{};
  std::vector<uint8_t> out;
  improv::Request req;
  {
    std::lock_guard<std::mutex> l(g_mu);
    for (int n = 0; n < kMaxBytesPerPoll && Serial.available() > 0; n++) {
      const int c = Serial.read();
      if (c < 0) break;
      improv::Request r = dev().feed(uint8_t(c), online, u, out);
      if (r.kind != improv::Request::Kind::None) req = std::move(r);
    }
  }
  send(out);
  if (req.kind == improv::Request::Kind::Connect) {
    LOG_INF("IMPROV", "Wi-Fi settings for \"%s\"", req.ssid.c_str());   // never the password
    hub().post([ssid = std::move(req.ssid), password = std::move(req.password)] { join(ssid, password); });
  } else if (req.kind == improv::Request::Kind::Scan) {
    hub().post(scan);
  }
}

}  // namespace x4::net
