// Device health as Home Assistant entities (eink-ha-os#32). The device POSTs these to HA's REST API (/api/states/<entity_id>,
// admin only): HA's WebSocket API has no set-state command. Not persisted by HA; re-pushed on every (re)connect.
// Behaviour spec for firmware/src/core/ha_report.{h,cpp}; vectors spec/test-vectors/ha-report.json.
import { powerSource } from './power.ts';
import { tr, type Lang } from './strings.ts';

export type Health = {
  hostname: string; name: string; battery: number; charging: boolean; usb: boolean;
  rssi: number | null; firmware: string; resetReason: string;
  /** epoch seconds; null or before 2023-11 (clock not set) = left out */
  lastFullEpoch: number | null; bootEpoch: number | null;
};
export type ReportState = { entity_id: string; state: string; attributes: Record<string, string | number | boolean> };
/** retry: the last push failed on the network (no HTTP answer) and gets one early retry (eink-ha-os#123). */
export type ReportLast = { atMs: number; battery: number; charging: boolean; retry?: boolean };

export const REPORT_MIN_GAP_MS = 60_000;
export const REPORT_RETRY_MS = 10_000;
export const REPORT_EVERY_MS = 600_000;
const SANE_EPOCH = 1_700_000_000;

/** "ha-paper-a1b2.local" → "ha_paper_a1b2": the entity id prefix, unique per display. */
export function reportSlug(hostname: string): string {
  return hostname.replace(/\.local$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const iso = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/** Every entity of one push, in this order. Wi-Fi signal without a reading and timestamps without a clock are left out. */
export function reportStates(h: Health): ReportState[] {
  const id = reportSlug(h.hostname);
  const out: ReportState[] = [];
  const add = (domain: string, key: string, label: string, state: string, extra: ReportState['attributes'] = {}) =>
    out.push({ entity_id: `${domain}.${id}_${key}`, state, attributes: { friendly_name: `${h.name} ${label}`, ...extra } });
  add('sensor', 'battery', 'battery', String(h.battery), { unit_of_measurement: '%', device_class: 'battery', state_class: 'measurement' });
  add('binary_sensor', 'charging', 'charging', h.charging ? 'on' : 'off', { device_class: 'battery_charging', source: powerSource(h.charging, h.usb) });
  if (h.rssi !== null) add('sensor', 'wifi_signal', 'Wi-Fi signal', String(h.rssi), { unit_of_measurement: 'dBm', device_class: 'signal_strength', state_class: 'measurement' });
  if (h.lastFullEpoch !== null && h.lastFullEpoch >= SANE_EPOCH) add('sensor', 'last_full_refresh', 'last full refresh', iso(h.lastFullEpoch), { device_class: 'timestamp' });
  if (h.bootEpoch !== null && h.bootEpoch >= SANE_EPOCH) add('sensor', 'last_boot', 'last boot', iso(h.bootEpoch), { device_class: 'timestamp' });
  add('sensor', 'firmware', 'firmware', h.firmware);
  add('sensor', 'reset_reason', 'reset reason', h.resetReason);
  return out;
}

/** Push now? Never pushed this boot → yes. Then never within 60 s of the last push (10 s when `last.retry`); after that
 * on `force` ((re)connected, toggle turned on), a battery change of ≥ 1 %, charging flipped, or 10 min since the last
 * push. */
export function reportDue(last: ReportLast | null, force: boolean, nowMs: number, battery: number, charging: boolean): boolean {
  if (!last) return true;
  const elapsed = nowMs - last.atMs;
  if (elapsed < (last.retry ? REPORT_RETRY_MS : REPORT_MIN_GAP_MS)) return false;
  return force || elapsed >= REPORT_EVERY_MS || Math.abs(battery - last.battery) >= 1 || charging !== last.charging;
}

/** GET /status `ha_report`. state: ok (last push accepted) | off (setting) | waiting (nothing pushed yet, or toggled on
 * again) | not_admin (HA answered 401/403: stopped until the next connect) | error (last push failed, retrying). */
export type ReportPhase = 'ok' | 'off' | 'waiting' | 'not_admin' | 'error';
export type ReportStatus = { enabled: boolean; state: ReportPhase; last_push_epoch: number | null };

/** Web console Device tab, Home Assistant card. `clock`: epoch seconds → "12:04". */
export function reportLine(r: ReportStatus, clock: (epoch: number) => string, lang: Lang = 'en'): string {
  const last = r.last_push_epoch ? tr(lang, 'repLast', clock(r.last_push_epoch)) : '';
  if (r.state === 'not_admin') return tr(lang, 'repNotAdmin');
  if (!r.enabled || r.state === 'off') return tr(lang, 'off');
  if (r.state === 'ok') return tr(lang, 'on') + last;
  if (r.state === 'error') return tr(lang, 'repFailed') + last;
  return tr(lang, 'repWaiting');
}
