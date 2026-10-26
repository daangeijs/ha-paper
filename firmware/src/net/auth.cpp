#include "net/auth.h"

#include <Arduino.h>
#include <ArduinoJson.h>

#include <ctime>
#include <algorithm>
#include <cctype>

#include "Logging.h"
#include "net/storage.h"
#include "net/util.h"

namespace x4::net {

namespace {
constexpr const char* kTokenAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";   // == emulator core/auth.ts
constexpr const char* kPairAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
constexpr size_t kMaxTokens = 20;
constexpr size_t kMaxSessions = 8;
constexpr uint8_t kMaxFails = 5;            // per IP within kFailWindowMs → blocked kBlockMs
constexpr uint32_t kFailWindowMs = 60000;
constexpr uint32_t kBlockMs = 60000;
constexpr uint32_t kPairMs = 10UL * 60UL * 1000UL;

int64_t nowEpoch() {
  time_t t = time(nullptr);
  return t > 1700000000 ? static_cast<int64_t>(t) : 0;
}
}  // namespace

Auth& auth() {
  static Auth a;
  return a;
}

void Auth::begin() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  tokens_.clear();
  JsonDocument d;
  if (deserializeJson(d, storage().loadTokensJson()) || !d.is<JsonArray>()) return;
  for (JsonObject o : d.as<JsonArray>()) {
    ApiToken t;
    t.id = o["id"] | "";
    t.name = o["name"] | "";
    t.hash = o["hash"] | "";
    t.masked = o["masked"] | "";
    t.rw = o["rw"] | false;
    t.created = o["created"] | 0;
    t.lastUsed = o["last"] | 0;
    if (!t.id.empty() && t.hash.size() == 64) tokens_.push_back(t);
  }
}

void Auth::persist() {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (auto& t : tokens_) {
    JsonObject o = a.add<JsonObject>();
    o["id"] = t.id;
    o["name"] = t.name;
    o["hash"] = t.hash;
    o["masked"] = t.masked;
    o["rw"] = t.rw;
    o["created"] = t.created;
    o["last"] = t.lastUsed;
  }
  std::string s;
  serializeJson(d, s);
  storage().saveTokensJson(s);
  lastUsedDirty_ = false;
  lastUsedPersistMs_ = millis();
}

std::vector<ApiToken> Auth::tokens() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  if (lastUsedDirty_ && millis() - lastUsedPersistMs_ > 60000) persist();   // throttle flash writes
  return tokens_;
}

std::string Auth::createToken(const std::string& name, bool rw, ApiToken* out) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  if (tokens_.size() >= kMaxTokens) return {};
  std::string secret = "x4_" + randomToken(26, kTokenAlphabet);
  ApiToken t;
  t.id = randomToken(8, "abcdefghijklmnopqrstuvwxyz0123456789");
  t.name = name.empty() ? "Token" : name.substr(0, 40);
  t.hash = sha256Hex(secret);
  t.masked = secret.substr(0, 6) + "…" + secret.substr(secret.size() - 4);
  t.rw = rw;
  t.created = nowEpoch();
  tokens_.push_back(t);
  persist();
  if (out) *out = t;
  LOG_INF("AUTH", "API token \"%s\" created (%s) · only its hash is stored", t.name.c_str(), rw ? "rw" : "ro");
  return secret;
}

bool Auth::revokeToken(const std::string& id) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  for (auto it = tokens_.begin(); it != tokens_.end(); ++it) {
    if (it->id == id) {
      tokens_.erase(it);
      persist();
      return true;
    }
  }
  return false;
}

void Auth::revokeAll() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  tokens_.clear();
  persist();
}

std::string Auth::createSession(const std::string& user, bool admin) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  const uint32_t now = millis();
  sessions_.erase(std::remove_if(sessions_.begin(), sessions_.end(),
                                 [&](const Session& s) { return static_cast<int32_t>(s.expiresMs - now) <= 0; }),
                  sessions_.end());
  if (sessions_.size() >= kMaxSessions) sessions_.erase(sessions_.begin());
  uint8_t raw[24];
  randomBytes(raw, sizeof raw);
  std::string value = hex(raw, sizeof raw);
  Session s;
  s.idHash = sha256Hex(value);
  s.user = user;
  s.admin = admin;
  s.expiresMs = now + kSessionMs;
  sessions_.push_back(s);
  return value;
}

void Auth::endSession(const std::string& cookie) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  const std::string h = sha256Hex(cookie);
  sessions_.erase(std::remove_if(sessions_.begin(), sessions_.end(), [&](const Session& s) { return s.idHash == h; }),
                  sessions_.end());
}

void Auth::endAllSessions() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  sessions_.clear();
}

bool Auth::session(const std::string& cookie, Session& out) {
  if (cookie.empty()) return false;
  std::lock_guard<std::recursive_mutex> l(mu_);
  const std::string h = sha256Hex(cookie);
  const uint32_t now = millis();
  for (auto& s : sessions_) {
    if (constantTimeEq(s.idHash, h) && static_cast<int32_t>(s.expiresMs - now) > 0) {
      out = s;
      return true;
    }
  }
  return false;
}

bool Auth::rateLimited(const std::string& ip, uint32_t* retryAfter) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  const uint32_t now = millis();
  for (auto& f : fails_) {
    if (f.ip == ip && f.blockedUntilMs && static_cast<int32_t>(f.blockedUntilMs - now) > 0) {
      if (retryAfter) *retryAfter = (f.blockedUntilMs - now) / 1000 + 1;
      return true;
    }
  }
  return false;
}

void Auth::noteFailure(const std::string& ip) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  const uint32_t now = millis();
  for (auto& f : fails_) {
    if (f.ip != ip) continue;
    if (now - f.firstMs > kFailWindowMs) {
      f.firstMs = now;
      f.count = 0;
      f.blockedUntilMs = 0;
    }
    if (++f.count >= kMaxFails) {
      f.blockedUntilMs = now + kBlockMs;
      LOG_WRN("AUTH", "%s blocked for %us after %u failed attempts", ip.c_str(), (unsigned)(kBlockMs / 1000), (unsigned)f.count);
    }
    return;
  }
  if (fails_.size() >= 16) fails_.erase(fails_.begin());
  fails_.push_back({ip, 1, now, 0});
}

AuthResult Auth::check(const std::string& ip, const std::string& bearer, const std::string& cookie, Scope need) {
  AuthResult r;
  uint32_t retry = 0;
  if (rateLimited(ip, &retry)) {
    r.code = 429;
    r.error = "too many failed attempts, retry in " + std::to_string(retry) + " s";
    return r;
  }
  if (!bearer.empty()) {
    const std::string h = sha256Hex(bearer);
    std::lock_guard<std::recursive_mutex> l(mu_);
    for (auto& t : tokens_) {
      if (constantTimeEq(t.hash, h)) {
        r.scope = t.rw ? Scope::Write : Scope::Read;
        r.who = "token \"" + t.name + "\"";
        if (need == Scope::Write && !t.rw) {
          r.code = 403;
          r.error = "token is read-only";
          return r;
        }
        int64_t now = nowEpoch();
        if (now) {
          t.lastUsed = now;
          lastUsedDirty_ = true;
        }
        return r;
      }
    }
    noteFailure(ip);
    r.code = 401;
    r.error = "invalid or revoked token";
    return r;
  }
  Session s;
  if (session(cookie, s)) {
    r.viaSession = true;
    r.who = s.user;
    r.scope = s.admin ? Scope::Write : Scope::Read;
    if (need == Scope::Write && !s.admin) {
      r.code = 403;
      r.error = "Home Assistant admin required";
    }
    return r;
  }
  if (!cookie.empty()) {
    r.code = 401;
    r.error = "session expired, sign in again";
    return r;
  }
  r.code = 401;
  r.error = "missing token";
  return r;
}

std::string Auth::pairingCode() {
  std::lock_guard<std::recursive_mutex> l(mu_);
  const uint32_t now = millis();
  if (pair_.empty() || static_cast<int32_t>(pairExpiresMs_ - now) <= 0) {
    pair_ = randomToken(4, kPairAlphabet);
    pairExpiresMs_ = now + kPairMs;
  }
  return pair_;
}

bool Auth::consumePairing(const std::string& code) {
  std::lock_guard<std::recursive_mutex> l(mu_);
  std::string c = code;
  for (auto& ch : c) ch = toupper(ch);
  const uint32_t now = millis();
  if (pair_.empty() || static_cast<int32_t>(pairExpiresMs_ - now) <= 0 || !constantTimeEq(c, pair_)) return false;
  pair_.clear();   // single use; next pairingCode() call issues a new one
  return true;
}

}  // namespace x4::net
