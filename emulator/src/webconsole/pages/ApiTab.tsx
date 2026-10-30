// Advanced › API (eink-ha-os#191): tokens on top (create, list, revoke), the OpenAPI description and the endpoints below.
import type { ConsoleView } from '../useConsole.ts';

export function ApiTab({ v }: { v: ConsoleView }) {
  return (
    <div style={{ flex: "1", minWidth: "0", minHeight: "0", overflow: "auto", padding: "22px 28px 40px", display: "flex", flexDirection: "column", gap: "28px" }}>
      <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h2 style={{ margin: "0", fontSize: "20px", fontWeight: "600" }}>{v.web.t('apiTokens')}</h2>
        <div style={{ fontSize: "14px", color: "#5c5a55", lineHeight: "1.5", maxWidth: "72ch" }}>{v.web.t('apiTokensNote')}</div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", border: "1px solid #d3d0c8", borderRadius: "10px", padding: "12px", background: "#FBFAF8" }}>
          <input aria-label={v.web.t('tokenName')} value={v.web.newName} onChange={v.web.setName} style={{ width: "200px", height: "36px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "8px", padding: "0 10px", font: "14px 'IBM Plex Sans', sans-serif" }} />
          <div style={{ display: "flex", border: "1px solid #c9c6be", borderRadius: "8px", overflow: "hidden" }}>
            {v.web.scopes.map((o) => (
              <button key={o.label} onClick={o.pick} style={{ height: "34px", padding: "0 12px", border: "0", borderRight: "1px solid #c9c6be", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Sans', sans-serif" }}>{o.label}</button>))}
          </div>
          <button onClick={v.web.createToken} style={{ height: "36px", padding: "0 16px", border: "0", borderRadius: "8px", background: "#1d1d1f", color: "#fff", font: "600 14px 'IBM Plex Sans', sans-serif" }}>{v.web.t('createToken')}</button>
        </div>
        {!!(v.web.hasReveal) && (
          <div style={{ border: "2px solid #1d1d1f", borderRadius: "12px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ fontSize: "14px", fontWeight: "600" }}>{v.web.t('copyToken')}</div>
            <div style={{ font: "500 15px 'IBM Plex Mono', monospace", background: "#F6F5F2", borderRadius: "8px", padding: "10px 12px", wordBreak: "break-all" }}>{v.web.reveal}</div>
            <pre style={{ margin: "0", font: "12px/1.6 'IBM Plex Mono', monospace", background: "#1d1e20", color: "#d9d6ce", borderRadius: "8px", padding: "10px 12px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{v.web.curlExample}</pre>
          </div>)}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {!!(v.web.noTokens) && (<div style={{ fontSize: "14px", color: "#5c5a55", padding: "12px 0" }}>{v.web.t('noTokens')}</div>)}
          {v.web.tokens.map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 0", borderTop: "1px solid #ece9e3" }}>
              <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column" }}><span style={{ fontSize: "15px", fontWeight: "600" }}>{t.name}</span><span style={{ font: "12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>{v.web.t('tokenMeta', t.masked, t.created, t.last)}</span></div>
              <span style={{ fontSize: "12px", fontWeight: "600", padding: "3px 8px", borderRadius: "10px", border: "1px solid #1d1d1f" }}>{t.scopeLabel}</span>
              <button className="dev-btn" onClick={t.revoke} style={{ height: "32px", padding: "0 12px", border: "1px solid #c9c6be", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.web.t('revoke')}</button>
            </div>))}
        </div>
      </section>
      <section style={{ display: "flex", flexDirection: "column", gap: "12px", borderTop: "1px solid #e3e0d9", paddingTop: "28px" }}>
        <h2 style={{ margin: "0", fontSize: "20px", fontWeight: "600" }}>{v.web.t('apiReference')}</h2>
        <div className="x4-api-grid" style={{ display: "grid", gridTemplateColumns: "340px minmax(0, 1fr)", gap: "20px", alignItems: "start" }}>
          <div style={{ border: "2px solid #1d1d1f", borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "6px", background: "#fff" }}>
            <div style={{ fontSize: "15px", fontWeight: "600" }}>{v.web.t('openApi')}</div>
            <a href={v.web.specHref} target="_blank" rel="noreferrer" style={{ font: "500 13px 'IBM Plex Mono', monospace", color: "#1d1d1f", wordBreak: "break-all" }}>{v.web.specUrl}</a>
            <div style={{ fontSize: "13px", color: "#5c5a55", lineHeight: "1.45" }}>{v.web.t('openApiNote')}</div>
            <pre style={{ margin: "0", font: "12px/1.5 'IBM Plex Mono', monospace", background: "#1d1e20", color: "#d9d6ce", borderRadius: "6px", padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{'curl ' + v.web.specUrl + ' -o openapi.yaml'}</pre>
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: "0" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", paddingBottom: "6px" }}>
              <span style={{ fontSize: "16px", fontWeight: "600" }}>{v.web.t('endpoints')}</span>
              <span style={{ font: "12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>http://{v.web.hostname}</span>
            </div>
            {v.web.endpoints.map((ep, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: "3px", padding: "9px 0", borderTop: "1px solid #e6e3dc" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}><span style={{ flex: "none", width: "44px", textAlign: "center", font: "600 11px 'IBM Plex Mono', monospace", padding: "2px 0", borderRadius: "4px", background: ep.bg, color: ep.fg }}>{ep.m}</span><span style={{ font: "500 13px 'IBM Plex Mono', monospace", wordBreak: "break-all" }}>{ep.path}</span></div>
                <div style={{ fontSize: "13px", color: "#3d3c39", paddingLeft: "52px" }}>{ep.desc} <span style={{ color: "#8d8a83" }}>· {ep.scope}</span></div>
              </div>))}
          </div>
        </div>
      </section>
    </div>
  );
}
