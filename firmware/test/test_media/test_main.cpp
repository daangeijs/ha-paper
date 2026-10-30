// Now playing tile (eink-ha-os#319): core/media against spec/test-vectors/media.json, and the tile on the real App: taps send the
// HA calls, ★ opens the favorites picker, a favorite starts and closes it, only title / state / volume redraw.
#include <unity.h>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include "app/app.h"
#include "core/config.h"
#include "core/ha_stream.h"
#include "core/json.h"
#include "core/media.h"
#include "../support/demo.h"
#include "../support/fakes.h"

using namespace x4;

static std::string readFile(const std::string& p) {
  std::ifstream f(p);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

static Widget widgetOf(const Json& j) {
  Widget w;
  for (auto& kv : j.obj) {
    if (kv.first == "type") w.type = kv.second.str;
    else if (kv.second.isStr()) w.fields[kv.first] = kv.second.str;
  }
  return w;
}

static const char* kPhase[] = {"playing", "paused", "buffering", "idle", "off"};

void test_media_vectors() {
  std::string t = readFile(std::string(X4_REPO_ROOT) + "/spec/test-vectors/media.json");
  TEST_ASSERT_FALSE_MESSAGE(t.empty(), "spec/test-vectors/media.json missing");
  Json j;
  TEST_ASSERT_TRUE(parseJson(t, j));
  int n = 0;
  for (auto& c : j.get("favorites")->arr) {
    auto got = media::parseFavorites(c.get("value")->str);
    auto& want = c.get("items")->arr;
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(want.size()), int(got.size()), c.get("value")->str.c_str());
    for (size_t k = 0; k < want.size(); ++k) {
      const Json& x = want[k];
      std::string msg = c.get("value")->str + " #" + std::to_string(k);
      if (x.get("bad")) { TEST_ASSERT_TRUE_MESSAGE(got[k].bad, msg.c_str()); TEST_ASSERT_EQUAL_STRING_MESSAGE(x.get("bad")->str.c_str(), got[k].label.c_str(), msg.c_str()); continue; }
      TEST_ASSERT_FALSE_MESSAGE(got[k].bad, msg.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(x.get("label")->str.c_str(), got[k].label.c_str(), msg.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(x.get("entity") ? x.get("entity")->str.c_str() : "", got[k].entity.c_str(), msg.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(x.get("type") ? x.get("type")->str.c_str() : "", got[k].type.c_str(), msg.c_str());
      TEST_ASSERT_EQUAL_STRING_MESSAGE(x.get("id") ? x.get("id")->str.c_str() : "", got[k].id.c_str(), msg.c_str());
    }
    ++n;
  }
  static const char* kTargets[] = {"prev", "play", "next", "down", "up", "fav", "set"};
  for (auto& c : j.get("actions")->arr) {
    Widget w = widgetOf(*c.get("widget"));
    int ti = 0;
    while (c.get("target")->str != kTargets[ti]) ++ti;
    media::Action a = media::action(w, media::Target(ti), int(c.get("fav")->num));
    const Json* call = c.get("call");
    std::string msg = c.get("target")->str + " " + std::to_string(int(c.get("fav")->num));
    TEST_ASSERT_EQUAL_MESSAGE(!call->isNull(), a.ok, msg.c_str());
    if (call->isNull()) { ++n; continue; }
    TEST_ASSERT_EQUAL_STRING_MESSAGE(call->get("domain")->str.c_str(), a.domain.c_str(), msg.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(call->get("service")->str.c_str(), a.service.c_str(), msg.c_str());
    Json d;
    TEST_ASSERT_TRUE_MESSAGE(parseJson(a.data, d), a.data.c_str());
    auto& want = call->get("data")->obj;
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(want.size()), int(d.obj.size()), a.data.c_str());
    for (auto& kv : want) {
      const Json* g = d.get(kv.first);
      TEST_ASSERT_NOT_NULL_MESSAGE(g, (msg + " " + kv.first).c_str());
      if (kv.second.isNum()) { TEST_ASSERT_TRUE_MESSAGE(g->isNum() && g->num == kv.second.num, (msg + " " + a.data).c_str()); continue; }
      TEST_ASSERT_EQUAL_STRING_MESSAGE(kv.second.str.c_str(), g->str.c_str(), (msg + " " + kv.first).c_str());
    }
    ++n;
  }
  for (auto& c : j.get("views")->arr) {
    const Json* st = c.get("state");
    EntityValue ev;
    if (!st->isNull()) ev.state = st->str.c_str();
    for (auto& kv : c.get("attrs")->obj) ev.attrs[kv.first.c_str()] = kv.second.str.c_str();
    media::View v = media::view(st->isNull() ? nullptr : &ev);
    const Json* want = c.get("view");
    std::string name = c.get("name")->str;
    const char* gap = v.gap == EntityGap::Unavailable ? "unavailable" : v.gap == EntityGap::Unknown ? "unknown" : "";
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want->get("gap")->isNull() ? "" : want->get("gap")->str.c_str(), gap, name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want->get("phase")->str.c_str(), kPhase[int(v.phase)], name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want->get("title")->str.c_str(), v.title.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want->get("artist")->str.c_str(), v.artist.c_str(), name.c_str());
    TEST_ASSERT_EQUAL_INT_MESSAGE(want->get("vol")->isNull() ? -1 : int(want->get("vol")->num), v.vol, name.c_str());
    TEST_ASSERT_EQUAL_MESSAGE(want->get("slider")->b, v.slider, name.c_str());
    ++n;
  }
  for (auto& c : j.get("volumeAt")->arr) {
    int x = int(c.get("x")->num), bx = int(c.get("bx")->num), bw = int(c.get("bw")->num);
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(c.get("level")->num), media::volumeAt(x, bx, bw), (std::to_string(x) + " on " + std::to_string(bx) + "+" + std::to_string(bw)).c_str());
    ++n;
  }
  for (auto& c : j.get("layouts")->arr) {
    media::Layout l = media::layout(int(c.get("cs")->num), int(c.get("rs")->num), int(c.get("n")->num));
    const Json* x = c.get("layout");
    char msg[32];
    std::snprintf(msg, sizeof msg, "%dx%d n%d", int(c.get("cs")->num), int(c.get("rs")->num), int(c.get("n")->num));
    TEST_ASSERT_EQUAL_MESSAGE(x->get("volume")->b, l.volume, msg);
    TEST_ASSERT_EQUAL_MESSAGE(x->get("star")->b, l.star, msg);
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(x->get("inlineCols")->num), l.inlineCols, msg);
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(x->get("inlineShown")->num), l.inlineShown, msg);
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(x->get("pickCols")->num), l.pickCols, msg);
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(x->get("pickRows")->num), l.pickRows, msg);
    TEST_ASSERT_EQUAL_INT_MESSAGE(int(x->get("pickShown")->num), l.pickShown, msg);
    ++n;
  }
  std::printf("media vectors: %d cases\n", n);
  TEST_ASSERT_GREATER_THAN(40, n);
}

void test_media_attrs_kept() {
  for (const char* k : {"media_title", "media_artist", "volume_level"}) TEST_ASSERT_TRUE_MESSAGE(keepAttr(k), k);
  TEST_ASSERT_FALSE(keepAttr("media_position"));   // progress: dropped at ingest, never a redraw
  TEST_ASSERT_TRUE(keepAttrFor("media_player.living_room", "supported_features"));   // eink-ha-os#351: VOLUME_SET → slider
  TEST_ASSERT_FALSE(keepAttrFor("light.kitchen", "supported_features"));
}

// ---- the tile on the App ----
static const int64_t kEpoch1300 = 1791896400;
struct Rig {
  fake::FakeDisplay d;
  fake::FakeBoard b;
  fake::FakeServices s;
  App app{d, b, s};
  explicit Rig(const std::string& widgets, bool feedback = false, const char* features = nullptr) {
    b.epoch = kEpoch1300;
    s.linked();
    demo::load(app.entities(), 13, 0);
    EntityValue e;
    e.state = "playing";
    e.attrs["friendly_name"] = "Living room speaker";
    e.attrs["media_title"] = "Evening Radio Hour";
    e.attrs["media_artist"] = "Local station";
    e.attrs["volume_level"] = "0.32";
    if (features) e.attrs["supported_features"] = features;
    app.entities().set("media_player.living_room", e);
    app.setPressFeedback(feedback);
    app.setBootWake("timer");
    ParseResult p = parseConfig("version: 1\nscreens:\n  - id: m\n    title: Music\n    widgets:\n" + widgets);
    TEST_ASSERT_TRUE_MESSAGE(p.ok, p.message.c_str());
    app.begin(p.config, DisplaySettings());
    step(1800);
  }
  void step(uint32_t ms) { for (uint32_t t = 0; t < ms; t += 50) { b.now += 50; app.loop(); } }
  void tap(int x, int y) { b.tap(x, y); step(50); }
  void drag(int x, int y, int ex, bool fast = false) { b.drag(x, y, ex, y, fast); step(50); }
  std::string sig(const std::string& k) { auto m = app.regionSignatures(); return m.count(k) ? m[k] : std::string(); }
  int tileParts() const {   // partials over the first tile (the minute tick redraws the bar clock, elsewhere)
    int n = 0;
    for (auto& e : d.events) n += !e.full && !e.fast && e.r.y < 70 + 192 && e.r.y + e.r.h > 70 && e.r.x < 14 + 380;
    return n;
  }
  void set(const char* attr, const char* v, const char* state = nullptr) {
    EntityValue e = *app.entities().get("media_player.living_room");
    if (attr) e.attrs[attr] = v;
    if (state) e.state = state;
    app.entities().set("media_player.living_room", e);
    step(31000);
  }
};

// grid: 4 × 2 cells from (14, 70), 12 px gaps, 184 × 192 px cells; a 2 × 1 tile at the top left
static const char* kTile = "      - {type: media, entity: media_player.living_room, cs: 2, favorites: Radio 1=music:http://x/r1.mp3; Night=script.good_night}\n";

void test_media_tile_taps() {
  Rig r(kTile);
  std::string t0 = r.sig("t0");
  TEST_ASSERT_TRUE_MESSAGE(t0.find("Evening Radio Hour") != std::string::npos, t0.c_str());
  TEST_ASSERT_TRUE(t0.find("32%") != std::string::npos);
  const int by = 70 + 192 - 12 - 24;   // button centre row
  r.tap(14 + 14 + 24, by);   // ⏮
  r.tap(14 + 14 + 56 + 24, by);   // ⏯
  r.tap(14 + 14 + 112 + 24, by);   // ⏭
  r.tap(14 + 14 + 184 + 24, by);   // −
  r.tap(14 + 14 + 240 + 24, by);   // +
  TEST_ASSERT_EQUAL_INT(5, int(r.s.calls.size()));
  const char* svc[] = {"media_previous_track", "media_play_pause", "media_next_track", "volume_down", "volume_up"};
  for (int k = 0; k < 5; ++k) {
    TEST_ASSERT_EQUAL_STRING("media_player", r.s.calls[k].domain.c_str());
    TEST_ASSERT_EQUAL_STRING(svc[k], r.s.calls[k].service.c_str());
    TEST_ASSERT_EQUAL_STRING("{\"entity_id\":\"media_player.living_room\"}", r.s.calls[k].json.c_str());
  }
  // ★ (right end of the button row) opens the picker; a favorite runs and closes it
  r.tap(14 + 380 - 14 - 24, by);
  TEST_ASSERT_TRUE(r.sig("t0").find("Radio 1") != std::string::npos);
  TEST_ASSERT_TRUE(r.sig("t0").find("Evening Radio Hour") == std::string::npos);
  r.tap(14 + 14 + 40, 70 + 8 + 20);   // first cell
  TEST_ASSERT_EQUAL_INT(6, int(r.s.calls.size()));
  TEST_ASSERT_EQUAL_STRING("play_media", r.s.calls[5].service.c_str());
  TEST_ASSERT_EQUAL_STRING("{\"entity_id\":\"media_player.living_room\",\"media_content_id\":\"http://x/r1.mp3\",\"media_content_type\":\"music\"}", r.s.calls[5].json.c_str());
  TEST_ASSERT_TRUE(r.sig("t0").find("Evening Radio Hour") != std::string::npos);   // closed
  // ★ then ×: closed without a call; the second favorite is a script
  r.tap(14 + 380 - 14 - 24, by);
  r.tap(14 + 14 + 260, 70 + 8 + 20);   // second cell (right column)
  TEST_ASSERT_EQUAL_STRING("script", r.s.calls[6].domain.c_str());
  TEST_ASSERT_EQUAL_STRING("turn_on", r.s.calls[6].service.c_str());
}

void test_media_redraw_only_on_change() {
  Rig r(kTile);
  int parts = r.tileParts();
  r.set("media_position", "120");   // dropped at the client; even in the store it draws nothing
  TEST_ASSERT_EQUAL_INT(parts, r.tileParts());
  r.set("media_title", "So What");
  TEST_ASSERT_EQUAL_INT(parts + 1, r.tileParts());
  r.set(nullptr, nullptr, "paused");
  TEST_ASSERT_EQUAL_INT(parts + 2, r.tileParts());
  TEST_ASSERT_TRUE(r.sig("t0").find("PAUSED") != std::string::npos);
}

void test_media_press_feedback() {   // a transport tap shows one inverted partial (< 0.6 s on the panel), then the restore
  Rig r(kTile, true);
  int parts = r.d.partials();
  r.tap(14 + 14 + 24, 70 + 192 - 12 - 24);
  TEST_ASSERT_EQUAL_INT(1, int(r.s.calls.size()));
  TEST_ASSERT_EQUAL_INT(parts + 2, r.d.partials());
}

void test_media_narrow_and_tall() {
  Rig r("      - {type: media, entity: media_player.living_room, favorites: A=music:1; B=music:2}\n"
        "      - {type: media, entity: media_player.living_room, label: Kitchen, cs: 2, rs: 2, favorites: A=music:1; B=music:2}\n");
  std::string t0 = r.sig("t0"), t1 = r.sig("t1");
  TEST_ASSERT_TRUE(t0.find("32%") == std::string::npos);   // 1 wide: no volume
  TEST_ASSERT_TRUE_MESSAGE(t1.find("A") != std::string::npos && t1.find("KITCHEN") != std::string::npos, t1.c_str());
  r.tap(14 + 184 - 14 - 16, 70 + 8 + 16);   // ★ in the 1-wide header
  TEST_ASSERT_TRUE(r.sig("t0").find("×") != std::string::npos);
}

// eink-ha-os#351: a VOLUME_SET player gets the bar (region v0) from x 14 + 14 + 184 to ★ (380 − 14 − 48 − 8): 112 px wide
void test_media_volume_slider() {
  Rig r(kTile, false, "152511");
  const int bx = 14 + 14 + 184, bw = 380 - 28 - 184 - 56, by = 70 + 192 - 12 - 24;
  std::string v0 = r.sig("v0");
  TEST_ASSERT_TRUE_MESSAGE(v0.find("32%") != std::string::npos, v0.c_str());
  TEST_ASSERT_TRUE(r.sig("t0").find("32%") == std::string::npos);   // not in the header
  const int parts = r.tileParts();
  r.tap(bx + bw * 3 / 4, by);   // three quarters along: 75 %
  TEST_ASSERT_EQUAL_INT(1, int(r.s.calls.size()));
  TEST_ASSERT_EQUAL_STRING("volume_set", r.s.calls[0].service.c_str());
  TEST_ASSERT_EQUAL_STRING("{\"entity_id\":\"media_player.living_room\",\"volume_level\":0.75}", r.s.calls[0].json.c_str());
  TEST_ASSERT_TRUE_MESSAGE(r.sig("v0").find("75%") != std::string::npos, r.sig("v0").c_str());   // optimistic
  TEST_ASSERT_EQUAL_INT(parts + 1, r.tileParts());   // one partial: the bar only
  const auto& last = r.d.events.back();
  TEST_ASSERT_EQUAL_INT(bx, last.r.x);
  TEST_ASSERT_EQUAL_INT(bw, last.r.w);
  TEST_ASSERT_EQUAL_INT(48, last.r.h);
  // HA reports 0.75: the ack draws nothing new
  r.set("volume_level", "0.75");
  TEST_ASSERT_EQUAL_INT(parts + 1, r.tileParts());
  // a slow drag to the left from the bar: one call at the lift point; a fast one is not a page swipe
  r.drag(bx + bw * 3 / 4, by, bx + bw / 4);
  TEST_ASSERT_EQUAL_INT(2, int(r.s.calls.size()));
  TEST_ASSERT_TRUE(r.s.calls[1].json.find("\"volume_level\":0.25") != std::string::npos);
  r.drag(bx + 10, by, bx + bw + 40, true);
  TEST_ASSERT_EQUAL_INT(3, int(r.s.calls.size()));
  TEST_ASSERT_TRUE_MESSAGE(r.s.calls[2].json.find("\"volume_level\":1}") != std::string::npos, r.s.calls[2].json.c_str());
  TEST_ASSERT_TRUE(r.sig("t0").find("Evening Radio Hour") != std::string::npos);   // still this page
  // a drag that starts off the bar does nothing
  r.drag(14 + 100, 70 + 60, 14 + 300);
  TEST_ASSERT_EQUAL_INT(3, int(r.s.calls.size()));
  // no ack within 10 s: HA's level again
  r.step(11000);
  TEST_ASSERT_TRUE_MESSAGE(r.sig("v0").find("75%") != std::string::npos, r.sig("v0").c_str());
}

void test_media_steps_without_volume_set() {   // VOLUME_STEP only: − / + stay, no bar
  Rig r(kTile, false, "1024");
  TEST_ASSERT_TRUE(r.sig("v0").empty());
  TEST_ASSERT_TRUE(r.sig("t0").find("32%") != std::string::npos);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_media_vectors);
  RUN_TEST(test_media_attrs_kept);
  RUN_TEST(test_media_tile_taps);
  RUN_TEST(test_media_redraw_only_on_change);
  RUN_TEST(test_media_press_feedback);
  RUN_TEST(test_media_narrow_and_tall);
  RUN_TEST(test_media_volume_slider);
  RUN_TEST(test_media_steps_without_volume_set);
  return UNITY_END();
}
