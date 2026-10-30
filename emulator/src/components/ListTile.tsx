// List from attributes tile (eink-ha-os#332, core/attrList.ts listView / listRows). Header: the label. Rows below 3 columns: the
// title bold with "how long ago" right, the subtitle under it (50 px pitch); from 3 columns one line per row: title
// column (40 %), subtitle, ago right (28 px pitch). Dotted rules between rows. Foot: the entity's attribution left,
// "+N more" right. Classic: uppercase label; Modern (on its card): sentence case. Firmware app/ui_list.cpp.

export function ListTile({ w }: { w: any }) {
  const sl: boolean = w.listSleek;
  const ell = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
  const rule = (i: number) => (i ? "2px dotted #111" : "2px solid transparent");
  const title = { fontSize: sl ? "18px" : "19px", fontWeight: "700", ...ell };
  const small = { fontSize: "16px", ...ell };
  return (
    <div style={{ flex: "1", minHeight: "0", padding: sl ? "14px 18px 10px" : "10px 14px 8px", display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: sl ? "16px" : "20px", fontWeight: sl ? "600" : "700", textTransform: sl ? "none" : "uppercase", lineHeight: "24px", ...ell }}>{w.label}</div>
      <div style={{ marginTop: "6px", flex: "1", minHeight: "0" }}>
        {!!w.empty && <div style={{ height: "28px", lineHeight: "28px", fontSize: sl ? "17px" : "19px", ...ell }}>{w.empty}</div>}
        {w.rows.map((r: any, i: number) => (w.oneLine
          ? <div key={i} style={{ height: "28px", boxSizing: "border-box", borderTop: rule(i), display: "grid", gridTemplateColumns: "40% 1fr auto", columnGap: "10px", alignItems: "center" }}>
              <span style={title}>{r.title}</span><span style={small}>{r.sub}</span><span style={{ ...small, fontVariantNumeric: "tabular-nums" }}>{r.ago}</span>
            </div>
          : <div key={i} style={{ height: "50px", boxSizing: "border-box", borderTop: rule(i), paddingTop: "4px" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "baseline", height: "24px" }}>
                <span style={{ ...title, flex: "1", minWidth: "0" }}>{r.title}</span><span style={{ ...small, flex: "none" }}>{r.ago}</span>
              </div>
              <div style={{ ...small, height: "20px", lineHeight: "20px" }}>{r.sub}</div>
            </div>))}
      </div>
      {!!(w.attribution || w.more) && (
        <div style={{ flex: "none", height: "22px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "8px", fontSize: "14px" }}>
          <span style={{ minWidth: "0", ...ell }}>{w.attribution}</span><span style={{ flex: "none", fontWeight: "700" }}>{w.more}</span>
        </div>
      )}
    </div>
  );
}
