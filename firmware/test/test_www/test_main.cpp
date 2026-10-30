// core/www_image (#350): www partition bounds, the erase-then-write order, sha verdict, version file, manifest entry.
#include <unity.h>
#include <string>
#include <vector>
#include "core/www_image.h"

using namespace x4::www;

void setUp() {}
void tearDown() {}

constexpr uint32_t kSize = 0x340000;   // partitions.csv www

struct FakeFlash : Sink {
  std::vector<uint8_t> mem = std::vector<uint8_t>(kSize, 0);
  std::vector<uint32_t> erases;
  size_t maxEnd = 0;
  bool failErase = false, failWrite = false;
  size_t writes = 0;
  bool erase(uint32_t off, uint32_t len) override {
    if (failErase) return false;
    erases.push_back(off);
    for (uint32_t i = 0; i < len; ++i) mem.at(off + i) = 0xFF;
    return true;
  }
  bool write(uint32_t off, const uint8_t* d, size_t n) override {
    if (failWrite) return false;
    // only whole sectors, sector aligned (the Update pattern; #350 device run)
    if (off % kErase || n != kErase) return false;
    ++writes;
    for (size_t i = 0; i < n; ++i) {
      if (mem.at(off + i) != 0xFF) return false;   // written without erase first
      mem.at(off + i) = d[i];
    }
    if (off + n > maxEnd) maxEnd = off + n;
    return true;
  }
};

void test_bounds() {
  TEST_ASSERT_NULL(checkTarget(kStart, kSize, kSize));
  TEST_ASSERT_NOT_NULL(checkTarget(kStart, kSize, kSize - 1));          // short image
  TEST_ASSERT_NOT_NULL(checkTarget(kStart, kSize, kSize + 1));          // longer than the partition
  TEST_ASSERT_NOT_NULL(checkTarget(0x9000, 0x5000, 0x5000));            // NVS
  TEST_ASSERT_NOT_NULL(checkTarget(0xFD0000, 0x20000, 0x20000));        // userdata
  TEST_ASSERT_NOT_NULL(checkTarget(kStart, kSize + kErase, kSize + kErase));   // would reach userdata
  TEST_ASSERT_NOT_NULL(checkTarget(0x650000, 0x640000, 0x640000));     // app1
  TEST_ASSERT_NOT_NULL(checkTarget(kStart + 0x800, kSize - kErase, kSize - kErase));   // not sector aligned
  TEST_ASSERT_NOT_NULL(checkTarget(kStart, 0, 0));
}

void test_write_streams_and_verifies() {
  FakeFlash f;
  Writer w;
  std::vector<uint8_t> buf(kErase);
  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  std::vector<uint8_t> chunk(1436);   // TCP-sized (lwIP MSS), not sector aligned
  size_t left = kSize;
  uint8_t v = 0;
  while (left) {
    size_t n = left < chunk.size() ? left : chunk.size();
    for (size_t i = 0; i < n; ++i) chunk[i] = v++;
    TEST_ASSERT_TRUE(w.write(chunk.data(), n));
    left -= n;
  }
  TEST_ASSERT_EQUAL(kSize / kErase, f.erases.size());   // each sector erased exactly once
  TEST_ASSERT_EQUAL(kSize / kErase, f.writes);          // and written in one aligned 4 KB go
  for (size_t i = 0; i < kSize; i += 99991) TEST_ASSERT_EQUAL_UINT8(uint8_t(i), f.mem[i]);
  for (size_t i = 0; i < f.erases.size(); ++i) TEST_ASSERT_EQUAL_UINT32(i * kErase, f.erases[i]);
  TEST_ASSERT_EQUAL(kSize, f.maxEnd);
  const std::string sha(64, 'a');
  TEST_ASSERT_NULL(w.finish(sha, std::string(64, 'A')));   // hex compare is case-insensitive
  TEST_ASSERT_FALSE(w.active());
}

void test_refuses_overflow_and_mismatch() {
  FakeFlash f;
  Writer w;
  std::vector<uint8_t> buf(kErase);
  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  std::vector<uint8_t> big(kSize + 1, 1);
  TEST_ASSERT_FALSE(w.write(big.data(), big.size()));   // one byte too many: nothing written
  TEST_ASSERT_EQUAL(0, f.maxEnd);
  TEST_ASSERT_EQUAL_STRING("", w.failedOp());   // refused, not a flash error
  TEST_ASSERT_FALSE(w.write(big.data(), 1));            // dead after a refusal
  TEST_ASSERT_NOT_NULL(w.finish(std::string(64, 'a'), std::string(64, 'a')));

  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  TEST_ASSERT_TRUE(w.write(big.data(), 4096));
  TEST_ASSERT_EQUAL_STRING("www.bin is incomplete", w.finish(std::string(64, 'a'), std::string(64, 'a')));

  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  TEST_ASSERT_TRUE(w.write(big.data(), kSize));
  TEST_ASSERT_EQUAL_STRING("SHA-256 does not match", w.finish(std::string(64, 'a'), std::string(64, 'b')));
  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  TEST_ASSERT_TRUE(w.write(big.data(), kSize));
  TEST_ASSERT_EQUAL_STRING("SHA-256 missing", w.finish(std::string(64, 'a'), ""));

  f.failErase = true;
  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  TEST_ASSERT_TRUE(w.write(big.data(), 10));             // staged, nothing touched yet
  TEST_ASSERT_FALSE(w.write(big.data(), 2 * kErase));    // first full sector → erase fails
  TEST_ASSERT_EQUAL_STRING("erase", w.failedOp());
  TEST_ASSERT_EQUAL_UINT32(0, w.failedAt());
  f.failErase = false;
  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  TEST_ASSERT_TRUE(w.write(big.data(), kErase + 5));
  f.failWrite = true;
  TEST_ASSERT_FALSE(w.write(big.data(), kErase));        // second sector → write fails at 0x1000
  TEST_ASSERT_EQUAL_STRING("write", w.failedOp());
  TEST_ASSERT_EQUAL_UINT32(kErase, w.failedAt());
  TEST_ASSERT_NULL(w.begin(&f, buf.data(), kStart, kSize, kSize));
  TEST_ASSERT_EQUAL_STRING("", w.failedOp());
  TEST_ASSERT_NOT_NULL(w.begin(&f, buf.data(), 0xFD0000, 0x20000, 0x20000));   // userdata target refused at begin
  TEST_ASSERT_FALSE(w.active());
}

void test_version_and_manifest() {
  TEST_ASSERT_EQUAL_STRING("0.2.0-beta.5", consoleVersion("0.2.0-beta.5\n").c_str());
  TEST_ASSERT_EQUAL_STRING("", consoleVersion("").c_str());
  TEST_ASSERT_EQUAL_STRING("", consoleVersion("a b").c_str());
  TEST_ASSERT_EQUAL_STRING("", consoleVersion(std::string(65, '1')).c_str());
  TEST_ASSERT_TRUE(consoleCurrent("0.3.0", "0.3.0"));
  TEST_ASSERT_FALSE(consoleCurrent("", ""));
  TEST_ASSERT_FALSE(consoleCurrent("0.2.0", "0.3.0"));

  Manifest m;
  const std::string sha(64, 'F');
  TEST_ASSERT_TRUE(parseManifest("{\"version\":\"0.3.0\",\"www\":{\"path\":\"www.bin\",\"size\":3407872,\"sha256\":\"" + sha + "\"}}", m));
  TEST_ASSERT_EQUAL_STRING("www.bin", m.path.c_str());
  TEST_ASSERT_EQUAL(3407872, m.size);
  TEST_ASSERT_EQUAL_STRING(std::string(64, 'f').c_str(), m.sha256.c_str());
  TEST_ASSERT_FALSE(parseManifest("{\"version\":\"0.2.0\",\"sha256\":\"" + sha + "\",\"size\":1}", m));   // pre-#350
  TEST_ASSERT_FALSE(parseManifest("{\"www\":{\"path\":\"www.bin\",\"size\":0,\"sha256\":\"" + sha + "\"}}", m));
  TEST_ASSERT_FALSE(parseManifest("{\"www\":{\"path\":\"www.bin\",\"size\":5,\"sha256\":\"xyz\"}}", m));
  TEST_ASSERT_FALSE(parseManifest("not json", m));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_bounds);
  RUN_TEST(test_write_streams_and_verifies);
  RUN_TEST(test_refuses_overflow_and_mismatch);
  RUN_TEST(test_version_and_manifest);
  return UNITY_END();
}
