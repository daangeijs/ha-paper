// Minimal JSON reader/writer for pure core code (entity attributes, config JSON, test vectors). No Arduino deps.
#pragma once
#include <string>
#include <vector>
#include <utility>
#include <cstddef>

namespace x4 {

struct Json {
  enum class Type { Null, Bool, Number, String, Array, Object } type = Type::Null;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<Json> arr;
  std::vector<std::pair<std::string, Json>> obj;   // insertion order kept

  bool isNull() const { return type == Type::Null; }
  bool isNum() const { return type == Type::Number; }
  bool isStr() const { return type == Type::String; }
  bool isArr() const { return type == Type::Array; }
  bool isObj() const { return type == Type::Object; }
  const Json* get(const std::string& key) const;     // object member or nullptr
  double numOr(double d) const { return isNum() ? num : d; }
  std::string strOr(const std::string& d) const { return isStr() ? str : d; }
};

// Parses a complete JSON text (surrounding whitespace allowed). Returns false on any syntax error.
bool parseJson(const std::string& text, Json& out);
// Parses a JSON string literal starting at text[pos] == '"'. On success sets pos past the closing quote.
bool parseJsonString(const std::string& text, size_t& pos, std::string& out);
// JSON.stringify(string) semantics (quotes, escapes control chars, keeps non-ASCII as UTF-8).
std::string jsonQuote(const std::string& s);
// JS Number → String for finite doubles (integers without ".0", shortest round-trip otherwise).
std::string jsNumber(double v);
// Number.prototype.toFixed(digits) semantics (ties round away from zero on the exact binary value).
std::string toFixed(double v, int digits);
// Math.round semantics (half rounds towards +infinity).
double jsRound(double v);

}  // namespace x4
