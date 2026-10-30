// Home Assistant address typed on the link page (eink-ha-os#54) = emulator src/core/haAddress.ts,
// spec/test-vectors/ha-address.json. Pure: the HTTP probe is passed in (net/web_server.cpp: GET /auth/providers).
#pragma once
#include <cstdint>
#include <functional>
#include <string>

namespace x4::ha_address {

constexpr const char* kProbePath = "/auth/providers";
// One probe at a time; the next may start this long after the last one ended (eink-ha-os#75). Else 429.
constexpr uint32_t kProbeCooldownMs = 1000;
constexpr const char* kProbeBusy = "The display is still checking an address. Try again in a moment.";

// "homeassistant.local:8123", "https://ha.example.com/lovelace/0" → base URL + the other scheme to try.
// LAN addresses are fine; loopback and link-local are refused (eink-ha-os#75). Scheme typed: the other scheme is tried on its
// default port. error non-empty = not an address (url/alt empty).
struct Parsed {
  std::string url, alt, error;
  bool typed = false;   // scheme typed by the user
};
Parsed parse(const std::string& input);

// One GET url + kProbePath without following redirects. status ≤ 0 = no answer (refused, DNS, timeout, TLS).
struct Answer {
  int status = -1;
  std::string body, location;
};
bool isHaProviders(const std::string& body);
std::string originOf(const std::string& location);   // scheme://host[:port] of an absolute URL, "" otherwise

// url set = use it. Else status 422 (not an address / not HA / wrong scheme / redirects elsewhere) or 502 (no answer)
// + error. Only a redirect to the https upgrade of the same host and port is probed. Probed bodies are never echoed.
struct Resolved {
  std::string url, error;
  int status = 200;
};
Resolved resolve(const std::string& input, const std::function<Answer(const std::string& url)>& probe);

}  // namespace x4::ha_address
