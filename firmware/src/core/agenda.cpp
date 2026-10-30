// Agenda and Next tiles (#316); see agenda.h. Port of emulator src/core/agenda.ts.
#include "core/agenda.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "core/history.h"
#include "core/history_fetch.h"

namespace x4 {
namespace agenda {

namespace {
int64_t floorDiv(int64_t a, int64_t b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }
int64_t dayStart(int64_t day, int tz) { return day * kDay - int64_t(tz) * kMin; }
std::string pad2(int v) { char b[8]; std::snprintf(b, sizeof b, "%02d", v); return b; }
std::string hm(int64_t ms, int tz) {
  int64_t m = floorDiv(ms + int64_t(tz) * kMin, kMin) % 1440;
  if (m < 0) m += 1440;
  return pad2(int(m / 60)) + ":" + pad2(int(m % 60));
}
int wdayOf(int64_t day) { return int(((day + 4) % 7 + 7) % 7); }   // day 0 = Thursday 1 Jan 1970
int mdayOf(int64_t day) {   // civil from days (H. Hinnant)
  const int64_t z = day + 719468, era = (z >= 0 ? z : z - 146096) / 146097, doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  return int(doy - (153 * mp + 2) / 5 + 1);
}
std::string shortDay(Lang l, int64_t day) { return tr(l, S(int(S::agDay0) + wdayOf(day))); }
bool isWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }
bool dateOnly(const char* s, size_t n) {
  while (n && isWs(*s)) ++s, --n;
  while (n && isWs(s[n - 1])) --n;
  if (n != 10) return false;
  for (size_t i = 0; i < 10; ++i) {
    const bool dash = i == 4 || i == 7;
    if (dash ? s[i] != '-' : !(s[i] >= '0' && s[i] <= '9')) return false;
  }
  return true;
}
// a title's bytes (leading spaces already skipped) → the kept text: see cutTitle
size_t finishTitle(const uint8_t* b, size_t n) {
  if (n > kTitleBytes) {
    n = kTitleBytes;
    while (n > 0 && (b[n] & 0xC0) == 0x80) --n;
  }
  while (n && b[n - 1] == ' ') --n;
  return n;
}
}  // namespace

bool isAgendaType(const std::string& t) { return t == "agenda" || t == "next"; }

std::vector<std::string> calendarsOf(const std::string& v) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < v.size()) {
    size_t j = v.find(' ', i);
    if (j == std::string::npos) j = v.size();
    if (j > i) out.push_back(v.substr(i, j - i));
    i = j + 1;
  }
  return out;
}

std::string configError(const std::string& type, const std::string& entities) {
  const size_t n = calendarsOf(entities).size();
  if (!n) return type + ": pick at least one calendar";
  if (n > size_t(kMaxCalendars)) return type + ": at most " + std::to_string(kMaxCalendars) + " calendars";
  return "";
}

std::string keyOf(const std::string& entities) {
  std::vector<std::string> c = calendarsOf(entities);
  std::sort(c.begin(), c.end());
  c.erase(std::unique(c.begin(), c.end()), c.end());
  std::string k;
  for (auto& s : c) k += (k.empty() ? "" : " ") + s;
  return k;
}

int64_t dayOf(int64_t ms, int tz) { return floorDiv(ms + int64_t(tz) * kMin, kDay); }

std::string request(const std::string& key, int64_t now, int tz, uint32_t id) {
  const int64_t s = dayStart(dayOf(now, tz), tz);
  std::string ids;
  for (auto& c : calendarsOf(key)) ids += (ids.empty() ? "\"" : ",\"") + c + "\"";
  return "{\"id\":" + std::to_string(id) +
         ",\"type\":\"call_service\",\"domain\":\"calendar\",\"service\":\"get_events\",\"service_data\":{\"start_date_time\":\"" +
         hist::isoUtc(s) + "\",\"end_date_time\":\"" + hist::isoUtc(s + kDays * kDay) + "\"},\"target\":{\"entity_id\":[" + ids +
         "]},\"return_response\":true}";
}

std::string cutTitle(const std::string& s) {
  std::string t;
  for (char c : s) {
    const uint8_t u = uint8_t(c);
    const char m = u < 0x20 || u == 0x7F ? ' ' : c;
    if (m == ' ' && t.empty()) continue;
    t += m;
  }
  return t.substr(0, finishTitle(reinterpret_cast<const uint8_t*>(t.data()), t.size()));
}

int cmp(const Event& a, const Event& b) {
  if (a.start != b.start) return a.start < b.start ? -1 : 1;
  if (a.allDay != b.allDay) return a.allDay ? -1 : 1;
  if (a.end != b.end) return a.end < b.end ? -1 : 1;
  if (a.cal != b.cal) return a.cal < b.cal ? -1 : 1;
  const int c = std::memcmp(a.title, b.title, std::min(a.len, b.len));
  if (c) return c < 0 ? -1 : 1;
  return a.len == b.len ? 0 : a.len < b.len ? -1 : 1;
}

void insert(Fetch& f, const Event& e) {
  size_t i = f.events.size();
  while (i > 0 && cmp(f.events[i - 1], e) > 0) --i;
  if (i >= size_t(kMaxEvents)) { f.more++; return; }   // = insert then drop the last
  if (f.events.capacity() < size_t(kMaxEvents) + 1) f.events.reserve(kMaxEvents + 1);
  f.events.insert(f.events.begin() + long(i), e);
  if (f.events.size() > size_t(kMaxEvents)) { f.events.pop_back(); f.more++; }
}

// ---- Scanner ----
void Scanner::begin(const std::string& key, int64_t now, int tz, Fetch* out) {
  *this = Scanner();
  out_ = out;
  cals_ = calendarsOf(key);
  now_ = now;
  tz_ = tz;
  wEnd_ = dayStart(dayOf(now, tz), tz) + kDays * kDay;
}

// path: depth 1 root {…}, 2 "result" {…}, 3 "response" {…}, 4 "<calendar>" {…}, 5 "events" […], 6 an event {…}
void Scanner::open(bool obj) {
  if (depth_ >= kMaxDepth) { broken_ = true; return; }
  const bool onPath = match_ == depth_ && !lastKeyOver_ && [&] {
    switch (depth_) {
      case 0: return obj;
      case 1: return obj && !std::strcmp(lastKey_, "result");
      case 2: return obj && !std::strcmp(lastKey_, "response");
      case 3: {
        if (!obj) return false;
        cal_ = -1;
        for (size_t i = 0; i < cals_.size(); ++i) if (cals_[i] == lastKey_) cal_ = int(i);
        return cal_ >= 0;
      }
      case 4: return !obj && !std::strcmp(lastKey_, "events");
      case 5: return obj;
      default: return false;
    }
  }();
  ++depth_;
  const uint32_t bit = 1u << depth_;
  objBits_ = obj ? objBits_ | bit : objBits_ & ~bit;
  keyBits_ = obj ? keyBits_ | bit : keyBits_ & ~bit;
  if (onPath) match_ = depth_;
  if (onPath && depth_ == 6) {
    evStart_ = evEnd_ = titleStr_ = false;
    titleN_ = 0;
  }
  lastKey_[0] = 0;
  lastKeyOver_ = false;
}

void Scanner::close() {
  if (depth_ == 6 && match_ == 6) eventEnd();
  if (match_ == depth_) --match_;
  --depth_;
  if (depth_ == 0) done_ = true;
  if (depth_ > 0 && (objBits_ >> depth_ & 1)) keyBits_ |= 1u << depth_;   // after a value in an object: a key
}

void Scanner::eventEnd() {
  if (!evStart_) return;
  const int64_t st = hist::parseTime(start_, std::strlen(start_), tz_);
  if (st == hist::kNoTime) return;
  Event e;
  e.start = st;
  e.allDay = dateOnly(start_, std::strlen(start_));
  int64_t en = evEnd_ ? hist::parseTime(end_, std::strlen(end_), tz_) : hist::kNoTime;
  if (en == hist::kNoTime || en <= st) en = e.allDay ? st + kDay : st;
  e.end = en;
  e.cal = uint8_t(cal_);
  const size_t n = titleStr_ ? finishTitle(title_, titleN_) : 0;
  std::memcpy(e.title, title_, n);
  e.title[n] = 0;
  e.len = uint8_t(n);
  if (e.end <= now_ || e.start >= wEnd_) return;
  insert(*out_, e);
}

void Scanner::putByte(uint8_t b) {
  switch (field_) {
    case FKey:
      if (keyN_ < kKey) key_[keyN_++] = char(b); else keyOver_ = true;
      break;
    case FStart: case FEnd: case FSuccess:
      if (valN_ < kVal) val_[valN_++] = char(b); else valOver_ = true;
      break;
    case FSummary: {
      if (b < 0x20 || b == 0x7F) b = ' ';
      if (b == ' ' && titleN_ == 0) break;
      if (titleN_ <= kTitleBytes) title_[titleN_++] = b;   // one byte past the cut: is it a continuation?
      break;
    }
    default: break;
  }
}

void Scanner::putCp(uint32_t cp) {
  if (cp < 0x80) putByte(uint8_t(cp));
  else if (cp < 0x800) { putByte(uint8_t(0xC0 | cp >> 6)); putByte(uint8_t(0x80 | (cp & 0x3F))); }
  else if (cp < 0x10000) { putByte(uint8_t(0xE0 | cp >> 12)); putByte(uint8_t(0x80 | (cp >> 6 & 0x3F))); putByte(uint8_t(0x80 | (cp & 0x3F))); }
  else {
    putByte(uint8_t(0xF0 | cp >> 18)); putByte(uint8_t(0x80 | (cp >> 12 & 0x3F)));
    putByte(uint8_t(0x80 | (cp >> 6 & 0x3F))); putByte(uint8_t(0x80 | (cp & 0x3F)));
  }
}

void Scanner::scalarEnd(bool str) {
  if (isKey_) {
    key_[keyN_] = 0;
    std::memcpy(lastKey_, key_, keyN_ + 1);
    lastKeyOver_ = keyOver_;
    isKey_ = false;
    keyBits_ &= ~(1u << depth_);
    field_ = FNone;
    return;
  }
  val_[valN_] = 0;
  if (field_ == FStart && str && !valOver_) { std::memcpy(start_, val_, valN_ + 1); evStart_ = true; }
  if (field_ == FEnd && str && !valOver_) { std::memcpy(end_, val_, valN_ + 1); evEnd_ = true; }
  if (field_ == FSummary) titleStr_ = str;
  if (field_ == FSuccess) success_ = !str && !std::strcmp(val_, "true");
  field_ = FNone;
  if (depth_ > 0 && (objBits_ >> depth_ & 1)) keyBits_ |= 1u << depth_;
  if (depth_ == 0) done_ = true;
}

void Scanner::feed(const char* p, size_t n) {
  for (size_t i = 0; i < n && !broken_; ++i) {
    const char c = p[i];
    switch (mode_) {
      case Str:
        if (c == '"') {
          if (hi_) { putCp(0xFFFD); hi_ = 0; }
          mode_ = Ws;
          scalarEnd(true);
        } else if (c == '\\') mode_ = Esc;
        else {
          if (hi_) { putCp(0xFFFD); hi_ = 0; }
          putByte(uint8_t(c));
        }
        break;
      case Esc: {
        mode_ = Str;
        char o = 0;
        switch (c) {
          case '"': o = '"'; break; case '\\': o = '\\'; break; case '/': o = '/'; break;
          case 'b': o = '\b'; break; case 'f': o = '\f'; break; case 'n': o = '\n'; break; case 'r': o = '\r'; break; case 't': o = '\t'; break;
          case 'u': mode_ = Uni; uni_ = 0; cp_ = 0; break;
          default: broken_ = true; break;
        }
        if (mode_ == Str && !broken_) {
          if (hi_) { putCp(0xFFFD); hi_ = 0; }
          putByte(uint8_t(o));
        }
        break;
      }
      case Uni: {
        int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (d < 0) { broken_ = true; break; }
        cp_ = cp_ << 4 | uint32_t(d);
        if (++uni_ < 4) break;
        mode_ = Str;
        if (cp_ >= 0xD800 && cp_ < 0xDC00) {
          if (hi_) putCp(0xFFFD);
          hi_ = cp_;
        } else if (cp_ >= 0xDC00 && cp_ < 0xE000) {
          if (hi_) { putCp(0x10000 + ((hi_ - 0xD800) << 10) + (cp_ - 0xDC00)); hi_ = 0; }
          else putCp(0xFFFD);
        } else {
          if (hi_) { putCp(0xFFFD); hi_ = 0; }
          putCp(cp_);
        }
        break;
      }
      case Lit:
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'E') { putByte(uint8_t(c)); break; }
        mode_ = Ws;
        scalarEnd(false);
        --i;   // the delimiter again, in Ws
        break;
      case Ws: {
        if (isWs(c) || c == ':' || c == ',') break;
        if (done_) { broken_ = true; break; }
        const bool key = depth_ > 0 && (keyBits_ >> depth_ & 1) && (objBits_ >> depth_ & 1);
        if (c == '{' || c == '[') {
          if (key) { broken_ = true; break; }
          open(c == '{');
        } else if (c == '}' || c == ']') {
          if (!depth_ || bool(objBits_ >> depth_ & 1) != (c == '}')) { broken_ = true; break; }
          close();
        } else if (c == '"') {
          mode_ = Str;
          hi_ = 0;
          isKey_ = key;
          if (key) { field_ = FKey; keyN_ = 0; keyOver_ = false; break; }
          valN_ = 0; valOver_ = false;
          field_ = FNone;
          if (match_ == 6 && depth_ == 6 && !lastKeyOver_) {
            if (!std::strcmp(lastKey_, "start")) field_ = FStart;
            else if (!std::strcmp(lastKey_, "end")) field_ = FEnd;
            else if (!std::strcmp(lastKey_, "summary")) { field_ = FSummary; titleN_ = 0; }
          }
        } else {
          if (key || depth_ == 0) { broken_ = true; break; }
          mode_ = Lit;
          isKey_ = false;
          valN_ = 0; valOver_ = false;
          field_ = depth_ == 1 && !lastKeyOver_ && !std::strcmp(lastKey_, "success") ? FSuccess : FNone;
          if (match_ == 6 && depth_ == 6 && !std::strcmp(lastKey_, "summary")) { field_ = FSummary; titleN_ = 0; }
          if (match_ == 6 && depth_ == 6 && !std::strcmp(lastKey_, "start")) evStart_ = false;
          if (match_ == 6 && depth_ == 6 && !std::strcmp(lastKey_, "end")) evEnd_ = false;
          putByte(uint8_t(c));
        }
        break;
      }
    }
  }
}

// ---- views ----
int maxLines(int rs) { return rs > 1 ? 11 : 4; }

Lines lines(const Fetch& f, int64_t now, int tz, Lang l, int maxN) {
  Lines out;
  const int64_t today = dayOf(now, tz);
  struct Live { const Event* e; int64_t d; };
  std::vector<Live> live;
  for (auto& e : f.events) {
    const int64_t d = std::max(dayOf(e.start, tz), today);
    if (e.end > now && d < today + kDays) live.push_back({&e, d});
  }
  std::stable_sort(live.begin(), live.end(), [](const Live& a, const Live& b) { return a.d < b.d; });
  int shown = 0;
  int64_t prev = INT64_MIN;
  const std::string allDay = tr(l, S::agAllDay);
  for (auto& x : live) {
    const int need = x.d != prev ? 2 : 1;
    if (int(out.lines.size()) + need > maxN) break;
    if (x.d != prev) {
      const std::string label = shortDay(l, x.d) + " " + std::to_string(mdayOf(x.d));
      Line h;
      h.day = true;
      h.text = x.d == today ? std::string(tr(l, S::agToday)) + " · " + label : x.d == today + 1 ? std::string(tr(l, S::agTomorrow)) + " · " + label : label;
      out.lines.push_back(h);
      prev = x.d;
    }
    const Event& e = *x.e;
    const int64_t ds = dayStart(x.d, tz);
    Line r;
    r.time = e.allDay ? allDay : e.start >= ds ? hm(e.start, tz) : e.end <= ds + kDay ? "–" + hm(e.end, tz) : allDay;
    r.text = e.len ? e.text() : std::string(tr(l, S::agBusy));
    r.allDay = r.time == allDay;
    out.lines.push_back(r);
    ++shown;
  }
  out.more = int(live.size()) - shown + f.more;
  return out;
}

Next next(const Fetch& f, int64_t now, int tz, Lang l) {
  Next n;
  const Event* e = nullptr;
  for (auto& x : f.events) if (!x.allDay && x.end > now) { e = &x; break; }
  if (!e) return n;
  n.has = true;
  n.mins = floorDiv(e->start - now + kMin - 1, kMin);   // Math.ceil
  const int64_t d = dayOf(e->start, tz), today = dayOf(now, tz), ed = dayOf(e->end - 1, tz);
  n.pill = e->start <= now ? std::string(tr(l, S::now))
           : n.mins < 60 ? tr(l, S::agInMin, std::to_string(n.mins))
           : d == today ? tr(l, S::agInH, std::to_string(int64_t(std::floor(double(n.mins) / 60 + 0.5))))
           : d == today + 1 ? std::string(tr(l, S::agTomorrow)) : shortDay(l, d);
  n.when = e->end == e->start ? hm(e->start, tz) : hm(e->start, tz) + " – " + (ed > d ? shortDay(l, ed) + " " : "") + hm(e->end, tz);
  n.title = e->len ? e->text() : std::string(tr(l, S::agBusy));
  return n;
}

// ---- Fetcher ----
void Fetcher::setKeys(const std::vector<std::string>& keys) {
  std::vector<Slot, PsramAlloc<Slot>> next;
  for (auto& k : keys) {
    if (std::any_of(next.begin(), next.end(), [&](const Slot& s) { return s.key == PStr(k); })) continue;
    auto it = std::find_if(slots_.begin(), slots_.end(), [&](const Slot& s) { return s.key == PStr(k); });
    if (it != slots_.end()) next.push_back(*it);
    else { next.emplace_back(); next.back().key = k; }
  }
  if (reqSlot_ >= 0) {   // the answer in flight belongs to a set that may have moved or left
    const PStr k = slots_[size_t(reqSlot_)].key;
    reqSlot_ = -1;
    for (size_t i = 0; i < next.size(); ++i) if (next[i].key == k) reqSlot_ = int(i);
    if (reqSlot_ < 0) reqId_ = 0;   // its answer is then not ours: WsClient keeps it out of the message buffer anyway
  }
  slots_.swap(next);
}

void Fetcher::reset() { reqId_ = 0; reqSlot_ = -1; }

bool Fetcher::next(int64_t now, int tz, uint32_t id, std::string& json) {
  if (reqId_) return false;
  for (size_t i = 0; i < slots_.size(); ++i) {
    Slot& s = slots_[i];
    const bool stale = !s.fetchedAt || now - s.fetchedAt >= kRefreshMs || dayOf(now, tz) != dayOf(s.fetchedAt, tz);
    if (!stale || (s.triedAt && now - s.triedAt < kRetryMs)) continue;
    s.triedAt = now;
    reqId_ = id; reqSlot_ = int(i); reqAt_ = now; reqNow_ = now; reqTz_ = tz;
    json = request(std::string(s.key), now, tz, id);
    return true;
  }
  return false;
}

void Fetcher::begin(uint32_t id) {
  (void)id;
  incoming_ = Fetch();
  scan_.begin(reqSlot_ >= 0 ? std::string(slots_[size_t(reqSlot_)].key) : std::string(), reqNow_, reqTz_, &incoming_);
}

bool Fetcher::end(int64_t now) {
  const int i = reqSlot_;
  reqId_ = 0; reqSlot_ = -1;
  if (i < 0) return false;
  Slot& s = slots_[size_t(i)];
  if (!scan_.ok()) {
    if (s.state == State::Loading) { s.state = State::Error; s.dirty = true; }
    return false;
  }
  s.fetch = incoming_;
  s.fetchedAt = now;
  s.state = State::Ok;
  s.dirty = true;
  return true;
}

void Fetcher::abandon() { reqId_ = 0; reqSlot_ = -1; }

std::string Fetcher::save() const {
  std::string t = "A1\n";
  char b[96];
  for (auto& s : slots_) {
    if (s.state != State::Ok) continue;
    std::snprintf(b, sizeof b, "\t%lld\t%d\n", static_cast<long long>(s.fetchedAt), s.fetch.more);
    t += "K\t" + std::string(s.key) + b;
    for (auto& e : s.fetch.events) {
      std::snprintf(b, sizeof b, "E\t%lld\t%lld\t%d\t%d\t", static_cast<long long>(e.start), static_cast<long long>(e.end), e.allDay ? 1 : 0, int(e.cal));
      t += b + e.text() + "\n";
    }
  }
  return t;
}

void Fetcher::load(const std::string& text) {
  if (text.compare(0, 3, "A1\n")) return;
  Slot* cur = nullptr;
  size_t i = 3;
  while (i < text.size()) {
    size_t j = text.find('\n', i);
    if (j == std::string::npos) j = text.size();
    std::vector<std::string> f;
    size_t a = i;
    for (;;) {
      size_t t = text.find('\t', a);
      if (t == std::string::npos || t > j) { f.push_back(text.substr(a, j - a)); break; }
      f.push_back(text.substr(a, t - a));
      a = t + 1;
    }
    i = j + 1;
    if (f[0] == "K" && f.size() == 4) {
      cur = nullptr;
      for (auto& s : slots_) if (s.key == PStr(f[1]) && s.state == State::Loading) cur = &s;
      if (!cur) continue;
      cur->fetchedAt = std::atoll(f[2].c_str());
      cur->fetch = Fetch();
      cur->fetch.more = std::atoi(f[3].c_str());
      cur->state = State::Ok;
      cur->dirty = true;
    } else if (f[0] == "E" && f.size() == 6 && cur && cur->fetch.events.size() < size_t(kMaxEvents)) {
      Event e;
      e.start = std::atoll(f[1].c_str());
      e.end = std::atoll(f[2].c_str());
      e.allDay = f[3] == "1";
      e.cal = uint8_t(std::atoi(f[4].c_str()));
      const size_t n = std::min(f[5].size(), kTitleBytes);
      std::memcpy(e.title, f[5].data(), n);
      e.len = uint8_t(n);
      cur->fetch.events.push_back(e);
    }
  }
}

}  // namespace agenda
}  // namespace x4
