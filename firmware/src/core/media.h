// Now playing tile (#319, emulator src/core/media.ts, spec/test-vectors/media.json): favorites, the HA call per tap,
// what the tile shows from the player, what fits a cs × rs tile.
#pragma once
#include <string>
#include <vector>
#include "core/config.h"
#include "core/entities.h"
#include "core/home.h"

namespace x4::media {

constexpr int kMaxFavorites = 6;
// entity = script.* / scene.* (→ turn_on), else type + id (→ media_player.play_media). bad = the rejected item text.
struct Favorite { std::string label, entity, type, id; bool bad = false; };
std::vector<Favorite> parseFavorites(const std::string& value);   // every item, bad ones marked
std::vector<Favorite> favoritesOf(const Widget& w);                // the valid ones
std::string favoritesError(const std::string& value);             // parseConfig message, "" = fine

enum class Target : uint8_t { Prev, Play, Next, Down, Up, Fav, Set };
// data = the service_data JSON object text; ok = false: no such favorite. n: Fav = favorite index, Set = volume % (#351).
struct Action { bool ok = false; std::string domain, service, data; };
Action action(const Widget& w, Target t, int n = 0);

enum class Phase : uint8_t { Playing, Paused, Buffering, Idle, Off };
// vol -1 = none; slider (#351) = supported_features has VOLUME_SET (4): the volume bar instead of − / +
struct View { EntityGap gap = EntityGap::None; Phase phase = Phase::Idle; std::string title, artist; int vol = -1; bool slider = false; };
View view(const EntityValue* v);   // nullptr = not in HA (yet)
View view(const std::string& state, bool known, const std::string& title, const std::string& artist, const std::string& volume,
          const std::string& features = std::string());
int volumeAt(int x, int bx, int bw);   // slider: tap / drag end at x on a bar from bx, bw wide → whole % 0–100

struct Layout { bool volume; int inlineCols, inlineShown; bool star; int pickCols, pickRows, pickShown; };
Layout layout(int cs, int rs, int nFav);

}  // namespace x4::media
