// Boot / crash diagnostics (GET /api/v1/diagnostics, ROBUSTNESS_PLAN Phase 1). The behaviour spec for the firmware's
// firmware/src/core/diag.cpp: a ring of the last 8 boots, newest first; boots[0] is the running boot and gets its
// uptime / min heap / wall clock refreshed while it runs. Vectors: spec/test-vectors/diag.json (scripts/gen-vectors.ts).

import type { BattHistory } from './battery.ts';

export const DIAG_BOOTS = 8;
/** Field sizes of the firmware's RTC struct (C strings, NUL included): longer values are cut. */
export const DIAG_REASON_LEN = 12, DIAG_VERSION_LEN = 24, DIAG_PANIC_LEN = 96, DIAG_HW_LEN = 16;
/** esp_reset_reason() names (ESP_RST_ prefix dropped). */
export const RESET_REASONS = ['UNKNOWN', 'POWERON', 'EXT', 'SW', 'PANIC', 'INT_WDT', 'TASK_WDT', 'WDT', 'DEEPSLEEP', 'BROWNOUT', 'SDIO', 'USB', 'JTAG', 'EFUSE', 'PWR_GLITCH', 'CPU_LOCKUP'] as const;
const CRASH = new Set(['PANIC', 'INT_WDT', 'TASK_WDT', 'WDT', 'BROWNOUT', 'CPU_LOCKUP']);

/** hw (eink-ha-os#241): the chip's raw reset cause (esp_rom_get_reset_reason, e.g. CORE_SW, CORE_MWDT0, USB_UART) next to the
 *  IDF reason; null when unknown (emulator, boots stored before eink-ha-os#241). */
export type DiagBoot = { reason: string; hw: string | null; version: string; uptime_s: number; min_free_heap: number; panic: string | null; last_seen: number | null };
export type DiagRing = DiagBoot[];

export const isCrash = (reason: string): boolean => CRASH.has(reason);
const cut = (s: string, len: number) => s.slice(0, len - 1);

/** A new boot starts: push it in front, drop the oldest beyond 8. Glance (eink-ha-os#10) wakes from deep sleep every 15 min: a
 *  DEEPSLEEP boot right after another DEEPSLEEP boot replaces it, so wakes never push crashes out of the ring. */
export function diagPush(ring: DiagRing, reason: string, version: string, panic: string | null, hw: string | null = null): DiagRing {
  const b: DiagBoot = { reason: cut(reason, DIAG_REASON_LEN), hw: hw ? cut(hw, DIAG_HW_LEN) : null, version: cut(version, DIAG_VERSION_LEN), uptime_s: 0, min_free_heap: 0, panic: panic ? cut(panic, DIAG_PANIC_LEN) : null, last_seen: null };
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
export const bootsJson = (ring: DiagRing) => ring.map((b) => ({ reason: b.reason, hw: b.hw, crash: isCrash(b.reason), version: b.version, uptime_s: b.uptime_s, min_free_heap: b.min_free_heap, panic: b.panic, last_seen: b.last_seen }));

export type DiagOp =
  | { op: 'boot'; reason: string; version: string; panic: string | null; hw?: string | null }
  | { op: 'touch'; uptime_s: number; min_free_heap: number; epoch: number }
  | { op: 'clear' };
export function diagApply(ring: DiagRing, o: DiagOp): DiagRing {
  if (o.op === 'boot') return diagPush(ring, o.reason, o.version, o.panic, o.hw ?? null);
  if (o.op === 'touch') return diagTouch(ring, o.uptime_s, o.min_free_heap, o.epoch);
  return diagClear(ring);
}

/** heap.low_point (eink-ha-os#198, firmware net/health.cpp heapCheckpoint): what was going on at the last internal-heap low point. */
export type HeapLowPoint = { min_free_internal: number; min_dma: number; min_8bit_int: number; uptime_s: number; where: string; ws: boolean; tls_slots: number; ha_report: boolean; ota: boolean; web_open: number; last_path: string; rssi: number | null };

/** last_wdt (eink-ha-os#241): the last task-watchdog timeout, recorded in RTC memory by the TWDT interrupt and reported by the
 *  boot after it: tasks that did not feed, internal heap at that moment (largest block: last 10 s sample), the last log
 *  line of that boot. */
export type LastWdt = { uptime_s: number; tasks: string; free_internal: number; largest_internal: number; min_dma: number; last_log: string | null };

/** One boot's awake time in ms, cut in order: boot (reset → setup done), wifi (→ Wi-Fi up), ha (→ HA data in), then
 *  idle = the rest minus render + panel after that; render / panel = the boot's totals. pct = shown % (eink-ha-os#327 filter),
 *  raw = the gauge's own, mv null = not read; epoch null = clock unknown. */
export type AwakePhases = { wake: 'cold' | 'timer' | 'button' | 'charger' | 'other'; epoch: number | null; boot_ms: number; wifi_ms: number; ha_ms: number; render_ms: number; panel_ms: number; idle_ms: number; total_ms: number; pct: number | null; raw: number | null; mv: number | null };

/** GET /api/v1/diagnostics (spec/openapi.yaml Diagnostics). */
export type Diagnostics = {
  firmware: string; uptime_s: number; reset_reason: string;
  boots: ReturnType<typeof bootsJson>; last_crash: LastCrash | null; last_wdt: LastWdt | null;
  heap: { free_internal: number; min_free_internal: number; largest_free_internal: number; free_psram: number; low_point: HeapLowPoint | null };
  panel: { controller: string; source: 'probe' | 'default' | 'none'; verdict: 'primary' | 'ultrachip' | 'inconclusive' | null; promoted: boolean; ver: string | null; flg: number | null; nvs_screen_type: number | null; failed: boolean; failure: string | null };
  coredump: null | { task: string; pc: string; backtrace: string[]; backtrace_corrupted: boolean; exc_cause: number; exc_vaddr: string; panic: string | null; elf_sha256: string; size: number };
  touch_recoveries: number | null;
  /** First-boot safety (eink-ha-os#10): confirmed boots this image still needs before it may deep-sleep (0 = armed); armed_by
   *  (eink-ha-os#231): 'boots' (3 boots online) or 'uptime' (30 min online, image confirmed), null while not armed. */
  deep_sleep: { armed: boolean; boots_left: number; armed_by: 'uptime' | 'boots' | null };
  /** Battery history (eink-ha-os#231, core/battery.ts): 5 min samples, 24 h, since the last reset or deep-sleep wake. */
  battery: BattHistory;
  /** Power trail (eink-ha-os#225, firmware core/power_trail.h): /power.txt lines; the emulator has no power path (null, []).
   *  empty_house_sleeps (eink-ha-os#331): deep sleeps with reason "empty house" since power-on (RTC memory). phases (eink-ha-os#327,
   *  firmware core/phases.h): where awake time goes, this boot and the newest boots that ended in deep sleep. */
  power_trail: { before_boot: string | null; lines: string[]; empty_house_sleeps: number; phases: { boot: AwakePhases | null; wakes: AwakePhases[] } };
  /** Inbound path (eink-ha-os#227, firmware net/net_stats.cpp): web server, mDNS responder, Wi-Fi AP (bssid = 4-hex tag, not the MAC). */
  web: { open: number; served: number; refused_503: number; last_request_age_s: number | null };
  /** eink-ha-os#376: hostname = the name the responder answers to (null when off), v4 = station IPv4 socket joined. */
  mdns: { up: boolean; restarts: number; last_restart_reason: 'connect' | 'got_ip' | 'bssid' | 'idle' | 'v4_off' | 'renamed' | null;
    hostname: string | null; v4: boolean; last_announce_age_s: number | null };
  wifi: { rssi: number | null; bssid: string | null; idle_checks: number; idle_reconnects: number };
};

/** "3 h 12 min" / "45 s" for the console. */
export function fmtUptime(s: number): string {
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
  return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
}
