// Side panel: header, Hardware keys, Simulation, GitHub releases (mock), Event log.
// Markup converted from Main.dc.html lines 790–886 (+ "Installed" simulation button).
import { Fragment } from 'react';
import type { Vals } from '../emulator/Emulator.tsx';

export function SidePanel({ v }: { v: Vals }) {
  return (
    <>
  {/* RIGHT: dev panel */}
  <div style={{ width: "440px", flex: "none", height: "1020px", display: "flex", flexDirection: "column", gap: "16px" }}>
    <div style={{ background: "#F6F5F2", border: "1px solid #C4C0B7", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div style={{ fontSize: "22px", fontWeight: "600", letterSpacing: "-0.3px" }}>{v.osName} emulator</div>
        <div style={{ font: "500 11px 'IBM Plex Mono', monospace", padding: "3px 6px", borderRadius: "4px", background: "#1d1d1f", color: "#F6F5F2" }}>DEV</div>
      </div>
      <div style={{ fontSize: "13px", color: "#5c5a55" }}>Xteink X4 Pro · 800 × 480 landscape · 4-level gray · touch · mock HA data</div>
      <div style={{ font: "500 12px 'IBM Plex Mono', monospace", color: "#1d1d1f", marginTop: "4px" }}>{v.statusLine}</div>
    </div>

    <div style={{ background: "#F6F5F2", border: "1px solid #C4C0B7", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ fontSize: "15px", fontWeight: "600" }}>Hardware</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
        <button className="dev-btn" onClick={v.hwPrev} style={{ height: "40px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "14px" }}>Prev</button>
        <button className="dev-btn" onClick={v.hwNext} style={{ height: "40px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "14px" }}>Next</button>
        <button className="dev-btn" onClick={v.hwHome} style={{ height: "40px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "14px" }}>Home</button>
        <button className="dev-btn" onClick={v.hwPower} style={{ height: "40px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "14px" }}>Power</button>
        <button className="dev-btn" onClick={v.hwReset} style={{ height: "40px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "14px" }}>Reset</button>
        <button className="dev-btn" onClick={v.forceFull} style={{ height: "40px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "14px" }}>Full refresh</button>
      </div>
    </div>

    <div style={{ background: "#F6F5F2", border: "1px solid #C4C0B7", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ fontSize: "15px", fontWeight: "600" }}>Simulation</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ fontSize: "12px", color: "#5c5a55" }}>Time of day (solar, usage, prices · 23:00 starts quiet hours)</div>
        <div style={{ display: "flex", border: "1px solid #A8A49B", borderRadius: "6px", overflow: "hidden" }}>
          {(v.hourOpts).map((o: any, i_o: number) => (<Fragment key={i_o}>
            <button onClick={o.pick} style={{ flex: "1", height: "34px", border: "0", borderRight: "1px solid #A8A49B", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Mono', monospace" }}>{o.label}</button>
          </Fragment>))}
        </div>
      </div>
      <div style={{ display: "flex", gap: "12px" }}>
        <div style={{ flex: "1", display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: "12px", color: "#5c5a55" }}>Heated rooms (tado)</div>
          <div style={{ display: "flex", border: "1px solid #A8A49B", borderRadius: "6px", overflow: "hidden" }}>
            {(v.zoneOpts).map((o: any, i_o: number) => (<Fragment key={i_o}>
              <button onClick={o.pick} style={{ flex: "1", height: "34px", border: "0", borderRight: "1px solid #A8A49B", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Mono', monospace" }}>{o.label}</button>
            </Fragment>))}
          </div>
        </div>
        <div style={{ flex: "1", display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: "12px", color: "#5c5a55" }}>Panel rendering</div>
          <div style={{ display: "flex", border: "1px solid #A8A49B", borderRadius: "6px", overflow: "hidden" }}>
            {(v.renderOpts).map((o: any, i_o: number) => (<Fragment key={i_o}>
              <button onClick={o.pick} style={{ flex: "1", height: "34px", border: "0", borderRight: "1px solid #A8A49B", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Mono', monospace" }}>{o.label}</button>
            </Fragment>))}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ fontSize: "12px", color: "#5c5a55" }}>Display style (Classic, or Sleek in one of four typefaces · device setting, one full refresh)</div>
        <div style={{ display: "flex", border: "1px solid #A8A49B", borderRadius: "6px", overflow: "hidden" }}>
          {(v.lookOpts).map((o: any, i_o: number) => (<Fragment key={i_o}>
            <button onClick={o.pick} style={{ flex: "1", height: "34px", border: "0", borderRight: "1px solid #A8A49B", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Mono', monospace" }}>{o.label}</button>
          </Fragment>))}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ fontSize: "12px", color: "#5c5a55" }}>Travel situation (mock NS, OVapi and Google Maps data)</div>
        <div style={{ display: "flex", border: "1px solid #A8A49B", borderRadius: "6px", overflow: "hidden" }}>
          {(v.travelOpts).map((o: any, i_o: number) => (<Fragment key={i_o}>
            <button onClick={o.pick} style={{ flex: "1", height: "34px", border: "0", borderRight: "1px solid #A8A49B", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Mono', monospace" }}>{o.label}</button>
          </Fragment>))}
        </div>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <button className="dev-btn" onClick={v.togglePause} style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.pauseLabel}</button>
        <button className="dev-btn" onClick={v.toggleOffline} style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.offlineLabel}</button>
        <button className="dev-btn" onClick={v.toggleUsb} title="External power: no deep sleep, full speed. Plugging in wakes a sleeping display." style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.usbLabel}</button>
        <button className="dev-btn" onClick={v.revokeKey} style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>Revoke HA key</button>
        <button className="dev-btn" onClick={v.firstInstall} style={{ height: "34px", padding: "0 12px", border: "1px solid #1d1d1f", borderRadius: "6px", background: "#1d1d1f", color: "#F6F5F2", fontSize: "13px" }}>First install</button>
        <button className="dev-btn" onClick={v.installed} title="Already on Wi-Fi “HomeNet”, Home Assistant linked, web console signed in: boots straight to Home" style={{ height: "34px", padding: "0 12px", border: "1px solid #1d1d1f", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>Installed</button>
        <button className="dev-btn" onClick={v.holdReset} title="Hold Power + Right for 5 s, release: factory reset screen (Right erases, any other key cancels)" style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>Hold Power + Right</button>
        <button className="dev-btn" onClick={v.holdPower} title="Hold Power alone for 2 s: Turned off face, then off; press Power to turn on (issue #258)" style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>Hold Power 2 s</button>
        <button className="dev-btn" onClick={v.holdRestart} title="Hold Power + Left (Prev) for 5 s: Restarting…, then a clean restart (issue #226)" style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>Hold Power + Left</button>
        <button className="dev-btn" onClick={v.crashLoop} title="Boot ring shows 3 crash resets in a row: the reset screen is offered at boot" style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>Crash loop</button>
        <button className="dev-btn" onClick={v.noHaSim}style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>Never linked</button>
        <button className="dev-btn" onClick={v.toggleHaCurrency} title="The currency Home Assistant reports (get_config); price tiles show it (#147)" style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.haCurLabel}</button>
        <button className="dev-btn" onClick={v.toggleHaLang} title="The language Home Assistant reports (get_config); the display and the linked console follow it (#98)" style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.haLangLabel}</button>
        <button className="dev-btn" onClick={v.togglePanel} title="4-gray mode: areas redrawn by a partial refresh show black/white (gray1 → black, gray2 → white) until the next full refresh, like the X4 panel" style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.panelLabel}</button>
        <button className="dev-btn" onClick={v.toggleRegions} style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px" }}>{v.regionsLabel}</button>
      </div>
      <div style={{ font: "500 12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>{v.refreshStats}</div>
    </div>

    <div style={{ background: "#F6F5F2", border: "1px solid #C4C0B7", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600" }}>GitHub releases (mock)</div>
        <div style={{ font: "500 12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>{v.repoLine}</div>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button className="dev-btn" onClick={v.publishRelease} style={{ height: "34px", padding: "0 12px", border: "1px solid #A8A49B", borderRadius: "6px", background: "#fff", fontSize: "13px", flex: "none" }}>Publish release</button>
        <div style={{ flex: "1", display: "flex", border: "1px solid #A8A49B", borderRadius: "6px", overflow: "hidden" }}>
          {(v.failOpts).map((o: any, i_o: number) => (<Fragment key={i_o}>
            <button onClick={o.pick} style={{ flex: "1", height: "34px", border: "0", borderRight: "1px solid #A8A49B", background: o.bg, color: o.fg, font: "500 12px 'IBM Plex Mono', monospace" }}>{o.label}</button>
          </Fragment>))}
        </div>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <span style={{ fontSize: "13px", flex: "none", width: "110px" }}>Next check</span>
        <div style={{ flex: "1", display: "flex", border: "1px solid #A8A49B", borderRadius: "6px", overflow: "hidden" }}>
          {(v.checkOpts).map((o: any, i_o: number) => (<Fragment key={i_o}>
            <button onClick={o.pick} style={{ flex: "1", height: "34px", border: "0", borderRight: "1px solid #A8A49B", background: o.bg, color: o.fg, font: "500 12px 'IBM Plex Mono', monospace" }}>{o.label}</button>
          </Fragment>))}
        </div>
      </div>
    </div>

    <div style={{ flex: "1", minHeight: "0", background: "#1d1e20", borderRadius: "12px", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: "15px", fontWeight: "600", color: "#F6F5F2" }}>Event log</div>
        <button onClick={v.clearLog} style={{ height: "30px", padding: "0 10px", border: "1px solid #4a4b4f", borderRadius: "6px", background: "none", color: "#d9d6ce", fontSize: "12px" }}>Clear</button>
      </div>
      <div style={{ flex: "1", minHeight: "0", overflow: "auto", display: "flex", flexDirection: "column", gap: "3px", font: "12px/1.45 'IBM Plex Mono', monospace" }}>
        {(v.log).map((l: any, i_l: number) => (<Fragment key={i_l}>
          <div style={{ display: "flex", gap: "10px" }}><span style={{ color: "#8d8a83", flex: "none" }}>{l.t}</span><span style={{ color: l.c }}>{l.msg}</span></div>
        </Fragment>))}
      </div>
    </div>
  </div>
    </>
  );
}
