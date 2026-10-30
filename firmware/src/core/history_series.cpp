// Port of emulator src/core/history.ts attrSamples (#283) as a streaming scan (#292).
#include "core/history_series.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace x4 {
namespace hist {

namespace {
void copyKey(char* dst, size_t cap, const char* s, size_t n) {
  if (n >= cap) n = 0;   // too long: matches nothing
  std::memcpy(dst, s, n);
  dst[n] = 0;
}
bool digit(char c) { return c >= '0' && c <= '9'; }
}  // namespace

double numText(const char* t, size_t n, bool str) {
  if (!n) return kNone;
  if (str) {
    size_t i = t[0] == '-' ? 1 : 0, d = i;
    while (i < n && digit(t[i])) ++i;
    if (i == d) return kNone;
    if (i < n && t[i] == '.') {
      size_t f = ++i;
      while (i < n && digit(t[i])) ++i;
      if (i == f) return kNone;
    }
    if (i != n) return kNone;
  } else if (!(digit(t[0]) || t[0] == '-')) {
    return kNone;   // true / false / null
  }
  char* end = nullptr;
  const double v = std::strtod(t, &end);
  return end == t + n && std::isfinite(v) ? v : kNone;
}

namespace {
double numOf(const char* t, size_t n, bool str) { return numText(t, n, str); }
}  // namespace

void ListScanner::begin(const char* const* path, int nPath, const std::string& value, const std::string& time, int64_t t0,
                        int64_t step, int tz, SampleList* out) {
  out_ = out;
  fields_ = nullptr;
  nPath_ = path ? std::max(0, std::min(nPath, kPath)) : 0;
  for (int k = 0; k < nPath_; ++k) copyKey(path_[k], kKey, path[k], std::strlen(path[k]));
  copyKey(value_, kField, value.data(), value.size());
  copyKey(time_, kField, time.data(), time.size());
  t0_ = t0; step_ = step; tz_ = tz;
  objBits_ = keyBits_ = 0;
  depth_ = match_ = 0;
  mode_ = Ws;
  isKey_ = keyOk_ = success_ = broken_ = over_ = inList_ = inRow_ = succKey_ = rootDone_ = false;
  rowKey_ = 0;
  idx_ = 0;
  dropped_ = 0;
  tokN_ = 0;
}

void ListScanner::push(int64_t t, double v) {
  if (!out_) return;
  if (out_->size() >= kMaxSamples) { ++dropped_; return; }
  out_->push_back({t, v});
}

void ListScanner::open(bool obj) {
  if (depth_ >= 63 || (depth_ == 0 && rootDone_)) { broken_ = true; return; }
  const int L = nPath_ + 1;   // depth of the list container
  if (depth_ == 0) match_ = 1;
  else if (depth_ == match_ && keyOk_) match_ = depth_ + 1;
  if (depth_ + 1 == L && match_ == L && !obj) { inList_ = true; idx_ = 0; }
  if (inList_ && depth_ == L && obj) { inRow_ = true; rowT_ = kNoTime; rowV_ = kNone; rowKey_ = 0; }
  keyOk_ = succKey_ = false;
  rowKey_ = 0;
  ++depth_;
  const uint64_t bit = uint64_t(1) << depth_;
  objBits_ = obj ? objBits_ | bit : objBits_ & ~bit;
  keyBits_ = obj ? keyBits_ | bit : keyBits_ & ~bit;
}

void ListScanner::close(bool obj) {
  const uint64_t bit = uint64_t(1) << depth_;
  if (depth_ == 0 || bool(objBits_ & bit) != obj) { broken_ = true; return; }
  const int D = depth_--, L = nPath_ + 1;
  if (depth_ == 0) rootDone_ = true;
  if (inList_ && D == L + 1) {   // an entry closed: a row, or a nested list (no sample)
    if (inRow_ && rowT_ != kNoTime && has(rowV_)) push(rowT_, rowV_);
    if (inRow_ && fields_) fields_->rowEnd();
    inRow_ = false;
    ++idx_;
  } else if (inList_ && D == L) {
    inList_ = false;
  }
  if (match_ >= D) match_ = D - 1;
  rowKey_ = 0;
}

// A string or literal is complete in tok_: a key, or a value at depth_.
void ListScanner::scalar(bool str) {
  tok_[tokN_] = 0;
  const int L = nPath_ + 1;
  if (isKey_) {
    isKey_ = false;
    if (depth_ == match_ && depth_ <= nPath_) keyOk_ = !over_ && !std::strcmp(tok_, path_[depth_ - 1]);
    if (depth_ == 1) succKey_ = !over_ && !std::strcmp(tok_, "success");
    if (inRow_ && depth_ == L + 1) rowKey_ = over_ ? 0 : !std::strcmp(tok_, time_) ? 1 : !std::strcmp(tok_, value_) ? 2 : 0;
    if (fields_ && inRow_ && depth_ == L + 1) copyKey(fkey_, kField, tok_, over_ ? kField : tokN_);
    return;
  }
  if (depth_ == 1 && succKey_) success_ = !str && !std::strcmp(tok_, "true");
  if (fields_ && inRow_ && depth_ == L + 1 && !over_ && fkey_[0]) fields_->rowField(fkey_, tok_, tokN_, str);   // #318
  if (inList_ && depth_ == L) {   // a plain entry: one per step from t0
    const double v = over_ ? kNone : numOf(tok_, tokN_, str);
    if (has(v)) push(t0_ + idx_ * step_, v);
    ++idx_;
  } else if (inRow_ && depth_ == L + 1 && rowKey_) {
    if (rowKey_ == 1) rowT_ = over_ ? kNoTime : str ? parseTime(tok_, tokN_, tz_) : has(numOf(tok_, tokN_, false)) ? parseTimeNum(numOf(tok_, tokN_, false)) : kNoTime;
    else rowV_ = over_ ? kNone : numOf(tok_, tokN_, str);
  }
  keyOk_ = succKey_ = false;
  rowKey_ = 0;
  const uint64_t bit = uint64_t(1) << depth_;
  if (objBits_ & bit) keyBits_ |= bit;
}

void ListScanner::feed(const char* p, size_t n) {
  for (size_t i = 0; i < n && !broken_; ++i) {
    const char c = p[i];
    switch (mode_) {
      case Str:
        if (c == '\\') mode_ = Esc;
        else if (c == '"') { mode_ = Ws; scalar(true); }
        else put(c);
        continue;
      case Esc:
        if (c == 'u') { mode_ = Uni; uni_ = 4; put('?'); }
        else { mode_ = Str; put(c == 'n' ? '\n' : c == 't' ? '\t' : c); }
        continue;
      case Uni:
        if (--uni_ == 0) mode_ = Str;
        continue;
      case Lit:
        if (c == ',' || c == '}' || c == ']' || c == ' ' || c == '\n' || c == '\r' || c == '\t') {
          mode_ = Ws;
          scalar(false);
          break;   // the delimiter itself below
        }
        put(c);
        continue;
      case Ws:
        break;
    }
    const uint64_t bit = uint64_t(1) << depth_;
    switch (c) {
      case ' ': case '\n': case '\r': case '\t': case ':': break;
      case ',': if (objBits_ & bit) keyBits_ |= bit; break;
      case '{': keyBits_ &= ~bit; open(true); break;
      case '[': keyBits_ &= ~bit; open(false); break;
      case '}': close(true); break;
      case ']': close(false); break;
      case '"':
        isKey_ = (objBits_ & bit) && (keyBits_ & bit);
        if (isKey_) keyBits_ &= ~bit;
        mode_ = Str;
        tokN_ = 0;
        over_ = false;
        break;
      default:
        if (depth_ == 0) { broken_ = true; break; }
        keyBits_ &= ~bit;
        mode_ = Lit;
        tokN_ = 0;
        over_ = false;
        put(c);
    }
  }
}

void sortSamples(SampleList& s) {
  std::stable_sort(s.begin(), s.end(), [](const Sample& a, const Sample& b) { return a.t < b.t; });
}

void attrSamples(ListScanner& sc, const char* json, size_t n, const Spec& spec, int64_t now, int tz, SampleList& out) {
  out.clear();
  sc.begin(nullptr, 0, spec.value, spec.time, bucketStart(now, spec.bucketMs, tz), spec.bucketMs, tz, &out);
  sc.feed(json, n);
  if (!sc.complete()) out.clear();   // JSON.parse fails: no samples
  sortSamples(out);
}

}  // namespace hist
}  // namespace x4
