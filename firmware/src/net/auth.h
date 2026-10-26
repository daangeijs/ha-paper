// Device API tokens (x4_…, SHA-256 hash stored only), browser sessions (HttpOnly cookie after HA sign-in),
// failed-auth rate limiting, and the 4-char pairing code shown on the display.
#pragma once
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace x4::net {

enum class Scope : uint8_t { None, Read, Write };

struct ApiToken {
  std::string id, name, hash, masked;
  bool rw = false;
  int64_t created = 0, lastUsed = 0;   // epoch seconds (0 = never / clock unknown)
};

struct Session {
  std::string idHash;   // sha256 of the cookie value
  std::string user;
  bool admin = false;
  uint32_t expiresMs = 0;
};

struct AuthResult {
  int code = 0;          // 0 = ok, 401 / 403 / 429
  std::string error;
  Scope scope = Scope::None;
  std::string who;       // token name or session user
  bool viaSession = false;
};

class Auth {
 public:
  void begin();

  // Tokens
  std::vector<ApiToken> tokens();
  // Returns the secret (shown once). scope: "ro"/"read" or "rw"/"write".
  std::string createToken(const std::string& name, bool rw, ApiToken* out = nullptr);
  bool revokeToken(const std::string& id);
  void revokeAll();

  // Sessions
  std::string createSession(const std::string& user, bool admin);   // → cookie value
  void endSession(const std::string& cookieValue);
  void endAllSessions();
  bool session(const std::string& cookieValue, Session& out);

  // Request check. bearer = header value after "Bearer " ("" if missing); cookie = x4_session value.
  AuthResult check(const std::string& ip, const std::string& bearer, const std::string& cookie, Scope need);
  bool rateLimited(const std::string& ip, uint32_t* retryAfterSec = nullptr);
  void noteFailure(const std::string& ip);

  // Pairing code (display QR → /link?p=CODE): 4 chars, 10 min, single use.
  std::string pairingCode();               // current code, regenerated when expired/used
  bool consumePairing(const std::string& code);

  static constexpr const char* kCookie = "x4_session";
  static constexpr uint32_t kSessionMs = 12UL * 3600UL * 1000UL;

 private:
  void persist();
  std::recursive_mutex mu_;
  std::vector<ApiToken> tokens_;
  std::vector<Session> sessions_;
  struct Fail { std::string ip; uint8_t count; uint32_t firstMs, blockedUntilMs; };
  std::vector<Fail> fails_;
  std::string pair_;
  uint32_t pairExpiresMs_ = 0;
  uint32_t lastUsedPersistMs_ = 0;
  bool lastUsedDirty_ = false;
};

Auth& auth();

}  // namespace x4::net
