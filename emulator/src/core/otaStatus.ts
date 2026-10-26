// Settings › Updates status line on the display and the web console's Updates card (#250): "Checking…" while a
// check runs, then the result with its time, or a failed check in plain words. Firmware: core/ota_status.{h,cpp};
// spec/test-vectors/ota-status.json.
import { tr, type Lang } from './strings.ts';

/** Why a check failed (GET /api/v1/ota `error`). */
export type OtaErr = 'memory' | 'network' | 'busy' | 'none' | 'other';
export const OTA_ERRS: OtaErr[] = ['memory', 'network', 'busy', 'none', 'other'];

/** firmware net/tls.h kHttpLowMemory: the TLS heap guard refused the GitHub handshake (#248). */
export const HTTP_LOW_MEMORY = -100;

/** A failed GitHub request as the user sees it. code: HTTP status, ≤ 0 = no answer (connect/TLS/timeout). */
export function otaErrOf(code: number, online: boolean): OtaErr {
  if (!online) return 'network';
  if (code === HTTP_LOW_MEMORY) return 'memory';
  if (code === 403 || code === 429) return 'busy';   // unauthenticated API: 60 requests/h per IP
  if (code === 404) return 'none';
  if (code <= 0) return 'network';
  return 'other';
}

export type OtaLineIn = {
  /** GET /ota status; downloading/installing/updated/verifying are drawn elsewhere (install face, boot). */
  status: string;
  /** set with status error when a check failed; null = an install failed (message says why) */
  error: OtaErr | null;
  /** available version, without "v" */
  version: string;
  /** local "HH:MM" of the last check, "" = never / clock unknown */
  checked: string;
  channel: 'stable' | 'beta';
  message: string;
};

/** Title + one detail line. Errors carry no time: the last good check is older than the failure. */
export function otaLine(lg: Lang, i: OtaLineIn): { title: string; sub: string } {
  const chan = tr(lg, i.channel === 'beta' ? 'chanBetaLong' : 'chanStableLong');
  const at = i.checked ? tr(lg, 'otaChecked', i.checked) + ' · ' + chan : chan;
  switch (i.status) {
    case 'checking': return { title: tr(lg, 'checking'), sub: chan };
    case 'uptodate': return { title: tr(lg, 'otaUpToDate'), sub: at };
    case 'available': return { title: tr(lg, 'otaAvailable', i.version), sub: at };
    case 'blocked': return { title: tr(lg, 'otaLowBattery'), sub: i.message };
    case 'error':
      switch (i.error) {
        case 'memory': return { title: tr(lg, 'otaErrMemory'), sub: tr(lg, 'otaTryMinute') };
        case 'network': return { title: tr(lg, 'otaErrNetwork'), sub: tr(lg, 'otaTryLater') };
        case 'busy': return { title: tr(lg, 'otaErrBusy'), sub: tr(lg, 'otaTryLater') };
        case 'none': return { title: tr(lg, 'otaErrNone'), sub: at };
        case 'other': return { title: tr(lg, 'otaErrOther'), sub: i.message || tr(lg, 'otaTryLater') };
        default: return { title: tr(lg, 'otaFailed'), sub: i.message };
      }
    default: return { title: tr(lg, i.checked ? 'otaUpToDate' : 'otaNotChecked'), sub: at };
  }
}
