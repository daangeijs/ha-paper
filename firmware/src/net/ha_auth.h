// Home Assistant OAuth2 (authorization code + PKCE + state), token refresh/revoke, current-user check.
// client_id / redirect_uri are built from the browser's Host header (docs/FEASIBILITY.md): HA only
// string-compares client_id on refresh, and a redirect_uri on the same host as client_id is accepted without
// HA fetching anything. The client_id used at link time is stored and reused for every refresh.
#pragma once
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace x4::net {

struct PendingAuth {
  std::string state, verifier, clientId, redirectUri, haUrl;
  std::string returnTo = "/";  // console path to land on after /auth/callback
  bool linkDevice = false;    // true: store the refresh token as the display's key
  uint32_t createdMs = 0;
};

struct TokenSet {
  std::string access, refresh;
  uint32_t expiresInSec = 1800;
};

enum class RefreshResult { Ok, Revoked, NetError };

class HaAuth {
 public:
  // Non-blocking (web handler). host = request Host header ("ha-paper-a1b2.local", "192.168.1.42").
  std::string authorizeUrl(const std::string& host, const std::string& haUrl, bool linkDevice,
                           const std::string& returnTo = "/");
  bool takePending(const std::string& state, PendingAuth& out);   // single use, 10 min

  // Blocking (net task).
  // status (optional): the HTTP status or transport code (kHttpLowMemory: no heap for the handshake).
  static bool exchangeCode(const PendingAuth& p, const std::string& code, TokenSet& out, std::string& err,
                           int* status = nullptr);
  static RefreshResult refresh(const std::string& haUrl, const std::string& clientId, const std::string& refreshToken,
                               TokenSet& out);
  static void revoke(const std::string& haUrl, const std::string& refreshToken);
  // WS auth + auth/current_user. Returns false if HA rejects the token or is unreachable (err says which).
  static bool currentUser(const std::string& haUrl, const std::string& accessToken, std::string& name, bool& isAdmin,
                          std::string& err, bool* authRejected = nullptr);

 private:
  std::mutex mu_;
  std::vector<PendingAuth> pending_;
};

HaAuth& haAuth();

}  // namespace x4::net
