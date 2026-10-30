// Guest Wi-Fi tile (#329, core/guestWifi.ts): the QR code in its white quiet zone, the network and password in large
// type. Positions come from guestLayout (tile-relative, the 2 px Classic border included), so the firmware's
// app/ui_guest.cpp draws the same geometry. Pure black / white modules, integer px per module, no smoothing.

export function GuestWifiTile({ w }: { w: any }) {
  const L = w.L; const bw: number = w.bw; const n: number = w.qr ? w.qr.length : 0;
  const at = (x: number, y: number) => ({ position: "absolute" as const, left: `${x - bw}px`, top: `${y - bw}px` });
  let d = '';
  if (w.qr) w.qr.forEach((row: number[], y: number) => row.forEach((m: number, x: number) => { if (m) d += `M${x} ${y}h1v1h-1z`; }));
  return (
    <div style={{ flex: "1", minHeight: "0", position: "relative" }}>
      {w.qr && w.guestSleek && <div style={{ ...at(L.zone.x, L.zone.y), width: `${L.zone.s}px`, height: `${L.zone.s}px`, borderRadius: "18px", background: "#fff" }} />}
      {w.qr && (
        <svg role="img" aria-label="QR code" width={n * L.px} height={n * L.px} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" style={{ ...at(L.qx, L.qy), display: "block" }}>
          <path d={d} fill="#111" />
        </svg>
      )}
      {!w.qr && (
        <div style={{ ...at(L.zone.x, L.zone.y), width: `${L.zone.s}px`, height: `${L.zone.s}px`, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <span style={{ maxWidth: `${L.zone.s - 16}px`, fontSize: "18px", lineHeight: "22px", fontWeight: "700", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{w.msg}</span>
        </div>
      )}
      {L.text && w.rows.map((r: any, k: number) => (
        <div key={k} style={{ ...at(L.text.x, L.text.y + k * 54), width: `${L.text.w}px` }}>
          <div style={{ height: "18px", fontSize: "16px", lineHeight: "18px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.cap}</div>
          <div className="num" style={{ height: "34px", fontSize: "28px", lineHeight: "34px", fontWeight: r.soft ? "400" : "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.val}</div>
        </div>
      ))}
    </div>
  );
}
