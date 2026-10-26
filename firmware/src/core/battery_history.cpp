#include "core/battery_history.h"

#include "core/json.h"

namespace x4::batt {

namespace {
constexpr int64_t kSaneEpoch = 1700000000;
}

std::string line(const In& i) {
  return std::to_string(i.pct) + "% " + (i.mv < 0 ? std::string("-") : std::to_string(i.mv)) + " mV · chg " +
         (i.chg ? "1" : "0") + " · usb " + (i.usb ? "1" : "0") + " · rssi " +
         (i.rssi == kNoRssi ? std::string("-") : std::to_string(i.rssi));
}

std::string History::step(const In& i) {
  if (i.pct < 0) return "";
  const bool due = !sampled_ || i.ms - lastMs_ >= kSampleS * 1000;
  const bool changed = seen_ && (chg_ != i.chg || usb_ != i.usb);
  seen_ = true;
  chg_ = i.chg;
  usb_ = i.usb;
  if (due) {
    if (buf_.empty()) buf_.resize(kRows);
    Row& r = buf_[(head_ + n_) % kRows];
    r.t = uint32_t(i.epoch > kSaneEpoch ? i.epoch : i.ms / 1000);
    r.power = i.power;
    r.mv = int16_t(i.mv < 0 ? -1 : i.mv);
    r.pct = int8_t(i.pct);
    r.rssi = int8_t(i.rssi < -127 ? kNoRssi : i.rssi > 127 ? 127 : i.rssi);
    r.chg = i.chg;
    r.usb = i.usb;
    if (n_ < kRows) n_++;
    else head_ = (head_ + 1) % kRows;
    sampled_ = true;
    lastMs_ = i.ms;
  }
  return due || changed ? line(i) : "";
}

std::string History::json() const {
  std::string o = "{\"interval_s\":" + std::to_string(kSampleS) +
                  ",\"fields\":[\"t\",\"pct\",\"mv\",\"chg\",\"usb\",\"power\",\"rssi\"],\"history\":[";
  o.reserve(o.size() + n_ * 48 + 2);
  for (size_t k = 0; k < n_; k++) {
    const Row& r = at(k);
    o += k ? ",[" : "[";
    o += std::to_string(r.t) + "," + std::to_string(r.pct) + "," + (r.mv < 0 ? "null" : std::to_string(r.mv)) + "," +
         (r.chg ? "1" : "0") + "," + (r.usb ? "1" : "0") + "," + jsonQuote(r.power) + "," +
         (r.rssi == kNoRssi ? "null" : std::to_string(r.rssi)) + "]";
  }
  return o + "]}";
}

}  // namespace x4::batt
