// core/access_cache (#19): the HA access token kept in RTC memory across deep sleep.
#include <unity.h>
#include <cstring>
#include <string>
#include "core/access_cache.h"

using namespace x4;

void setUp() {}
void tearDown() {}

static const int64_t T0 = 1790000000000LL;
static const int64_t kTtl = 1800000;   // HA: 30 min
static const uint32_t B = access::bindOf("http://ha.example:8123", "http://x4.local/", "refresh-a");

static access::Rec fresh() {
  access::Rec r;
  memset(&r, 0xa5, sizeof r);   // RTC_NOINIT garbage after power-on
  return r;
}

void test_garbage_is_not_a_token() {
  access::Rec r = fresh();
  std::string t;
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
  TEST_ASSERT_TRUE(t.empty());
}

void test_reuse_until_margin() {
  access::Rec r = fresh();
  access::store(r, "tok-1", T0, kTtl, B);
  std::string t;
  TEST_ASSERT_EQUAL_INT64(kTtl, access::take(r, T0, B, t));
  TEST_ASSERT_EQUAL_STRING("tok-1", t.c_str());
  t.clear();
  TEST_ASSERT_EQUAL_INT64(kTtl - 900000, access::take(r, T0 + 900000, B, t));   // a glance wake 15 min later
  TEST_ASSERT_EQUAL_STRING("tok-1", t.c_str());
  t.clear();
  const int64_t edge = T0 + kTtl - access::kMarginMs;
  TEST_ASSERT_EQUAL_INT64(access::kMarginMs + 1, access::take(r, edge - 1, B, t));
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, edge, B, t));   // inside the margin: refresh
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0 + kTtl + 1, B, t));
}

void test_other_link_or_relink() {
  access::Rec r = fresh();
  access::store(r, "tok-1", T0, kTtl, B);
  std::string t;
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, access::bindOf("http://ha.example:8123", "http://x4.local/", "refresh-b"), t));
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, access::bindOf("http://other:8123", "http://x4.local/", "refresh-a"), t));
  TEST_ASSERT_TRUE(t.empty());
}

void test_clock_back_or_unset() {
  access::Rec r = fresh();
  access::store(r, "tok-1", T0, kTtl, B);
  std::string t;
  TEST_ASSERT_NOT_EQUAL(0, access::take(r, T0 - access::kSlackMs, B, t));   // BM8563 truncation, small NTP step
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0 - access::kSlackMs - 1, B, t));
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, 5000, B, t));                   // clock not set
  access::store(r, "tok-1", 5000, kTtl, B);                                   // stored without a clock: nothing
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, 5000, B, t));
}

void test_bad_ttl_or_length_not_kept() {
  access::Rec r = fresh();
  std::string t;
  access::store(r, "tok-1", T0, access::kMarginMs, B);
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
  access::store(r, "tok-1", T0, access::kMaxTtlMs + 1, B);
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
  access::store(r, "", T0, kTtl, B);
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
  access::store(r, std::string(access::kMaxLen, 'x'), T0, kTtl, B);
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
  access::store(r, std::string(access::kMaxLen - 1, 'x'), T0, kTtl, B);
  TEST_ASSERT_EQUAL_INT64(kTtl, access::take(r, T0, B, t));
  TEST_ASSERT_EQUAL(access::kMaxLen - 1, t.size());
}

void test_clear_wipes_bytes() {
  access::Rec r = fresh();
  access::store(r, "secret-token", T0, kTtl, B);
  access::clear(r);
  std::string t;
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
  const auto* p = reinterpret_cast<const uint8_t*>(&r);
  for (size_t i = 0; i < sizeof r; ++i) TEST_ASSERT_EQUAL_UINT8(0, p[i]);
}

void test_corruption_rejected() {
  access::Rec r = fresh();
  access::store(r, "tok-1", T0, kTtl, B);
  r.tok[2] ^= 1;
  std::string t;
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
  access::store(r, "tok-1", T0, kTtl, B);
  r.expiresAt += 3600000;
  TEST_ASSERT_EQUAL_INT64(0, access::take(r, T0, B, t));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_garbage_is_not_a_token);
  RUN_TEST(test_reuse_until_margin);
  RUN_TEST(test_other_link_or_relink);
  RUN_TEST(test_clock_back_or_unset);
  RUN_TEST(test_bad_ttl_or_length_not_kept);
  RUN_TEST(test_clear_wipes_bytes);
  RUN_TEST(test_corruption_rejected);
  return UNITY_END();
}
