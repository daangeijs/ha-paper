// Configurator header: tabs, draft state, Push to display, account.
// Markup converted from Main.dc.html (web console section, lines 888–1176).
import { Fragment } from 'react';
import type { ConsoleView } from '../useConsole.ts';

export function Header({ v }: { v: ConsoleView }) {
  return (
    <>
      <div className="x4-head" style={{ minHeight: "60px", flex: "none", display: "flex", alignItems: "center", gap: "16px", padding: "0 20px", borderBottom: "1px solid #e3e0d9" }}>
        <div style={{ display: "flex", flexDirection: "column" }}><span style={{ fontSize: "15px", fontWeight: "600" }}>{v.osName}</span><span style={{ fontSize: "12px", color: "#5c5a55" }}>{v.web.deviceName}</span></div>
        <div style={{ display: "flex", gap: "4px", marginLeft: "12px" }}>
          {(v.web.tabs).map((t: any, i_t: number) => (<Fragment key={i_t}>
            <button onClick={t.pick} style={{ height: "36px", padding: "0 14px", border: "0", borderRadius: "8px", background: t.bg, color: t.fg, font: "500 14px 'IBM Plex Sans', sans-serif" }}>{t.label}</button>
          </Fragment>))}
        </div>
        {!!(v.web.isScreens) && (
          <fieldset aria-label={v.web.t('screenView')} style={{ display: "flex", flex: "none", margin: "0", padding: "0", minWidth: "0", border: "1px solid #c9c6be", borderRadius: "8px", overflow: "hidden" }}>
            {(v.web.screenViews).map((o: any) => (
              <button key={o.label} aria-pressed={o.on} onClick={o.pick} style={{ height: "34px", padding: "0 12px", border: "0", background: o.bg, color: o.fg, font: "500 13px 'IBM Plex Sans', sans-serif" }}>{o.label}</button>))}
          </fieldset>)}
        <div className="x4-grow" style={{ flex: "1" }}></div>
        <span style={{ fontSize: "13px", color: v.web.stateColor, fontWeight: "500" }}>{v.web.stateText}</span>
        {!!(v.web.dirty) && (<>
          <button className="dev-btn" onClick={v.web.discard} style={{ height: "36px", padding: "0 14px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "14px" }}>{v.web.t('discard')}</button>
        </>)}
        {!v.web.viewOnly && (<button onClick={v.web.push} disabled={!v.web.dirty} style={{ height: "36px", padding: "0 16px", border: "0", borderRadius: "8px", background: v.web.pushBg, color: v.web.pushFg, font: "600 14px 'IBM Plex Sans', sans-serif" }}>{v.web.t('push')}</button>)}
        <span style={{ fontSize: "13px", color: "#5c5a55", whiteSpace: "nowrap" }}>{v.web.tp('signedInAs')[0]}<b style={{ color: "#1d1d1f", fontWeight: "600" }}>{v.web.user}</b>{v.web.tp('signedInAs')[1]}</span>
        <button className="dev-btn" onClick={v.web.signOut} style={{ height: "36px", padding: "0 14px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "14px" }}>{v.web.t('signOut')}</button>
      </div>
      {!!(v.web.haDown) && (
        <div role="status" style={{ flex: "none", padding: "10px 20px", background: "#F6F5F2", borderBottom: "1px solid #e3e0d9", fontSize: "14px", lineHeight: "1.4", color: "#3d3c39" }}>{v.web.haDownText}</div>
      )}
      {!!(v.web.viewOnly) && (
        <div role="status" style={{ flex: "none", display: "flex", alignItems: "center", gap: "16px", padding: "10px 20px", background: "#F6F5F2", borderBottom: "1px solid #e3e0d9", fontSize: "14px", lineHeight: "1.4", color: "#3d3c39" }}>
          <span style={{ flex: "1" }}>{v.web.viewOnlyText}</span>
          <button onClick={v.web.signInAdmin} style={{ height: "34px", padding: "0 14px", border: "0", borderRadius: "8px", background: "#1d1d1f", color: "#fff", font: "600 13px 'IBM Plex Sans', sans-serif", whiteSpace: "nowrap" }}>{v.web.t('signInAdmin')}</button>
        </div>
      )}
    </>
  );
}
