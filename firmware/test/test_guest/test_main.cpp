// core/guest_wifi + app/qr (qrcodegen) (eink-ha-os#329) against spec/test-vectors/guest-wifi.json (emulator src/core/guestWifi.ts).
#include <unity.h>
#include <fstream>
#include <sstream>
#include <string>
#include "core/guest_wifi.h"
#include "core/json.h"

using namespace x4;

void setUp() {}
void tearDown() {}

static bool load(Json& j) {
  std::ifstream f(std::string(X4_REPO_ROOT) + "/spec/test-vectors/guest-wifi.json", std::ios::binary);
  std::stringstream ss; ss << f.rdbuf();
  return !ss.str().empty() && parseJson(ss.str(), j);
}
static std::string str(const Json& o, const char* k) { const Json* v = o.get(k); return v && v->isStr() ? v->str : std::string(); }

void test_payload_and_fields() {
  Json j; TEST_ASSERT_TRUE(load(j));
  for (auto& c : j.get("payload")->arr)
    TEST_ASSERT_EQUAL_STRING(str(c, "out").c_str(),
                             guest::payload(str(c, "ssid"), str(c, "password"), str(c, "security"), c.get("hidden")->b).c_str());
  int n = 0;
  for (auto& c : j.get("fields")->arr) {
    TEST_ASSERT_EQUAL_STRING_MESSAGE(str(c, "encoded").c_str(), guest::fieldEncode(str(c, "value")).c_str(), str(c, "value").c_str());
    TEST_ASSERT_EQUAL_STRING(str(c, "value").c_str(), guest::fieldDecode(str(c, "encoded")).c_str());
    ++n;
  }
  for (auto& c : j.get("decode")->arr) TEST_ASSERT_EQUAL_STRING(str(c, "out").c_str(), guest::fieldDecode(str(c, "value")).c_str());
  TEST_ASSERT_GREATER_THAN(10, n);
}

void test_views() {
  Json j; TEST_ASSERT_TRUE(load(j));
  static const char* kStatus[] = {"ok", "pick", "wait", "long"};
  for (auto& c : j.get("views")->arr) {
    const Json& w = *c.get("w"); const Json& o = *c.get("out");
    const Json* pw = c.get("pwState");
    guest::View v = guest::view(str(w, "ssid"), str(w, "password"), str(w, "security"), str(w, "hidden"), str(w, "password_entity"),
                                pw->isStr() ? pw->str.c_str() : nullptr);
    const std::string nm = str(c, "name"); const char* name = nm.c_str();
    TEST_ASSERT_EQUAL_STRING_MESSAGE(str(o, "status").c_str(), kStatus[int(v.status)], name);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(str(o, "ssid").c_str(), v.ssid.c_str(), name);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(str(o, "password").c_str(), v.password.c_str(), name);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(str(o, "payload").c_str(), v.payload.c_str(), name);
    TEST_ASSERT_EQUAL_MESSAGE(o.get("open")->b, v.open, name);
  }
}

// Bit-exact modules: the emulator's qrcodegen.ts and the firmware's qrcodegen.c pick the same version and mask.
void test_qr_modules() {
  Json j; TEST_ASSERT_TRUE(load(j));
  int n = 0;
  for (auto& c : j.get("qr")->arr) {
    QrMatrix m;
    const bool ok = guest::encode(str(c, "text"), m);
    const int size = int(c.get("size")->num);
    TEST_ASSERT_EQUAL(size > 0, ok);
    if (!ok) continue;
    TEST_ASSERT_EQUAL_INT(size, m.size);
    for (int y = 0; y < size; ++y) {
      std::string row;
      for (int x = 0; x < size; ++x) row += m.at(x, y) ? '1' : '0';
      TEST_ASSERT_EQUAL_STRING(c.get("rows")->arr[y].str.c_str(), row.c_str());
    }
    ++n;
  }
  TEST_ASSERT_GREATER_THAN(6, n);
}

void test_layout() {
  Json j; TEST_ASSERT_TRUE(load(j));
  static const char* kKind[] = {"stack", "side", "qr"};
  for (auto& c : j.get("layout")->arr) {
    guest::Layout L = guest::layout(int(c.get("w")->num), int(c.get("h")->num), int(c.get("cs")->num), int(c.get("rs")->num), int(c.get("n")->num));
    const Json& o = *c.get("out"); const Json& z = *o.get("zone"); const Json* t = o.get("text");
    TEST_ASSERT_EQUAL_STRING(str(o, "kind").c_str(), kKind[int(L.kind)]);
    TEST_ASSERT_EQUAL_INT(int(z.get("x")->num), L.zx); TEST_ASSERT_EQUAL_INT(int(z.get("y")->num), L.zy); TEST_ASSERT_EQUAL_INT(int(z.get("s")->num), L.zs);
    TEST_ASSERT_EQUAL_INT(int(o.get("px")->num), L.px); TEST_ASSERT_EQUAL_INT(int(o.get("qx")->num), L.qx); TEST_ASSERT_EQUAL_INT(int(o.get("qy")->num), L.qy);
    TEST_ASSERT_EQUAL(!t->isNull(), L.hasText);
    if (L.hasText) { TEST_ASSERT_EQUAL_INT(int(t->get("x")->num), L.tx); TEST_ASSERT_EQUAL_INT(int(t->get("y")->num), L.ty); TEST_ASSERT_EQUAL_INT(int(t->get("w")->num), L.tw); }
  }
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_payload_and_fields);
  RUN_TEST(test_views);
  RUN_TEST(test_qr_modules);
  RUN_TEST(test_layout);
  return UNITY_END();
}
