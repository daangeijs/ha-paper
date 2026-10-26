// Wi-Fi ok, Home Assistant not linked: linking is the sign-in.
// Markup converted from Main.dc.html (web console section, lines 888–1176).
import type { ConsoleView } from '../useConsole.ts';
import { HaSignIn } from './HaSignIn.tsx';

export function LinkPage({ v }: { v: ConsoleView }) {
  return (
    <>
      <div style={{ flex: "1", display: "flex", alignItems: "center", justifyContent: "center", background: "#F6F5F2" }}>
        <div style={{ width: "460px", boxSizing: "border-box", background: "#fff", border: "1px solid #d3d0c8", borderRadius: "16px", padding: "36px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ fontSize: "26px", fontWeight: "600", letterSpacing: "-0.3px" }}>{v.web.linkTitle}</div>
          <div style={{ fontSize: "15px", lineHeight: "1.5", color: "#3d3c39" }}>{v.web.linkText}</div>
          <HaSignIn v={v} onSignIn={v.web.signIn} />
        </div>
      </div>
    </>
  );
}
