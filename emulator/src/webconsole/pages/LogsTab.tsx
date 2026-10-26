// Advanced › Device log (#200): live tail of GET /api/v1/logs, level / tag filter, previous boot, download.
import { useEffect, useRef } from 'react';
import type { ConsoleView } from '../useConsole.ts';

export function LogsTab({ v }: { v: ConsoleView }) {
  const w = v.web;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);   // follow new lines while scrolled to the bottom
  useEffect(() => { if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight; });
  const segs = (items: { label: string; bg: string; fg: string; pick: () => void }[]) => (
    <div style={{ display: "flex", border: "1px solid #c9c6be", borderRadius: "8px", overflow: "hidden" }}>
      {items.map((o) => (<button key={o.label} onClick={o.pick} style={{ height: "32px", padding: "0 12px", border: "0", borderRight: "1px solid #c9c6be", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Sans', sans-serif" }}>{o.label}</button>))}
    </div>);
  return (
    <div style={{ flex: "1", minWidth: "0", minHeight: "0", display: "flex", flexDirection: "column", gap: "12px", padding: "22px 28px 24px" }}>
      <h2 style={{ margin: "0", fontSize: "20px", fontWeight: "600" }}>{w.t('advLogs')}</h2>
      <div style={{ fontSize: "14px", color: "#5c5a55", lineHeight: "1.5", maxWidth: "72ch" }}>{w.logsNote}</div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        {segs(w.logsBoots)}
        {segs(w.logsLevels)}
        <input aria-label={w.t('logsTag')} placeholder={w.t('logsTag')} value={w.logsTag} onChange={w.setLogsTag} style={{ width: "180px", height: "34px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "8px", padding: "0 10px", font: "13px 'IBM Plex Mono', monospace" }} />
        {!!(w.logsCanPause) && (<button className="dev-btn" onClick={w.logsTogglePause} style={{ height: "34px", padding: "0 12px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "13px" }}>{w.logsPauseLabel}</button>)}
        <button className="dev-btn" onClick={w.logsDownload} style={{ height: "34px", padding: "0 12px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "13px" }}>{w.t('logsDownload')}</button>
        <span style={{ fontSize: "13px", color: w.logsStatusColor }}>{w.logsStatus}</span>
      </div>
      {!!(w.logsDropped) && (<div style={{ fontSize: "13px", color: "#8A5A00" }}>{w.t('logsDropped')}</div>)}
      <div ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        style={{ flex: "1", minHeight: "240px", overflow: "auto", background: "#1d1e20", borderRadius: "10px", padding: "10px 14px", font: "12px/1.55 'IBM Plex Mono', monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {!!(w.logsEmpty) && (<div style={{ color: "#8d8a83" }}>{w.t('logsEmpty')}</div>)}
        {w.logsLines.map((l) => (<div key={l.key} style={{ color: l.color }}>{l.text}</div>))}
      </div>
    </div>
  );
}
