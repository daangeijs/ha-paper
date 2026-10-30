// Bin day tile (#317, core/bins.ts binsView). 2+ wide: title + TONIGHT / TODAY pill, a bin, the soonest bin big with
// its day line, the later bins along the foot. 1 wide: the soonest bin's name, when (Today / Tomorrow / in N days),
// the date or "Put out tonight". Classic: uppercase title, square pill on a 2 px rule; Modern: card, capsule pill,
// display font. Firmware app/ui_bins.cpp draws the same geometry.

/** A wheelie bin, 40 × 48: lid, handle, hatched body. */
const Bin = ({ sleek }: { sleek: boolean }) => (
  <svg width="40" height="48" viewBox="0 0 40 48" aria-hidden="true" style={{ flex: "none" }}>
    <defs><pattern id={sleek ? "x4-bin-hs" : "x4-bin-hc"} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="4" fill="#111" /></pattern></defs>
    <rect x="14" y="0" width="12" height="6" fill="none" stroke="#111" strokeWidth="2" />
    <rect x="0" y="5" width="40" height="5" fill="#111" />
    <rect x="5.5" y="12.5" width="29" height="34" fill="none" stroke="#111" strokeWidth="3" />
    <rect x="9" y="16" width="22" height="27" fill={`url(#${sleek ? "x4-bin-hs" : "x4-bin-hc"})`} />
  </svg>
);

export function BinsTile({ w, sleek }: { w: any; sleek: boolean }) {
  const titleStyle = sleek
    ? { fontSize: "16px", fontWeight: "600" }
    : { fontSize: "20px", fontWeight: "700", textTransform: "uppercase" as const };
  const pill = w.pill ? (
    <span data-x4-pill="" style={{ flex: "none", height: "28px", boxSizing: "border-box", padding: "0 12px", border: "2px solid #111", borderRadius: sleek ? "14px" : "4px", background: "#111", color: "#fff", display: "flex", alignItems: "center", fontSize: "15px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>{w.pill}</span>
  ) : null;
  const big = sleek ? { fontFamily: "var(--fd)", fontStretch: "var(--fs)" } : {};
  if (!w.wide) return (
    <div style={{ flex: "1", minHeight: "0", padding: sleek ? "14px 16px 12px" : "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "4px" }}>
      <div style={{ ...titleStyle, lineHeight: "24px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.single}</div>
      <div className="num" style={{ ...big, fontSize: sleek ? "calc(28px * var(--fk))" : "28px", fontWeight: "700", lineHeight: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.big}</div>
      <div style={{ fontSize: "18px", fontWeight: w.tonight ? "700" : "400", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.foot}</div>
    </div>
  );
  return (
    <div style={{ flex: "1", minHeight: "0", padding: sleek ? "14px 18px 10px" : "10px 14px 9px", display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ height: "30px", flex: "none", display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ ...titleStyle, flex: "1", minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.title}</span>
        {pill}
      </div>
      <div style={{ flex: "1", minHeight: "0", display: "flex", alignItems: "center", gap: "14px" }}>
        <Bin sleek={sleek} />
        <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "4px" }}>
          <div className="num" style={{ ...big, fontSize: sleek ? "calc(30px * var(--fk))" : "36px", fontWeight: "700", lineHeight: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.head}</div>
          <div style={{ fontSize: "18px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.line}</div>
        </div>
      </div>
      {w.rest.length > 0 && (
        <div className="rt" style={{ flex: "none", borderTop: sleek ? "1px dotted #111" : "2px solid #111", paddingTop: "5px", height: "26px", boxSizing: "border-box", display: "flex", flexWrap: "wrap", columnGap: "16px", fontSize: "16px", lineHeight: "21px", whiteSpace: "nowrap", overflow: "hidden" }}>
          {w.rest.map((r: any, i: number) => (<span key={i} style={{ flex: "none" }}><b>{r.label}</b> {r.when}</span>))}
        </div>
      )}
    </div>
  );
}
