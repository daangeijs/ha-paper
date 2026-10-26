#include "net/ha_auth.h"

#include <Arduino.h>
#include <ArduinoJson.h>

#include <algorithm>
#include <cctype>
#include <cstring>

#include "Logging.h"
#include "hw/watchdog.h"
#include "net/health.h"
#include "net/tls.h"
#include "net/util.h"
#include "net/ws_client.h"

namespace x4::net {

namespace {
constexpr uint32_t kPendingMs = 10UL * 60UL * 1000UL;
constexpr const char* kB64Url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
}  // namespace

HaAuth& haAuth() {
  static HaAuth a;
  return a;
}

std::string HaAuth::authorizeUrl(const std::string& host, const std::string& haUrl, bool linkDevice,
                                 const std::string& returnTo) {
  PendingAuth p;
  p.state = randomToken(24, kB64Url);
  p.verifier = randomToken(64, kB64Url);   // RFC 7636: 43..128 chars
  p.clientId = "http://" + host + "/";
  p.redirectUri = "http://" + host + "/auth/callback";
  p.haUrl = haUrl;
  p.linkDevice = linkDevice;
  // only same-origin paths (no //evil.example open redirect)
  p.returnTo = (!returnTo.empty() && returnTo[0] == '/' && returnTo.rfind("//", 0) != 0) ? returnTo : "/";
  p.createdMs = millis();
  uint8_t h[32];
  sha256(reinterpret_cast<const uint8_t*>(p.verifier.data()), p.verifier.size(), h);
  const std::string challenge = base64UrlNoPad(h, 32);
  {
    std::lock_guard<std::mutex> l(mu_);
    const uint32_t now = millis();
    pending_.erase(std::remove_if(pending_.begin(), pending_.end(),
                                  [&](const PendingAuth& x) { return now - x.createdMs > kPendingMs; }),
                   pending_.end());
    if (pending_.size() >= 4) pending_.erase(pending_.begin());
    pending_.push_back(p);
  }
  // HA ignores PKCE parameters it doesn't know; code_verifier is sent again at the token step.
  return haUrl + "/auth/authorize?response_type=code&client_id=" + urlEncode(p.clientId) +
         "&redirect_uri=" + urlEncode(p.redirectUri) + "&state=" + urlEncode(p.state) +
         "&code_challenge=" + challenge + "&code_challenge_method=S256";
}

bool HaAuth::takePending(const std::string& state, PendingAuth& out) {
  std::lock_guard<std::mutex> l(mu_);
  const uint32_t now = millis();
  for (auto it = pending_.begin(); it != pending_.end(); ++it) {
    if (constantTimeEq(it->state, state)) {
      bool fresh = now - it->createdMs <= kPendingMs;
      out = *it;
      pending_.erase(it);
      return fresh;
    }
  }
  return false;
}

static bool parseTokens(const std::string& body, TokenSet& out) {
  JsonDocument d;
  if (deserializeJson(d, body)) return false;
  out.access = d["access_token"] | "";
  if (d["refresh_token"].is<const char*>()) out.refresh = d["refresh_token"].as<const char*>();
  out.expiresInSec = d["expires_in"] | 1800;
  return !out.access.empty();
}

// For logs: only the OAuth `error` code of a token-endpoint body ("invalid_grant"), never the body itself (a 200
// without refresh_token still carries an access token). Capped, and limited to [A-Za-z0-9_.-].
static std::string errorCode(const std::string& body) {
  JsonDocument filter;
  filter["error"] = true;
  JsonDocument d;
  if (deserializeJson(d, body, DeserializationOption::Filter(filter))) return "-";
  std::string e = d["error"] | "";
  e.erase(std::remove_if(e.begin(), e.end(), [](char c) { return !isalnum((unsigned char)c) && !strchr("_.-", c); }), e.end());
  if (e.size() > 40) e.resize(40);
  return e.empty() ? "-" : e;
}

bool HaAuth::exchangeCode(const PendingAuth& p, const std::string& code, TokenSet& out, std::string& err, int* statusOut) {
  WifiPsOff psOff;
  std::string body = "grant_type=authorization_code&code=" + urlEncode(code) + "&client_id=" + urlEncode(p.clientId) +
                     "&code_verifier=" + urlEncode(p.verifier);
  std::string resp;
  int status = httpPostForm(p.haUrl + "/auth/token", body, resp);
  if (statusOut) *statusOut = status;
  if (status != 200 || !parseTokens(resp, out) || out.refresh.empty()) {
    err = status < 0 ? "Home Assistant not reachable" : "Home Assistant refused the sign-in (HTTP " + std::to_string(status) + ")";
    LOG_WRN("HA", "code exchange failed: %d error=%s", status, errorCode(resp).c_str());
    return false;
  }
  LOG_INF("HA", "POST /auth/token grant_type=authorization_code → access_token (%us) + refresh_token", (unsigned)out.expiresInSec);
  return true;
}

RefreshResult HaAuth::refresh(const std::string& haUrl, const std::string& clientId, const std::string& refreshToken,
                              TokenSet& out) {
  WifiPsOff psOff;
  std::string body = "grant_type=refresh_token&refresh_token=" + urlEncode(refreshToken) + "&client_id=" + urlEncode(clientId);
  std::string resp;
  int status = httpPostForm(haUrl + "/auth/token", body, resp);
  if (status == 200 && parseTokens(resp, out)) return RefreshResult::Ok;
  if (status == 400 || status == 403) {
    // {"error":"invalid_grant"} → refresh token revoked / expired (90 days idle) / wrong client_id
    LOG_WRN("HA", "refresh rejected (%d): error=%s → key revoked", status, errorCode(resp).c_str());
    return RefreshResult::Revoked;
  }
  LOG_WRN("HA", "refresh failed: %d", status);
  return RefreshResult::NetError;
}

void HaAuth::revoke(const std::string& haUrl, const std::string& refreshToken) {
  std::string resp;
  int status = httpPostForm(haUrl + "/auth/revoke", "token=" + urlEncode(refreshToken), resp, 8000);
  LOG_INF("HA", "POST /auth/revoke → %d", status);
}

bool HaAuth::currentUser(const std::string& haUrl, const std::string& accessToken, std::string& name, bool& isAdmin,
                         std::string& err, bool* authRejected) {
  if (authRejected) *authRejected = false;
  WifiPsOff psOff;
  Url u;
  if (!parseUrl(haUrl, u)) {
    err = "bad Home Assistant URL";
    return false;
  }
  std::string base = u.path == "/" ? "" : u.path;
  while (!base.empty() && base.back() == '/') base.pop_back();
  WsClient ws;
  if (!ws.connect(u, base + "/api/websocket", 10000)) {
    err = "Home Assistant not reachable";
    return false;
  }
  const uint32_t t0 = millis();
  std::string msg;
  bool authed = false;
  while (millis() - t0 < 12000 && ws.connected()) {
    wdt::feedIfSubscribed();
    if (!ws.poll(msg)) {
      delay(10);
      continue;
    }
    JsonDocument d;
    if (deserializeJson(d, msg)) continue;
    const char* type = d["type"] | "";
    if (!strcmp(type, "auth_required")) {
      ws.sendText("{\"type\":\"auth\",\"access_token\":\"" + jsonEscape(accessToken) + "\"}");
    } else if (!strcmp(type, "auth_invalid")) {
      err = "Home Assistant rejected the key";
      if (authRejected) *authRejected = true;
      ws.close();
      return false;
    } else if (!strcmp(type, "auth_ok")) {
      authed = true;
      ws.sendText("{\"id\":1,\"type\":\"auth/current_user\"}");
    } else if (!strcmp(type, "result") && authed && (d["id"] | 0) == 1) {
      name = d["result"]["name"] | "";
      isAdmin = d["result"]["is_admin"] | false;
      ws.close();
      return d["success"] | false;
    }
  }
  ws.close();
  err = "Home Assistant did not answer";
  return false;
}

}  // namespace x4::net
