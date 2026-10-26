// core/epd_sequence (#201, #197): a model of the SSD1677's BW (0x24) and RED (0x26) RAM planes, following the vendored
// Ssd1677Driver in single-buffer mode, plus the glass. A FAST or window partial compares 0x24 with 0x26 over the whole
// panel and drives every pixel where they differ, even when only a window was written; HALF/FULL drive every pixel.
// After any sequence both planes hold the base (a window partial drives nothing outside its window), and the glass
// shows the 2-bit frame: a gray from the last frame neither stays nor gets the overlay twice. A Fast is B/W only (#212):
// the glass shows the frame thresholded (dark gray black, light gray white) and the next Clean brings the grays back.
#include <unity.h>

#include <cstdint>
#include <cstring>
#include <vector>

#include "core/epd_sequence.h"

using namespace x4;

void setUp() {}
void tearDown() {}

namespace {
constexpr int kW = 800, kH = 480, kWb = kW / 8, kN = kWb * kH;

// Glass per pixel: 2-bit level as the UI draws it (0 black, 1 dark gray, 2 light gray, 3 white); kOver = the overlay ran
// on a pixel that was not white (twice-darkened gray or a gray over black).
constexpr uint8_t kOver = 9;
inline bool bit(const std::vector<uint8_t>& p, int i) { return (p[i >> 3] >> (7 - (i & 7))) & 1; }
inline bool bit(const uint8_t* p, int i) { return (p[i >> 3] >> (7 - (i & 7))) & 1; }

struct FakeSsd1677 {
  enum RefreshMode { FULL_REFRESH, HALF_REFRESH, FAST_REFRESH };
  std::vector<uint8_t> bw = std::vector<uint8_t>(kN, 0), red = std::vector<uint8_t>(kN, 0);
  std::vector<uint8_t> glass = std::vector<uint8_t>(kW * kH, 0);
  bool inGray = false;
  long drivenOutside = -1;   // pixels driven outside the window by the last displayWindow
  long drivenLast = 0;       // pixels the last refresh drove
  int grayPasses = 0;

  void drive(bool all) {     // BW = new; FAST drives only where BW != RED
    drivenLast = 0;
    for (int i = 0; i < kW * kH; i++)
      if (all || bit(bw, i) != bit(red, i)) { glass[i] = bit(bw, i) ? 3 : 0; ++drivenLast; }
  }
  void displayBuffer(RefreshMode m, const uint8_t* fb) {   // every mode ends with both planes = fb (post-refresh sync)
    if (inGray && m == FAST_REFRESH) m = HALF_REFRESH;      // driver: FAST out of gray RAM is promoted
    inGray = false;
    memcpy(bw.data(), fb, kN);
    drive(m != FAST_REFRESH);
    memcpy(red.data(), fb, kN);
  }
  void copyGrayscaleBuffers(const uint8_t* lsb, const uint8_t* msb) {
    memcpy(bw.data(), lsb, kN);
    memcpy(red.data(), msb, kN);
  }
  void copyGrayscaleMsbBuffers(const uint8_t* msb) { memcpy(red.data(), msb, kN); }
  void displayGrayBuffer() {   // overlay LUT: MSB 1 darkens a white pixel to dark (LSB 1) or light (LSB 0) gray
    inGray = true;
    ++grayPasses;
    for (int i = 0; i < kW * kH; i++)
      if (bit(red, i)) glass[i] = glass[i] == 3 ? (bit(bw, i) ? 1 : 2) : kOver;
  }
  void cleanupGrayscaleBuffers(const uint8_t* b) {
    memcpy(red.data(), b, kN);
    inGray = false;
  }
  void copyGrayscaleLsbBuffers(const uint8_t* lsb) { memcpy(bw.data(), lsb, kN); }

  void displayWindow(const uint8_t* fb, int x, int y, int w, int h) {
    if (inGray) return displayBuffer(HALF_REFRESH, fb);
    for (int r = y; r < y + h; r++) memcpy(&bw[r * kWb + x / 8], &fb[r * kWb + x / 8], w / 8);
    drive(false);
    drivenOutside = 0;
    for (int r = 0; r < kH; r++)
      for (int c = 0; c < kWb; c++) {
        const bool in = r >= y && r < y + h && c >= x / 8 && c < (x + w) / 8;
        if (!in) drivenOutside += __builtin_popcount(bw[r * kWb + c] ^ red[r * kWb + c]);
      }
    for (int r = y; r < y + h; r++) {
      memcpy(&bw[r * kWb + x / 8], &fb[r * kWb + x / 8], w / 8);
      memcpy(&red[r * kWb + x / 8], &fb[r * kWb + x / 8], w / 8);
    }
  }
};

// The firmware's EInkDisplay owns its framebuffer; the fake takes it as an argument, so bind it here.
struct Bound {
  using RefreshMode = FakeSsd1677::RefreshMode;
  static constexpr RefreshMode FULL_REFRESH = FakeSsd1677::FULL_REFRESH;
  static constexpr RefreshMode HALF_REFRESH = FakeSsd1677::HALF_REFRESH;
  static constexpr RefreshMode FAST_REFRESH = FakeSsd1677::FAST_REFRESH;
  FakeSsd1677& p;
  const uint8_t* fb;
  void displayBuffer(RefreshMode m) { p.displayBuffer(m, fb); }
  void copyGrayscaleMsbBuffers(const uint8_t* m) { p.copyGrayscaleMsbBuffers(m); }
  void copyGrayscaleBuffers(const uint8_t* l, const uint8_t* m) { p.copyGrayscaleBuffers(l, m); }
  void displayGrayBuffer() { p.displayGrayBuffer(); }
  void cleanupGrayscaleBuffers(const uint8_t* b) { p.cleanupGrayscaleBuffers(b); }
  void copyGrayscaleLsbBuffers(const uint8_t* l) { p.copyGrayscaleLsbBuffers(l); }
};

// A dashboard-like frame (1 = white): white background, black text rows, AA edges = dark gray (LSB 1, MSB 1)
// and light gray (LSB 0, MSB 1); in the B/W base the grays are white.
struct Frame {
  std::vector<uint8_t> base = std::vector<uint8_t>(kN, 0xFF), lsb = std::vector<uint8_t>(kN, 0),
                       msb = std::vector<uint8_t>(kN, 0);
  explicit Frame(int r0 = 100, bool gray = true) {
    for (int r = r0; r < 400; r += 20)
      for (int c = 5; c < 95; c++) {
        base[r * kWb + c] = 0xF0;   // 4 px black text (right half), white under the grays
        if (!gray) continue;
        msb[r * kWb + c] = 0xF0;    // 4 px gray edge
        lsb[r * kWb + c] = 0xC0;    // 2 of them dark gray
      }
  }
  bool anyGray() const { for (uint8_t m : msb) if (m) return true; return false; }
  // thresholded as a partial / Fast sends it (X4Display::toBw grayBase false): dark gray black, light gray white
  std::vector<uint8_t> bwBase() const {
    std::vector<uint8_t> t(kN);
    for (int i = 0; i < kN; i++) t[i] = static_cast<uint8_t>(base[i] & ~lsb[i]);
    return t;
  }
  uint8_t level(int i) const { return !bit(base, i) ? 0 : !bit(msb, i) ? 3 : bit(lsb, i) ? 1 : 2; }
  uint8_t bwLevel(int i) const { return level(i) >= 2 ? 3 : 0; }
  long wrongOn(const FakeSsd1677& p) const {   // glass pixels that do not show this frame
    long n = 0;
    for (int i = 0; i < kW * kH; i++) n += p.glass[i] != level(i);
    return n;
  }
  long wrongOnBw(const FakeSsd1677& p) const {   // ... this frame after a Fast (B/W)
    long n = 0;
    for (int i = 0; i < kW * kH; i++) n += p.glass[i] != bwLevel(i);
    return n;
  }
};

// The #201/#197 rule: both RAM planes = the glass, grays counted as white.
bool planesMatchGlass(const FakeSsd1677& p) {
  if (p.bw != p.red) return false;
  for (int i = 0; i < kW * kH; i++)
    if (bit(p.bw, i) != (p.glass[i] != 0)) return false;
  return true;
}

// What X4Display::show does per refresh: Fast sends the frame thresholded without a gray pass (#212), with the RED seed
// when grays are on the glass; Clean / Full send the base (grays white) and the overlay.
struct Panel {
  FakeSsd1677 p;
  std::vector<uint8_t> fb;          // the host B/W buffer (EInkDisplay framebuffer): what the last refresh sent
  std::vector<uint8_t> grayMask;    // msb of the frame on the glass when it shows grays, else empty
  void show(const Frame& f, EpdKind kind, bool seed = true) {
    const std::vector<uint8_t> nb = kind == EpdKind::Fast ? f.bwBase() : f.base;
    std::vector<uint8_t> red(kN);
    const bool useSeed = seed && kind == EpdKind::Fast && !grayMask.empty();
    if (useSeed)
      for (int i = 0; i < kN; i++) red[i] = redSeedByte(fb[i], nb[i], grayMask[i]);
    const bool withGray = grayPassFor(kind, f.anyGray());
    fb = nb;
    Bound b{p, fb.data()};
    epdSequence(b, kind, fb.data(), f.lsb.data(), f.msb.data(), f.anyGray(), true, useSeed ? red.data() : nullptr);
    grayMask = withGray ? f.msb : std::vector<uint8_t>();
  }
  bool planesHold(const Frame& f) const { return p.bw == f.base && p.red == f.base; }
  bool planesHoldBw(const Frame& f) const { const auto t = f.bwBase(); return p.bw == t && p.red == t; }
};

long windowAfterFull(bool grayPass, bool resyncBw) {
  FakeSsd1677 p;
  Frame f;
  Bound b{p, f.base.data()};
  epdSequence(b, EpdKind::Full, f.base.data(), f.lsb.data(), f.msb.data(), grayPass, resyncBw);
  std::vector<uint8_t> next = f.base;   // clock tick: a 160x48 window at (320, 16) changes
  for (int r = 16; r < 64; r++) memset(&next[r * kWb + 40], 0x00, 20);
  p.displayWindow(next.data(), 320, 16, 160, 48);
  return p.drivenOutside;
}
}  // namespace

static void test_gray_full_then_window_drives_nothing_outside() {
  TEST_ASSERT_EQUAL_INT32(0, windowAfterFull(true, true));
}

static void test_without_resync_the_window_drives_the_whole_screen() {
  // the #201 bug: 0x24 still holds the LSB plane, so white background and light-gray edges flip outside the window
  TEST_ASSERT_GREATER_THAN_INT32(kW * kH / 2, windowAfterFull(true, false));
}

static void test_bw_full_then_window_drives_nothing_outside() {
  TEST_ASSERT_EQUAL_INT32(0, windowAfterFull(false, true));
  TEST_ASSERT_EQUAL_INT32(0, windowAfterFull(false, false));
}

static void test_second_window_still_clean() {
  FakeSsd1677 p;
  Frame f;
  Bound b{p, f.base.data()};
  epdSequence(b, EpdKind::Full, f.base.data(), f.lsb.data(), f.msb.data(), true, true);
  std::vector<uint8_t> next = f.base;
  for (int r = 16; r < 64; r++) memset(&next[r * kWb + 40], 0x00, 20);
  p.displayWindow(next.data(), 320, 16, 160, 48);
  for (int r = 16; r < 64; r++) memset(&next[r * kWb + 40], 0xFF, 20);
  p.displayWindow(next.data(), 320, 16, 160, 48);
  TEST_ASSERT_EQUAL_INT32(0, p.drivenOutside);
  TEST_ASSERT_TRUE(p.bw == p.red);
}

// ---- #197: fast and clean sequences ----
static void test_clean_shows_the_frame_and_leaves_the_base_in_both_planes() {
  Frame a;
  Panel x;
  x.show(a, EpdKind::Clean);
  TEST_ASSERT_EQUAL_INT32(0, a.wrongOn(x.p));
  TEST_ASSERT_TRUE(x.planesHold(a));
}

static void test_fast_bw_drives_only_changed_pixels() {
  Frame a(100, false), b(110, false);
  Panel x;
  x.show(a, EpdKind::Clean);
  x.show(b, EpdKind::Fast);
  long diff = 0;
  for (int i = 0; i < kW * kH; i++) diff += bit(a.base, i) != bit(b.base, i);
  TEST_ASSERT_EQUAL_INT32(diff, x.p.drivenLast);
  TEST_ASSERT_EQUAL_INT32(0, b.wrongOn(x.p));
  TEST_ASSERT_TRUE(x.planesHold(b));
}

static void test_fast_after_gray_page_shows_the_new_page() {
  Frame a(100), b(110);   // the grays move
  Panel x;
  x.show(a, EpdKind::Clean);
  x.show(b, EpdKind::Fast);
  TEST_ASSERT_EQUAL_INT32(0, b.wrongOnBw(x.p));
  TEST_ASSERT_TRUE(x.planesHoldBw(b));
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
}

// #212: a Fast never runs the gray pass; the glass is B/W after it and the next Clean restores the grays
static void test_fast_is_bw_and_clean_restores_grays() {
  Frame a(100), b(110);
  Panel x;
  x.show(a, EpdKind::Clean);
  TEST_ASSERT_EQUAL_INT(1, x.p.grayPasses);
  x.show(b, EpdKind::Fast);
  TEST_ASSERT_EQUAL_INT(1, x.p.grayPasses);
  long grays = 0;
  for (uint8_t g : x.p.glass) grays += g != 0 && g != 3;
  TEST_ASSERT_EQUAL_INT32(0, grays);
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
  x.show(a, EpdKind::Fast);                    // B/W glass: no seed needed
  TEST_ASSERT_EQUAL_INT32(0, a.wrongOnBw(x.p));
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
  x.show(a, EpdKind::Clean);
  TEST_ASSERT_EQUAL_INT(2, x.p.grayPasses);
  TEST_ASSERT_EQUAL_INT32(0, a.wrongOn(x.p));
  TEST_ASSERT_TRUE(x.planesHold(a));
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
}

// the epdSequence rule itself: grayPass = true is ignored for a Fast
static void test_fast_ignores_gray_pass_request() {
  FakeSsd1677 p;
  Frame f;
  const auto t = f.bwBase();
  Bound b{p, t.data()};
  epdSequence(b, EpdKind::Fast, t.data(), f.lsb.data(), f.msb.data(), true, true);
  TEST_ASSERT_EQUAL_INT(0, p.grayPasses);
  TEST_ASSERT_TRUE(planesMatchGlass(p));
}

static void test_fast_without_seed_leaves_old_grays() {
  Frame a(100), b(110);
  Panel x;
  x.show(a, EpdKind::Clean);
  x.show(b, EpdKind::Fast, false);
  TEST_ASSERT_GREATER_THAN_INT32(1000, b.wrongOnBw(x.p));   // A's light grays stay where B is white
}

static void test_fast_same_gray_page_twice() {
  Frame a(100);
  Panel x;
  x.show(a, EpdKind::Clean);
  x.show(a, EpdKind::Fast);
  TEST_ASSERT_EQUAL_INT32(0, a.wrongOnBw(x.p));
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
  for (uint8_t g : x.p.glass) TEST_ASSERT_TRUE(g != kOver);
  Panel y;
  y.show(a, EpdKind::Clean);
  y.show(a, EpdKind::Fast, false);
  TEST_ASSERT_GREATER_THAN_INT32(0, a.wrongOnBw(y.p));   // without the seed the light grays stay (white in both)
}

static void test_fast_gray_to_bw_page() {
  Frame a(100), b(110, false);
  Panel x;
  x.show(a, EpdKind::Clean);
  x.show(b, EpdKind::Fast);
  TEST_ASSERT_EQUAL_INT32(0, b.wrongOn(x.p));   // B/W page: thresholded = itself
  TEST_ASSERT_TRUE(x.planesHold(b));
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
}

static void test_window_after_fast_or_clean_drives_nothing_outside() {
  for (EpdKind k : {EpdKind::Fast, EpdKind::Clean}) {
    Frame a(100), b(110);
    Panel x;
    x.show(a, EpdKind::Clean);
    x.show(b, k);
    std::vector<uint8_t> next = b.base;
    for (int r = 16; r < 64; r++) memset(&next[r * kWb + 40], 0x00, 20);
    x.p.displayWindow(next.data(), 320, 16, 160, 48);
    TEST_ASSERT_EQUAL_INT32(0, x.p.drivenOutside);
    TEST_ASSERT_TRUE(x.p.bw == x.p.red);
  }
}

static void test_ten_fast_pages_stay_correct() {
  std::vector<Frame> pages;
  for (int i = 0; i < 4; i++) pages.emplace_back(100 + 5 * i, i != 2);   // one B/W page among gray ones
  Panel x;
  x.show(pages[0], EpdKind::Clean);
  for (int n = 1; n <= 10; n++) {
    const Frame& f = pages[(n * 3) % 4];
    x.show(f, EpdKind::Fast);
    TEST_ASSERT_EQUAL_INT32(0, f.wrongOnBw(x.p));
    TEST_ASSERT_TRUE(x.planesHoldBw(f));
    TEST_ASSERT_TRUE(planesMatchGlass(x.p));
  }
  x.show(pages[1], EpdKind::Clean);            // the 10th navigation: the clean brings the grays back
  TEST_ASSERT_EQUAL_INT32(0, pages[1].wrongOn(x.p));
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
}

static void test_partial_between_gray_page_and_fast() {
  Frame a(100), b(110);
  Panel x;
  x.show(a, EpdKind::Clean);
  // a partial thresholds the whole frame into the host buffer (dark gray → black) and sends a window over gray rows
  x.fb = a.bwBase();
  x.p.displayWindow(x.fb.data(), 0, 96, 800, 48);
  x.show(b, EpdKind::Fast);
  TEST_ASSERT_EQUAL_INT32(0, b.wrongOnBw(x.p));
  TEST_ASSERT_TRUE(x.planesHoldBw(b));
  TEST_ASSERT_TRUE(planesMatchGlass(x.p));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_gray_full_then_window_drives_nothing_outside);
  RUN_TEST(test_without_resync_the_window_drives_the_whole_screen);
  RUN_TEST(test_bw_full_then_window_drives_nothing_outside);
  RUN_TEST(test_second_window_still_clean);
  RUN_TEST(test_clean_shows_the_frame_and_leaves_the_base_in_both_planes);
  RUN_TEST(test_fast_bw_drives_only_changed_pixels);
  RUN_TEST(test_fast_after_gray_page_shows_the_new_page);
  RUN_TEST(test_fast_without_seed_leaves_old_grays);
  RUN_TEST(test_fast_same_gray_page_twice);
  RUN_TEST(test_fast_is_bw_and_clean_restores_grays);
  RUN_TEST(test_fast_ignores_gray_pass_request);
  RUN_TEST(test_fast_gray_to_bw_page);
  RUN_TEST(test_window_after_fast_or_clean_drives_nothing_outside);
  RUN_TEST(test_ten_fast_pages_stay_correct);
  RUN_TEST(test_partial_between_gray_page_and_fast);
  return UNITY_END();
}
