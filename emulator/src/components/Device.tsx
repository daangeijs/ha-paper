// Device: hardware frame (keys) + the 800 × 480 e-ink screen (boot, main UI, night, standby, OTA overlays).
// Markup converted mechanically from Main.dc.html lines 29–769 (RECREATE.md Option C mapping).
import { Fragment, type CSSProperties } from 'react';
import type { Vals } from '../emulator/Emulator.tsx';
import { HOST, SIM_IP } from '../core/data.ts';
import { currency } from '../core/locale.ts';
import { fitMiddle } from '../core/format.ts';
import { TRACK, TRACK_PAINT } from '../core/panel.ts';

/** No value in Home Assistant (unavailable / unknown, #86): a 28 px ring, bottom on the value's baseline. */
const GapRing = () => <span aria-hidden="true" style={{ flex: "none", display: "inline-block", width: "28px", height: "28px", border: "3px solid #111", borderRadius: "50%", boxSizing: "border-box" }} />;

/** OTA version line (#215): core fitMiddle over the firmware's size steps; width estimated at 0.6 em per codepoint
 *  for bold sans (the firmware measures its glyphs). */
const updVersion = (s: string) => fitMiddle(s, [28, 24, 20, 18], 720, (t, size) => [...t].length * size * 0.6);

export function Device({ v }: { v: Vals }) {
  return (
    <>
    {/* DEVICE */}
    <div style={{ position: "relative", width: "908px", height: "612px" }}>
      <button className="hw" aria-label="Power" onClick={v.hwPower} style={{ position: "absolute", left: "70px", top: "0", width: "72px", height: "22px", background: "none", border: "0", padding: "0", display: "flex", alignItems: "flex-end" }}><span style={{ display: "block", width: "100%", height: "8px", borderRadius: "4px 4px 0 0", background: "#3b3b3e" }}></span></button>
      <button className="hw" aria-label="Previous page" onClick={v.hwPrev} style={{ position: "absolute", left: "640px", top: "0", width: "76px", height: "22px", background: "none", border: "0", padding: "0", display: "flex", alignItems: "flex-end" }}><span style={{ display: "block", width: "100%", height: "8px", borderRadius: "4px 4px 0 0", background: "#3b3b3e" }}></span></button>
      <button className="hw" aria-label="Next page" onClick={v.hwNext} style={{ position: "absolute", left: "726px", top: "0", width: "76px", height: "22px", background: "none", border: "0", padding: "0", display: "flex", alignItems: "flex-end" }}><span style={{ display: "block", width: "100%", height: "8px", borderRadius: "4px 4px 0 0", background: "#3b3b3e" }}></span></button>
      <div style={{ position: "absolute", left: "70px", top: "-18px", width: "72px", textAlign: "center", font: "500 11px 'IBM Plex Mono', monospace", color: "#555" }}>POWER</div>
      <div style={{ position: "absolute", left: "640px", top: "-18px", width: "76px", textAlign: "center", font: "500 11px 'IBM Plex Mono', monospace", color: "#555" }}>PREV</div>
      <div style={{ position: "absolute", left: "726px", top: "-18px", width: "76px", textAlign: "center", font: "500 11px 'IBM Plex Mono', monospace", color: "#555" }}>NEXT</div>

      <div style={{ position: "absolute", left: "0", top: "14px", width: "900px", height: "590px", borderRadius: "30px", background: v.bodyColor, boxShadow: "0 1px 0 rgba(255,255,255,.08) inset, 0 24px 48px rgba(0,0,0,.22), 0 4px 10px rgba(0,0,0,.18)" }}>
        <button aria-label="Home" onClick={v.hwHome} style={{ position: "absolute", left: "852px", top: "273px", width: "44px", height: "44px", borderRadius: "50%", background: "none", border: "0", padding: "0", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ display: "block", width: "18px", height: "18px", borderRadius: "50%", border: `2px solid ${v.keyColor}` }}></span>
        </button>
        <button aria-label="Reset" onClick={v.hwReset} style={{ position: "absolute", left: "30px", top: "552px", width: "44px", height: "32px", background: "none", border: "0", padding: "0", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ display: "block", width: "6px", height: "6px", borderRadius: "50%", background: "#0c0c0c", boxShadow: `0 0 0 1px ${v.keyColor}` }}></span>
        </button>

        {/* SCREEN 800x480 */}
        <div style={{ position: "absolute", left: "50px", top: "55px", width: "800px", height: "480px", overflow: "hidden", borderRadius: "3px", background: "#ECEBE5", boxShadow: "0 0 0 2px rgba(0,0,0,.35)" }}>
          {/* Panel preview (#25, core/panel.ts): gray everywhere, B/W (gray1 → ink, gray2 → paper) inside the areas a partial
              refresh redrew since the last full refresh. The flood rects mask the thresholded copy. */}
          <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
            {/* B/W-safe paint for SVG strokes (core/panel.ts TRACK_PAINT; firmware Tone::Track) */}
            <pattern id="x4-track" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#ECEBE5" /><rect width="1" height="1" fill="#111" /></pattern>
            <filter id="x4-panel-bw" filterUnits="userSpaceOnUse" x="0" y="0" width="800" height="480" colorInterpolationFilters="sRGB">
              <feColorMatrix in="SourceGraphic" type="saturate" values="0" result="gray" />
              <feComponentTransfer in="gray" result="bw">
                <feFuncR type="discrete" tableValues="0.0667 0.92" />
                <feFuncG type="discrete" tableValues="0.0667 0.92" />
                <feFuncB type="discrete" tableValues="0.0667 0.92" />
              </feComponentTransfer>
              {(v.bwRects).map((r: any, i_r: number) => (<feFlood key={i_r} x={r.x} y={r.y} width={r.w} height={r.h} floodColor="#fff" result={"m" + i_r} />))}
              <feMerge result="mask">{(v.bwRects).map((_r: any, i_r: number) => (<feMergeNode key={i_r} in={"m" + i_r} />))}</feMerge>
              <feComposite in="bw" in2="mask" operator="in" result="bwm" />
              <feMerge><feMergeNode in="gray" /><feMergeNode in="bwm" /></feMerge>
            </filter>
          </svg>
          <div data-x4-screen="" className={v.lookClass + v.regionsClass} onPointerDownCapture={v.ambientDown} onClickCapture={v.ambientClick} onPointerDown={v.markInput} style={{ position: "absolute", inset: "0", color: "#111", fontFamily: v.screenFont, "--fd": v.fontD, "--fs": v.fontS, "--fk": v.fontK, filter: v.screenFilter } as CSSProperties}>

            {/* BOOT */}
            {!!(v.isBoot) && (<>
              <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "18px" }}>
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"></path><path d="M5 10v10h14V10"></path><path d="M10 20v-6h4v6"></path></svg>
                <div className="num" style={{ fontSize: "44px", fontWeight: "700", letterSpacing: "-0.5px" }}>{v.osName}</div>
                <div style={{ fontSize: "18px", color: "#555" }}>{v.bootMsg}</div>
              </div>
            </>)}

            {/* MAIN UI */}
            {!!(v.isMain) && (<>
              <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                {/* top bar (58px incl. rule) */}
                {!!(v.isClassic) && (<>
                <div style={{ position: "relative", height: "56px", flex: "none", display: "flex", alignItems: "center", gap: "12px", padding: "0 6px", borderBottom: "2px solid #111" }}>
                  {/* zone 1: app (switch apps) + page title (fixed 232) */}
                  <button className="ink-btn" aria-label="Switch app" onClick={v.toggleApps} style={{ flex: "none", width: "232px", minWidth: "0", height: "50px", border: "0", background: "#ECEBE5", borderRadius: "8px", padding: "0 8px", display: "flex", flexDirection: "column", justifyContent: "center", gap: "1px", textAlign: "left" }}>
                    {!!(v.chromeApp) && (<>
                    <span style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "20px", fontWeight: "700", letterSpacing: "1px", textTransform: "uppercase", lineHeight: "1.1" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flex: "none" }}><rect x="2" y="2" width="8.5" height="8.5" rx="2"></rect><rect x="13.5" y="2" width="8.5" height="8.5" rx="2"></rect><rect x="2" y="13.5" width="8.5" height="8.5" rx="2"></rect><rect x="13.5" y="13.5" width="8.5" height="8.5" rx="2"></rect></svg>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.appTitle}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}><path d={v.chevronPath}></path></svg>
                    </span>
                    </>)}
                    <span style={{ display: "flex", alignItems: "baseline", gap: "6px", minWidth: "0", width: "100%", lineHeight: "1.15" }}>
                      <span style={{ fontSize: "21px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" }}>{v.pageTitle}</span>
                      {!!(v.hasSub) && (<>
                        <span style={{ flex: "none", fontSize: "18px", fontWeight: "700", color: "#111", whiteSpace: "nowrap" }}>{v.subText}</span>
                      </>)}
                    </span>
                  </button>
                  {/* zone 2: unified status & notification bar */}
                  <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "center", gap: "10px" }}>
                    <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "center" }}>
                      {!!(v.note.isPill) && (<>
                        <button className="ink-btn" onClick={v.note.go} style={{ maxWidth: "100%", height: "36px", boxSizing: "border-box", padding: "0 12px 0 8px", border: "2px solid #111", borderRadius: "18px", background: v.note.bg, color: v.note.fg, display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "15px", fontWeight: "700", whiteSpace: "nowrap", minWidth: "0" }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}><path d={v.note.icon}></path></svg>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" }}>{v.note.text}</span>
                          {!!(v.note.hasMore) && (<><span style={{ flex: "none", fontSize: "13px", opacity: "0.75" }}>{v.note.more}</span></>)}
                        </button>
                      </>)}
                    </div>
                    {(v.statusIcons).map((i: any, i_i: number) => (<Fragment key={i_i}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill={i.fill} stroke={i.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={i.label} style={{ flex: "none" }}><path d={i.d}></path></svg>
                      {!!(i.text) && (<span aria-hidden="true" style={{ flex: "none", marginLeft: "-4px", fontSize: "18px", fontWeight: "400" }}>{i.text}</span>)}
                    </Fragment>))}
                    {!!(v.chromeBatt) && (<div style={{ display: "flex", alignItems: "center", gap: "4px", flex: "none" }}>
                      {!!(v.battLow) && (<><span style={{ fontSize: "18px", fontWeight: "700" }}>{v.devBatt}%</span></>)}
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <div style={{ width: "26px", height: "13px", border: "2px solid #111", borderRadius: "3px", padding: "1px", boxSizing: "border-box" }}><div style={{ height: "100%", width: `${v.devBatt}%`, background: "#111" }}></div></div>
                        <div style={{ width: "3px", height: "6px", background: "#111", borderRadius: "0 1px 1px 0" }}></div>
                      </div>
                    </div>)}
                    {!!(v.chromeClock) && (<div style={{ position: "relative", flex: "none", fontSize: "22px", fontWeight: "700", fontVariantNumeric: "tabular-nums" }}>{v.clock}{!!(v.timeDirty) && (<><div className="dirty"></div></>)}</div>)}
                  </div>
                  {/* zone 3: page navigation (fixed 176); hidden in ambient (#27) */}
                  {!!(v.chromePager) && (<div style={{ flex: "none", width: "176px", height: "44px", display: "flex", border: "2px solid #111", borderRadius: "8px", overflow: "hidden" }}>
                    <button className="ink-btn" aria-label="Previous page" onClick={v.tapPrev} style={{ width: "56px", border: "0", borderRight: "2px solid #111", background: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg></button>
                    <button className="ink-btn" aria-label="All pages in this app" onClick={v.togglePages} style={{ flex: "1", minWidth: "0", border: "0", background: v.pagesBg, color: v.pagesFg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px", padding: "0" }}>
                      <span style={{ fontSize: "18px", fontWeight: "700", fontVariantNumeric: "tabular-nums", lineHeight: "1" }}>{v.pageText}</span>
                      <span style={{ display: "flex", gap: "2px" }} aria-hidden="true"><span style={{ width: "4px", height: "4px", background: "currentColor", borderRadius: "1px" }}></span><span style={{ width: "4px", height: "4px", background: "currentColor", borderRadius: "1px" }}></span><span style={{ width: "4px", height: "4px", background: "currentColor", borderRadius: "1px" }}></span></span>
                    </button>
                    <button className="ink-btn" aria-label="Next page" onClick={v.tapNext} style={{ width: "56px", border: "0", borderLeft: "2px solid #111", background: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg></button>
                  </div>)}
                  {!!(v.barDirty) && (<><div className="dirty"></div></>)}
                </div>
                </>)}
                {/* sleek top bar: no rule, big title, page dots */}
                {!!(v.isSleek) && (<>
                <div style={{ position: "relative", height: "64px", flex: "none", display: "flex", alignItems: "center", gap: "12px", padding: "0 12px 0 6px" }}>
                  <button className="ink-btn" aria-label="Switch app" onClick={v.toggleApps} style={{ flex: "none", width: "250px", minWidth: "0", height: "56px", border: "0", background: "transparent", borderRadius: "14px", padding: "0 10px", display: "flex", flexDirection: "column", justifyContent: "center", gap: "1px", textAlign: "left" }}>
                    {!!(v.chromeApp) && (<>
                    <span style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "13px", fontWeight: "600", color: "#111", lineHeight: "1.2" }}>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.appTitle}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}><path d={v.chevronPath} /></svg>
                    </span>
                    </>)}
                    <span style={{ display: "flex", alignItems: "baseline", gap: "8px", minWidth: "0", width: "100%" }}>
                      <span style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(27px * var(--fk))", fontWeight: "700", letterSpacing: "-0.3px", lineHeight: "1.05", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" }}>{v.pageTitle}</span>
                      {!!(v.hasSub) && (<>
                        <span style={{ flex: "none", fontSize: "14px", fontWeight: "600", color: "#111", whiteSpace: "nowrap" }}>{v.subText}</span>
                      </>)}
                    </span>
                  </button>
                  <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "center", gap: "10px" }}>
                    <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "center" }}>
                      {!!(v.note.isPill) && (<>
                        <button className="ink-btn" onClick={v.note.go} style={{ maxWidth: "100%", height: "38px", boxSizing: "border-box", padding: "0 14px 0 10px", border: "2px solid #111", borderRadius: "19px", background: v.note.bg, color: v.note.fg, display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "15px", fontWeight: "600", whiteSpace: "nowrap", minWidth: "0" }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}><path d={v.note.icon} /></svg>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" }}>{v.note.text}</span>
                          {!!(v.note.hasMore) && (<><span style={{ flex: "none", fontSize: "13px", opacity: "0.75" }}>{v.note.more}</span></>)}
                        </button>
                      </>)}
                    </div>
                    {(v.statusIcons).map((i: any, i_i: number) => (<Fragment key={i_i}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill={i.fill} stroke={i.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={i.label} style={{ flex: "none" }}><path d={i.d} /></svg>
                      {!!(i.text) && (<span aria-hidden="true" style={{ flex: "none", marginLeft: "-4px", fontSize: "14px", fontWeight: "400" }}>{i.text}</span>)}
                    </Fragment>))}
                    {!!(v.chromeBatt) && (<div style={{ display: "flex", alignItems: "center", gap: "4px", flex: "none" }}>
                      {!!(v.battLow) && (<><span style={{ fontSize: "14px", fontWeight: "700" }}>{v.devBatt}%</span></>)}
                      <div style={{ width: "24px", height: "12px", borderRadius: "4px", background: TRACK, overflow: "hidden" }}><div style={{ height: "100%", width: `${v.devBatt}%`, background: "#111" }}></div></div>
                    </div>)}
                    {!!(v.chromeClock) && (<div style={{ position: "relative", flex: "none", fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(24px * var(--fk))", fontWeight: "700", fontVariantNumeric: "tabular-nums" }}>{v.clock}{!!(v.timeDirty) && (<><div className="dirty"></div></>)}</div>)}
                  </div>
                  {!!(v.chromePager) && (<div style={{ flex: "none", height: "52px", boxSizing: "border-box", padding: "4px", borderRadius: "26px", background: "#DEDCD5", display: "flex", alignItems: "center", gap: "2px" }}>
                    <button className="ink-btn" aria-label="Previous page" onClick={v.tapPrev} style={{ width: "44px", height: "44px", border: "0", borderRadius: "50%", background: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg></button>
                    <button className="ink-btn" aria-label={`All pages in this app, ${v.pageText}`} onClick={v.togglePages} style={{ height: "44px", minWidth: "52px", padding: "0 10px", border: "0", borderRadius: "22px", background: v.pagesBgS, display: "flex", alignItems: "center", justifyContent: "center", gap: "5px" }}>
                      {(v.pageDots).map((pd: any, i_pd: number) => (<Fragment key={i_pd}><span style={{ flex: "none", width: `${pd.w}px`, height: "8px", borderRadius: "4px", background: pd.c }}></span></Fragment>))}
                    </button>
                    <button className="ink-btn" aria-label="Next page" onClick={v.tapNext} style={{ width: "44px", height: "44px", border: "0", borderRadius: "50%", background: "#111", color: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg></button>
                  </div>)}
                  {!!(v.barDirty) && (<><div className="dirty"></div></>)}
                </div>
                </>)}

                {/* APP SWITCHER / PAGE OVERVIEW */}
                {!!(v.isMenu) && (<>
                  <div style={{ flex: "1", minHeight: "0", padding: "14px", display: "flex", flexDirection: "column", gap: "10px", overflow: "hidden" }}>
                    <div className="lbl" style={{ fontSize: "20px", fontWeight: "700", letterSpacing: "1px", textTransform: "uppercase", color: "#111" }}>{v.menuHeading}</div>
                    <div style={{ flex: "1", minHeight: "0", display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridAutoRows: "132px", gap: "12px" }}>
                      {(v.menuItems).map((m: any, i_m: number) => (<Fragment key={i_m}>
                        <button className="ink-btn" onClick={m.go} style={{ boxSizing: "border-box", border: m.border, borderRadius: v.menuRadius, background: v.menuBg, padding: "12px 14px", textAlign: "left", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", fontSize: "20px", fontWeight: "700", color: "#111" }}>
                            {!!(m.hasIcon) && (<><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={m.icon}></path></svg></>)}
                            {!!(m.noIcon) && (<><span>{m.num}</span></>)}
                            <span>{m.pages}</span>
                          </span>
                          <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <span className="num" style={{ fontSize: "26px", fontWeight: "700", lineHeight: "30px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.title}</span>
                            <span style={{ fontSize: "18px", lineHeight: "22px", color: "#111", display: "-webkit-box", WebkitLineClamp: m.descLines, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.desc}</span>
                          </span>
                        </button>
                      </Fragment>))}
                    </div>
                  </div>
                </>)}

                {/* widget grid */}
                {!!(v.isGrid) && (<>
                <div onPointerDown={v.swipeStart} onPointerUp={v.swipeEnd} style={{ position: "relative", flex: "1", minHeight: "0", padding: v.gridPad, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))", gap: v.gridGap, touchAction: "pan-y", userSelect: "none" }}>
                  {!!(v.isEmpty) && (<>
                    <div style={{ gridColumn: "span 4", gridRow: "span 2", border: "2px dotted #111", borderRadius: "10px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px", color: "#111" }}>
                      <div style={{ fontSize: "24px", fontWeight: "700", color: "#111" }}>{v.t('emptyScreen')}</div>
                      <div style={{ fontSize: "17px" }}>{v.emptyHint}</div>
                    </div>
                  </>)}
                  {(v.widgets).map((w: any, i_w: number) => (<Fragment key={i_w}>
                    <div style={{ position: "relative", gridColumn: w.col ? `${w.col} / span ${w.cs}` : `span ${w.cs}`, gridRow: w.row ? `${w.row} / span ${w.rs}` : `span ${w.rs}`, minWidth: "0", minHeight: "0", boxSizing: "border-box", border: w.border, borderRadius: `${w.radius}px`, overflow: "hidden", display: "flex", flexDirection: "column", background: w.bg, color: w.fg }} className="tile">

                      {/* ===== SLEEK CARDS (Display style ≠ Classic) ===== */}
                      {/* sleek stat: icon badge, display numeral, 24 h spark */}
                      {!!(w.sStat) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "14px 16px 12px", display: "flex", flexDirection: "column", gap: "4px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "0" }}>
                            <span style={{ flex: "none", width: "30px", height: "30px", borderRadius: "50%", background: "#111", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#ECEBE5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={w.icon} /></svg></span>
                            <span style={{ fontSize: "16px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.label}</span>
                          </div>
                          <div style={{ flex: "1" }}></div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px", fontFamily: "var(--fd)", fontStretch: "var(--fs)" }}>
                            {w.gap ? <GapRing /> : <span style={{ fontSize: `calc(${w.vs}px * var(--fk))`, fontWeight: "700", lineHeight: "0.9", letterSpacing: "-1px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{w.value}</span>}
                            <span style={{ fontSize: "20px", fontWeight: "600" }}>{w.unit}</span>
                          </div>
                          {!!(w.hasSpark) && (<>
                            <div style={{ height: "22px", flex: "none", display: "flex", alignItems: "flex-end", gap: "2px", marginTop: "4px" }} aria-hidden="true">
                              {(w.spark).map((b: any, i_b: number) => (<Fragment key={i_b}>
                                <div style={{ flex: "1", height: `${b.h}%`, background: b.c, borderRadius: "2px" }}></div>
                              </Fragment>))}
                            </div>
                          </>)}
                          <div style={{ fontSize: "14px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sub}</div>
                        </div>
                      </>)}

                      {/* sleek clock: inverted hero card with day progress */}
                      {!!(w.sClock) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "16px 20px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "16px", fontWeight: "600", color: "#ECEBE5" }}><span>{v.weekday}</span><span>{v.dayMonth}</span></div>
                          <div style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: `calc(${w.big}px * var(--fk))`, fontWeight: "700", lineHeight: "0.82", letterSpacing: "-3px", fontVariantNumeric: "tabular-nums" }}>{v.clock}</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                            <div style={{ height: "6px", borderRadius: "3px", background: "linear-gradient(#ECEBE5, #ECEBE5) 0 2px / 100% 2px no-repeat", overflow: "hidden" }}><div style={{ width: `${w.dayPct}%`, height: "100%", background: "#ECEBE5", borderRadius: "3px" }}></div></div>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#ECEBE5", fontVariantNumeric: "tabular-nums" }}><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
                          </div>
                        </div>
                        {!!(w.clockDirty) && (<><div className="dirty" style={{ top: "40px" }}></div></>)}
                      </>)}

                      {/* sleek price: big number + 24 h price strip */}
                      {!!(w.sPrice) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "14px 16px 12px", display: "flex", flexDirection: "column", gap: "6px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                            <span style={{ fontSize: "16px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sLabel}</span>
                            <span style={{ flex: "none", height: "26px", padding: "0 10px", borderRadius: "13px", background: w.chipBg, color: w.chipFg, fontSize: "13px", fontWeight: "700", display: "flex", alignItems: "center" }}>{w.chip}</span>
                          </div>
                          <div style={{ flex: "1" }}></div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "3px", fontFamily: "var(--fd)", fontStretch: "var(--fs)" }}>
                            <span style={{ fontSize: "24px", fontWeight: "600" }}>{currency()}</span>
                            <span style={{ fontSize: "calc(58px * var(--fk))", fontWeight: "700", lineHeight: "0.9", letterSpacing: "-1px", fontVariantNumeric: "tabular-nums" }}>{w.value}</span>
                          </div>
                          <div style={{ height: "26px", flex: "none", display: "flex", alignItems: "flex-end", gap: "1px" }} aria-hidden="true">
                            {(w.cells).map((c: any, i_c: number) => (<Fragment key={i_c}>
                              <div style={{ flex: "1", height: `${c.hh}px`, background: c.c, borderRadius: "2px" }}></div>
                            </Fragment>))}
                          </div>
                          <div style={{ fontSize: "14px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sub}</div>
                        </div>
                      </>)}

                      {/* sleek battery: ring */}
                      {!!(w.sGauge) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "14px 16px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                          <div style={{ alignSelf: "stretch", fontSize: "16px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sLabel}</div>
                          <div style={{ position: "relative", width: "112px", height: "112px", flex: "none" }}>
                            <svg width="112" height="112" viewBox="0 0 112 112" aria-hidden="true"><circle cx="56" cy="56" r="46" fill="none" stroke={TRACK_PAINT} strokeWidth="12" /><circle cx="56" cy="56" r="46" fill="none" stroke="#111" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${w.dash} 289`} transform="rotate(-90 56 56)" /></svg>
                            <div style={{ position: "absolute", inset: "0", display: "flex", alignItems: "baseline", justifyContent: "center", paddingTop: "34px", fontFamily: "var(--fd)", fontStretch: "var(--fs)" }}><span style={{ fontSize: "calc(40px * var(--fk))", fontWeight: "700", lineHeight: "1", fontVariantNumeric: "tabular-nums" }}>{w.value}</span>{!w.gap && <span style={{ fontSize: "16px", fontWeight: "600" }}>%</span>}</div>
                          </div>
                          <div style={{ alignSelf: "stretch", textAlign: "center", fontSize: "14px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sub}</div>
                        </div>
                      </>)}

                      {/* sleek chart: capsule bars + "now" flag */}
                      {!!(w.sBars) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "14px 18px 10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" }}>
                            <span style={{ fontSize: "16px", fontWeight: "600" }}>{w.label}</span>
                            <span style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(20px * var(--fk))", fontWeight: "700" }}>{w.summary}</span>
                          </div>
                          <div style={{ position: "relative", flex: "1", minHeight: "0", display: "flex", alignItems: "flex-end", gap: "5px", paddingTop: "22px" }}>
                            <div style={{ position: "absolute", top: "0", left: `${w.nowPct}%`, transform: "translateX(-50%)", height: "20px", padding: "0 8px", borderRadius: "10px", background: "#111", color: "#ECEBE5", fontSize: "12px", fontWeight: "700", display: "flex", alignItems: "center" }}>{v.t('now')}</div>
                            {(w.bars).map((b: any, i_b: number) => (<Fragment key={i_b}>
                              <div style={{ flex: "1", height: `${b.h}%`, background: b.c, borderRadius: "6px" }}></div>
                            </Fragment>))}
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: "#111", fontVariantNumeric: "tabular-nums" }}><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
                        </div>
                      </>)}

                      {/* sleek thermostat: 270° dial with set-point marker */}
                      {!!(w.sThermo) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "10px 12px 10px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between" }}>
                          <div style={{ position: "relative", width: "120px", height: "104px", flex: "none" }}>
                            <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true" style={{ position: "absolute", top: "-4px", left: "0" }}><path d="M28.9 91.1 A44 44 0 1 1 91.1 91.1" fill="none" stroke={TRACK_PAINT} strokeWidth="9" strokeLinecap="round" /><path d="M28.9 91.1 A44 44 0 1 1 91.1 91.1" fill="none" stroke="#111" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${w.arc} 208`} /><circle cx={w.mx} cy={w.my} r="7" fill="#ECEBE5" stroke="#111" strokeWidth="3" /></svg>
                            <div style={{ position: "absolute", inset: "0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1px", paddingTop: "6px" }}>
                              <span style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(34px * var(--fk))", fontWeight: "700", lineHeight: "1", fontVariantNumeric: "tabular-nums" }}>{w.value}°</span>
                            </div>
                          </div>
                          {/* #162: the name under the ring's open bottom, card-wide (was 76 px inside the ring) */}
                          <span style={{ alignSelf: "stretch", textAlign: "center", fontSize: "13px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.label}</span>
                          <div style={{ alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                            <button className="ink-btn" aria-label={`Lower ${w.label}`} onClick={w.dec} style={{ width: "46px", height: "46px", border: "0", borderRadius: "50%", background: "#ECEBE5", fontSize: "24px", fontWeight: "600", lineHeight: "1" }}>−</button>
                            <span style={{ fontSize: "15px", fontWeight: "700", fontVariantNumeric: "tabular-nums", textDecoration: w.setDeco }}>→ {w.set}°</span>
                            <button className="ink-btn" aria-label={`Raise ${w.label}`} onClick={w.inc} style={{ width: "46px", height: "46px", border: "0", borderRadius: "50%", background: "#111", color: "#ECEBE5", fontSize: "24px", fontWeight: "600", lineHeight: "1" }}>+</button>
                          </div>
                        </div>
                      </>)}

                      {/* sleek heating: room cards, heating rooms inverted */}
                      {!!(w.sZones) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "4px 0 0", display: "flex", flexDirection: "column", gap: "8px" }}>
                          <div style={{ position: "relative", height: "48px", flex: "none", display: "flex", alignItems: "center", gap: "12px" }}>
                            <div style={{ flex: "1", fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(22px * var(--fk))", fontWeight: "700" }}>{w.summary}</div>
                            {!!(w.awayOk) && (<button className="ink-btn" onClick={w.toggleAway} style={{ height: "44px", padding: "0 18px", border: "0", borderRadius: "22px", background: "#111", color: "#ECEBE5", fontSize: "15px", fontWeight: "700" }}>{w.awayLabel}</button>)}
                            {!!(w.hdrDirty) && (<><div className="dirty"></div></>)}
                          </div>
                          <div style={{ flex: "1", minHeight: "0", display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
                            {(w.rows).map((r: any, i_r: number) => (<Fragment key={i_r}>
                              <div style={{ position: "relative", minWidth: "0", minHeight: "0", borderRadius: "16px", background: r.cbg, color: r.cfg, padding: "10px 10px 8px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px", minWidth: "0" }}>
                                  <span style={{ fontSize: "15px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                                  {!!(r.heating) && (<><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Heating" style={{ flex: "none" }}><path d="M12 .98c1.74 4.93 7.25 7.54 7.25 14.79A7.25 7.25 0 0 1 4.75 15.77c0-3.335 1.595-5.365 3.335-6.96 0 3.19 1.74 4.93 3.48 4.93 0-4.93-1.74-8.41.435-12.76z" /></svg></>)}
                                </div>
                                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "4px" }}>
                                  <span style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(34px * var(--fk))", fontWeight: "700", lineHeight: "1", fontVariantNumeric: "tabular-nums" }}>{r.cur}°</span>
                                  <span style={{ fontSize: "13px", fontWeight: "700", color: r.csub, fontVariantNumeric: "tabular-nums", textDecoration: r.setDeco }}>→{r.set}</span>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                                  <button className="ink-btn" aria-label={`Lower ${r.name}`} onClick={r.dec} style={{ flex: "1", height: "44px", border: "0", borderRadius: "22px", background: r.bbg, color: "#111", fontSize: "22px", fontWeight: "600", lineHeight: "1" }}>−</button>
                                  <button className="ink-btn" aria-label={`Raise ${r.name}`} onClick={r.inc} style={{ flex: "1", height: "44px", border: "0", borderRadius: "22px", background: r.bbg, color: "#111", fontSize: "22px", fontWeight: "600", lineHeight: "1" }}>+</button>
                                </div>
                                {!!(r.dirty) && (<><div className="dirty" style={{ borderRadius: "16px" }}></div></>)}
                              </div>
                            </Fragment>))}
                          </div>
                        </div>
                      </>)}

                      {/* sleek lights: room sections with pill switches */}
                      {!!(w.sLights) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "4px 0 0", display: "flex", flexDirection: "column", gap: "6px" }}>
                          <div style={{ position: "relative", height: "48px", flex: "none", display: "flex", alignItems: "center", gap: "12px" }}>
                            <div style={{ flex: "1", fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(22px * var(--fk))", fontWeight: "700" }}>{w.summary}</div>
                            <button className="ink-btn" onClick={w.allOff} style={{ height: "44px", padding: "0 18px", border: "0", borderRadius: "22px", background: "#111", color: "#ECEBE5", fontSize: "15px", fontWeight: "700" }}>{v.t('allLightsOff')}</button>
                            {!!(w.hdrDirty) && (<><div className="dirty"></div></>)}
                          </div>
                          <div style={{ flex: "1", minHeight: "0", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridTemplateRows: "repeat(5, minmax(0, 1fr))", gridAutoFlow: "column", columnGap: "24px", rowGap: "6px" }}>
                            {(w.rows).map((r: any, i_r: number) => (<Fragment key={i_r}>
                              <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "8px", minWidth: "0", minHeight: "0" }}>
                                {!!(r.isHeader) && (<>
                                  <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "baseline", gap: "8px", whiteSpace: "nowrap", overflow: "hidden", alignSelf: "flex-end", paddingBottom: "6px" }}>
                                    <span style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(20px * var(--fk))", fontWeight: "700" }}>{r.room}</span>
                                    <span style={{ fontSize: "14px", color: "#111" }}>{r.count}</span>
                                  </div>
                                  <button className="ink-btn" aria-label={`${r.toggleLabel} in ${r.room}`} onClick={r.toggle} style={{ flex: "none", height: "44px", padding: "0 14px", border: "0", borderRadius: "22px", background: "#DEDCD5", fontSize: "14px", fontWeight: "700" }}>{r.toggleLabel}</button>
                                </>)}
                                {!!(r.isLight) && (<>
                                  <button className="ink-btn" aria-label={`Toggle ${r.name}`} onClick={r.toggle} style={{ position: "relative", flex: "1", minWidth: "0", height: "52px", border: "0", borderRadius: "26px", background: r.chipBg, color: r.chipFg, padding: "0 16px 0 8px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left", overflow: "hidden" }}>
                                    <span style={{ flex: "none", width: "36px", height: "36px", borderRadius: "50%", background: r.dotBg, display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={r.dotFg} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></svg></span>
                                    <span style={{ flex: "1", minWidth: "0", fontSize: "17px", fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                                    <span style={{ flex: "none", fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(18px * var(--fk))", fontWeight: "700", fontVariantNumeric: "tabular-nums" }}>{r.value}</span>
                                    <span style={{ position: "absolute", left: "52px", right: "18px", bottom: "7px", height: "3px", borderRadius: "2px", background: r.trackC }}><span style={{ display: "block", width: `${r.bw}%`, height: "100%", borderRadius: "2px", background: r.fillC }}></span></span>
                                  </button>
                                  {!!(r.dimmable) && (<>
                                    <button className="ink-btn" aria-label={`Dim ${r.name}`} onClick={r.dec} style={{ flex: "none", width: "44px", height: "44px", border: "0", borderRadius: "50%", background: "#DEDCD5", fontSize: "22px", fontWeight: "600", lineHeight: "1" }}>−</button>
                                    <button className="ink-btn" aria-label={`Brighten ${r.name}`} onClick={r.inc} style={{ flex: "none", width: "44px", height: "44px", border: "0", borderRadius: "50%", background: "#DEDCD5", fontSize: "22px", fontWeight: "600", lineHeight: "1" }}>+</button>
                                  </>)}
                                  {!!(r.fixed) && (<>
                                    <span style={{ flex: "none", width: "96px", textAlign: "center", fontSize: "13px", color: "#111" }}>{v.t('onOffOnly')}</span>
                                  </>)}
                                </>)}
                                {!!(r.dirty) && (<><div className="dirty"></div></>)}
                              </div>
                            </Fragment>))}
                          </div>
                        </div>
                      </>)}

                      {/* sleek favourite light: the whole card is the switch */}
                      {!!(w.sLight) && (<>
                        <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column", padding: "8px 8px 8px" }}>
                          <button aria-label={`Toggle ${w.label}`} onClick={w.toggle} className="ink-btn" style={{ flex: "1", minHeight: "0", border: "0", borderRadius: "14px", background: "transparent", color: "inherit", padding: "6px 8px", textAlign: "left", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                            <span style={{ width: "34px", height: "34px", borderRadius: "50%", background: w.dotBg, display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={w.dotFg} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></svg></span>
                            <span style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "0", width: "100%" }}>
                              {w.gap ? <GapRing /> : <span style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(38px * var(--fk))", fontWeight: "700", lineHeight: "1" }}>{w.value}</span>}
                              <span style={{ fontSize: "14px", fontWeight: "600", color: w.subc, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.gap ? w.label + ' · ' + w.gapText : w.label}</span>
                            </span>
                          </button>
                          {!!(w.dimmable) && (<div style={{ display: "flex", gap: "6px", flex: "none" }}>
                            <button className="ink-btn" aria-label={`Dim ${w.label}`} onClick={w.dec} style={{ flex: "1", height: "44px", border: "0", borderRadius: "22px", background: w.btnBg, color: "#111", fontSize: "22px", fontWeight: "600" }}>−</button>
                            <button className="ink-btn" aria-label={`Brighten ${w.label}`} onClick={w.inc} style={{ flex: "1", height: "44px", border: "0", borderRadius: "22px", background: w.btnBg, color: "#111", fontSize: "22px", fontWeight: "600" }}>+</button>
                          </div>)}
                        </div>
                      </>)}

                      {/* sleek scene: inverted action card */}
                      {!!(w.sScene) && (<>
                        <button className="ink-btn" onClick={w.run} style={{ flex: "1", border: "0", background: "transparent", color: "inherit", padding: "14px 16px 12px", textAlign: "left", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <span style={{ width: "36px", height: "36px", borderRadius: "50%", background: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" /></svg></span>
                          <span style={{ fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(30px * var(--fk))", fontWeight: "700", lineHeight: "1.05" }}>{w.label}</span>
                          <span style={{ fontSize: "14px", color: "#ECEBE5" }}>{w.sub}</span>
                        </button>
                      </>)}

                      {/* sleek setting: value inside a stepper capsule */}
                      {!!(w.sSetting) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "14px 12px 12px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div style={{ fontSize: "16px", fontWeight: "600", padding: "0 4px" }}>{w.label}</div>
                          {!!(w.hint) && (<div style={{ fontSize: "15px", lineHeight: "20px", padding: "0 4px" }}>{w.hint}</div>)}
                          <div style={{ height: "56px", borderRadius: "28px", background: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px", gap: "4px" }}>
                            <button className="ink-btn" aria-label={`Decrease ${w.label}`} onClick={w.dec} style={{ flex: "none", width: "44px", height: "44px", border: "0", borderRadius: "50%", background: "#DEDCD5", fontSize: "22px", fontWeight: "600", lineHeight: "1" }}>−</button>
                            <span style={{ minWidth: "0", fontFamily: "var(--fd)", fontStretch: "var(--fs)", fontSize: "calc(20px * var(--fk))", fontWeight: "700", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.value}</span>
                            <button className="ink-btn" aria-label={`Increase ${w.label}`} onClick={w.inc} style={{ flex: "none", width: "44px", height: "44px", border: "0", borderRadius: "50%", background: "#111", color: "#ECEBE5", fontSize: "22px", fontWeight: "600", lineHeight: "1" }}>+</button>
                          </div>
                        </div>
                      </>)}
                      {/* ===== /SLEEK CARDS ===== */}

                      {/* stat */}
                      {!!(w.isStat) && (<>
                        <div style={{ flex: "1", padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase", lineHeight: "24px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{w.label}</div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>{w.gap ? <GapRing /> : <span style={{ fontSize: "50px", fontWeight: "700", letterSpacing: "-1.5px", fontVariantNumeric: "tabular-nums", lineHeight: "1" }}>{w.value}</span>}<span style={{ fontSize: "18px", fontWeight: "700" }}>{w.unit}</span></div>
                          <div style={{ fontSize: "18px", color: "#111", minHeight: "22px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sub}</div>
                        </div>
                      </>)}

                      {/* clock */}
                      {!!(w.isClock) && (<>
                        <div style={{ flex: "1", padding: "12px 18px", display: "flex", flexDirection: "column", justifyContent: "center", gap: "4px" }}>
                          <div style={{ position: "relative", fontSize: "92px", fontWeight: "700", letterSpacing: "-4px", lineHeight: "0.95", fontVariantNumeric: "tabular-nums" }}>{v.clock}{!!(w.clockDirty) && (<><div className="dirty"></div></>)}</div>
                          <div style={{ fontSize: "20px", fontWeight: "700" }}>{v.dateText}</div>
                        </div>
                      </>)}

                      {/* price now */}
                      {!!(w.isPrice) && (<>
                        <div style={{ flex: "1", padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                            <div style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase", lineHeight: "24px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.label}</div>
                            <div style={{ flex: "none", fontSize: "16px", fontWeight: "700", padding: "2px 5px", borderRadius: "4px", background: w.tagBg, color: w.tagFg, border: "2px solid #111" }}>{w.tagText}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}><span style={{ fontSize: "22px", fontWeight: "700" }}>{currency()}</span><span style={{ fontSize: "50px", fontWeight: "700", letterSpacing: "-1.5px", lineHeight: "1", fontVariantNumeric: "tabular-nums" }}>{w.value}</span><span style={{ fontSize: "16px", fontWeight: "700" }}>/kWh</span></div>
                          <div style={{ fontSize: "18px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sub}</div>
                        </div>
                      </>)}

                      {/* gauge */}
                      {!!(w.isGauge) && (<>
                        <div style={{ flex: "1", padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase", lineHeight: "24px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{w.label}</div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>{w.gap ? <GapRing /> : (<><span style={{ fontSize: "50px", fontWeight: "700", letterSpacing: "-1.5px", lineHeight: "1", fontVariantNumeric: "tabular-nums" }}>{w.value}</span><span style={{ fontSize: "20px", fontWeight: "700" }}>%</span></>)}</div>
                          <div style={{ height: "18px", border: "2px solid #111", borderRadius: "4px", padding: "2px", boxSizing: "border-box" }}><div style={{ height: "100%", width: `${w.pct}%`, background: "#111" }}></div></div>
                          <div style={{ fontSize: "18px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sub}</div>
                        </div>
                      </>)}

                      {/* bars */}
                      {!!(w.isBars) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "10px 14px 8px", display: "flex", flexDirection: "column", gap: "6px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" }}>
                            <div style={{ minWidth: "0", fontSize: "20px", fontWeight: "700", textTransform: "uppercase", lineHeight: "24px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.label}</div>
                            <div style={{ flex: "none", fontSize: "18px", fontWeight: "700" }}>{w.summary}</div>
                          </div>
                          <div style={{ flex: "1", minHeight: "0", display: "flex", alignItems: "flex-end", gap: "3px", borderBottom: "2px solid #111" }}>
                            {(w.bars).map((b: any, i_b: number) => (<Fragment key={i_b}>
                              <div style={{ flex: "1", height: `${b.h}%`, background: b.c, borderRadius: "2px 2px 0 0" }}></div>
                            </Fragment>))}
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "18px", color: "#111", fontVariantNumeric: "tabular-nums" }}><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
                        </div>
                      </>)}

                      {/* thermostat tile */}
                      {!!(w.isThermo) && (<>
                        <div style={{ flex: "1", padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "6px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                            <div style={{ fontSize: "18px", fontWeight: "700" }}>{w.label}</div>
                            {!!(w.heating) && (<>
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="#111" aria-label="Heating" role="img"><path d="M12 .98c1.74 4.93 7.25 7.54 7.25 14.79A7.25 7.25 0 0 1 4.75 15.77c0-3.335 1.595-5.365 3.335-6.96 0 3.19 1.74 4.93 3.48 4.93 0-4.93-1.74-8.41.435-12.76z"></path></svg>
                            </>)}
                          </div>
                          <div style={{ display: "flex", alignItems: "flex-start" }}><span style={{ fontSize: `${w.bigSize}px`, fontWeight: "700", letterSpacing: "-2px", lineHeight: "1", fontVariantNumeric: "tabular-nums" }}>{w.value}</span><span style={{ fontSize: "22px", fontWeight: "700", marginTop: "4px" }}>°</span></div>
                          <div style={{ fontSize: "16px", color: "#111" }}>{w.sub}</div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", borderTop: "2px solid #111", paddingTop: "8px" }}>
                            <button className="ink-btn" aria-label={`Lower ${w.label}`} onClick={w.dec} style={{ width: "48px", height: "48px", border: "2px solid #111", borderRadius: "50%", background: "#ECEBE5", fontSize: "26px", fontWeight: "700", lineHeight: "1" }}>−</button>
                            <div style={{ textAlign: "center" }}><div style={{ fontSize: "13px", fontWeight: "700", letterSpacing: "0.8px" }}>{v.t('setTemp').toUpperCase()}</div><div style={{ fontSize: "24px", fontWeight: "700", fontVariantNumeric: "tabular-nums", textDecoration: w.setDeco }}>{w.set}°</div></div>
                            <button className="ink-btn" aria-label={`Raise ${w.label}`} onClick={w.inc} style={{ width: "48px", height: "48px", border: "2px solid #111", borderRadius: "50%", background: "#ECEBE5", fontSize: "26px", fontWeight: "700", lineHeight: "1" }}>+</button>
                          </div>
                        </div>
                      </>)}

                      {/* heating list */}
                      {!!(w.isZoneList) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "8px 14px 6px", display: "flex", flexDirection: "column", gap: "4px" }}>
                          <div style={{ position: "relative", height: "48px", flex: "none", display: "flex", alignItems: "center", gap: "12px" }}>
                            <div style={{ flex: "1", minWidth: "0", fontSize: "20px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.summary}</div>
                            {!!(w.awayOk) && (<button className="ink-btn" onClick={w.toggleAway} style={{ height: "44px", padding: "0 14px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{w.awayLabel}</button>)}
                            {!!(w.hdrDirty) && (<><div className="dirty"></div></>)}
                          </div>
                          <div style={{ flex: "none", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: "28px", fontSize: "20px", fontWeight: "700", color: "#111" }}>
                            <div style={{ display: "flex", gap: "8px" }}><span style={{ flex: "1" }}>{v.t('room').toUpperCase()}</span><span style={{ width: "52px", textAlign: "right" }}>{v.t('now').toUpperCase()}</span><span style={{ width: "154px", textAlign: "center" }}>{v.t('setTemp').toUpperCase()}</span></div>
                            <div style={{ display: "flex", gap: "8px" }}><span style={{ flex: "1" }}>{v.t('room').toUpperCase()}</span><span style={{ width: "52px", textAlign: "right" }}>{v.t('now').toUpperCase()}</span><span style={{ width: "154px", textAlign: "center" }}>{v.t('setTemp').toUpperCase()}</span></div>
                          </div>
                          <div style={{ flex: "1", minHeight: "0", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridTemplateRows: "repeat(5, minmax(0, 1fr))", gridAutoFlow: "column", columnGap: "28px" }}>
                            {(w.rows).map((r: any, i_r: number) => (<Fragment key={i_r}>
                              <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "8px", borderTop: "1px dotted #111", minWidth: "0" }}>
                                <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "center", gap: "6px" }}>
                                  <span style={{ fontSize: "20px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                                  {!!(r.heating) && (<>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#111" aria-label="Heating" role="img" style={{ flex: "none" }}><path d="M12 .98c1.74 4.93 7.25 7.54 7.25 14.79A7.25 7.25 0 0 1 4.75 15.77c0-3.335 1.595-5.365 3.335-6.96 0 3.19 1.74 4.93 3.48 4.93 0-4.93-1.74-8.41.435-12.76z"></path></svg>
                                  </>)}
                                </div>
                                <span style={{ width: "52px", flex: "none", textAlign: "right", fontSize: "20px", fontWeight: "700", color: "#111", fontVariantNumeric: "tabular-nums" }}>{r.cur}°</span>
                                <div style={{ width: "154px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                  <button className="ink-btn" aria-label={`Lower ${r.name}`} onClick={r.dec} style={{ width: "46px", height: "46px", border: "2px solid #111", borderRadius: "50%", background: "#ECEBE5", fontSize: "24px", fontWeight: "700", lineHeight: "1" }}>−</button>
                                  <span style={{ fontSize: "22px", fontWeight: "700", fontVariantNumeric: "tabular-nums", textDecoration: r.setDeco }}>{r.set}°</span>
                                  <button className="ink-btn" aria-label={`Raise ${r.name}`} onClick={r.inc} style={{ width: "46px", height: "46px", border: "2px solid #111", borderRadius: "50%", background: "#ECEBE5", fontSize: "24px", fontWeight: "700", lineHeight: "1" }}>+</button>
                                </div>
                                {!!(r.dirty) && (<><div className="dirty"></div></>)}
                              </div>
                            </Fragment>))}
                          </div>
                        </div>
                      </>)}

                      {/* lights list, grouped by room */}
                      {!!(w.isLightList) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "8px 14px 6px", display: "flex", flexDirection: "column", gap: "4px" }}>
                          <div style={{ position: "relative", height: "48px", flex: "none", display: "flex", alignItems: "center", gap: "12px" }}>
                            <div style={{ flex: "1", minWidth: "0", fontSize: "20px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.summary}</div>
                            <button className="ink-btn" onClick={w.allOff} style={{ height: "44px", padding: "0 14px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{v.t('allLightsOff')}</button>
                            {!!(w.hdrDirty) && (<><div className="dirty"></div></>)}
                          </div>
                          <div style={{ flex: "1", minHeight: "0", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridTemplateRows: "repeat(5, minmax(0, 1fr))", gridAutoFlow: "column", columnGap: "28px" }}>
                            {(w.rows).map((r: any, i_r: number) => (<Fragment key={i_r}>
                              <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "8px", minWidth: "0", borderTop: r.rule }}>
                                {!!(r.isHeader) && (<>
                                  <div style={{ flex: "1", minWidth: "0", display: "flex", alignItems: "baseline", gap: "8px", whiteSpace: "nowrap", overflow: "hidden" }}>
                                    <span style={{ fontSize: "18px", fontWeight: "700", textTransform: "uppercase" }}>{r.room}</span>
                                    <span style={{ fontSize: "18px", color: "#111" }}>{r.count}</span>
                                  </div>
                                  <button className="ink-btn" aria-label={`${r.toggleLabel} in ${r.room}`} onClick={r.toggle} style={{ flex: "none", height: "44px", padding: "0 12px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{r.toggleLabel}</button>
                                </>)}
                                {!!(r.isLight) && (<>
                                  <button className="ink-btn" aria-label={`Toggle ${r.name}`} onClick={r.toggle} style={{ flex: "1", minWidth: "0", height: "48px", border: "0", background: "#ECEBE5", borderRadius: "8px", padding: "0 4px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left" }}>
                                    <span style={{ flex: "none", width: "44px", height: "24px", boxSizing: "border-box", border: "2px solid #111", borderRadius: "12px", background: r.trackBg, display: "flex", alignItems: "center", justifyContent: r.knobSide, padding: "2px" }}><span style={{ width: "16px", height: "16px", borderRadius: "50%", background: r.knobBg, border: "2px solid #111", boxSizing: "border-box" }}></span></span>
                                    <span style={{ fontSize: "20px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" }}>{r.name}</span>
                                  </button>
                                  <span style={{ flex: "none", textAlign: "right", fontSize: "20px", fontWeight: "700", color: "#111" }}>{r.value}</span>
                                  {!!(r.dimmable) && (<>
                                    <button className="ink-btn" aria-label={`Dim ${r.name}`} onClick={r.dec} style={{ flex: "none", width: "44px", height: "44px", border: "2px solid #111", borderRadius: "50%", background: "#ECEBE5", fontSize: "22px", fontWeight: "700", lineHeight: "1" }}>−</button>
                                    <button className="ink-btn" aria-label={`Brighten ${r.name}`} onClick={r.inc} style={{ flex: "none", width: "44px", height: "44px", border: "2px solid #111", borderRadius: "50%", background: "#ECEBE5", fontSize: "22px", fontWeight: "700", lineHeight: "1" }}>+</button>
                                  </>)}
                                  {!!(r.fixed) && (<>
                                    <span style={{ flex: "none", width: "96px", textAlign: "center", fontSize: "18px", lineHeight: "22px", color: "#111" }}>{v.t('onOffOnly')}</span>
                                  </>)}
                                </>)}
                                {!!(r.dirty) && (<><div className="dirty"></div></>)}
                              </div>
                            </Fragment>))}
                          </div>
                        </div>
                      </>)}

                      {/* light tile (favourite) */}
                      {!!(w.isLight) && (<>
                        <div style={{ flex: "1", display: "flex", flexDirection: "column" }}>
                          <button aria-label={`Toggle ${w.label}`} onClick={w.toggle} className="ink-btn" style={{ flex: "1", border: "0", background: "#ECEBE5", padding: "12px 14px", textAlign: "left", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: "8px" }}>
                              <span style={{ fontSize: "18px", fontWeight: "700" }}>{w.label}</span>
                              <span style={{ flex: "none", width: "48px", height: "26px", boxSizing: "border-box", border: "2px solid #111", borderRadius: "13px", background: w.trackBg, display: "flex", alignItems: "center", justifyContent: w.knobSide, padding: "2px" }}><span style={{ width: "18px", height: "18px", borderRadius: "50%", background: w.knobBg, border: "2px solid #111", boxSizing: "border-box" }}></span></span>
                            </div>
                            {w.gap ? <span style={{ display: "flex", alignItems: "center", gap: "8px" }}><GapRing /><span style={{ fontSize: "16px" }}>{w.gapText}</span></span> : <span style={{ fontSize: "34px", fontWeight: "700" }}>{w.value}</span>}
                          </button>
                          {!!(w.dimmable) && (<div style={{ display: "flex", borderTop: "2px solid #111" }}>
                            <button className="ink-btn" aria-label={`Dim ${w.label}`} onClick={w.dec} style={{ flex: "1", height: "46px", border: "0", borderRight: "2px solid #111", background: "#ECEBE5", fontSize: "22px", fontWeight: "700" }}>−</button>
                            <button className="ink-btn" aria-label={`Brighten ${w.label}`} onClick={w.inc} style={{ flex: "1", height: "46px", border: "0", background: "#ECEBE5", fontSize: "22px", fontWeight: "700" }}>+</button>
                          </div>)}
                        </div>
                      </>)}

                      {/* scene */}
                      {!!(w.isScene) && (<>
                        <button className="ink-btn" onClick={w.run} style={{ flex: "1", border: "0", background: "#ECEBE5", padding: "12px 14px", textAlign: "left", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <span style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase", lineHeight: "24px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.kind}</span>
                          <span style={{ fontSize: "30px", fontWeight: "700" }}>{w.label}</span>
                          <span style={{ fontSize: "18px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.sub}</span>
                        </button>
                      </>)}

                      {/* setting */}
                      {!!(w.isSetting) && (<>
                        <div style={{ flex: "1", padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase", lineHeight: "24px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{w.label}</div>
                          <div style={{ fontSize: "26px", fontWeight: "700", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.value}</div>
                          {!!(w.hint) && (<div style={{ fontSize: "18px", lineHeight: "22px", color: "#111" }}>{w.hint}</div>)}
                          <div style={{ display: "flex", gap: "8px" }}>
                            <button className="ink-btn" aria-label={`Decrease ${w.label}`} onClick={w.dec} style={{ flex: "1", height: "46px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "24px", fontWeight: "700" }}>−</button>
                            <button className="ink-btn" aria-label={`Increase ${w.label}`} onClick={w.inc} style={{ flex: "1", height: "46px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "24px", fontWeight: "700" }}>+</button>
                          </div>
                        </div>
                      </>)}

                      {/* info */}
                      {!!(w.isInfo) && (<>
                        <div style={{ flex: "1", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
                          <div className="lbl" style={{ fontSize: "16px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.8px" }}>{w.label}</div>
                          {(w.lines).map((ln: any, i_ln: number) => (<Fragment key={i_ln}>
                            <div className="hl" style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "16px", borderBottom: "1px dotted #111", paddingBottom: "5px" }}><span style={{ color: "#111" }}>{ln.k}</span><span style={{ fontWeight: "700", textAlign: "right" }}>{ln.v}</span></div>
                          </Fragment>))}
                        </div>
                      </>)}

                      {/* first install, step 2: continue in the browser on the home network */}
                      {!!(w.isSetupWeb) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "18px 22px", display: "flex", gap: "28px", alignItems: "center" }}>
                          <div style={{ width: "210px", flex: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                            <div style={{ width: "200px", height: "200px", boxSizing: "border-box", border: "2px dashed #111", borderRadius: "8px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", textAlign: "center", padding: "12px" }}>
                              <div style={{ fontSize: "18px", fontWeight: "700" }}>[QR CODE]</div>
                              <div style={{ fontSize: "13px", color: "#111" }}>http://{SIM_IP}</div>
                            </div>
                            <div style={{ fontSize: "22px", fontWeight: "700", letterSpacing: "0.5px" }}>{HOST}</div>
                            <div style={{ fontSize: "18px", color: "#111", marginTop: "-6px" }}>{w.orIp}</div>
                          </div>
                          <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "10px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "16px", fontWeight: "700" }}>
                              <span style={{ width: "22px", height: "22px", borderRadius: "50%", background: "#111", color: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px" }}>✓</span>
                              {w.connected}
                            </div>
                            <div style={{ fontSize: "30px", fontWeight: "700", lineHeight: "1.1" }}>{w.title}</div>
                            {(w.steps).map((st: any, i_st: number) => (<Fragment key={i_st}>
                              <div className="hl" style={{ display: "flex", gap: "12px", alignItems: "flex-start", paddingTop: "8px", borderTop: "1px dotted #111" }}>
                                <span style={{ flex: "none", width: "26px", height: "26px", border: "2px solid #111", borderRadius: "50%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: "700" }}>{st.n}</span>
                                <span style={{ display: "flex", flexDirection: "column", minWidth: "0" }}><span style={{ fontSize: "19px", fontWeight: "700" }}>{st.text}</span><span style={{ fontSize: "14px", color: "#111", lineHeight: "1.35" }}>{st.sub}</span></span>
                              </div>
                            </Fragment>))}
                            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" }}>
                              <button className="ink-btn ob" onClick={w.changeWifi} style={{ height: "44px", padding: "0 14px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "15px", fontWeight: "700" }}>{w.otherWifi}</button>
                              <span style={{ fontSize: "14px", color: "#111" }}>{w.waiting}</span>
                            </div>
                          </div>
                        </div>
                      </>)}

                      {/* ghost tile: the shape of what will appear once Home Assistant is linked */}
                      {!!(w.isGhost) && (<>
                        <div style={{ flex: "1", padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between", color: "#111" }}>
                          <div className="lbl" style={{ fontSize: "16px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.label}</div>
                          <div className="num" style={{ fontSize: "44px", fontWeight: "700", lineHeight: "1" }}>—</div>
                          <div style={{ height: "16px" }}></div>
                        </div>
                      </>)}

                      {/* link card (Home page when Home Assistant is not linked) */}
                      {!!(w.isLinkCard) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px" }}>
                          <div style={{ fontSize: "24px", fontWeight: "700", lineHeight: "1.15" }}>{v.t('linkHa')}</div>
                          <div style={{ fontSize: "15px", color: "#111", lineHeight: "1.35" }}>{v.t('linkHaWhy')}</div>
                          <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
                            <div style={{ width: "128px", height: "128px", flex: "none", boxSizing: "border-box", border: "2px dashed #111", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: "700" }}>[QR]</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                              <span style={{ fontSize: "13px", color: "#111" }}>{v.t('pairingCode')}</span>
                              <span style={{ fontSize: "28px", fontWeight: "700", letterSpacing: "5px" }}>{w.pair}</span>
                              <span style={{ fontSize: "13px", color: "#111" }}>{v.t('scanWithPhone')}</span>
                            </div>
                          </div>
                          <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column" }}>
                            {(w.stages).map((st: any, i_st: number) => (<Fragment key={i_st}>
                              <div className="hl" style={{ flex: "1", minHeight: "0", display: "flex", alignItems: "center", gap: "10px", borderTop: "1px dotted #111" }}>
                                <span style={{ flex: "none", width: "22px", height: "22px", boxSizing: "border-box", border: st.ring, borderRadius: "50%", background: st.bg, color: st.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700" }}>{st.mark}</span>
                                <span style={{ fontSize: "15px", fontWeight: st.weight, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.title}</span>
                              </div>
                            </Fragment>))}
                          </div>
                          <button className="ink-btn ob" onClick={w.simulate} style={{ height: "44px", flex: "none", border: "2px solid #111", borderRadius: "8px", background: "#111", color: "#ECEBE5", fontSize: "15px", fontWeight: "700" }}>{w.simLabel}</button>
                        </div>
                      </>)}

                      {/* Home Assistant link */}
                      {!!(w.isHa) && (<>
                        <div style={{ flex: "1", minHeight: "0", display: "flex" }}>
                          {!!(w.isStatus) && (<>
                            <div className="rr" style={{ width: "290px", flex: "none", boxSizing: "border-box", padding: "14px 16px", borderRight: "2px solid #111", display: "flex", flexDirection: "column", gap: "8px" }}>
                              <div className="lbl" style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase" }}>Home Assistant</div>
                              <div style={{ fontSize: "28px", fontWeight: "700", lineHeight: "1.1" }}>{w.title}</div>
                              {(w.lines).map((ln: any, i_ln: number) => (<Fragment key={i_ln}>
                                <div className="hl" style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "18px", borderBottom: "1px dotted #111", paddingBottom: "4px" }}><span style={{ color: "#111", flex: "none" }}>{ln.k}</span><span style={{ fontWeight: "700", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ln.v}</span></div>
                              </Fragment>))}
                              {!!(w.hint) && (<div style={{ fontSize: "18px", lineHeight: "22px", color: "#111" }}>{w.hint}</div>)}
                              <div style={{ flex: "1" }}></div>
                              {!!(w.linked) && (<>
                                <div style={{ display: "flex", gap: "8px" }}>
                                  <button className="ink-btn ob" onClick={w.reconnect} style={{ flex: "1", height: "44px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{v.t('reconnect')}</button>
                                  <button className="ink-btn ob" onClick={w.unlink} style={{ flex: "1", height: "44px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{v.t('unlink')}</button>
                                </div>
                              </>)}
                              <button className="ink-btn ob" onClick={w.openLink} style={{ height: "48px", border: "2px solid #111", borderRadius: "8px", background: w.linkBg, color: w.linkFg, fontSize: "18px", fontWeight: "700", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2"></path></svg>
                                {w.linkLabel}
                              </button>
                            </div>
                            <div style={{ flex: "1", minWidth: "0", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "6px" }}>
                              <div className="lbl" style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase" }}>{v.t('whatReads')}</div>
                              {(w.uses).map((u: any, i_u: number) => (<Fragment key={i_u}>
                                <div className="hl" style={{ flex: "1", minHeight: "0", display: "flex", alignItems: "center", gap: "12px", borderTop: "1px dotted #111" }}>
                                  <span style={{ flex: "none", width: "28px", height: "28px", boxSizing: "border-box", border: "2px solid #111", borderRadius: "50%", background: u.dotBg, display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={u.tick} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"></path></svg></span>
                                  <span style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column" }}><span style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}><span style={{ fontSize: "20px", fontWeight: "700" }}>{u.name}</span><span style={{ flex: "none", fontSize: "18px", fontWeight: "700" }}>{u.count}</span></span><span style={{ fontSize: "18px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.src}</span></span>
                                </div>
                              </Fragment>))}
                              <div style={{ flex: "none", fontSize: "18px", lineHeight: "22px", color: "#111" }}>{v.t('changeShownAt', v.t('hostOr', HOST, SIM_IP))}</div>
                            </div>
                          </>)}
                          {/* link: QR → phone → HA login → one-time code → key */}
                          {!!(w.isLink) && (<>
                            <div style={{ flex: "1", minWidth: "0", padding: "14px 18px", display: "flex", gap: "24px" }}>
                              <div style={{ width: "210px", flex: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                                <div style={{ width: "200px", height: "200px", boxSizing: "border-box", border: "2px dashed #111", borderRadius: "8px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", textAlign: "center", padding: "12px" }}>
                                  <div style={{ fontSize: "18px", fontWeight: "700" }}>[QR CODE]</div>
                                  <div style={{ fontSize: "12px", color: "#111", wordBreak: "break-all" }}>{SIM_IP}/link?p={w.pair}</div>
                                </div>
                                <div style={{ fontSize: "18px", color: "#111" }}>{v.t('pairingCode')}</div>
                                <div style={{ fontSize: "30px", fontWeight: "700", letterSpacing: "6px", fontVariantNumeric: "tabular-nums" }}>{w.pair}</div>
                              </div>
                              <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "6px" }}>
                                <div style={{ fontSize: "24px", fontWeight: "700" }}>{v.t('linkHa')}</div>
                                <div style={{ fontSize: "18px", lineHeight: "22px", color: "#111" }}>{v.t('linkScanNote')}</div>
                                <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column", marginTop: "4px" }}>
                                  {(w.stages).map((st: any, i_st: number) => (<Fragment key={i_st}>
                                    <div className="hl" style={{ flex: "1", minHeight: "0", display: "flex", alignItems: "center", gap: "12px", borderTop: "1px dotted #111" }}>
                                      <span style={{ flex: "none", width: "30px", height: "30px", boxSizing: "border-box", border: st.ring, borderRadius: "50%", background: st.bg, color: st.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: "700" }}>{st.mark}</span>
                                      <span style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column" }}><span style={{ fontSize: "18px", fontWeight: "700" }}>{st.title}</span><span style={{ fontSize: "18px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.sub}</span></span>
                                    </div>
                                  </Fragment>))}
                                </div>
                                <div style={{ display: "flex", gap: "10px" }}>
                                  <button className="ink-btn ob" onClick={w.simulate} style={{ height: "44px", padding: "0 14px", border: "2px solid #111", borderRadius: "8px", background: "#111", color: "#ECEBE5", fontSize: "15px", fontWeight: "700" }}>{w.simLabel}</button>
                                  <button className="ink-btn ob" onClick={w.cancel} style={{ height: "44px", padding: "0 14px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{v.t('cancel')}</button>
                                </div>
                              </div>
                            </div>
                          </>)}
                        </div>
                      </>)}

                      {/* About */}
                      {!!(w.isAbout) && (<>
                        <div style={{ flex: "1", minHeight: "0", display: "flex" }}>
                          <div style={{ flex: "1", minWidth: "0", padding: "14px 18px", display: "flex", flexDirection: "column", gap: "6px" }}>
                            <div className="rbt" style={{ display: "flex", alignItems: "center", gap: "14px", paddingBottom: "8px", borderBottom: "2px solid #111" }}>
                              <div style={{ width: "54px", height: "40px", flex: "none", boxSizing: "border-box", border: "3px solid #111", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ width: "36px", height: "22px", border: "1.5px solid #111", boxSizing: "border-box" }}></div></div>
                              <div style={{ minWidth: "0" }}><div style={{ fontSize: "26px", fontWeight: "700", lineHeight: "1.1" }}>{w.name}</div><div style={{ fontSize: "18px", color: "#111", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.model}</div></div>
                            </div>
                            <div style={{ flex: "1", minHeight: "0", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridAutoRows: "minmax(0, 1fr)", columnGap: "24px" }}>
                              {(w.facts).map((f: any, i_f: number) => (<Fragment key={i_f}>
                                <div className="hl" style={{ display: "flex", flexDirection: "column", justifyContent: "center", borderBottom: "1px dotted #111", minWidth: "0" }}><span className="lbl" style={{ fontSize: "16px", fontWeight: "700", letterSpacing: "0.6px", color: "#111", textTransform: "uppercase" }}>{f.k}</span><span style={{ fontSize: "20px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.v}</span></div>
                              </Fragment>))}
                            </div>
                          </div>
                          <div className="rl" style={{ width: "230px", flex: "none", boxSizing: "border-box", borderLeft: "2px solid #111", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                            <div className="lbl" style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase" }}>{v.t('tabDevice')}</div>
                            <button className="ink-btn ob" onClick={w.restart} style={{ height: "48px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{v.t('restart')}</button>
                            <div style={{ fontSize: "18px", color: "#111", lineHeight: "22px" }}>{v.t('restartNote')}</div>
                            <div style={{ flex: "1" }}></div>
                            <button className="ink-btn ob" onClick={w.reset} style={{ height: "48px", border: "2px solid #111", borderRadius: "8px", background: w.resetBg, color: w.resetFg, fontSize: "18px", fontWeight: "700" }}>{w.resetLabel}</button>
                            <div style={{ fontSize: "18px", color: "#111", lineHeight: "22px" }}>{w.resetHint}</div>
                          </div>
                        </div>
                      </>)}

                      {/* Wi-Fi settings */}
                      {!!(w.isWifi) && (<>
                        <div style={{ flex: "1", minHeight: "0", display: "flex" }}>

                          {/* list view */}
                          {!!(w.isList) && (<>
                            <div className="rr" style={{ width: "290px", flex: "none", boxSizing: "border-box", padding: "14px 16px", borderRight: "2px solid #111", display: "flex", flexDirection: "column", gap: "8px" }}>
                              <div className="lbl" style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase" }}>{w.statusLabel}</div>
                              <div style={{ fontSize: "28px", fontWeight: "700", lineHeight: "1.1", wordBreak: "break-word" }}>{w.statusTitle}</div>
                              {(w.statusLines).map((ln: any, i_ln: number) => (<Fragment key={i_ln}>
                                <div className="hl" style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "18px", borderBottom: "1px dotted #111", paddingBottom: "4px" }}><span style={{ color: "#111" }}>{ln.k}</span><span style={{ fontWeight: "700" }}>{ln.v}</span></div>
                              </Fragment>))}
                              <div style={{ flex: "1" }}></div>
                              {!!(w.isConnected) && (<>
                                <button className="ink-btn ob" onClick={w.disconnect} style={{ height: "44px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{v.t('disconnect')}</button>
                              </>)}
                              <button className="ink-btn ob" onClick={w.openPhone} style={{ height: "48px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2"></path></svg>
                                {v.t('setupFromPhone')}
                              </button>
                            </div>
                            <div style={{ flex: "1", minWidth: "0", padding: "10px 14px", display: "flex", flexDirection: "column", gap: "4px" }}>
                              <div style={{ height: "44px", flex: "none", display: "flex", alignItems: "center", gap: "10px" }}>
                                <div className="lbl" style={{ flex: "1", minWidth: "0", fontSize: "20px", fontWeight: "700", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.t('wifiNetworks')}</div>
                                <button className="ink-btn ob" onClick={w.scan} style={{ height: "40px", padding: "0 14px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{w.scanLabel}</button>
                              </div>
                              <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column" }}>
                                {(w.nets).map((n: any, i_n: number) => (<Fragment key={i_n}>
                                  <button className="ink-btn hl pb" onClick={n.pick} style={{ flex: "none", height: "54px", border: "0", borderTop: "1px dotted #111", background: "#ECEBE5", padding: "0 6px", display: "flex", alignItems: "center", gap: "12px", textAlign: "left" }}>
                                    <span aria-hidden="true" style={{ flex: "none", display: "flex", alignItems: "flex-end", gap: "2px", height: "18px" }}>
                                      {(n.bars).map((b: any, i_b: number) => (<Fragment key={i_b}><span style={{ display: "block", width: "4px", height: `${b.h}px`, background: b.c, border: "1px solid #111", boxSizing: "border-box" }}></span></Fragment>))}
                                    </span>
                                    <span style={{ flex: "1", minWidth: "0", fontSize: "24px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.ssid}</span>
                                    {!!(n.secure) && (<>
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Password protected" style={{ flex: "none" }}><path d="M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"></path></svg>
                                    </>)}
                                    <span style={{ flex: "none", textAlign: "right", fontSize: "18px", fontWeight: "700", color: "#111" }}>{n.tag}</span>
                                  </button>
                                </Fragment>))}
                              </div>
                              <div style={{ flex: "none", fontSize: "18px", lineHeight: "22px", color: "#111" }}>{v.t('wifi5g')}</div>
                            </div>
                          </>)}

                          {/* password + on-screen keyboard */}
                          {!!(w.isPw) && (<>
                            <div style={{ flex: "1", minWidth: "0", padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
                              <div style={{ height: "44px", flex: "none", display: "flex", alignItems: "center", gap: "10px" }}>
                                <button className="ink-btn ob" onClick={w.cancel} aria-label="Back to networks" style={{ width: "44px", height: "44px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg></button>
                                <div style={{ flex: "1", minWidth: "0", fontSize: "20px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.t('pwFor', w.target)}</div>
                                <button className="ink-btn ob" onClick={w.toggleShow} style={{ height: "40px", padding: "0 12px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{w.showLabel}</button>
                              </div>
                              <div style={{ height: "48px", flex: "none", boxSizing: "border-box", border: "2px solid #111", borderRadius: "8px", padding: "0 12px", display: "flex", alignItems: "center", gap: "2px", fontSize: "22px", fontWeight: "700", fontVariantNumeric: "tabular-nums", letterSpacing: "1px", overflow: "hidden" }}>
                                <span style={{ whiteSpace: "nowrap", overflow: "hidden" }}>{w.field}</span><span style={{ width: "2px", height: "26px", background: "#111", flex: "none" }}></span>
                                <span style={{ flex: "1" }}></span>
                                <span style={{ fontSize: "18px", fontWeight: "700", color: w.msgColor, letterSpacing: "0", whiteSpace: "nowrap" }}>{w.msg}</span>
                              </div>
                              <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column", gap: "6px" }}>
                                {(w.kb).map((row: any, i_row: number) => (<Fragment key={i_row}>
                                  <div style={{ flex: "1", minHeight: "0", display: "flex", gap: "6px", padding: `0 ${row.inset}px` }}>
                                    {(row.keys).map((k: any, i_k: number) => (<Fragment key={i_k}>
                                      <button className="ink-btn" aria-label={k.aria} onClick={k.press} style={{ flex: k.flex, minWidth: "0", border: "2px solid #111", borderRadius: "6px", background: k.bg, color: k.fg, fontSize: `${k.size}px`, fontWeight: "700", padding: "0" }}>{k.label}</button>
                                    </Fragment>))}
                                  </div>
                                </Fragment>))}
                              </div>
                            </div>
                          </>)}

                          {/* connecting (static text: no spinner on e-ink) */}
                          {!!(w.isConnecting) && (<>
                            <div style={{ flex: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px" }}>
                              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5v.01"></path></svg>
                              <div style={{ fontSize: "28px", fontWeight: "700" }}>{v.t('connectingTo', w.target)}</div>
                              <div style={{ fontSize: "18px", color: "#111" }}>{v.t('connectingNote')}</div>
                            </div>
                          </>)}

                          {/* set up from phone (SoftAP + captive portal) */}
                          {!!(w.isPhone) && (<>
                            <div style={{ flex: "1", minWidth: "0", padding: "16px 20px", display: "flex", gap: "28px", alignItems: "center" }}>
                              <div style={{ width: "200px", height: "200px", flex: "none", boxSizing: "border-box", border: "2px dashed #111", borderRadius: "8px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", textAlign: "center", padding: "12px" }}>
                                <div style={{ fontSize: "18px", fontWeight: "700" }}>[QR CODE]</div>
                                <div style={{ fontSize: "13px", color: "#111" }}>Joins HA-Paper-Setup and opens the setup page</div>
                              </div>
                              <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "12px" }}>
                                <div style={{ fontSize: "26px", fontWeight: "700" }}>{v.t('phoneTitle')}</div>
                                {(w.steps).map((st: any, i_st: number) => (<Fragment key={i_st}>
                                  <div style={{ display: "flex", gap: "12px", alignItems: "baseline", fontSize: "18px", lineHeight: "1.35" }}><span style={{ flex: "none", width: "26px", height: "26px", border: "2px solid #111", borderRadius: "50%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: "700" }}>{st.n}</span><span>{st.text}</span></div>
                                </Fragment>))}
                                <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                                  <button className="ink-btn ob" onClick={w.phoneDone} style={{ height: "46px", padding: "0 16px", border: "2px solid #111", borderRadius: "8px", background: "#111", color: "#ECEBE5", fontSize: "16px", fontWeight: "700" }}>Simulate phone setup</button>
                                  <button className="ink-btn ob" onClick={w.cancel} style={{ height: "46px", padding: "0 16px", border: "2px solid #111", borderRadius: "8px", background: "#ECEBE5", fontSize: "18px", fontWeight: "700" }}>{v.t('cancel')}</button>
                                </div>
                              </div>
                            </div>
                          </>)}
                        </div>
                      </>)}

                      {/* travel route: status badge = 4-step severity (bars + word; colour where the panel has it) */}
                      {!!(w.isRoute) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "10px 14px 9px", display: "flex", flexDirection: "column", gap: "4px" }}>
                          <div style={{ height: "34px", flex: "none", display: "flex", alignItems: "center", gap: "8px" }}>
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}><path d={w.icon}></path></svg>
                            <div style={{ flex: "1", minWidth: "0", fontSize: "18px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.title}</div>
                            {!!(w.sev) && (
                            <div role="img" aria-label={`Status: ${w.sev.word}`} style={{ flex: "none", height: "30px", boxSizing: "border-box", padding: "0 10px 0 8px", border: "2px solid #111", borderRadius: "15px", background: w.sev.bg, color: w.sev.fg, display: "flex", alignItems: "center", gap: "7px", fontSize: "15px", fontWeight: "700", whiteSpace: "nowrap" }}>
                              <span style={{ display: "flex", gap: "2px", alignItems: "flex-end" }}>
                                {(w.sev.segs).map((g: any, i_g: number) => (<Fragment key={i_g}>
                                  <span style={{ display: "block", width: "5px", height: `${g.h}px`, boxSizing: "border-box", border: `1.5px solid ${g.bd}`, background: g.c, borderRadius: "1px" }}></span>
                                </Fragment>))}
                              </span>
                              {w.sev.word}
                            </div>
                            )}
                          </div>
                          {!!(w.isTransit) && (<>
                            <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column" }}>
                              {(w.deps).map((dp: any, i_dp: number) => (<Fragment key={i_dp}>
                                <div className="hl" style={{ flex: "1", minHeight: "0", display: "flex", alignItems: "center", gap: "10px", borderTop: "1px dotted #111" }}>
                                  <span style={{ width: "60px", flex: "none", fontSize: "21px", fontWeight: "700", fontVariantNumeric: "tabular-nums", textDecoration: dp.deco }}>{dp.time}</span>
                                  <span style={{ width: "40px", flex: "none", fontSize: "18px", fontWeight: "700", fontVariantNumeric: "tabular-nums" }}>{dp.delay}</span>
                                  <span style={{ flex: "1", minWidth: "0", fontSize: "16px", color: dp.infoColor, fontWeight: dp.infoWeight, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dp.info}</span>
                                </div>
                              </Fragment>))}
                            </div>
                          </>)}
                          {!!(w.isCar) && (<>
                            <div className="hl" style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column", justifyContent: "center", gap: "4px", borderTop: "1px dotted #111" }}>
                              <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}><span className="num" style={{ fontSize: "52px", fontWeight: "700", letterSpacing: "-1.5px", lineHeight: "1", fontVariantNumeric: "tabular-nums" }}>{w.eta}</span><span style={{ fontSize: "20px", fontWeight: "700" }}>min</span><span style={{ fontSize: "17px", color: "#111", marginLeft: "10px" }}>{v.t('arriveIfLeave', w.arrive)}</span></div>
                              <div style={{ fontSize: "16px", color: "#111" }}>{w.vs}</div>
                            </div>
                          </>)}
                          <div className="rt" style={{ flex: "none", borderTop: "2px solid #111", paddingTop: "5px", fontSize: "15px", fontWeight: w.noteWeight, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.note}</div>
                        </div>
                      </>)}

                      {/* firmware updates (OTA from GitHub Releases) */}
                      {!!(w.isOta) && (<>
                        <div style={{ flex: "1", minHeight: "0", padding: "14px 16px", display: "flex", gap: "22px" }}>
                          <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "10px" }}>
                            <div className="lbl" style={{ fontSize: "20px", fontWeight: "700", textTransform: "uppercase" }}>{v.t('firmware')}</div>
                            <div style={{ display: "flex", alignItems: "baseline", gap: "12px", minWidth: "0" }}><span className="num" style={{ fontSize: `${w.fwSize}px`, fontWeight: "700", letterSpacing: "-1px", lineHeight: "46px", minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>v{w.fwShown}</span><span style={{ flex: "none", fontSize: "18px", color: "#111" }}>{v.t('installed')}</span></div>
                            <div className="rt" style={{ borderTop: "2px solid #111", paddingTop: "10px", display: "flex", flexDirection: "column", gap: "4px" }}>
                              <div style={{ fontSize: "26px", fontWeight: "700" }}>{w.statusTitle}</div>
                              <div style={{ fontSize: "18px", lineHeight: "22px", color: "#111", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{w.statusSub}</div>
                            </div>
                            {!!(w.hasNotes) && (<>
                              <div style={{ display: "flex", flexDirection: "column", gap: "4px", minHeight: "0", overflow: "hidden" }}>
                                <div style={{ fontSize: "18px", fontWeight: "700", color: "#111", textTransform: "uppercase" }}>{v.t('otaWhatsNew')}</div>
                                {(w.notes).map((n: any, i_n: number) => (<Fragment key={i_n}>
                                  <div style={{ display: "flex", gap: "8px", fontSize: "18px" }}><span style={{ flex: "none", width: "6px", height: "6px", marginTop: "8px", background: "#111", borderRadius: "50%" }}></span><span>{n.text}</span></div>
                                </Fragment>))}
                              </div>
                            </>)}
                          </div>
                          <div className="rl" style={{ width: "270px", flex: "none", display: "flex", flexDirection: "column", gap: "12px", borderLeft: "2px solid #111", paddingLeft: "20px" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              <div style={{ fontSize: "18px", fontWeight: "700", textTransform: "uppercase" }}>{v.t('otaChannel')}</div>
                              <div style={{ display: "flex", height: "44px", border: "2px solid #111", borderRadius: "8px", overflow: "hidden" }}>
                                {(w.channels).map((c: any, i_c: number) => (<Fragment key={i_c}>
                                  <button className="rr" onClick={c.pick} style={{ flex: "1", border: "0", borderRight: "2px solid #111", background: c.bg, color: c.fg, fontSize: "18px", fontWeight: "700" }}>{c.label}</button>
                                </Fragment>))}
                              </div>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              <div style={{ fontSize: "18px", fontWeight: "700", textTransform: "uppercase" }}>{v.t('otaAutomatic')}</div>
                              <div style={{ display: "flex", height: "44px", border: "2px solid #111", borderRadius: "8px", overflow: "hidden" }}>
                                {(w.autos).map((c: any, i_c: number) => (<Fragment key={i_c}>
                                  <button className="rr" onClick={c.pick} style={{ flex: "1", border: "0", borderRight: "2px solid #111", background: c.bg, color: c.fg, fontSize: "18px", fontWeight: "700" }}>{c.label}</button>
                                </Fragment>))}
                              </div>
                              <div style={{ fontSize: "18px", lineHeight: "22px", color: "#111" }}>{w.autoHint}</div>
                            </div>
                            <div style={{ flex: "1" }}></div>
                            <button className="ink-btn ob" onClick={w.action} style={{ height: "56px", border: "2px solid #111", borderRadius: "8px", background: w.actionBg, color: w.actionFg, fontSize: "20px", fontWeight: "700" }}>{w.actionLabel}</button>
                            <div style={{ fontSize: "18px", color: "#111", minHeight: "22px" }}>{w.actionHint}</div>
                          </div>
                        </div>
                      </>)}

                      {!!(w.dirty) && (<><div className="dirty"></div></>)}
                    </div>
                  </Fragment>))}
                  {/* not linked: one calm card over the ghosted page */}
                  {!!(v.noHa.show) && (<>
                    <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "460px", boxSizing: "border-box", background: "#ECEBE5", border: "3px solid #111", borderRadius: "14px", padding: "22px 24px", display: "flex", flexDirection: "column", gap: "10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 15l6-6M10.5 6.5l1-1a4 4 0 0 1 5.7 5.7l-1 1M13.5 17.5l-1 1a4 4 0 0 1-5.7-5.7l1-1"></path></svg>
                        <div style={{ fontSize: "24px", fontWeight: "700", lineHeight: "1.15" }}>{v.noHa.title}</div>
                      </div>
                      <div style={{ fontSize: "17px", lineHeight: "1.4" }}>{v.noHa.text}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: "14px", marginTop: "4px" }}>
                        <button className="ink-btn" onClick={v.noHa.go} style={{ height: "48px", padding: "0 18px", border: "2px solid #111", borderRadius: "8px", background: "#111", color: "#ECEBE5", fontSize: "16px", fontWeight: "700" }}>{v.t('linkHa')}</button>
                        <span style={{ fontSize: "15px", color: "#111" }}>{v.t('linkHaTime')}</span>
                      </div>
                    </div>
                  </>)}
                </div>
                </>)}
              </div>
            </>)}

            {/* NIGHT FACE */}
            {!!(v.isNight) && (<>
              <div style={{ position: "absolute", inset: "0", background: "#ECEBE5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px" }}>
                <div className="num" style={{ position: "relative", fontSize: "150px", fontWeight: "700", letterSpacing: "-7px", lineHeight: "0.9", fontVariantNumeric: "tabular-nums" }}>{v.clock}{!!(v.timeDirty) && (<><div className="dirty"></div></>)}</div>
                <div style={{ fontSize: "28px", fontWeight: "700" }}>{v.dateText}</div>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", maxWidth: "760px", columnGap: "40px", rowGap: "10px", marginTop: "22px", fontSize: "26px" }}>
                  <span>{v.t('inside')} <b>{v.night.inside}</b></span><span>{v.t('battery')} <b>{v.night.batt}</b></span><span>{v.t('cheapest')} <b>{v.night.cheap}</b></span>
                </div>
                {!!(v.asleepLine || v.nightAsOf) && (<div style={{ fontSize: "18px", color: "#111", marginTop: "10px" }}>{v.asleepLine || v.nightAsOf}</div>)}
                <button aria-label="Show dashboard" onClick={v.peek} style={{ position: "absolute", inset: "0", background: "none", border: "0" }}></button>
              </div>
            </>)}

            {/* FIRST-RUN SETUP (one phone flow: Wi-Fi → Home Assistant → what to show) */}
            {!!(v.isOnboard) && (<>
              <div style={{ position: "absolute", inset: "0", background: "#ECEBE5", padding: "40px 48px", boxSizing: "border-box", display: "flex", gap: "40px", alignItems: "center" }}>
                <div style={{ width: "240px", height: "240px", flex: "none", boxSizing: "border-box", border: "2px dashed #111", borderRadius: "10px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px", textAlign: "center", padding: "16px" }}>
                  <div style={{ fontSize: "20px", fontWeight: "700" }}>[QR CODE]</div>
                  <div style={{ fontSize: "14px", color: "#111" }}>Joins “HA-Paper-Setup” and opens the setup page</div>
                </div>
                <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "14px" }}>
                  <div style={{ fontSize: "38px", fontWeight: "700", letterSpacing: "-0.5px" }}>Welcome to {v.osName}</div>
                  <div style={{ fontSize: "18px", color: "#111" }}>Set it up with your phone. It takes about two minutes.</div>
                  {(v.onboardSteps).map((st: any, i_st: number) => (<Fragment key={i_st}>
                    <div style={{ display: "flex", alignItems: "center", gap: "14px", padding: "8px 0", borderTop: "1px dotted #111" }}>
                      <span style={{ flex: "none", width: "32px", height: "32px", boxSizing: "border-box", border: "2px solid #111", borderRadius: "50%", background: st.bg, color: st.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: "700" }}>{st.mark}</span>
                      <span style={{ display: "flex", flexDirection: "column" }}><span style={{ fontSize: "20px", fontWeight: "700" }}>{st.title}</span><span style={{ fontSize: "15px", color: "#111" }}>{st.sub}</span></span>
                    </div>
                  </Fragment>))}
                  <div style={{ display: "flex", gap: "10px" }}>
                    <button className="ink-btn" onClick={v.onboardSim} style={{ height: "48px", padding: "0 18px", border: "2px solid #111", borderRadius: "8px", background: "#111", color: "#ECEBE5", fontSize: "16px", fontWeight: "700" }}>Simulate phone setup</button>
                  </div>
                </div>
              </div>
            </>)}

            {/* STANDBY */}
            {!!(v.isSleeping) && (<>
              <div style={{ position: "absolute", inset: "0", background: "#ECEBE5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px" }}>
                <div className="num" style={{ position: "relative", fontSize: "150px", fontWeight: "700", letterSpacing: "-7px", lineHeight: "0.9", fontVariantNumeric: "tabular-nums" }}>{v.clock}{!!(v.timeDirty) && (<><div className="dirty"></div></>)}</div>
                <div style={{ fontSize: "28px", fontWeight: "700" }}>{v.dateText}</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", columnGap: "40px", rowGap: "10px", marginTop: "22px", fontSize: "26px" }}>
                  <span>{v.t('solar')} <b>{v.standbySolar}</b></span><span>{v.t('battery')} <b>{v.standbyBatt}</b></span><span>{v.t('price')} <b>{v.standbyPrice}</b></span><span>{v.t('heating')} <b>{v.standbyHeat}</b></span>
                </div>
                <div style={{ fontSize: "18px", color: "#111", marginTop: "10px" }}>{v.asleepLine || v.t('standbyFoot', v.lastUpdate)}</div>
              </div>
            </>)}

            {/* FACTORY RESET? (hardware keys or a crash loop at boot, src/core/recovery.ts) */}
            {!!(v.recoveryOn) && (<>
              <div onPointerDown={v.recoveryTouch} style={{ position: "absolute", inset: "0", zIndex: 5, background: "#ECEBE5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "16px", textAlign: "center" }}>
                <div style={{ fontSize: "40px", fontWeight: "700" }}>{v.t(v.recoveryCrash ? 'recCrashTitle' : 'recTitle')}</div>
                <div style={{ fontSize: "18px", width: "560px" }}>{v.recoveryCrash ? v.t('recCrashLine') + ' ' + v.t('recErasesCrash') : v.t('recErases')}</div>
                <div style={{ fontSize: "22px", fontWeight: "700", marginTop: "10px" }}>{v.t('recPress')}</div>
                <div style={{ fontSize: "16px" }}>{v.t('recAuto')}</div>
              </div>
            </>)}

            {/* UPDATING (OTA in progress) */}
            {!!(v.isUpdating) && (<>
              <div style={{ position: "absolute", inset: "0", background: "#ECEBE5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "18px" }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 19h16"></path></svg>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}><div style={{ fontSize: "36px", fontWeight: "700" }}>{v.t('updatingTo')}</div>{(() => { const f = updVersion(v.t('updVersion', v.upd.version)); return <div style={{ fontSize: `${f.size}px`, fontWeight: "700", whiteSpace: "nowrap" }}>{f.value}</div>; })()}</div>
                <div style={{ width: "520px", height: "26px", border: "2px solid #111", borderRadius: "6px", padding: "3px", boxSizing: "border-box" }}><div style={{ height: "100%", width: `${v.upd.pct}%`, background: "#111" }}></div></div>
                <div style={{ display: "flex", justifyContent: "space-between", width: "520px", fontSize: "18px" }}><span style={{ fontWeight: "700" }}>{v.upd.step}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{v.upd.pct}%</span></div>
                <div style={{ fontSize: "16px", color: "#111" }}>{v.t('updKeepOn')}</div>
              </div>
            </>)}
          </div>

          <div style={{ position: "absolute", inset: "0", pointerEvents: "none", background: v.lightColor, opacity: v.lightOpacity, mixBlendMode: "multiply" }}></div>
          {!!(v.flashing) && (<>
            <div style={{ position: "absolute", inset: "0", background: v.flashColor }}></div>
          </>)}
        </div>
      </div>
    </div>
    </>
  );
}
