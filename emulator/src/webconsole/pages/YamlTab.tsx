// Advanced › Screens as YAML (eink-ha-os#191): the editor fills the page, Validate and Push top right.
import type { ConsoleView } from '../useConsole.ts';

export function YamlTab({ v }: { v: ConsoleView }) {
  return (
    <div style={{ flex: "1", minWidth: "0", minHeight: "0", display: "flex", flexDirection: "column", gap: "12px", padding: "22px 28px" }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <h2 style={{ margin: "0", flex: "1", fontSize: "20px", fontWeight: "600" }}>{v.web.t('advYaml')}</h2>
        <button className="dev-btn" onClick={v.web.validate} style={{ height: "36px", padding: "0 16px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "14px", fontWeight: "500" }}>{v.web.t('validate')}</button>
        <button onClick={v.web.pushYaml} style={{ height: "36px", padding: "0 16px", border: "0", borderRadius: "8px", background: "#1d1d1f", color: "#fff", font: "600 14px 'IBM Plex Sans', sans-serif" }}>{v.web.t('push')}</button>
      </div>
      <div style={{ flex: "none", fontSize: "14px", color: "#5c5a55", lineHeight: "1.5" }}><span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#1d1d1f" }}>screens.yaml</span> · {v.web.yamlSource} {v.web.t('yamlOptional')}</div>
      {!!(v.web.hasYamlMsg) && (
        <div role="status" style={{ flex: "none", border: `1.5px solid ${v.web.yamlMsgColor}`, borderRadius: "10px", padding: "10px 12px", fontSize: "14px", lineHeight: "1.45", color: v.web.yamlMsgColor }}>{v.web.yamlMsg}</div>)}
      <textarea aria-label={v.web.t('yamlAria')} spellCheck="false" value={v.web.yaml} onChange={v.web.editYaml} style={{ flex: "1", minHeight: "320px", resize: "none", boxSizing: "border-box", border: "1px solid #d3d0c8", borderRadius: "10px", padding: "14px 16px", font: "13px/1.6 'IBM Plex Mono', monospace", background: "#FBFAF8", color: "#1d1d1f" }}></textarea>
    </div>
  );
}
