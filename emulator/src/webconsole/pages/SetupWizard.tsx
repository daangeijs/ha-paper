// Setup wizard reached through the SoftAP (192.168.4.1): Wi-Fi → Home Assistant → done.
// Markup converted from Main.dc.html (web console section, lines 888–1176).
import { Fragment } from 'react';
import type { ConsoleView } from '../useConsole.ts';
import { HaSignIn } from './HaSignIn.tsx';

export function SetupWizard({ v }: { v: ConsoleView }) {
  return (
    <>
      <div style={{ flex: "1", minHeight: "0", display: "flex", justifyContent: "center", background: "#F6F5F2", overflow: "auto" }}>
        <div style={{ width: "580px", padding: "44px 0", display: "flex", flexDirection: "column", gap: "18px" }}>
          <div style={{ font: "500 12px 'IBM Plex Mono', monospace", letterSpacing: "1px", color: "#5c5a55" }}>FIRST-TIME SETUP · {v.osName}</div>
          <div style={{ fontSize: "30px", fontWeight: "600", letterSpacing: "-0.4px" }}>{v.web.t('setupTitle')}</div>
          <div style={{ display: "flex", gap: "8px" }}>
            {(v.web.setupSteps).map((st: any, i_st: number) => (<Fragment key={i_st}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", height: "34px", padding: "0 14px 0 6px", border: "1px solid #1d1d1f", borderRadius: "17px", background: st.bg, color: st.fg, fontSize: "14px", fontWeight: "500" }}><span style={{ width: "22px", height: "22px", borderRadius: "50%", border: "1.5px solid currentColor", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px" }}>{st.mark}</span>{st.label}</div>
            </Fragment>))}
          </div>
          <div style={{ background: "#fff", border: "1px solid #d3d0c8", borderRadius: "16px", padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
            {!!(v.web.sWifi) && (<>
              <div style={{ fontSize: "20px", fontWeight: "600" }}>{v.web.t('chooseWifi')}</div>
              <div style={{ fontSize: "14px", color: "#5c5a55" }}>{v.web.t('wifiHint')}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {(v.web.nets).map((n: any, i_n: number) => (<Fragment key={i_n}>
                  <button onClick={n.pick} style={{ height: "50px", boxSizing: "border-box", border: n.border, borderRadius: "10px", background: n.bg, padding: "0 14px", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", textAlign: "left" }}><span style={{ fontSize: "15px", fontWeight: "600" }}>{n.ssid}</span><span style={{ fontSize: "12px", color: "#5c5a55" }}>{n.info}</span></button>
                </Fragment>))}
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", color: "#5c5a55" }}>Password
                <input type="password" value={v.web.wifiPw} onChange={v.web.setWifiPw} style={{ height: "44px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "10px", padding: "0 12px", font: "16px 'IBM Plex Sans', sans-serif" }} />
              </label>
              {!!(v.web.hasWifiMsg) && (<><div style={{ fontSize: "14px", color: "#B3261E" }}>{v.web.wifiMsg}</div></>)}
              <button onClick={v.web.wifiConnect} style={{ height: "48px", border: "0", borderRadius: "10px", background: "#1d1d1f", color: "#fff", font: "600 15px 'IBM Plex Sans', sans-serif" }}>{v.web.wifiLabel}</button>
            </>)}
            {!!(v.web.sHa) && (<>
              <div style={{ fontSize: "20px", fontWeight: "600" }}>{v.web.t('linkHa')}</div>
              <div style={{ fontSize: "15px", lineHeight: "1.5" }}>{v.web.linkText}</div>
              <HaSignIn v={v} onSignIn={v.web.haSignIn} />
            </>)}
            {!!(v.web.sDone) && (<>
              <div style={{ fontSize: "20px", fontWeight: "600" }}>{v.web.t('allSet')}</div>
              <div style={{ fontSize: "15px", lineHeight: "1.5" }}>{v.web.t('allSetText')}</div>
              <button onClick={v.web.finish} style={{ height: "48px", border: "0", borderRadius: "10px", background: "#1d1d1f", color: "#fff", font: "600 15px 'IBM Plex Sans', sans-serif" }}>{v.web.t('openConfigurator')}</button>
            </>)}
          </div>
        </div>
      </div>
    </>
  );
}
