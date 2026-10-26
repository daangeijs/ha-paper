#include "core/ota_status.h"

namespace x4 {

OtaErr otaErrOf(int code, bool online) {
  if (!online) return OtaErr::Network;
  if (code == kOtaHttpLowMemory) return OtaErr::Memory;
  if (code == 403 || code == 429) return OtaErr::Busy;   // unauthenticated API: 60 requests/h per IP
  if (code == 404) return OtaErr::NoReleases;
  if (code <= 0) return OtaErr::Network;
  return OtaErr::Other;
}

static const char* const kNames[] = {nullptr, "memory", "network", "busy", "none", "other"};

const char* otaErrName(OtaErr e) { return kNames[int(e)]; }

OtaErr otaErrFromName(const std::string& s) {
  for (int i = 1; i < 6; ++i) if (s == kNames[i]) return OtaErr(i);
  return OtaErr::None;
}

OtaLine otaLine(Lang l, const OtaLineIn& in) {
  const std::string chan = tr(l, in.channel == "beta" ? S::chanBetaLong : S::chanStableLong);
  const std::string at = in.checked.empty() ? chan : tr(l, S::otaChecked, in.checked) + " · " + chan;
  const std::string& st = in.status;
  if (st == "checking") return {tr(l, S::checking), chan};
  if (st == "uptodate") return {tr(l, S::otaUpToDate), at};
  if (st == "available") return {tr(l, S::otaAvailable, in.version), at};
  if (st == "blocked") return {tr(l, S::otaLowBattery), in.message};
  if (st == "error") {
    switch (in.error) {
      case OtaErr::Memory: return {tr(l, S::otaErrMemory), tr(l, S::otaTryMinute)};
      case OtaErr::Network: return {tr(l, S::otaErrNetwork), tr(l, S::otaTryLater)};
      case OtaErr::Busy: return {tr(l, S::otaErrBusy), tr(l, S::otaTryLater)};
      case OtaErr::NoReleases: return {tr(l, S::otaErrNone), at};
      case OtaErr::Other: return {tr(l, S::otaErrOther), in.message.empty() ? std::string(tr(l, S::otaTryLater)) : in.message};
      case OtaErr::None: return {tr(l, S::otaFailed), in.message};
    }
  }
  return {tr(l, in.checked.empty() ? S::otaNotChecked : S::otaUpToDate), at};
}

}  // namespace x4
