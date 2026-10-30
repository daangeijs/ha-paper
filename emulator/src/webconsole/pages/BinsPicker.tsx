// Bin day tile editor (eink-ha-os#317): tick each bin's sensor (likely bins first), give it the name the tile shows.
import type { CSSProperties } from 'react';
import type { ConsoleView } from '../useConsole.ts';

const SEARCH: CSSProperties = { height: "34px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "8px", padding: "0 10px", fontSize: "13px" };

export function BinsPicker({ web }: { web: ConsoleView['web'] }) {
  return (<>
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <span style={{ fontSize: "14px", fontWeight: "600" }}>{web.binsTitle}</span>
      <span style={{ fontSize: "12px", color: "#5c5a55" }}>{web.binsHint}</span>
    </div>
    <input type="search" aria-label={web.listSearch} placeholder={web.listSearch} value={web.qEntity} onChange={web.setQEntity} style={SEARCH} />
    {!!(web.entLoading) && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{web.entStatus}</div>)}
    <fieldset aria-label={web.binsTitle} style={{ margin: "0", padding: "0", minWidth: "0", border: "0", flex: "none", height: "280px", overflow: "auto", display: "flex", flexDirection: "column", gap: "3px" }}>
      {web.binRows.map((r) => (
        <div key={r.id} style={{ flex: "none", minHeight: "40px", border: "1px solid #e3e0d9", borderRadius: "8px", padding: "4px 10px", display: "flex", alignItems: "center", gap: "10px" }}>
          <input type="checkbox" checked={r.on} onChange={r.toggle} aria-label={r.name} />
          <span style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "14px", fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
            <span style={{ font: "11px 'IBM Plex Mono', monospace", color: "#5c5a55", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.id}{r.state ? ' · ' + r.state : ''}</span>
          </span>
          {/* uncontrolled: the stored name is trimmed, the field keeps what is typed */}
          {r.on && <input type="text" aria-label={r.nameLabel} placeholder={r.name} defaultValue={r.label} onChange={r.setLabel} style={{ ...SEARCH, width: "110px", flex: "none" }} />}
        </div>))}
    </fieldset>
  </>);
}
