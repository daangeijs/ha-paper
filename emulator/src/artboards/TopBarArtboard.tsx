// Top bar design system artboard (static). Port of the original design artifact TopBar.dc.html.
import { Fragment } from 'react';

const INK = '#111', PAPER = '#ECEBE5';
const ICON = {
  offline: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5v.01M3 3l18 18',
  update: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  alert: 'M12 3l10 18H2zM12 10v4.5M12 17.5v.01',
  sync: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  away: 'M3 11l9-7 9 7M5 10v10h14V10M9.5 15h5',
  night: 'M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z',
  light: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
};
const st = (d: string, label: string) => ({ d, fill: 'none', stroke: INK, label });
const bar = (o: Record<string, unknown>) => ({ hasSub: false, sub: '', icons: [] as unknown[], batt: 76, battLow: false, clock: '17:05', midBg: PAPER, midFg: INK, chev: 'M6 9l6 6 6-6', name: '', caption: '', app: '', page: '', pos: '', ...o });

function renderVals() {
  return {
    anatomy: [bar({ app: 'House', page: 'Heating', hasSub: true, sub: '1 of 2', pos: '1 / 3', icons: [st(ICON.away, 'Away mode')] })],
    examples: [
      bar({ name: 'Resting', caption: 'Nothing to report: the middle stays empty.', app: 'Home', page: 'Home', pos: '1 / 4' }),
      bar({ name: 'Long list', caption: 'Page title carries “1 of 2”; the pager counts pages in the app.', app: 'House', page: 'Lights', hasSub: true, sub: '2 of 3', pos: '4 / 5' }),
      bar({ name: 'Something is off', caption: 'Offline and a command waiting: two quiet icons, nothing blocks.', app: 'Travel', page: 'Travel', pos: '1 / 1', icons: [st(ICON.offline, 'Offline'), st(ICON.sync, 'Sending')] }),
      bar({ name: 'Update + low battery', caption: 'Battery shows its number only under 20%.', app: 'Settings', page: 'Updates', pos: '2 / 2', icons: [st(ICON.update, 'Update ready')], batt: 14, battLow: true }),
      bar({ name: 'Page overview open', caption: 'Middle of the pager is inverted while its overview is shown.', app: 'Home', page: 'All pages', pos: '2 / 4', midBg: INK, midFg: PAPER, icons: [{ d: ICON.night, fill: INK, stroke: 'none', label: 'Night' }, st(ICON.light, 'Front light')] }),
    ],
    rules: [
      { n: '1', title: 'Edges never move.', body: 'App + page (232 px) and the pager (176 px) are fixed, so thumbs and the physical keys always find them.' },
      { n: '2', title: 'Two levels, always named.', body: 'Small caps = the app. Large = the page. Never just one of them.' },
      { n: '3', title: 'Status is icons, never messages.', body: 'Nothing pops up or covers content. Details live on the screen the icon belongs to.' },
      { n: '4', title: 'Built for e-ink.', body: 'No spinners, countdowns or seconds: the bar only redraws when an icon or the minute changes.' },
    ],
    nav: [
      { input: 'Tap app name', does: 'App switcher: Home, Travel, House, Settings.' },
      { input: 'Tap 2 / 4', does: 'Overview of every page in this app, long lists split into parts.' },
      { input: '‹ ›, swipe, keys', does: 'Previous / next page inside the current app; wraps around.' },
      { input: 'Home key', does: 'First page of the Home app; press again for the app switcher.' },
      { input: 'Power', does: 'Standby clock. Any key wakes it.' },
    ],
    icons: [
      { name: 'offline', when: 'Home Assistant unreachable; values are the last known', d: ICON.offline, fill: 'none', stroke: INK },
      { name: 'sync', when: 'A command is on its way (e.g. tado)', d: ICON.sync, fill: 'none', stroke: INK },
      { name: 'update', when: 'New firmware ready (Settings › Updates)', d: ICON.update, fill: 'none', stroke: INK },
      { name: 'alert', when: 'Last update did not finish', d: ICON.alert, fill: 'none', stroke: INK },
      { name: 'away', when: 'Heating is in away mode', d: ICON.away, fill: 'none', stroke: INK },
      { name: 'night', when: 'Peeking during quiet hours (only filled icon)', d: ICON.night, fill: INK, stroke: 'none' },
      { name: 'light', when: 'Front light is on', d: ICON.light, fill: 'none', stroke: INK },
    ],
  };
}

export function TopBarArtboard() {
  const v = renderVals();
  return (
    <>
<div style={{ width: "1340px", height: "1100px", boxSizing: "border-box", padding: "56px", background: "#F4F3EF", color: "#1d1d1f", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", display: "flex", flexDirection: "column", gap: "32px" }}>

  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
    <div style={{ font: "500 13px 'IBM Plex Mono', monospace", letterSpacing: "1px", color: "#5c5a55" }}>HA PAPER · DESIGN SYSTEM · COMPONENT</div>
    <h1 style={{ margin: "0", fontFamily: "'Atkinson Hyperlegible', sans-serif", fontSize: "48px", fontWeight: "700", letterSpacing: "-1px" }}>Top bar</h1>
    <p style={{ margin: "0", fontSize: "18px", lineHeight: "1.5", maxWidth: "900px", color: "#3d3c39" }}>Three fixed zones. Left says which app and page you are on; right moves between pages; the middle is quiet status, icons only. No messages, no pop-ups: nothing ever covers or blocks the screen.</p>
  </div>

  <div style={{ display: "flex", gap: "48px", flex: "1", minHeight: "0" }}>

    {/* LEFT: anatomy + states */}
    <div style={{ width: "800px", flex: "none", display: "flex", flexDirection: "column", gap: "26px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "0.4px", textTransform: "uppercase" }}>Anatomy · 800 × 56 px, 2 px rule below</div>
        <div style={{ position: "relative", height: "128px" }}>
          <div style={{ position: "absolute", left: "0", top: "0", width: "800px" }}>
            {(v.anatomy).map((b: any, i_b: number) => (<Fragment key={i_b}>
              <div style={{ width: "800px", height: "58px", boxSizing: "border-box", borderBottom: "2px solid #111", background: "#ECEBE5", display: "flex", alignItems: "center", gap: "12px", padding: "0 6px", fontFamily: "'Atkinson Hyperlegible', sans-serif", color: "#111" }}>
                <div style={{ width: "232px", flex: "none", display: "flex", flexDirection: "column", gap: "1px", padding: "0 8px", boxSizing: "border-box", minWidth: "0" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "13px", fontWeight: "700", letterSpacing: "1.2px", textTransform: "uppercase", lineHeight: "1.1" }}><svg width="12" height="12" viewBox="0 0 24 24" fill="#111" aria-hidden="true"><rect x="2" y="2" width="8.5" height="8.5" rx="2"></rect><rect x="13.5" y="2" width="8.5" height="8.5" rx="2"></rect><rect x="2" y="13.5" width="8.5" height="8.5" rx="2"></rect><rect x="13.5" y="13.5" width="8.5" height="8.5" rx="2"></rect></svg>{b.app}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: "6px", lineHeight: "1.15", minWidth: "0" }}><span style={{ fontSize: "21px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" }}>{b.page}</span>{!!(b.hasSub) && (<><span style={{ flex: "none", fontSize: "15px", fontWeight: "700", color: "#555" }}>{b.sub}</span></>)}</span>
                </div>
                                <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px" }}>
                  {(b.icons).map((i: any, i_i: number) => (<Fragment key={i_i}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill={i.fill} stroke={i.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={i.label} style={{ flex: "none" }}><path d={i.d}></path></svg>
                  </Fragment>))}
                  <div style={{ display: "flex", alignItems: "center", gap: "4px", flex: "none" }}>
                    {!!(b.battLow) && (<><span style={{ fontSize: "14px", fontWeight: "700" }}>{b.batt}%</span></>)}
                    <div style={{ display: "flex", alignItems: "center" }}><div style={{ width: "26px", height: "13px", border: "2px solid #111", borderRadius: "3px", padding: "1px", boxSizing: "border-box" }}><div style={{ height: "100%", width: `${b.batt}%`, background: "#111" }}></div></div><div style={{ width: "3px", height: "6px", background: "#111" }}></div></div>
                  </div>
                  <div style={{ flex: "none", fontSize: "22px", fontWeight: "700", fontVariantNumeric: "tabular-nums" }}>{b.clock}</div>
                </div>
                                <div style={{ width: "176px", height: "44px", flex: "none", boxSizing: "border-box", border: "2px solid #111", borderRadius: "8px", display: "flex", fontSize: "17px", fontWeight: "700", overflow: "hidden" }}>
                  <span style={{ width: "56px", borderRight: "2px solid #111", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</span>
                  <span style={{ flex: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px", background: b.midBg, color: b.midFg }}><span style={{ fontSize: "16px", lineHeight: "1" }}>{b.pos}</span><span style={{ display: "flex", gap: "2px" }}><span style={{ width: "4px", height: "4px", background: "currentColor" }}></span><span style={{ width: "4px", height: "4px", background: "currentColor" }}></span><span style={{ width: "4px", height: "4px", background: "currentColor" }}></span></span></span>
                  <span style={{ width: "56px", borderLeft: "2px solid #111", display: "flex", alignItems: "center", justifyContent: "center" }}>›</span>
                </div>
              </div>
            </Fragment>))}
          </div>
          <div style={{ position: "absolute", left: "6px", top: "72px", width: "232px", borderTop: "2px solid #1d1d1f", paddingTop: "6px", fontSize: "13px", lineHeight: "1.35" }}><b>① App + page</b> · 232 px, fixed<br />Small caps = app (tap: switch app)<br />Large = page title</div>
          <div style={{ position: "absolute", left: "250px", top: "72px", width: "328px", borderTop: "2px solid #1d1d1f", paddingTop: "6px", fontSize: "13px", lineHeight: "1.35" }}><b>② Status</b> · flexible, right-aligned<br />Icons only · battery · clock</div>
          <div style={{ position: "absolute", left: "618px", top: "72px", width: "176px", borderTop: "2px solid #1d1d1f", paddingTop: "6px", fontSize: "13px", lineHeight: "1.35" }}><b>③ Pages</b> · 176 px, fixed<br />‹ › turn page · middle = all pages</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "0.4px", textTransform: "uppercase" }}>States</div>
        {(v.examples).map((b: any, i_b: number) => (<Fragment key={i_b}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", gap: "10px", alignItems: "baseline" }}><span style={{ fontSize: "15px", fontWeight: "600" }}>{b.name}</span><span style={{ fontSize: "14px", color: "#5c5a55" }}>{b.caption}</span></div>
            <div style={{ width: "800px", height: "58px", boxSizing: "border-box", borderBottom: "2px solid #111", background: "#ECEBE5", display: "flex", alignItems: "center", gap: "12px", padding: "0 6px", fontFamily: "'Atkinson Hyperlegible', sans-serif", color: "#111", boxShadow: "0 0 0 1px #cfccc4" }}>
              <div style={{ width: "232px", flex: "none", display: "flex", flexDirection: "column", gap: "1px", padding: "0 8px", boxSizing: "border-box", minWidth: "0" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "13px", fontWeight: "700", letterSpacing: "1.2px", textTransform: "uppercase", lineHeight: "1.1" }}><svg width="12" height="12" viewBox="0 0 24 24" fill="#111" aria-hidden="true"><rect x="2" y="2" width="8.5" height="8.5" rx="2"></rect><rect x="13.5" y="2" width="8.5" height="8.5" rx="2"></rect><rect x="2" y="13.5" width="8.5" height="8.5" rx="2"></rect><rect x="13.5" y="13.5" width="8.5" height="8.5" rx="2"></rect></svg>{b.app}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={b.chev}></path></svg></span>
                <span style={{ display: "flex", alignItems: "baseline", gap: "6px", lineHeight: "1.15", minWidth: "0" }}><span style={{ fontSize: "21px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" }}>{b.page}</span>{!!(b.hasSub) && (<><span style={{ flex: "none", fontSize: "15px", fontWeight: "700", color: "#555" }}>{b.sub}</span></>)}</span>
              </div>
                            <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px" }}>
                {(b.icons).map((i: any, i_i: number) => (<Fragment key={i_i}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill={i.fill} stroke={i.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={i.label} style={{ flex: "none" }}><path d={i.d}></path></svg>
                </Fragment>))}
                <div style={{ display: "flex", alignItems: "center", gap: "4px", flex: "none" }}>
                  {!!(b.battLow) && (<><span style={{ fontSize: "14px", fontWeight: "700" }}>{b.batt}%</span></>)}
                  <div style={{ display: "flex", alignItems: "center" }}><div style={{ width: "26px", height: "13px", border: "2px solid #111", borderRadius: "3px", padding: "1px", boxSizing: "border-box" }}><div style={{ height: "100%", width: `${b.batt}%`, background: "#111" }}></div></div><div style={{ width: "3px", height: "6px", background: "#111" }}></div></div>
                </div>
                <div style={{ flex: "none", fontSize: "22px", fontWeight: "700", fontVariantNumeric: "tabular-nums" }}>{b.clock}</div>
              </div>
                            <div style={{ width: "176px", height: "44px", flex: "none", boxSizing: "border-box", border: "2px solid #111", borderRadius: "8px", display: "flex", fontSize: "17px", fontWeight: "700", overflow: "hidden" }}>
                <span style={{ width: "56px", borderRight: "2px solid #111", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</span>
                <span style={{ flex: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px", background: b.midBg, color: b.midFg }}><span style={{ fontSize: "16px", lineHeight: "1" }}>{b.pos}</span><span style={{ display: "flex", gap: "2px" }}><span style={{ width: "4px", height: "4px", background: "currentColor" }}></span><span style={{ width: "4px", height: "4px", background: "currentColor" }}></span><span style={{ width: "4px", height: "4px", background: "currentColor" }}></span></span></span>
                <span style={{ width: "56px", borderLeft: "2px solid #111", display: "flex", alignItems: "center", justifyContent: "center" }}>›</span>
              </div>
            </div>
          </div>
        </Fragment>))}
      </div>
    </div>

    {/* RIGHT: rules, navigation, icons */}
    <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "24px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "0.4px", textTransform: "uppercase" }}>Rules</div>
        {(v.rules).map((r: any, i_r: number) => (<Fragment key={i_r}>
          <div style={{ display: "flex", gap: "12px", fontSize: "15px", lineHeight: "1.45" }}><span style={{ flex: "none", width: "22px", height: "22px", borderRadius: "50%", border: "2px solid #1d1d1f", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "600" }}>{r.n}</span><span><b>{r.title}</b> {r.body}</span></div>
        </Fragment>))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "0.4px", textTransform: "uppercase" }}>Navigation · apps contain pages</div>
        {(v.nav).map((n: any, i_n: number) => (<Fragment key={i_n}>
          <div style={{ display: "flex", gap: "12px", padding: "6px 0", borderTop: "1px solid #d3d0c8", fontSize: "14px", lineHeight: "1.4" }}>
            <span style={{ width: "120px", flex: "none", fontWeight: "600" }}>{n.input}</span>
            <span style={{ flex: "1", minWidth: "0", color: "#3d3c39" }}>{n.does}</span>
          </div>
        </Fragment>))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><div style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "0.4px", textTransform: "uppercase" }}>Status icons</div><div style={{ font: "500 12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>24 grid · 20 px · 2 px stroke</div></div>
        {(v.icons).map((i: any, i_i: number) => (<Fragment key={i_i}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "4px 0", borderTop: "1px solid #d3d0c8" }}>
            <div style={{ width: "34px", height: "34px", flex: "none", borderRadius: "8px", background: "#ECEBE5", border: "1px solid #c9c6be", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill={i.fill} stroke={i.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={i.d}></path></svg></div>
            <div style={{ width: "70px", flex: "none", font: "500 13px 'IBM Plex Mono', monospace" }}>{i.name}</div>
            <div style={{ flex: "1", minWidth: "0", fontSize: "14px", color: "#3d3c39" }}>{i.when}</div>
          </div>
        </Fragment>))}
      </div>
    </div>
  </div>
</div>
    </>
  );
}
