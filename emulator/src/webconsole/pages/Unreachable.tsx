// Display not on the network yet: the browser shows "This site can’t be reached".
// Markup converted from Main.dc.html (web console section, lines 888–1176).
import type { ConsoleView } from '../useConsole.ts';

export function Unreachable({ v }: { v: ConsoleView }) {
  return (
    <>
      <div style={{ flex: "1", display: "flex", alignItems: "center", justifyContent: "center", background: "#fff" }}>
        <div style={{ width: "520px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#8d8a83" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5v.01M3 3l18 18"></path></svg>
          <div style={{ fontSize: "26px", fontWeight: "600", color: "#3d3c39" }}>This site can’t be reached</div>
          <div style={{ font: "14px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>{v.web.hostname} · DNS_PROBE_FINISHED_NXDOMAIN</div>
          <div style={{ fontSize: "15px", lineHeight: "1.55", color: "#3d3c39" }}>The display isn’t on your network yet. Connect it to Wi-Fi first, on the display itself. Then reload this page on a phone or computer on the same Wi-Fi.</div>
          <div style={{ fontSize: "13px", color: "#5c5a55", lineHeight: "1.5" }}>No keyboard wanted? On the display choose “Set up from phone”, join the Wi-Fi “HA-Paper-Setup” and open 192.168.4.1.</div>
          <button onClick={v.web.reload} style={{ alignSelf: "flex-start", height: "40px", padding: "0 18px", border: "1px solid #c9c6be", borderRadius: "20px", background: "#fff", font: "500 14px 'IBM Plex Sans', sans-serif" }}>Reload</button>
        </div>
      </div>
    </>
  );
}
