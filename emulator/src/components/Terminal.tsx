// Laptop terminal: the device API from the command line (simulated curl).
// Markup converted from Main.dc.html lines 771–787.
import { Fragment } from 'react';
import type { Vals } from '../emulator/Emulator.tsx';

export function Terminal({ v }: { v: Vals }) {
  return (
    <>
    {/* LAPTOP TERMINAL: the device API from the command line */}
    <div style={{ height: "368px", boxSizing: "border-box", background: "#1d1e20", borderRadius: "12px", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: "34px", flex: "none", display: "flex", alignItems: "center", gap: "7px", padding: "0 14px", background: "#2a2b2e" }}>
        <span style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#4a4b4f" }}></span><span style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#4a4b4f" }}></span><span style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#4a4b4f" }}></span>
        <div style={{ flex: "1", textAlign: "center", font: "500 12px 'IBM Plex Mono', monospace", color: "#a9a69f" }}>laptop — terminal (simulated) — talks to the device API</div>
      </div>
      <div style={{ flex: "1", minHeight: "0", overflow: "hidden", padding: "10px 16px", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: "1px", font: "12.5px/1.5 'IBM Plex Mono', monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {(v.term.lines).map((ln: any, i_ln: number) => (<Fragment key={i_ln}>
          <div style={{ color: ln.c }}>{ln.t}</div>
        </Fragment>))}
      </div>
      <div style={{ flex: "none", borderTop: "1px solid #3a3b3f", padding: "10px 12px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {(v.term.cmds).map((c: any, i_c: number) => (<Fragment key={i_c}>
          <button onClick={c.run} style={{ height: "30px", padding: "0 10px", border: "1px solid #4a4b4f", borderRadius: "6px", background: c.bg, color: c.fg, font: "500 12px 'IBM Plex Mono', monospace" }}>{c.label}</button>
        </Fragment>))}
      </div>
    </div>
    </>
  );
}
