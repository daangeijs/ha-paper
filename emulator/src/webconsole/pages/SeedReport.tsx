// First-run card above the Screens tab: the checklist (eink-ha-os#91, ../checklist.ts) with the seed report (eink-ha-os#89) under its
// "N of M tiles filled" step: what the seed (src/core/seed.ts) found in HA and why the other tiles are missing.
// GET /api/v1/seed; shown until dismissed (DELETE /api/v1/seed), by "Hide" or by finishing the checklist.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DeviceApi, SeedReportView } from '../DeviceApi.ts';
import type { SeedTile } from '../../core/seed.ts';
import type { ConsoleView } from '../useConsole.ts';
import { checklist, seedSplit, type CheckFix } from '../checklist.ts';
import { tr, type Lang, type StrKey } from '../../core/strings.ts';

const NAME: Record<string, StrKey> = {
  price: 'seedPrice', inside: 'seedInside', outside: 'seedOutside', solar_power: 'seedSolarPower', home_power: 'homeUse',
  grid_power: 'seedGridPower', battery_soc: 'homeBattery', battery_power: 'seedBatteryPower', solar_today: 'solarToday', solar_chart: 'seedSolarChart',
  energy_today: 'usedToday', grid_import_today: 'seedImportedToday', grid_export_today: 'seedExportedToday', usage_chart: 'seedUsageChart',
  lights: 'lights', heating: 'heating', rooms: 'rooms',
};
const SENSOR: Record<string, StrKey> = {
  inside: 'snsInside', outside: 'snsOutside', solar_power: 'snsSolarPower', home_power: 'snsHomePower',
  grid_power: 'snsGridPower', battery_soc: 'snsBatterySoc', battery_power: 'snsBatteryPower', solar_today: 'snsSolarToday',
  energy_today: 'snsEnergyToday', grid_import_today: 'snsImportToday', grid_export_today: 'snsExportToday',
};
const METER: Record<string, StrKey> = { price: 'meterPrice', solar_chart: 'meterSolar', usage_chart: 'meterGridSolar' };

export function seedWhy(t: SeedTile, lang: Lang = 'en'): string {
  switch (t.why) {
    case 'no_energy': return tr(lang, 'whyNoEnergy');
    case 'no_meter': return tr(lang, 'whyNoMeter', tr(lang, METER[t.tile] || 'meterNone'));
    case 'no_sensor': return tr(lang, 'whyNoSensor', tr(lang, SENSOR[t.tile] || 'snsDefault'));
    case 'none': return tr(lang, t.tile === 'lights' ? 'whyNoLights' : 'whyNoThermostat');
    case 'few_rooms': return tr(lang, 'whyFewRooms');
    case 'overview_full': return tr(lang, 'whyOverviewFull');
    default: return '';
  }
}

const BOX: CSSProperties = { flex: 'none', margin: '12px 16px 0', padding: '10px 14px', border: '1px solid #e3e0d9', borderRadius: '10px', background: '#FBFAF8', fontSize: '13px', color: '#3d3c39' };
const LINK: CSSProperties = { border: '0', background: 'transparent', padding: '0', font: "500 13px 'IBM Plex Sans', sans-serif", color: '#1d1d1f', textDecoration: 'underline', cursor: 'pointer' };

export function SeedReport({ api, v }: { api: DeviceApi; v: ConsoleView }) {
  const [rep, setRep] = useState<SeedReportView | null>(null);
  const [open, setOpen] = useState(false);
  const sent = useRef(false);
  const rev = v.web.configRev;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when a new config lands (the seed saves one)
  useEffect(() => {
    let alive = true;
    api.getSeedReport().then((r) => { if (alive) setRep(r); }, () => undefined);
    return () => { alive = false; };
  }, [api, rev]);
  const done = !!rep && !rep.dismissed && checklist(input(rep, v), v.web.t)[3].ok;
  // All steps done: dismiss on the display once (no card in the next browser); this page keeps it until "Hide".
  useEffect(() => {
    if (!done || sent.current || v.web.viewOnly) return;
    sent.current = true;
    api.dismissSeedReport().catch(() => undefined);
  }, [done, api, v.web.viewOnly]);
  if (!rep || rep.dismissed) return null;
  const hide = () => {
    setRep({ ...rep, dismissed: true });
    if (!v.web.viewOnly && !sent.current) api.dismissSeedReport().catch(() => undefined);
  };
  const fix = (to: CheckFix) => { if (to === 'device') v.web.openDevice(); else if (to === 'values') v.web.showValues(); else setOpen(true); };
  return <FirstRunCard rep={rep} v={v} open={open} setOpen={setOpen} hide={hide} fix={fix} />;
}

const input = (rep: SeedReportView, v: ConsoleView) => { const s = seedSplit(rep.tiles); return { offline: v.web.offline, filled: s.filled, total: s.total, previewSeen: v.web.previewSeen }; };

/** The card itself, stateless (render tests). */
export function FirstRunCard({ rep, v, open, setOpen, hide, fix }: { rep: SeedReportView; v: ConsoleView; open: boolean; setOpen: (o: boolean) => void; hide: () => void; fix: (to: CheckFix) => void }) {
  const t = v.web.t;
  const steps = checklist(input(rep, v), t).filter((s) => s.id !== 'done' || s.ok);
  const { pickable: dropped, leftOut } = seedSplit(rep.tiles);
  return (
    <div role="status" style={BOX}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
        <b style={{ flex: '1', fontWeight: 600 }}>{t('clTitle')}</b>
        <button onClick={hide} style={LINK}>{t('hide')}</button>
      </div>
      <ol style={{ margin: '6px 0 0', padding: '0', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {steps.map((s, k) => (
          <li key={s.id} data-step={s.id} data-ok={s.ok} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
            <span style={{ width: '18px', flex: 'none', textAlign: 'center', fontWeight: 600, color: s.ok ? '#1E6B35' : '#6f6c66' }}>{s.ok ? '✓' : k + 1}</span>
            <span style={{ flex: '1', color: s.ok ? '#3d3c39' : '#1d1d1f' }}>{s.text}</span>
            {s.fix && !(s.fix.to === 'missing' && !dropped.length) && <button onClick={() => fix(s.fix!.to)} style={LINK}>{s.fix.label}</button>}
          </li>
        ))}
      </ol>
      {!!leftOut.length && <div style={{ marginTop: '6px', color: '#5c5a55' }}>{t('clLeftOut', leftOut.map((k) => t(k)).join(', '))}</div>}
      {!!dropped.length && (
        <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} style={{ marginTop: '6px' }}>
          <summary style={{ cursor: 'pointer', color: '#5c5a55' }}>{dropped.length === 1 ? t('whyMissing1') : t('whyMissingN', dropped.length)}</summary>
          <ul style={{ margin: '6px 0 0', padding: '0', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {dropped.map((x) => (
              <li key={x.tile} style={{ display: 'flex', gap: '8px' }}>
                <span style={{ width: '150px', flex: 'none', fontWeight: 500 }}>{NAME[x.tile] ? t(NAME[x.tile]) : x.tile}</span>
                <span style={{ flex: '1', color: '#5c5a55' }}>{seedWhy(x, v.web.lang)}</span>
                {(x.why === 'no_sensor' || x.why === 'overview_full') && !v.web.viewOnly && <button onClick={() => v.web.openScreen(x.screen)} style={LINK}>{t('pickOne')}</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
