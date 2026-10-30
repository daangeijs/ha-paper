#include "core/media.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include "core/json.h"

namespace x4::media {

namespace {
std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}
bool typeOk(const std::string& t) {
  if (t.empty()) return false;
  for (char c : t)
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '/' || c == '+' || c == '.' || c == '-')) return false;
  return true;
}
}  // namespace

std::vector<Favorite> parseFavorites(const std::string& value) {
  std::vector<Favorite> out;
  size_t i = 0;
  while (i <= value.size()) {
    size_t j = value.find(';', i);
    if (j == std::string::npos) j = value.size();
    std::string x = trim(value.substr(i, j - i));
    i = j + 1;
    if (x.empty()) continue;
    Favorite f;
    size_t eq = x.find('=');
    std::string t = eq == std::string::npos ? std::string() : trim(x.substr(eq + 1));
    f.label = eq == std::string::npos ? std::string() : trim(x.substr(0, eq));
    if (f.label.empty()) { f.label = x; f.bad = true; out.push_back(f); continue; }
    if (entityFits(t, {"script", "scene"})) { f.entity = t; out.push_back(f); continue; }
    size_t c = t.find(':');
    if (c == std::string::npos || c == 0 || c + 1 == t.size() || !typeOk(t.substr(0, c))) { f.label = x; f.bad = true; out.push_back(f); continue; }
    f.type = t.substr(0, c);
    f.id = trim(t.substr(c + 1));
    out.push_back(f);
  }
  return out;
}

std::vector<Favorite> favoritesOf(const Widget& w) {
  std::vector<Favorite> out;
  for (auto& f : parseFavorites(w.field("favorites"))) if (!f.bad) out.push_back(f);
  return out;
}

std::string favoritesError(const std::string& value) {
  auto fs = parseFavorites(value);
  for (auto& f : fs)
    if (f.bad) return "media: \xE2\x80\x9C" + f.label + "\xE2\x80\x9D in favorites is not Name=type:id or Name=script.<id> / scene.<id>";
  return int(fs.size()) > kMaxFavorites ? "media: at most " + std::to_string(kMaxFavorites) + " favorites" : std::string();
}

Action action(const Widget& w, Target t, int fav) {
  const std::string e = w.field("entity");
  if (t == Target::Set) {   // volume_level = % / 100 as a JSON number: 0, 0.07, 0.75, 1
    const int p = std::max(0, std::min(100, fav));
    std::string lv = p == 100 ? "1" : p == 0 ? "0" : (p < 10 ? "0.0" : "0.") + std::to_string(p % 10 == 0 && p >= 10 ? p / 10 : p);
    return Action{true, "media_player", "volume_set", "{\"entity_id\":" + jsonQuote(e) + ",\"volume_level\":" + lv + "}"};
  }
  static const char* const kSvc[] = {"media_previous_track", "media_play_pause", "media_next_track", "volume_down", "volume_up"};
  if (t != Target::Fav) return Action{true, "media_player", kSvc[int(t)], "{\"entity_id\":" + jsonQuote(e) + "}"};
  auto fs = favoritesOf(w);
  if (fav < 0 || fav >= int(fs.size())) return Action{};
  const Favorite& f = fs[fav];
  if (!f.entity.empty()) return Action{true, domainOf(f.entity), "turn_on", "{\"entity_id\":" + jsonQuote(f.entity) + "}"};
  return Action{true, "media_player", "play_media",
                "{\"entity_id\":" + jsonQuote(e) + ",\"media_content_id\":" + jsonQuote(f.id) + ",\"media_content_type\":" + jsonQuote(f.type) + "}"};
}

View view(const std::string& state, bool known, const std::string& title, const std::string& artist, const std::string& volume,
          const std::string& features) {
  View v;
  v.gap = !known ? EntityGap::None : state == "unavailable" ? EntityGap::Unavailable : state == "unknown" ? EntityGap::Unknown : EntityGap::None;
  v.phase = state == "playing" ? Phase::Playing : state == "paused" ? Phase::Paused : state == "buffering" ? Phase::Buffering
          : state == "off" ? Phase::Off : Phase::Idle;
  if (v.phase != Phase::Off) { v.title = trim(title); v.artist = trim(artist); }
  std::string t = trim(volume);
  char* end = nullptr;
  double d = t.empty() ? NAN : std::strtod(t.c_str(), &end);
  if (!t.empty() && end && *end == '\0' && std::isfinite(d) && d >= 0 && d <= 1) v.vol = int(std::floor(d * 100 + 0.5));
  const std::string f = trim(features);
  bool digits = !f.empty() && f.size() <= 10;
  for (char ch : f) digits = digits && ch >= '0' && ch <= '9';
  v.slider = digits && (std::strtoull(f.c_str(), nullptr, 10) & 4u) != 0;
  return v;
}

int volumeAt(int x, int bx, int bw) {
  if (bw <= 0) return 0;
  const double f = std::max(0.0, std::min(1.0, double(x - bx) / bw));
  return int(std::floor(f * 100 + 0.5));
}

View view(const EntityValue* e) {
  if (!e) return view("", false, "", "", "");
  auto a = [e](const char* k) { auto it = e->attrs.find(k); return it == e->attrs.end() ? std::string() : std::string(it->second.c_str()); };
  return view(std::string(e->state.c_str()), true, a("media_title"), a("media_artist"), a("volume_level"), a("supported_features"));
}

Layout layout(int cs, int rs, int nFav) {
  Layout l;
  int cols = cs >= 2 ? 2 : 1;
  l.volume = cs >= 2;
  l.inlineCols = cols;
  l.inlineShown = rs >= 2 ? std::min(nFav, cols * 4) : 0;
  l.star = nFav > l.inlineShown;
  l.pickCols = cols;
  l.pickRows = rs >= 2 ? 8 : 4;
  l.pickShown = std::min(nFav, cols * l.pickRows - 1);
  return l;
}

}  // namespace x4::media
