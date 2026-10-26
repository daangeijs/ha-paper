#include "core/strings.h"
#include <cctype>

namespace x4 {

static_assert(sizeof(kStrTable) / sizeof(kStrTable[0]) == size_t(S::count), "strings_gen.h: table and enum differ");

Lang langOf(const std::string& code) {
  size_t i = 0;
  while (i < code.size() && std::isspace(static_cast<unsigned char>(code[i]))) ++i;
  std::string base;
  for (; i < code.size() && std::isalpha(static_cast<unsigned char>(code[i])); ++i)
    base += char(std::tolower(static_cast<unsigned char>(code[i])));
  bool end = i == code.size() || code[i] == '-' || code[i] == '_' || std::isspace(static_cast<unsigned char>(code[i]));
  return base == "nl" && end ? Lang::Nl : Lang::En;
}

const char* langCode(Lang l) { return l == Lang::Nl ? "nl" : "en"; }

const char* tr(Lang l, S key) {
  size_t k = size_t(key);
  return k < size_t(S::count) ? kStrTable[k][l == Lang::Nl ? 1 : 0] : "";
}

std::string tr(Lang l, S key, const std::string& a, const std::string& b) {
  std::string s = tr(l, key), out;
  const std::string* args[] = {&a, &b};
  size_t n = 0, p = 0;
  for (size_t q; (q = s.find("{}", p)) != std::string::npos; p = q + 2) {
    out.append(s, p, q - p);
    out += n < 2 ? *args[n++] : "{}";
  }
  return out + s.substr(p);
}

std::string dateLine(Lang l, int wday, int mday, int month) {
  return std::string(tr(l, S(int(S::day0) + (wday % 7 + 7) % 7))) + " " + std::to_string(mday) + " " +
         tr(l, S(int(S::month0) + (month % 12 + 12) % 12));
}

}  // namespace x4
