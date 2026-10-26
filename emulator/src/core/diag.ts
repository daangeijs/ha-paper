// Boot / crash diagnostics (GET /api/v1/diagnostics, ROBUSTNESS_PLAN Phase 1). The behaviour spec for the firmware's
// firmware/src/core/diag.cpp: a ring of the last 8 boots, newest first; boots[0] is the running boot and gets its
// uptime / min heap / wall clock refreshed while it runs. Vectors: spec/test-vectors/diag.json (scripts/gen-vectors.ts).

export const DIAG_BOOTS = 8;
/** Field sizes of the firmware's RTC struct (C strings, NUL included): longer values are cut. */
export const DIAG_REASON_LEN = 12, DIAG_VERSION_LEN = 24, DIAG_PANIC_LEN = 96;
/** esp_reset_reason() names (ESP_RST_ prefix dropped). */
export const RESET_REASONS = ['UNKNOWN', 'POWERON', 'EXT', 'SW', 'PANIC', 'INT_WDT', 'TASK_WDT', 'WDT', 'DEEPSLEEP', 'BROWNOUT', 'SDIO', 'USB', 'JTAG', 'EFUSE', 'PWR_GLITCH', 'CPU_LOCKUP'] as const;
const CRASH = new Set(['PANIC', 'INT_WDT', 'TASK_WDT', 'WDT', 'BROWNOUT', 'CPU_LOCKUP']);

export type DiagBoot = { reason: string; version: string; uptime_s: number; min_free_heap: number; panic: string | null; last_seen: number | null };
export type DiagRing = DiagBoot[];

export const isCrash = (reason: string): boolean => CRASH.has(reason);
const cut = (s: string, len: number) => s.slice(0, len - 1);

/** A new boot starts: push it in front, drop the oldest beyond 8. Glance (#10) wakes from deep sleep every 15 min: a
 *  DEEPSLEEP boot right after another DEEPSLEEP boot replaces it, so wakes never push crashes out of the ring. */
export function diagPush(ring: DiagRing, reason: string, version: string, panic: string | null): DiagRing {
  const b: DiagBoot = { reason: cut(reason, DIAG_REASON_LEN), version: cut(version, DIAG_VERSION_LEN), uptime_s: 0, min_free_heap: 0, panic: panic ? cut(panic, DIAG_PANIC_LEN) : null, last_seen: null };
  if (b.reason === 'DEEPSLEEP' && ring[0]?.reason === 'DEEPSLEEP') return [b, ...ring.slice(1)];
  return [b, ...ring].slice(0, DIAG_BOOTS);
}
/** The running boot is still alive: refresh uptime, min free heap and (when the clock is known, > 0) last_seen. */
export function diagTouch(ring: DiagRing, uptimeS: number, minFreeHeap: number, epoch: number): DiagRing {
  if (!ring.length) return ring;
  const [cur, ...rest] = ring;
  return [{ ...cur, uptime_s: uptimeS, min_free_heap: minFreeHeap, last_seen: epoch > 0 ? epoch : cur.last_seen }, ...rest];
}
/** DELETE /diagnostics: forget every boot, the running one too (else its crash reason stays "last crash"). The ring
 *  stays empty until the next boot; reset_reason in the response still says how this boot started. */
export const diagClear = (_ring: DiagRing): DiagRing => [];

export type LastCrash = { reason: string; panic: string | null; version: string; uptime_s: number | null; last_seen: number | null };
/** Newest boot that started with a crash reason. version / uptime_s / last_seen are those of the boot that crashed. */
export function lastCrash(ring: DiagRing): LastCrash | null {
  const i = ring.findIndex((b) => isCrash(b.reason));
  if (i < 0) return null;
  const prev = ring[i + 1];
  return { reason: ring[i].reason, panic: ring[i].panic, version: prev ? prev.version : ring[i].version, uptime_s: prev ? prev.uptime_s : null, last_seen: prev ? prev.last_seen : null };
}

/** boots[] as GET /diagnostics sends it. */
export const bootsJson = (ring: DiagRing) => ring.map((b) => ({ reason: b.reason, crash: isCrash(b.reason), version: b.version, uptime_s: b.uptime_s, min_free_heap: b.min_free_heap, panic: b.panic, last_seen: b.last_seen }));

export type DiagOp =
  | { op: 'boot'; reason: string; version: string; panic: string | null }
  | { op: 'touch'; uptime_s: number; min_free_heap: number; epoch: number }
  | { op: 'clear' };
export function diagApply(ring: DiagRing, o: DiagOp): DiagRing {
  if (o.op === 'boot') return diagPush(ring, o.reason, o.version, o.panic);
  if (o.op === 'touch') return diagTouch(ring, o.uptime_s, o.min_free_heap, o.epoch);
  return diagClear(ring);
}

/** heap.low_point (#198, firmware net/health.cpp heapCheckpoint): what was going on at the last internal-heap low point. */
export type HeapLowPoint = { min_free_internal: number; min_dma: number; min_8bit_int: number; uptime_s: number; where: string; ws: boolean; tls_slots: number; ha_report: boolean; ota: boolean; web_open: number; last_path: string; rssi: number | null };

/** GET /api/v1/diagnostics (spec/openapi.yaml Diagnostics). */
export type Diagnostics = {
  firmware: string; uptime_s: number; reset_reason: string;
  boots: ReturnType<typeof bootsJson>; last_crash: LastCrash | null;
  heap: { free_internal: number; min_free_internal: number; largest_free_internal: number; free_psram: number; low_point: HeapLowPoint | null };
  panel: { controller: string; source: 'probe' | 'default' | 'none'; verdict: 'primary' | 'ultrachip' | 'inconclusive' | null; promoted: boolean; ver: string | null; flg: number | null; nvs_screen_type: number | null; failed: boolean; failure: string | null };
  coredump: null | { task: string; pc: string; backtrace: string[]; backtrace_corrupted: boolean; exc_cause: number; exc_vaddr: string; panic: string | null; elf_sha256: string; size: number };
  touch_recoveries: number | null;
  /** First-boot safety (#10): confirmed boots this image still needs before it may deep-sleep (0 = armed). */
  deep_sleep: { armed: boolean; boots_left: number };
};

/** "3 h 12 min" / "45 s" for the console. */
export function fmtUptime(s: number): string {
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
  return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
}
