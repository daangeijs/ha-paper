// Link page / setup wizard: the Home Assistant address (#54), the sign-in button and two disclosures (#55).
import type { ConsoleView } from '../useConsole.ts';

const small = { fontSize: "13px", color: "#5c5a55", lineHeight: "1.5" };
const linkBtn = { border: "0", background: "none", padding: "0", font: "inherit", color: "#1d1d1f", textDecoration: "underline", cursor: "pointer" };

export function HaSignIn({ v, onSignIn }: { v: ConsoleView; onSignIn: () => void }) {
  const w = v.web;
  return (
    <>
      {!!(w.haFound) && (<div style={{ fontSize: "14px", color: "#3d3c39" }}>{w.tp('haFound')[0]}<b>{w.haLabel}</b>{w.tp('haFound')[1]} · <button onClick={w.haChange} style={linkBtn}>{w.t('change')}</button></div>)}
      {!!(w.haKnown) && (<div style={{ fontSize: "14px", color: "#3d3c39" }}>{w.tp('haAt')[0]}<b>{w.haLabel}</b>{w.tp('haAt')[1]} · <button onClick={w.haChange} style={linkBtn}>{w.t('change')}</button></div>)}
      {!!(w.haAsk) && (
        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", color: "#5c5a55" }}>{w.t('haAddress')}
          <input value={w.haField} onChange={w.setHaField} onKeyDown={(e) => { if (e.key === 'Enter') onSignIn(); }} aria-describedby="x4-ha-hint" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url"
            style={{ height: "44px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "10px", padding: "0 12px", font: "16px 'IBM Plex Sans', sans-serif" }} />
          <span id="x4-ha-hint">{w.t('haAddressHint')}</span>
        </label>
      )}
      {!!(w.hasHaMsg) && (<div role="alert" style={{ fontSize: "14px", color: "#B3261E", lineHeight: "1.45" }}>{w.haMsg}</div>)}
      <button onClick={onSignIn} style={{ height: "50px", border: "0", borderRadius: "10px", background: "#1d1d1f", color: "#fff", font: "600 16px 'IBM Plex Sans', sans-serif" }}>{w.signLabel}</button>
      <details style={small}>
        <summary style={{ cursor: "pointer", color: "#3d3c39", fontWeight: "500" }}>{w.keyTitle}</summary>
        <div style={{ marginTop: "6px" }}>{w.keyText}</div>
      </details>
      <details style={small}>
        <summary style={{ cursor: "pointer", color: "#3d3c39", fontWeight: "500" }}>{w.advancedTitle}</summary>
        <div style={{ marginTop: "6px" }}>{w.advancedText}</div>
      </details>
    </>
  );
}
