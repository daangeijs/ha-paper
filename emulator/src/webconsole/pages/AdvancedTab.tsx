// Advanced (#191): a sidebar with full pages: Screens as YAML, API (was the Advanced and API access tabs), Device log (#200).
import type { ConsoleView } from '../useConsole.ts';
import { YamlTab } from './YamlTab.tsx';
import { ApiTab } from './ApiTab.tsx';
import { LogsTab } from './LogsTab.tsx';

export function AdvancedTab({ v }: { v: ConsoleView }) {
  return (
    <div className="x4-adv" style={{ flex: "1", minHeight: "0", display: "flex" }}>
      <nav className="x4-adv-nav" aria-label={v.web.t('advPages')} style={{ width: "200px", flex: "none", boxSizing: "border-box", borderRight: "1px solid #e3e0d9", background: "#FBFAF8", padding: "18px 12px", display: "flex", flexDirection: "column", gap: "3px" }}>
        {v.web.advPages.map((p) => (
          <button key={p.label} aria-current={p.on ? 'page' : undefined} onClick={p.pick} style={{ border: "0", borderRadius: "8px", padding: "8px 10px", textAlign: "left", background: p.on ? "#1d1d1f" : "transparent", color: p.on ? "#fff" : "#1d1d1f", font: "500 14px 'IBM Plex Sans', sans-serif" }}>{p.label}</button>))}
        <div className="x4-adv-hint" style={{ marginTop: "14px", padding: "0 10px", fontSize: "12px", color: "#8d8a83", lineHeight: "1.45" }}>{v.web.t('advHint')}</div>
      </nav>
      {v.web.isYaml && <YamlTab v={v} />}
      {v.web.isApi && <ApiTab v={v} />}
      {v.web.isLogs && <LogsTab v={v} />}
    </div>
  );
}
