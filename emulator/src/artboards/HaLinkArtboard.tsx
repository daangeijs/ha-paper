// Home Assistant phone-link flow artboard (static). Port of the original design artifact HaLink.dc.html.
import { Fragment } from 'react';

const who = (w: string) => ({ who: w, bg: w === 'Display' ? '#1d1d1f' : '#fff', fg: w === 'Display' ? '#fff' : '#1d1d1f' });
function renderVals() {
  return {
    steps: [
      { n: '1', ...who('Display'), what: 'Shows a QR code and a 4-character pairing code (single use, 10 min).', tech: 'QR → http://ha-paper-a1b2.local/link?p=4F7K' },
      { n: '2', ...who('Display'), what: 'Phone opens the setup page; display finds Home Assistant on the network.', tech: 'mDNS _home-assistant._tcp → homeassistant.local:8123' },
      { n: '3', ...who('Phone'), what: 'Continue sends the phone to Home Assistant’s sign-in page.', tech: 'GET /auth/authorize?client_id=http://ha-paper-a1b2.local/&redirect_uri=http://ha-paper-a1b2.local/auth/callback&state=<random>' },
      { n: '4', ...who('HA'), what: 'You sign in, with two-factor if enabled.', tech: 'Home Assistant’s own login flow' },
      { n: '5', ...who('HA'), what: 'Home Assistant sends the phone back to the display with a one-time code.', tech: '302 → /auth/callback?code=…&state=<random>  (display checks state)' },
      { n: '6', ...who('Display'), what: 'Display swaps the code for its own key, directly with Home Assistant.', tech: 'POST /auth/token grant_type=authorization_code&code=…&client_id=http://ha-paper-a1b2.local/ → access_token (30 min) + refresh_token' },
      { n: '7', ...who('Display'), what: 'Stores the key encrypted and connects for live data.', tech: 'refresh_token → encrypted NVS · /api/websocket auth with access_token' },
      { n: '8', ...who('Display'), what: 'Renews itself every ~30 min. If you revoke it, shows “Key revoked” and asks to re-link.', tech: 'POST /auth/token grant_type=refresh_token … · 400 invalid_grant → re-link' },
    ],
  };
}

export function HaLinkArtboard() {
  const v = renderVals();
  return (
    <>
<div style={{ width: "1600px", height: "920px", boxSizing: "border-box", padding: "48px 56px", background: "#F4F3EF", color: "#1d1d1f", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", display: "flex", flexDirection: "column", gap: "28px" }}>
  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
    <div style={{ font: "500 13px 'IBM Plex Mono', monospace", letterSpacing: "1px", color: "#5c5a55" }}>HA PAPER · FLOW</div>
    <h1 style={{ margin: "0", fontFamily: "'Atkinson Hyperlegible', sans-serif", fontSize: "44px", fontWeight: "700", letterSpacing: "-1px" }}>Linking Home Assistant with your phone</h1>
    <p style={{ margin: "0", fontSize: "17px", color: "#3d3c39", maxWidth: "980px", lineHeight: "1.5" }}>Scan, sign in to Home Assistant on the phone, done. Home Assistant hands a one-time code back to the display, which swaps it for its own key. Nobody types or copies a token.</p>
  </div>

  <div style={{ flex: "1", minHeight: "0", display: "flex", gap: "48px" }}>
    {/* phones */}
    <div style={{ display: "flex", gap: "28px", flex: "none" }}>

      {/* phone 1 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "300px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600" }}>① Setup page on the display</div>
        <div style={{ width: "300px", height: "620px", boxSizing: "border-box", border: "10px solid #1d1d1f", borderRadius: "36px", background: "#fff", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ height: "36px", flex: "none", background: "#f0efeb", display: "flex", alignItems: "center", justifyContent: "center", font: "500 11px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>ha-paper-a1b2.local/link?p=4F7K</div>
          <div style={{ flex: "1", padding: "22px 20px", display: "flex", flexDirection: "column", gap: "14px", fontFamily: "'Atkinson Hyperlegible', sans-serif" }}>
            <div style={{ fontSize: "24px", fontWeight: "700", lineHeight: "1.15" }}>Link your display to Home Assistant</div>
            <div style={{ border: "2px solid #1d1d1f", borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "13px", color: "#5c5a55" }}>Pairing code</span>
              <span style={{ fontSize: "28px", fontWeight: "700", letterSpacing: "6px" }}>4F7K</span>
              <span style={{ fontSize: "13px", color: "#5c5a55" }}>Same as on the display? Then continue.</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: "700", letterSpacing: "0.6px", color: "#5c5a55" }}>HOME ASSISTANT</span>
              <label style={{ display: "flex", alignItems: "center", gap: "10px", border: "2px solid #1d1d1f", borderRadius: "10px", padding: "10px 12px", fontSize: "15px" }}><input type="radio" name="ha" checked style={{ width: "18px", height: "18px", margin: "0" }} /><span><b>homeassistant.local:8123</b><br /><span style={{ fontSize: "13px", color: "#5c5a55" }}>Found on your network</span></span></label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "#5c5a55" }}>Or another address
                <input placeholder="https://[YOUR-HA-ADDRESS]" style={{ height: "40px", boxSizing: "border-box", border: "1px solid #a8a49b", borderRadius: "8px", padding: "0 10px", font: "15px 'Atkinson Hyperlegible', sans-serif" }} />
              </label>
            </div>
            <div style={{ flex: "1" }}></div>
            <div style={{ fontSize: "13px", color: "#5c5a55", lineHeight: "1.4" }}>Sign in with your own account. The display keeps a key with that account’s Home Assistant rights.</div>
            <button style={{ height: "50px", border: "0", borderRadius: "12px", background: "#1d1d1f", color: "#fff", font: "700 16px 'Atkinson Hyperlegible', sans-serif" }}>Continue to Home Assistant</button>
          </div>
        </div>
      </div>

      {/* phone 2 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "300px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600" }}>② Home Assistant’s own sign-in</div>
        <div style={{ width: "300px", height: "620px", boxSizing: "border-box", border: "10px solid #1d1d1f", borderRadius: "36px", background: "#fff", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ height: "36px", flex: "none", background: "#f0efeb", display: "flex", alignItems: "center", justifyContent: "center", font: "500 11px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>homeassistant.local:8123/auth/authorize…</div>
          <div style={{ flex: "1", padding: "22px 20px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ border: "2px dashed #a8a49b", borderRadius: "10px", padding: "12px", fontSize: "13px", color: "#5c5a55", lineHeight: "1.4", textAlign: "center" }}>Placeholder: this page is served by your Home Assistant, not by HA Paper. Shown as a wireframe.</div>
            <div style={{ height: "22px", width: "70%", background: "#e4e2dc", borderRadius: "4px" }}></div>
            <div style={{ height: "14px", width: "90%", background: "#eceae4", borderRadius: "4px" }}></div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" }}><span style={{ fontSize: "13px", color: "#5c5a55" }}>Username</span><div style={{ height: "42px", border: "1px solid #c9c6be", borderRadius: "8px" }}></div></div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "13px", color: "#5c5a55" }}>Password</span><div style={{ height: "42px", border: "1px solid #c9c6be", borderRadius: "8px" }}></div></div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "13px", color: "#5c5a55" }}>Two-factor code (if on)</span><div style={{ height: "42px", border: "1px solid #c9c6be", borderRadius: "8px" }}></div></div>
            <div style={{ flex: "1" }}></div>
            <div style={{ height: "48px", borderRadius: "12px", background: "#d6d3cb" }}></div>
            <div style={{ fontSize: "13px", color: "#3d3c39", lineHeight: "1.4", textAlign: "center" }}><b>The display never sees your password.</b></div>
          </div>
        </div>
      </div>

      {/* phone 3 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "300px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600" }}>③ Back on the display’s page</div>
        <div style={{ width: "300px", height: "620px", boxSizing: "border-box", border: "10px solid #1d1d1f", borderRadius: "36px", background: "#fff", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ height: "36px", flex: "none", background: "#f0efeb", display: "flex", alignItems: "center", justifyContent: "center", font: "500 11px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>ha-paper-a1b2.local/auth/callback</div>
          <div style={{ flex: "1", padding: "22px 20px", display: "flex", flexDirection: "column", gap: "14px", fontFamily: "'Atkinson Hyperlegible', sans-serif" }}>
            <div style={{ width: "64px", height: "64px", borderRadius: "50%", background: "#1d1d1f", display: "flex", alignItems: "center", justifyContent: "center", marginTop: "30px" }}><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"></path></svg></div>
            <div style={{ fontSize: "26px", fontWeight: "700", lineHeight: "1.15" }}>Linked</div>
            <div style={{ fontSize: "16px", lineHeight: "1.45" }}>Living room display is signed in to Home Assistant as <b>X4 display</b>.</div>
            <div style={{ fontSize: "15px", color: "#5c5a55", lineHeight: "1.45" }}>You can close this page. The display updates in a few seconds.</div>
            <div style={{ flex: "1" }}></div>
            <div style={{ borderTop: "1px solid #e0ddd6", paddingTop: "12px", fontSize: "13px", color: "#5c5a55", lineHeight: "1.45" }}>To remove access later: Home Assistant › your profile › Security › Refresh tokens.</div>
          </div>
        </div>
      </div>
    </div>

    {/* sequence */}
    <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "0.4px", textTransform: "uppercase" }}>What happens, for the firmware</div>
      {(v.steps).map((s: any, i_s: number) => (<Fragment key={i_s}>
        <div style={{ display: "flex", gap: "12px", padding: "7px 0", borderTop: "1px solid #d3d0c8" }}>
          <span style={{ flex: "none", width: "22px", font: "500 13px 'IBM Plex Mono', monospace", color: "#5c5a55", paddingTop: "2px" }}>{s.n}</span>
          <span style={{ flex: "none", width: "78px", height: "22px", boxSizing: "border-box", border: "1.5px solid #1d1d1f", borderRadius: "11px", background: s.bg, color: s.fg, fontSize: "12px", fontWeight: "600", display: "flex", alignItems: "center", justifyContent: "center" }}>{s.who}</span>
          <span style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "2px" }}>
            <span style={{ fontSize: "14px", lineHeight: "1.4" }}>{s.what}</span>
            <span style={{ font: "12px/1.45 'IBM Plex Mono', monospace", color: "#5c5a55", wordBreak: "break-all" }}>{s.tech}</span>
          </span>
        </div>
      </Fragment>))}
      <div style={{ marginTop: "6px", border: "1.5px solid #1d1d1f", borderRadius: "10px", padding: "12px 14px", fontSize: "14px", lineHeight: "1.5", background: "#fff" }}>
        <b>Keep the client ID stable.</b> Use the hostname <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>http://ha-paper-a1b2.local/</span>, never the IP address: the key only renews with the same client ID, and the IP can change. Because the return address is on that same host, Home Assistant accepts it without extra checks.
      </div>
    </div>
  </div>
</div>
    </>
  );
}
