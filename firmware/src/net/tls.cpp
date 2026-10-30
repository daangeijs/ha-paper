#include "net/tls.h"

#include <HTTPClient.h>

#include <memory>
#include <algorithm>

#include "Logging.h"
#include "hw/watchdog.h"
#include "net/health.h"
#include "net/util.h"

extern const uint8_t x509_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t x509_crt_bundle_end[] asm("_binary_x509_crt_bundle_end");

namespace x4::net {

void attachCaBundle(NetworkClientSecure& c) {
  // cppcheck-suppress comparePointers ; linker-provided start/end of one embedded blob
  c.setCACertBundle(x509_crt_bundle_start, x509_crt_bundle_end - x509_crt_bundle_start);
  c.setHandshakeTimeout(10);   // seconds; library default 120 s
}

// Every TLS caller runs on the net task, so handshakes never overlap. The -32512 in eink-ha-os#123 was one handshake next to
// the open WebSocket's two 16 KB record buffers (now in net/tls_pool.cpp's reserve); callers still handle
// kHttpLowMemory (sign-in yields the WebSocket).
int tlsConnect(NetworkClientSecure& c, const char* host, uint16_t port, uint32_t timeoutMs) {
  const uint32_t freeB = heapFreeInternal(), largest = heapLargestFree(), t0 = millis();
  const unsigned slots = tlsPoolUsed();
  bool ok;
  {
    wdt::BlockingCall b("TLS connect");   // DNS + TCP connect + handshake
    ok = c.connect(host, port, static_cast<int32_t>(timeoutMs));
  }
  const unsigned ms = millis() - t0;
  heapCheckpoint("tls handshake");
  if (ok) {
    LOG_INF("TLS", "handshake %s:%u %u ms · internal free %u B, largest %u B, reserve %u/%u before · free %u B after",
            host, port, ms, unsigned(freeB), unsigned(largest), slots, kTlsPoolSlots, unsigned(heapFreeInternal()));
    return 0;
  }
  const int err = c.lastError(nullptr, 0);
  LOG_WRN("TLS", "handshake %s:%u failed after %u ms (%d) · internal free %u B, largest %u B, reserve %u/%u before", host,
          port, ms, err, unsigned(freeB), unsigned(largest), slots, kTlsPoolSlots);
  return err == kTlsAllocFailed ? kHttpLowMemory : -1;
}

namespace {

// https:// with too little internal heap for a handshake → skip (logged with the host only, never the URL).
bool lowHeapFor(const std::string& url) {
  if (url.rfind("https://", 0) != 0) return false;
  Url u;
  return !tlsHeapOk(parseUrl(url, u) ? u.host.c_str() : "?");
}

// The handshake gets the caller's timeout too (whole seconds, at most attachCaBundle's 10 s): a 5 s probe must not
// sit 10 s in a stalled handshake (eink-ha-os#79).
std::unique_ptr<NetworkClient> clientFor(const std::string& url, uint32_t timeoutMs) {
  if (url.rfind("https://", 0) == 0) {
    auto* s = new NetworkClientSecure();
    attachCaBundle(*s);
    s->setHandshakeTimeout(std::min<uint32_t>(10, (timeoutMs + 999) / 1000));
    return std::unique_ptr<NetworkClient>(s);
  }
  return std::unique_ptr<NetworkClient>(new NetworkClient());
}

// https:// connects here, before HTTPClient (it reuses a connected client), so the handshake is timed (eink-ha-os#123).
// 0, or the code to return: -1 (HTTPC_ERROR_CONNECTION_REFUSED, what HTTPClient gives) or kHttpLowMemory.
int connectFor(NetworkClient& c, const std::string& url, uint32_t timeoutMs) {
  Url u;
  if (url.rfind("https://", 0) != 0 || !parseUrl(url, u)) return 0;
  int code = tlsConnect(static_cast<NetworkClientSecure&>(c), u.host.c_str(), u.port, timeoutMs);
  if (code == 0) c.setTimeout(timeoutMs);
  return code;
}

void readBody(HTTPClient& http, std::string& out, size_t maxBytes) {
  out.clear();
  NetworkClient* s = http.getStreamPtr();
  int remaining = http.getSize();   // -1 = unknown / chunked handled by HTTPClient? (getString handles chunked)
  if (remaining < 0) {
    wdt::BlockingCall b("http body");
    String str = http.getString();
    out.assign(str.c_str(), std::min<size_t>(str.length(), maxBytes));
    return;
  }
  uint8_t buf[1024];
  const uint32_t t0 = millis();
  while (s && remaining > 0 && out.size() < maxBytes && millis() - t0 < 20000) {
    wdt::feedIfSubscribed();
    size_t avail = s->available();
    if (!avail) {
      if (!s->connected()) break;
      delay(2);
      continue;
    }
    int n = s->read(buf, std::min(avail, sizeof buf));
    if (n <= 0) break;
    out.append(reinterpret_cast<char*>(buf), n);
    remaining -= n;
  }
}

}  // namespace

int httpPostForm(const std::string& url, const std::string& body, std::string& response, uint32_t timeoutMs) {
  if (lowHeapFor(url)) return kHttpLowMemory;
  auto client = clientFor(url, timeoutMs);
  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setConnectTimeout(timeoutMs);
  if (int c = connectFor(*client, url, timeoutMs)) return c;
  if (!http.begin(*client, url.c_str())) return -1;
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  http.setUserAgent(String("HA-Paper/") + firmwareVersion());
  int code;
  {
    wdt::BlockingCall b("http POST");
    code = http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(body.data())), body.size());
  }
  if (code > 0) readBody(http, response, 32 * 1024);
  http.end();
  return code;
}

int httpPostJsonEach(const std::string& base, const std::string& bearer, const std::vector<std::pair<std::string, std::string>>& pathBodies,
                     uint32_t timeoutMs) {
  if (lowHeapFor(base)) return kHttpLowMemory;
  auto client = clientFor(base, timeoutMs);
  HTTPClient http;
  http.setReuse(true);
  http.setTimeout(timeoutMs);
  http.setConnectTimeout(timeoutMs);
  const String auth = String("Bearer ") + bearer.c_str();
  if (int c = connectFor(*client, base, timeoutMs)) return c;
  int code = -1;
  for (auto& pb : pathBodies) {
    if (!http.begin(*client, (base + pb.first).c_str())) { code = -1; break; }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", auth);
    http.setUserAgent(String("HA-Paper/") + firmwareVersion());
    {
      wdt::BlockingCall b("http POST");
      code = http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(pb.second.data())), pb.second.size());
    }
    std::string ignored;
    if (code > 0) readBody(http, ignored, 4096);   // read to the end: the connection is reused
    http.end();
    if (code < 200 || code >= 300) break;
  }
  client->stop();
  return code;
}

int httpGet(const std::string& url, std::string& response, size_t maxBytes, uint32_t timeoutMs, const char* accept) {
  if (lowHeapFor(url)) return kHttpLowMemory;
  auto client = clientFor(url, timeoutMs);
  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setConnectTimeout(timeoutMs);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  if (int c = connectFor(*client, url, timeoutMs)) return c;
  if (!http.begin(*client, url.c_str())) return -1;
  http.setUserAgent(String("HA-Paper/") + firmwareVersion());
  if (accept) http.addHeader("Accept", accept);
  int code;
  {
    wdt::BlockingCall b("http GET");
    code = http.GET();
  }
  if (code > 0) readBody(http, response, maxBytes);
  http.end();
  return code;
}

int httpProbe(const std::string& url, std::string& response, std::string& location, size_t maxBytes, uint32_t timeoutMs) {
  if (lowHeapFor(url)) return kHttpLowMemory;
  auto client = clientFor(url, timeoutMs);
  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setConnectTimeout(timeoutMs);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (int c = connectFor(*client, url, timeoutMs)) return c;
  if (!http.begin(*client, url.c_str())) return -1;
  http.setUserAgent(String("HA-Paper/") + firmwareVersion());
  const char* keep[] = {"Location"};
  http.collectHeaders(keep, 1);
  int code;
  {
    wdt::BlockingCall b("http probe");
    code = http.GET();
  }
  if (code > 0) {
    location = http.header("Location").c_str();
    readBody(http, response, maxBytes);
  }
  http.end();
  return code;
}

}  // namespace x4::net
