// Screens: drag-and-drop screen builder.
// Markup converted from Main.dc.html (web console section, lines 888–1176).
import { Fragment, type CSSProperties } from 'react';
import type { ConsoleView } from '../useConsole.ts';

const SEARCH: CSSProperties = { flex: "none", height: "34px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "8px", padding: "0 10px", font: "14px 'IBM Plex Sans', sans-serif", background: "#fff" };
const ICON_BTN: CSSProperties = { flex: "none", width: "22px", height: "22px", border: "0", borderRadius: "6px", background: "#ECEBE5", fontSize: "14px", lineHeight: "1", padding: "0" };

export function ScreensTab({ v }: { v: ConsoleView }) {
  return (
    <>
        <div className="x4-screens" style={{ flex: "1", minHeight: "0", display: "flex" }}>
          <div className="x4-list" style={{ width: "250px", flex: "none", boxSizing: "border-box", borderRight: "1px solid #e3e0d9", padding: "14px 12px", display: "flex", flexDirection: "column", gap: "12px", overflow: "auto", background: "#FBFAF8" }}>
            <input type="search" aria-label={v.web.t('searchScreens')} placeholder={v.web.t('searchScreens')} value={v.web.qScreens} onChange={v.web.setQScreens} style={SEARCH} />
            {!!(v.web.noScreenMatch) && (<div style={{ fontSize: "13px", color: "#5c5a55", padding: "0 8px" }}>{v.web.t('noScreenMatch')}</div>)}
            {(v.web.apps).map((a: any) => (<Fragment key={a.id}>
              {!a.hidden && (
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <div draggable="true" onDragStart={a.dragStart} onDragOver={a.dragOver} onDragLeave={a.dragLeave} onDrop={a.drop} title={v.web.t('dragScreensHere')}
                  style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 6px 4px 8px", borderRadius: "8px", background: a.dropBg, cursor: "grab" }}>
                  {a.editing
                    ? <input autoFocus aria-label={v.web.t('categoryName')} defaultValue={a.title} onChange={a.rename} onBlur={a.endEdit} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') a.endEdit(); }} style={{ flex: "1", minWidth: "0", height: "26px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "6px", padding: "0 6px", font: "600 12px 'IBM Plex Sans', sans-serif" }} />
                    : <button onClick={a.startEdit} title={v.web.t('renameCategory')} style={{ flex: "1", minWidth: "0", border: "0", background: "transparent", padding: "0", textAlign: "left", fontSize: "11px", fontWeight: "600", letterSpacing: "1px", textTransform: "uppercase", color: "#5c5a55", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</button>}
                  <span style={{ fontSize: "11px", color: "#8d8a83", flex: "none" }}>{a.count}</span>
                  {!!(a.canDelete) && (<button onClick={a.remove} aria-label={v.web.t('deleteCategoryAria', a.title)} title={v.web.t('deleteCategory')} style={ICON_BTN}>×</button>)}
                  <button onClick={a.addScreen} aria-label={v.web.t('newScreenInAria', a.title)} title={v.web.t('newScreenIn')} style={ICON_BTN}>+</button>
                </div>
                {(a.screens).map((x: any, i_x: number) => (<Fragment key={i_x}>
                  <button draggable="true" onDragStart={x.dragStart} onDragOver={(e) => e.preventDefault()} onDrop={x.drop} onClick={x.pick} style={{ height: "36px", border: "0", borderRadius: "8px", background: x.bg, color: x.fg, padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", font: "500 14px 'IBM Plex Sans', sans-serif", textAlign: "left", cursor: "grab" }}><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.title}</span><span style={{ fontSize: "12px", opacity: "0.6", flex: "none" }}>{x.count}</span></button>
                </Fragment>))}
                {!a.screens.length && !v.web.qScreens && (<div onDragOver={a.dragOver} onDrop={a.drop} style={{ fontSize: "12px", color: "#8d8a83", padding: "6px 10px", border: "1px dashed #d3d0c8", borderRadius: "8px" }}>{v.web.t('emptyDrop')}</div>)}
              </div>)}
            </Fragment>))}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px solid #e3e0d9", paddingTop: "12px" }}>
              <div style={{ display: "flex", gap: "6px" }}>
                <input aria-label={v.web.t('newCategoryName')} placeholder={v.web.t('newCategory')} value={v.web.newApp} onChange={v.web.setNewApp} onKeyDown={(e) => { if (e.key === 'Enter') v.web.addApp(); }} disabled={!v.web.canAddApp} style={{ ...SEARCH, flex: "1", minWidth: "0" }} />
                <button className="dev-btn" onClick={v.web.addApp} disabled={!v.web.canAddApp} style={{ height: "34px", padding: "0 10px", border: "1px dashed #a8a49b", borderRadius: "8px", background: "#fff", fontSize: "13px" }}>{v.web.t('addBtn')}</button>
              </div>
              {!v.web.canAddApp && (<div style={{ fontSize: "12px", color: "#5c5a55" }}>{v.web.appLimit}</div>)}
              {!!(v.web.appMsg) && (<div style={{ fontSize: "12px", color: "#B3261E" }}>{v.web.appMsg}</div>)}
              <div style={{ fontSize: "12px", color: "#8d8a83", lineHeight: "1.4" }}>{v.web.t('categoriesNote')}</div>
            </div>
          </div>

          <div className="x4-main" style={{ flex: "1", minWidth: "0", minHeight: "0", overflow: "auto", padding: "18px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ flex: "none", display: "flex", alignItems: "flex-start", gap: "8px 12px", flexWrap: "wrap" }}>
              <div style={{ flex: "0 1 240px", minWidth: "0", display: "flex", flexDirection: "column", gap: "4px" }}>
                <input aria-label={v.web.t('screenTitle')} aria-invalid={!!v.web.titleErr} aria-describedby={v.web.titleErr ? 'x4-title-err' : undefined} value={v.web.curTitle} onChange={v.web.rename} style={{ width: "100%", height: "38px", boxSizing: "border-box", border: v.web.titleErr ? "1.5px solid #B3261E" : "1px solid #c9c6be", borderRadius: "8px", padding: "0 12px", font: "600 16px 'IBM Plex Sans', sans-serif" }} />
                {!!(v.web.titleErr) && (<span id="x4-title-err" role="alert" style={{ fontSize: "12px", color: "#B3261E" }}>{v.web.titleErr}</span>)}
              </div>
              <div style={{ flex: "1" }}></div>
              <select className={v.web.isValues ? undefined : 'x4-add'} aria-label={v.web.t('addTile')} value="" onChange={v.web.addPick} disabled={v.web.full} title={v.web.t(v.web.full ? 'screenFull' : 'addTileFirst')} style={{ height: "36px", maxWidth: "170px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", padding: "0 8px", font: "13px 'IBM Plex Sans', sans-serif" }}>
                <option value="">{v.web.t('addTileDots')}</option>
                {(v.web.addGroups).map((g: any) => (
                  <optgroup key={g.label} label={g.label}>{(g.items).map((o: any) => (<option key={o.value} value={o.value}>{o.label}</option>))}</optgroup>))}
              </select>
              <span style={{ alignSelf: "center", font: "500 12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>{v.web.capacity}</span>
              <button className="dev-btn" onClick={v.web.deleteScreen} style={{ height: "36px", padding: "0 12px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "13px" }}>{v.web.t('deleteScreen')}</button>
            </div>
            {!!(v.web.pvLine) && (<span role="status" style={{ flex: "none", font: "500 12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>{v.web.pvLine}</span>)}
            <div className="x4-canvas" style={{ flex: "none", height: v.web.isValues ? "410px" : "330px", boxSizing: "border-box", borderRadius: "12px", background: "#ECEBE5", border: "1px solid #d3d0c8", padding: "10px", display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
              {(v.web.cells).map((c: any) => (
                <div key={'c' + c.col + c.row} onDragOver={c.over} onDragLeave={c.leave} onDrop={c.drop} style={{ gridColumn: `${c.col} / span 1`, gridRow: `${c.row} / span 1`, border: c.border, borderRadius: "8px", background: c.bg }}></div>))}
              {(v.web.blocks).map((b: any) => (
                <button key={b.j} type="button" aria-pressed={b.on} aria-label={b.aria} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Delete" className="x4-tile"
                  draggable="true" onDragStart={b.dragStart} onDragOver={v.web.allowDrop} onDrop={b.drop} onClick={b.select} onKeyDown={b.key} style={{ gridColumn: `${b.col} / span ${b.cs}`, gridRow: `${b.row} / span ${b.rs}`, minWidth: "0", minHeight: "0", boxSizing: "border-box", border: b.bad ? "2px solid #B3261E" : b.border, borderRadius: "8px", background: b.bg, padding: b.crop && !b.bad ? "0" : "10px 12px", display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "space-between", textAlign: "left", cursor: "grab", overflow: "hidden" }}>
                  {b.crop && !b.bad
                    // #189: the tile as the display draws it, cut from preview.png (viewBox = its panel rectangle)
                    ? <svg viewBox={b.crop.box} preserveAspectRatio="xMidYMid meet" aria-hidden="true" style={{ display: "block", flex: "1", minHeight: "0", width: "100%", height: "100%" }}><image href={b.crop.url} width="800" height="480" /></svg>
                    : <>
                      <span style={{ display: "block", fontSize: "16px", fontWeight: "600", lineHeight: "1.2", overflow: "hidden" }}>{b.name}</span>
                      <span style={{ display: "block", fontSize: "12px", color: b.bad ? "#B3261E" : "#5c5a55", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.bad ? v.web.t('needsEntity') : b.sub}</span>
                    </>}
                </button>))}
            </div>
            {!!(v.web.canvasMsg) && (
              <div role="alert" style={{ flex: "none", display: "flex", alignItems: "center", gap: "10px", border: "1.5px solid #B3261E", borderRadius: "10px", padding: "8px 12px", color: "#B3261E", fontSize: "14px" }}>
                <span style={{ flex: "1" }}>{v.web.canvasMsg}</span>
                <button onClick={v.web.closeCanvasMsg} aria-label={v.web.t('dismiss')} style={{ border: "0", background: "transparent", color: "#B3261E", fontSize: "16px" }}>×</button>
              </div>)}
            {v.web.unplaced > 0 && (<div style={{ flex: "none", fontSize: "13px", color: "#9A4A00" }}>{v.web.unplaced === 1 ? v.web.t('noRoom1') : v.web.t('noRoomN', v.web.unplaced)}</div>)}
            <div style={{ flex: "none", fontSize: "13px", color: "#5c5a55" }}>{v.web.t('editorHelp')}</div>
            {!!(v.web.hasSel) && (
              <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: "12px", border: "1px solid #d3d0c8", borderRadius: "10px", padding: "12px 14px", background: "#FBFAF8" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  {v.web.hasLabel
                    ? <input aria-label={v.web.t('widgetName')} placeholder={v.web.labelPlaceholder} value={v.web.selLabel} onChange={v.web.setLabel} onBlur={v.web.endLabel} title={v.web.t('widgetNameTitle')} style={{ flex: "1", minWidth: "180px", height: "38px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "8px", padding: "0 12px", font: "600 16px 'IBM Plex Sans', sans-serif" }} />
                    : <span style={{ flex: "1", fontSize: "16px", fontWeight: "600" }}>{v.web.selName}</span>}
                  <button className="dev-btn" onClick={v.web.removeSel} style={{ height: "36px", padding: "0 12px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "13px" }}>{v.web.t('deleteTile')}</button>
                </div>
                <fieldset aria-label={v.web.t('moveTile')} style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", margin: "0", padding: "0", minWidth: "0", border: "0" }}>
                  <span style={{ fontSize: "13px", color: "#5c5a55", marginRight: "4px" }}>{v.web.t('move')}</span>
                  {(v.web.moves).map((m: any) => (<button key={m.aria} onClick={m.pick} aria-label={m.aria} title={m.aria} style={{ width: "34px", height: "32px", border: "1px solid #c9c6be", borderRadius: "6px", background: "#fff", fontSize: "14px" }}>{m.label}</button>))}
                </fieldset>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.t('width')}</span>
                  {(v.web.widths).map((o: any, i_o: number) => (<Fragment key={i_o}><button onClick={o.pick} aria-label={v.web.t('widthN', o.label)} aria-pressed={o.bg === '#1d1d1f'} style={{ width: "34px", height: "32px", border: "1px solid #c9c6be", borderRadius: "6px", background: o.bg, color: o.fg, fontSize: "13px" }}>{o.label}</button></Fragment>))}
                  <span style={{ fontSize: "13px", color: "#5c5a55", marginLeft: "10px" }}>{v.web.t('height')}</span>
                  {(v.web.heights).map((o: any, i_o: number) => (<Fragment key={i_o}><button onClick={o.pick} aria-label={v.web.t('heightN', o.label)} aria-pressed={o.bg === '#1d1d1f'} style={{ width: "34px", height: "32px", border: "1px solid #c9c6be", borderRadius: "6px", background: o.bg, color: o.fg, fontSize: "13px" }}>{o.label}</button></Fragment>))}
                </div>
                {!!(v.web.isRoute) && (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.t('routeMode')}</span>
                    {(v.web.modes).map((o: any, i_o: number) => (<Fragment key={i_o}><button onClick={o.pick} aria-pressed={o.bg === '#1d1d1f'} style={{ height: "32px", padding: "0 10px", border: "1px solid #c9c6be", borderRadius: "6px", background: o.bg, color: o.fg, fontSize: "13px" }}>{o.label}</button></Fragment>))}
                  </div>
                )}
                {!!(v.web.isBars) && (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.t('barsSeries')}</span>
                    {(v.web.seriesOpts).map((o: any, i_o: number) => (<Fragment key={i_o}><button onClick={o.pick} aria-pressed={o.bg === '#1d1d1f'} style={{ height: "32px", padding: "0 10px", border: "1px solid #c9c6be", borderRadius: "6px", background: o.bg, color: o.fg, fontSize: "13px" }}>{o.label}</button></Fragment>))}
                  </div>
                )}
                {!!(v.web.hasSource) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", borderTop: "1px solid #ece9e3", paddingTop: "12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px 10px", flexWrap: "wrap", fontSize: "14px" }}>
                      <span style={{ fontWeight: "600" }}>{v.web.t('source')}</span>
                      <span style={{ font: "500 13px 'IBM Plex Mono', monospace", overflowWrap: "anywhere" }}>{v.web.srcEntity}</span>
                      <span style={{ color: "#5c5a55" }}>· {v.web.srcFrom} ·</span>
                      <button className={v.web.srcOpen ? undefined : 'dev-btn'} aria-expanded={v.web.srcOpen} onClick={v.web.toggleSrc} style={{ height: "28px", padding: "0 10px", border: v.web.srcOpen ? "1px solid #1d1d1f" : "1px solid #c9c6be", borderRadius: "6px", background: v.web.srcOpen ? "#1d1d1f" : "#fff", color: v.web.srcOpen ? "#fff" : "#1d1d1f", fontSize: "12px", fontWeight: "500" }}>{v.web.t('change')}</button>
                      {!!(v.web.srcNowLine) && (<span style={{ marginLeft: "auto", font: "12px 'IBM Plex Mono', monospace", color: "#5c5a55" }}>{v.web.srcNowLine}</span>)}
                    </div>
                    {!!(v.web.srcShared) && (<div role="note" style={{ fontSize: "13px", lineHeight: "1.45", color: "#9A4A00" }}>{v.web.srcShared}</div>)}
                    {!v.web.srcLogical && !!(v.web.entityErr) && (<div id="x4-entity-err" role={v.web.entityErr.hard ? 'alert' : 'status'} style={{ fontSize: "13px", lineHeight: "1.4", color: v.web.entityErr.hard ? "#B3261E" : "#8A5A00" }}>{v.web.entityErr.msg}</div>)}
                    {v.web.srcOpen && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "10px", border: "1px solid #d3d0c8", borderRadius: "10px", background: "#fff", padding: "12px" }}>
                        {v.web.src ? (<>
                          {v.web.src.hasFlip ? (
                            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                              <span style={{ fontSize: "14px", fontWeight: "600" }}>{v.web.t('sign')}</span>
                              <div style={{ display: "flex", border: "1px solid #c9c6be", borderRadius: "8px", overflow: "hidden" }}>
                                {v.web.srcFlips.map((o) => (<button key={o.label} onClick={o.pick} aria-pressed={o.on} style={{ height: "32px", padding: "0 12px", border: "0", background: o.bg, color: o.fg, fontSize: "13px", fontWeight: "500" }}>{o.label}</button>))}
                              </div>
                              <span style={{ fontSize: "12px", color: "#5c5a55" }}>{v.web.src.hint}</span>
                            </div>)
                            : !!(v.web.src.hint) && (<div style={{ fontSize: "12px", color: "#5c5a55" }}>{v.web.src.hint}</div>)}
                          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
                            <span style={{ fontSize: "14px", fontWeight: "600" }}>{v.web.t('haEntity')}</span>
                            <span style={{ fontSize: "12px", color: "#5c5a55" }}>{v.web.t('srcDomains')}</span>
                          </div>
                          <input type="search" aria-label={v.web.t('searchEntities')} placeholder={v.web.t('searchByName')} value={v.web.qSrc} onChange={v.web.setQSrc} style={SEARCH} />
                          {!!(v.web.hasSrcMsg) && (<div role="status" style={{ fontSize: "13px", color: v.web.srcMsgColor }}>{v.web.srcMsg}</div>)}
                          {!!(v.web.entLoading) && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.entStatus}</div>)}
                          {!!(v.web.src.noEntities) && !v.web.src.typed && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.src.noEntitiesText}</div>)}
                          <div role="listbox" aria-label={v.web.t('haEntities')} style={{ flex: "none", maxHeight: "240px", overflow: "auto", display: "flex", flexDirection: "column", gap: "3px" }}>
                            {!!(v.web.src.typed) && (
                              <button role="option" aria-selected={false} onClick={v.web.src.useTyped} style={{ flex: "none", minHeight: "44px", border: "1px dashed #a8a49b", borderRadius: "8px", background: "#fff", padding: "4px 10px", display: "flex", alignItems: "center", textAlign: "left", fontSize: "14px" }}>
                                {v.web.t('useTyped')} <span style={{ fontFamily: "'IBM Plex Mono', monospace", marginLeft: "6px" }}>{v.web.src.typed}</span>
                                {!!(v.web.src.typedNote) && (<span style={{ marginLeft: "auto", paddingLeft: "10px", fontSize: "12px", color: "#8A5A00" }}>{v.web.src.typedNote}</span>)}
                              </button>)}
                            {v.web.srcEntities.map((en) => (
                              <button key={en.id} role="option" aria-selected={en.on} onClick={en.pick} style={{ flex: "none", minHeight: "44px", border: "1px solid #e3e0d9", borderRadius: "8px", background: en.bg, color: en.fg, padding: "4px 10px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left" }}>
                                <span style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column" }}>
                                  <span style={{ fontSize: "14px", fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{en.name}</span>
                                  <span style={{ font: "11px 'IBM Plex Mono', monospace", color: en.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{en.id}</span>
                                </span>
                                {!!(en.value) && (<span style={{ flex: "none", maxWidth: "45%", font: "12px 'IBM Plex Mono', monospace", color: en.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{en.value}</span>)}
                              </button>))}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                            <button className="dev-btn" onClick={v.web.src.auto} disabled={!v.web.src.manual} style={{ height: "32px", padding: "0 12px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "13px", opacity: v.web.src.manual ? 1 : 0.5 }}>{v.web.t('useAuto')}</button>
                            <span style={{ flex: "1", minWidth: "200px", fontSize: "12px", color: "#5c5a55", lineHeight: "1.4" }}>{v.web.src.note}</span>
                            <button className="dev-btn" onClick={v.web.closeSrc} style={{ height: "32px", padding: "0 14px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "13px" }}>{v.web.t('srcDone')}</button>
                          </div>
                        </>) : (<>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
                            <span style={{ fontSize: "14px", fontWeight: "600" }}>{v.web.t('haEntity')}</span>
                            <span style={{ fontSize: "12px", color: "#5c5a55" }}>{v.web.pickerHint}</span>
                          </div>
                          <input type="search" aria-label={v.web.t('searchEntities')} aria-describedby={v.web.entityErr ? 'x4-entity-err' : undefined} placeholder={v.web.t('searchByName')} value={v.web.qEntity} onChange={v.web.setQEntity} style={SEARCH} />
                          {!!(v.web.entLoading) && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.entStatus}</div>)}
                          {!!(v.web.noEntities) && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.noEntitiesText}</div>)}
                          {!!(v.web.entCut) && (<div role="status" style={{ fontSize: "12px", color: "#5c5a55" }}>{v.web.entCut}</div>)}
                          <div role="listbox" aria-label={v.web.t('haEntities')} style={{ flex: "none", height: "240px", overflow: "auto", display: "flex", flexDirection: "column", gap: "3px" }}>
                            {v.web.entities.map((en) => (
                              <button key={en.id} role="option" aria-selected={en.on} onClick={en.pick} style={{ flex: "none", minHeight: "44px", border: "1px solid #e3e0d9", borderRadius: "8px", background: en.bg, color: en.fg, padding: "4px 10px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left" }}>
                                <span style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column" }}>
                                  <span style={{ fontSize: "14px", fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{en.name}</span>
                                  <span style={{ font: "11px 'IBM Plex Mono', monospace", color: en.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{en.id}</span>
                                </span>
                                <span style={{ flex: "none", maxWidth: "45%", font: "12px 'IBM Plex Mono', monospace", color: en.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{en.value}</span>
                              </button>))}
                          </div>
                          {!v.web.srcForced && (<div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <button className="dev-btn" onClick={v.web.closeSrc} style={{ height: "32px", padding: "0 14px", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", fontSize: "13px" }}>{v.web.t('srcDone')}</button>
                          </div>)}
                        </>)}
                      </div>)}
                  </div>)}
                {!!(v.web.hasListPicker) && (<>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "14px", fontWeight: "600" }}>{v.web.listTitle}</span>
                    <span style={{ fontSize: "12px", color: "#5c5a55", flex: "1" }}>{v.web.listCount}</span>
                    {!!(v.web.listPicked) && (<button onClick={v.web.clearList} style={{ height: "28px", padding: "0 10px", border: "1px solid #c9c6be", borderRadius: "6px", background: "#fff", fontSize: "12px" }}>{v.web.listShowAll}</button>)}
                  </div>
                  <input type="search" aria-label={v.web.listSearch} placeholder={v.web.listSearch} value={v.web.qEntity} onChange={v.web.setQEntity} style={SEARCH} />
                  {!!(v.web.entLoading) && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.entStatus}</div>)}
                  {!!(v.web.listEmpty) && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.noEntitiesText}</div>)}
                  <fieldset aria-label={v.web.listTitle} style={{ margin: "0", padding: "0", minWidth: "0", border: "0", flex: "none", height: "280px", overflow: "auto", display: "flex", flexDirection: "column", gap: "3px" }}>
                    {(v.web.listGroups).map((g: any) => (<Fragment key={'g:' + g.area}>
                      {!!(g.name) && (<div style={{ flex: "none", display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", fontSize: "13px", fontWeight: "600" }}>
                        <span style={{ flex: "1" }}>{g.name}</span>
                        {!!(g.area) && (<label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: "400", color: "#5c5a55" }}><input type="checkbox" checked={g.on} onChange={g.toggle} aria-label={g.name + ': ' + v.web.listAreaLabel} />{v.web.listAreaLabel}</label>)}
                      </div>)}
                      {(g.rows).map((r: any) => (
                        <label key={r.id} style={{ flex: "none", minHeight: "40px", border: "1px solid #e3e0d9", borderRadius: "8px", padding: "4px 10px", display: "flex", alignItems: "center", gap: "10px", opacity: r.viaArea ? 0.6 : 1 }}>
                          <input type="checkbox" checked={r.on} disabled={r.viaArea} onChange={r.toggle} />
                          <span style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column" }}>
                            <span style={{ fontSize: "14px", fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                            <span style={{ font: "11px 'IBM Plex Mono', monospace", color: "#5c5a55", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.id}</span>
                          </span>
                        </label>))}
                    </Fragment>))}
                  </fieldset>
                </>)}
              </div>)}
          </div>

          {!v.web.isValues && (
          <div className="x4-side" style={{ width: "250px", flex: "none", boxSizing: "border-box", borderLeft: "1px solid #e3e0d9", padding: "16px 14px", display: "flex", flexDirection: "column", gap: "12px", overflow: "auto", background: "#FBFAF8" }}>
            <div style={{ fontSize: "14px", fontWeight: "600" }}>{v.web.t('widgets')}</div>
            <input type="search" aria-label={v.web.t('searchWidgets')} placeholder={v.web.t('searchWidgets')} value={v.web.qPalette} onChange={v.web.setQPalette} style={SEARCH} />
            {!!(v.web.noPalette) && (<div style={{ fontSize: "13px", color: "#5c5a55" }}>{v.web.t('noWidgetMatch')}</div>)}
            {(v.web.groups).map((g: any, i_g: number) => (<Fragment key={i_g}>
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                <div style={{ fontSize: "11px", fontWeight: "600", letterSpacing: "1px", textTransform: "uppercase", color: "#5c5a55" }}>{g.label}</div>
                {(g.items).map((it: any, i_it: number) => (<Fragment key={i_it}>
                  <div draggable="true" onDragStart={it.dragStart} style={{ height: "34px", boxSizing: "border-box", border: "1px solid #c9c6be", borderRadius: "8px", background: "#fff", padding: "0 6px 0 10px", display: "flex", alignItems: "center", gap: "8px", cursor: "grab", fontSize: "13px" }}>
                    <span style={{ flex: "1", minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
                    <button onClick={it.add} aria-label={v.web.t('addNamed', it.label)} style={{ width: "24px", height: "24px", border: "0", borderRadius: "6px", background: "#ECEBE5", fontSize: "15px", lineHeight: "1" }}>+</button>
                  </div>
                </Fragment>))}
              </div>
            </Fragment>))}
          </div>)}
        </div>
    </>
  );
}
