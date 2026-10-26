// Device settings (#190): the settings with an (i) each in the wide column; Wi-Fi folded to one line on top of the
// right column (Change opens the form), then Home Assistant, This display, Diagnostics.
import { Fragment } from 'react';
import type { ConsoleView } from '../useConsole.ts';

export function DeviceTab({ v }: { v: ConsoleView }) {
  const CARD = { background: "#fff", border: "1px solid #d3d0c8", borderRadius: "14px", padding: "20px", display: "flex", flexDirection: "column", gap: "10px" } as const;
  return (
    <>
        <div className="x4-dev" style={{ flex: "1", minHeight: "0", display: "flex", alignItems: "flex-start", gap: "20px", padding: "20px 24px", background: "#FBFAF8", overflow: "auto" }}>
          <div style={{ ...CARD, flex: "1", minWidth: "0", gap: "4px" }}>
            <div style={{ fontSize: "18px", fontWeight: "600" }}>{v.web.t('grpSettings')}</div>
            <div style={{ fontSize: "13px", color: "#5c5a55", lineHeight: "1.45", marginBottom: "6px" }}>{v.web.t('displayNote')}</div>
            {!v.web.settingsReady && (<div style={{ fontSize: "14px", color: "#5c5a55" }}>{v.web.t('loading')}</div>)}
            {v.web.settingsGroups.map((g) => (<Fragment key={g.id}>
              <div style={{ fontSize: "13px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.5px", color: "#5c5a55", marginTop: "10px" }}>{g.title}</div>
              {g.fields.map((f) => (
                <div key={f.key} style={{ borderTop: "1px solid #ece9e3", padding: "6px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", fontSize: "14px", minHeight: "36px" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "6px", color: "#5c5a55" }}>
                      <label htmlFor={'x4-set-' + f.key}>{f.label}</label>
                      {!!f.info && (<button aria-expanded={f.infoOpen} aria-controls={'x4-info-' + f.key} aria-label={v.web.t('aboutSetting', f.label)} onClick={f.toggleInfo}
                        style={{ width: "20px", height: "20px", flex: "none", border: f.infoOpen ? "1px solid #1d1d1f" : "1px solid #c9c6be", borderRadius: "50%", background: f.infoOpen ? "#1d1d1f" : "#fff", color: f.infoOpen ? "#fff" : "#5c5a55", font: "italic 600 11px/1 Georgia, 'Times New Roman', serif", padding: "0", display: "grid", placeItems: "center" }}>i</button>)}
                    </span>
                    <select id={'x4-set-' + f.key} value={f.value} onChange={f.change} style={{ height: "34px", minWidth: "150px", border: "1px solid #c9c6be", borderRadius: "8px", padding: "0 8px", background: "#fff", font: "500 14px 'IBM Plex Sans', sans-serif" }}>
                      {f.options.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                    </select>
                  </div>
                  {!!f.info && f.infoOpen && (<div id={'x4-info-' + f.key} style={{ margin: "4px 0 6px", padding: "10px 12px", borderRadius: "8px", background: "#F6F5F2", fontSize: "13px", lineHeight: "1.5", color: "#3d3c39" }}>{f.info}</div>)}
                </div>))}
            </Fragment>))}
            {!!(v.web.hasSettingsMsg) && (<div style={{ fontSize: "13px", color: v.web.settingsMsgColor, marginTop: "6px" }}>{v.web.settingsMsg}</div>)}
          </div>
          <div className="x4-dev-side" style={{ width: "400px", flex: "none", display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ ...CARD, padding: "14px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px 12px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "16px", fontWeight: "600" }}>{v.web.t('stepWifi')}</span>
                <b style={{ fontSize: "15px", fontWeight: "600" }}>{v.web.wifiNow}</b>
                {!!v.web.wifiSignal && (<span style={{ fontSize: "13px", color: "#5c5a55" }}>· {v.web.wifiSignal}</span>)}
                <button className="dev-btn" aria-expanded={v.web.wifiOpen} aria-label={v.web.t('wifiChangeAria')} onClick={v.web.toggleWifi} style={{ marginLeft: "auto", height: "32px", padding: "0 12px", border: "1px solid #c9c6be", borderRadius: "8px", background: v.web.wifiOpen ? "#1d1d1f" : "#fff", color: v.web.wifiOpen ? "#fff" : "#1d1d1f", fontSize: "13px" }}>{v.web.t('change')}</button>
              </div>
              {v.web.wifiOpen && (<>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {v.web.nets.map((n) => (
                    <button key={n.ssid} onClick={n.pick} style={{ height: "48px", boxSizing: "border-box", border: n.border, borderRadius: "10px", background: n.bg, padding: "0 14px", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", textAlign: "left" }}><span style={{ fontSize: "15px", fontWeight: "600" }}>{n.ssid}</span><span style={{ fontSize: "12px", color: "#5c5a55" }}>{n.info}</span></button>))}
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", color: "#5c5a55" }}>{v.web.t('password')}
                  <input type="password" value={v.web.wifiPw} onChange={v.web.setWifiPw} style={{ height: "42px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "10px", padding: "0 12px", font: "15px 'IBM Plex Sans', sans-serif" }} />
                </label>
                {!!(v.web.hasWifiMsg) && (<div style={{ fontSize: "14px", color: "#B3261E" }}>{v.web.wifiMsg}</div>)}
                <button onClick={v.web.wifiConnect} style={{ height: "44px", border: "0", borderRadius: "10px", background: "#1d1d1f", color: "#fff", font: "600 14px 'IBM Plex Sans', sans-serif" }}>{v.web.wifiLabel}</button>
                <div style={{ fontSize: "13px", color: "#5c5a55", lineHeight: "1.45" }}>{v.web.t('switchNote', v.web.hostname)}</div>
              </>)}
            </div>
            <div style={{ background: "#fff", border: "1px solid #d3d0c8", borderRadius: "14px", padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ fontSize: "18px", fontWeight: "600" }}>Home Assistant</div>
              {(v.web.haLines).map((ln: any, i_ln: number) => (<Fragment key={i_ln}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "14px", padding: "6px 0", borderTop: "1px solid #ece9e3" }}><span style={{ color: "#5c5a55" }}>{ln.k}</span><span style={{ fontWeight: "500", textAlign: "right" }}>{ln.v}</span></div>
              </Fragment>))}
              <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                <button className="dev-btn" onClick={v.web.haRelink} style={{ flex: "1", height: "40px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "14px" }}>{v.web.t('relink')}</button>
                <button className="dev-btn" onClick={v.web.haUnlink} style={{ flex: "1", height: "40px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "14px" }}>{v.web.t('unlink')}</button>
              </div>
            </div>
            <div style={{ background: "#fff", border: "1px solid #d3d0c8", borderRadius: "14px", padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ fontSize: "18px", fontWeight: "600" }}>{v.web.t('thisDisplay')}</div>
              {(v.web.devLines).map((ln: any, i_ln: number) => (<Fragment key={i_ln}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "14px", padding: "6px 0", borderTop: "1px solid #ece9e3" }}><span style={{ color: "#5c5a55" }}>{ln.k}</span><span style={{ fontWeight: "500" }}>{ln.v}</span></div>
              </Fragment>))}
            </div>
            {v.web.otaReady && (<div className="x4-ota" aria-live="polite" style={{ ...CARD }}>
              <div style={{ fontSize: "18px", fontWeight: "600" }}>{v.web.t('menuUpdates')}</div>
              <div style={{ borderTop: "1px solid #ece9e3", paddingTop: "8px" }}>
                <div style={{ fontSize: "15px", fontWeight: "600" }}>{v.web.otaLine.title}</div>
                {!!v.web.otaLine.sub && (<div style={{ fontSize: "13px", color: "#5c5a55", lineHeight: "1.45", overflowWrap: "anywhere" }}>{v.web.otaLine.sub}</div>)}
              </div>
              {!!v.web.otaMsg && (<div style={{ fontSize: "13px", color: "#B3261E" }}>{v.web.otaMsg}</div>)}
              {v.web.otaCanCheck && (<button className="dev-btn" onClick={v.web.otaCheck} disabled={v.web.otaChecking} style={{ height: "40px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "14px", opacity: v.web.otaChecking ? 0.6 : 1 }}>{v.web.t(v.web.otaChecking ? 'checking' : 'otaCheck')}</button>)}
            </div>)}
            <div style={{ background: "#fff", border: "1px solid #d3d0c8", borderRadius: "14px", padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ fontSize: "18px", fontWeight: "600" }}>{v.web.t('diagnostics')}</div>
              {!v.web.diagReady && !v.web.diagMsg && (<div style={{ fontSize: "14px", color: "#5c5a55" }}>{v.web.t('loading')}</div>)}
              {!!v.web.diagMsg && (<div style={{ fontSize: "13px", color: "#B3261E" }}>{v.web.diagMsg}</div>)}
              {v.web.diagLines.map((ln) => (
                <div key={ln.k} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "14px", padding: "6px 0", borderTop: "1px solid #ece9e3" }}><span style={{ color: "#5c5a55", flex: "none" }}>{ln.k}</span><span style={{ fontWeight: "500", textAlign: "right", overflowWrap: "anywhere" }}>{ln.v}</span></div>))}
              {!!v.web.diagPanic && (<div style={{ font: "12px 'IBM Plex Mono', monospace", background: "#F4F2EE", borderRadius: "8px", padding: "8px 10px", overflowWrap: "anywhere" }}>{v.web.diagPanic}</div>)}
              {!!v.web.diagCore && (<div style={{ fontSize: "13px", color: "#5c5a55", lineHeight: "1.45", overflowWrap: "anywhere" }}>Core dump: <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{v.web.diagCore}</span> · <a href={v.web.diagCoreHref} download="coredump.elf">download</a></div>)}
              {v.web.diagReady && (<button className="dev-btn" onClick={v.web.diagClear} style={{ height: "40px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "14px" }}>{v.web.t('clear')}</button>)}
            </div>
          </div>
        </div>
    </>
  );
}
