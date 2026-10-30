# Display styles (Classic + Sleek): integration plan

Status: plan + feasibility proof, 2026-10-14. **Firmware side implemented the same day** (owner decisions at the end):
`src/app/ui_sleek.cpp`, `src/app/gfx/style.h`, fonts via `tools/fontgen.py`, deviations in `firmware/DEVIATIONS.md`
("Display styles"). The proof code (`tools/sleek_proof.*`, `tools/sleek_fontgen.py`) and its `sleek_[a-d]_*.png`
images are gone; `tools/render.sh` now writes `test/out/sleek_<typeface>_<page>.png`. §2 below is historical.
Input: the display-styles package (`handoff/x4-display-styles/`, removed 2026-10-16; last in commit `c7393ae`). The package assumes an ESP-IDF C stack
(`ui/style.h`, `ui/theme_*.c`). This plan maps it onto what we actually have: the React emulator (`emulator/`) and the
Arduino/PlatformIO firmware with a 2-bit `Canvas` (`firmware/src/app`).

Six decisions belong to the owner. They are listed at the end with a recommendation each; **none of them is decided
in code**. Until they are, every place that depends on one carries a `TODO(display-styles OQn)`.

---

## 1. Headline findings

1. **On this hardware, partial refresh is black/white only.** `firmware/src/hw/x4_display.h`: a partial refresh
   thresholds gray (dark gray → black, light gray → white) until the next full refresh. Sleek's card surface (SURF),
   its tracks and future bars (G2) and much of its secondary text (G1) are gray. So in Sleek, **every partial redraw of
   a card turns that card's surface white** while its neighbours keep their gray from the last full refresh, until the
   next full refresh (`fullEvery`, default 8). This affects OQ1 and OQ6 more than anything in the package's
   `EINK_NOTES.md`, which assumes a 4-gray panel. Proof images below.
2. **Our firmware's region signatures are computed from the drawing, not from a view model.** The package's rule
   ("diff on `vm()`, never on skinned output") cannot hold literally in the firmware, because the firmware has no
   `vm()`. It does not need to: see §3.2. Recommended guard: a Classic-vs-Sleek region parity test.
3. **Fonts fit easily.** One Sleek typeface at all card sizes is 166–183 KB with our 2-bit `fontgen` pipeline;
   with the fallback screens it is at most ~400 KB. All four plus Atkinson stays under 4 MB of a 6.25 MB app slot.
4. **The rendering itself is fine.** The proof renders the Sleek Home page through our `Canvas` + fontgen glyph format
   and matches the browser rendering of the package markup to within a few pixels.

---

## 2. Feasibility proof (done)

`firmware/tools/sleek_proof.sh` builds `tools/sleek_proof.cpp` against `src/app/gfx/canvas.cpp` + generated
fonts/icons only. It does not link `app.cpp` or any `ui_*.cpp`, and the existing renderers' output is unchanged.
Fonts come from `tools/sleek_fontgen.py`, which reuses `fontgen.render_glyph`/`pack` and cuts static instances from
`assets/fonts/Archivo[wdth,wght].ttf` (SIL OFL 1.1, `assets/fonts/OFL-Archivo.txt`) with fontTools. The generated
font file goes to `.pio/render/` (not committed). It renders the default Home page in Sleek/Archivo at 13:00 with the
demo data: top bar with pager capsule, clock hero, price with 24 h strip, Inside, Solar and Home use with spark bars,
battery ring, Grid.

| File (`firmware/test/out/`) | SURF mapping | Full refresh | After a partial refresh (B/W) |
|---|---|---|---|
| `sleek_a_level2.png` | light gray (level 2) | Cards clearly visible. Every G2-on-card element disappears: ring track, future spark bars, "normal" price cells. | Card surfaces turn white. |
| `sleek_b_dither.png` | 25 % ordered dither of level 2 on paper | Closest to the design. Everything stays visible. Text over dither picks up some edge noise at 14 px. | Card surfaces turn white (dither pixels are level 2). |
| `sleek_c_outline.png` | paper + 1 px G2 outline | Reads like Classic-lite. PAPER-on-card elements disappear: the "Cheap" chip, the pager's Previous circle, the cheap price cells. | Outline gone (G2 → white). Cards lose their shape. |
| `sleek_d_inkdots.png` | 1-in-16 black dot screen (extra option, pure B/W) | Card tone comes out about right (luma ≈ 222 vs SURF 220). Visible dot texture. Dots collide with 12–14 px text. | **Unchanged.** The only mapping that survives partial refresh. |

Also: `sleek_*_partial.png` (each frame thresholded the way `X4Display::partialRefresh` does),
`sleek_design_ref.png` (the package's card markup in headless Chromium with the emulator's `grayscale(1)` filter),
`sleek_compare.png` / `sleek_compare_partial.png` (side by side).

What the partial views show, for every option: G2 elements (ring track, future spark bars, normal price cells,
the weekday/date and axis labels on the black clock card) vanish, and G1 text turns black. That part is independent of
SURF. Sleek needs B/W-safe versions of its tracks either way, or a different partial-refresh strategy (§6, R1).

Other notes from the proof:
- Layout from the spec (grid 2/14/14/14, gap 10, top bar 64) lands within ~2 px of the browser.
- Our glyphs are lighter than the browser's at 12–16 px (Pillow coverage quantised to 2 bits, no hinting). The weekday
  and date on the clock card look thin. Check on the panel; maybe text 600 → 700, 400 → 500.
- 24 price cells in a 153 px strip are 5 or 6 px wide, so the widths alternate visibly. Spark bars likewise (24 in
  153 px with 2 px gaps). Either accept it or make the strip width a multiple of 24.
- Naive nearest-level quantisation of SURF (luma 220) gives **paper** (236), not light gray (168). Any "automatic"
  mapping would silently pick option C without the outline.

Run: `cd firmware && tools/sleek_proof.sh` (needs clang++ and `.venv` with Pillow + fontTools).
Budget: `../.venv/bin/python tools/sleek_fontgen.py budget [FONTDIR]`.

---

## 3. Architecture: where the skin goes

### 3.1 Emulator (`emulator/`)

The package's `Main.dc.html` is the old single-file emulator. Port its changes (docs/CHANGES.md of the package) into the
React port:

| Package piece | Our file | Change |
|---|---|---|
| `skin(v, s, h, mins)`, `SK_ICON`, `SK_FONTS` | **new** `emulator/src/core/skin.ts` | Pure function `skin(v, look, h, mins)` + tables; unit tests next to it (`skin.test.ts`). |
| state `look` | `emulator/src/emulator/Emulator.tsx` (`EmuState`, initial state ~line 80) | `look: 'classic' \| 'archivo' \| …`. Default is OQ4. |
| skin applied | `Emulator.tsx` render values, where `widgets = sc.widgets.map(... this.vm(...))` (~lines 945–952) | `.map(v => skin(v, s.look, h, mins))` **for rendering only**. |
| diffing | `Emulator.tsx` `regions()` (line 365) and `commit()` (376) | **Unchanged.** They call `vm()` only, so diffing stays on the view model, as the package requires. |
| `renderVals()` additions | `Emulator.tsx` render values | `isSleek`, `isClassic`, `lookClass`, fonts (`--fd`, `--fs`, `--fk`), `weekday`, `dayMonth`, `pageDots`, `pagesBgS`. |
| Sleek top bar + 11 card templates | `emulator/src/components/Device.tsx` | Add `sStat … sSetting` blocks next to the `isStat …` blocks (line 128 on); Sleek bar next to the Classic bar (~line 45). |
| `sleek-fallback.css` | `emulator/src/styles.css` | Under `.look-sleek`. Its selectors match inline style strings (`[style*="border: 2px solid #111"]`). React sets styles through the CSSOM, and browsers re-serialise colours as `rgb(17, 17, 17)`, so these selectors probably won't match. Replace them with class names on the few elements involved. |
| Simulation › Display style | `emulator/src/components/SidePanel.tsx` | One row like the existing render options; pick → `fullRefresh('style')`. |
| Google Fonts link | `emulator/index.html` | Archivo (wdth 62–125), Bricolage, Fraunces, Geist; only the faces that ship, after OQ2. |

Additional emulator work this plan recommends (not in the package):
- **Panel preview.** The emulator's "4-gray" mode is CSS `grayscale(1)`. Add a true 4-level quantise (SVG
  `feComponentTransfer type="discrete"`) and, for regions redrawn by a partial refresh, a B/W threshold overlay until
  the next full refresh. Without this the emulator hides finding 1, and the emulator is our behaviour spec.
- **Known divergence to record in `emulator/DEVIATIONS.md`:** `skin()` reads the hour and minute, which `vm()` does
  not contain. In the emulator a stat card's spark bars therefore don't redraw on the hour unless the value also
  changed. The firmware will redraw them (§3.2). The firmware is right here; note it rather than copy it.

**Installed state.** We already have it (`installedSim()`, `Emulator.tsx:321`). Differences from the package's
version: the package sets `idx` to the `overview` screen and `sub: 0` directly (ours relies on `boot()` resetting to
`idx: 0`, which is the overview only while it is the first screen), replaces `wifi.saved` with `['HomeNet']` (ours
appends), opens the console on the Screens tab (we only set `session.signedIn`), and logs different text. None of these
change behaviour with the default config. Optional: adopt the `findIndex('overview')`. No other change needed.

### 3.2 Firmware (`firmware/src/app`): signatures are post-skin, and that is acceptable

Verified in the code:
- `App::Impl::build()` (`app.cpp:201`) creates one `RegionDef {key, rect, draw}` per tile / list row / bar.
- `App::Impl::signatures()` (`app.cpp:260`) runs each `draw` lambda against a `Canvas(nullptr)` with
  `setRecord(&sig)`. Every primitive appends a text record in `Canvas::rec()` (`gfx/canvas.cpp`: `F…` fill,
  `B…` box, `T…` text with size/weight/colour/string, `I…` icon, …). That string is the region signature.
- `commit()` (`app.cpp:340`) diffs those strings (`changedRegions`), and `partialRefresh()` redraws the changed rects.

So the firmware's signatures are computed **from the drawn output**. There is no view model to diff, and any skin
necessarily runs inside the painters, i.e. before the signature is taken. They are **not** pre-skin, and cannot be
without a model layer.

Why this is acceptable: the property the package actually wants is "a style switch costs one full refresh; after
that, Sleek causes the same partial refreshes as Classic". With draw-op signatures that holds when:
1. **A style or typeface change triggers `fullRefresh("style")`, never `commit()`.** Today `setCfg()` (`app.cpp:748`)
   ends in `settingsChanged(); commit("setting")`, and `App::setSettings()` (PUT /settings) also commits. With a style
   change, `commit()` would see every region changed and do a whole-page partial. Both need a style special case.
2. **Sleek painters keep the Classic region keys and rects** (`t<i>`, `h<i>`, `z:<zone>`, `l:<light>`, `r:<room>`).
   The package already requires this ("each room card is one redraw region").
3. **Sleek painters read only the same inputs as their Classic counterpart, plus the hour/minute.** The only
   additional time-dependence is the spark "now" bar and price-strip "now" cell (hourly) and the clock's day-progress
   bar (per minute, inside the clock region that redraws every minute anyway). Those redraws are correct, not noise.

Rejected alternative: split each painter into `model()` + `paintClassic()/paintSleek()` and hash the model, to mirror
the emulator literally. About 1–2 days of refactoring `ui_tiles.cpp`/`ui_system.cpp` with no visible gain.

Guard instead: a native test in `test/test_app` that applies the same scripted data changes (one zone setpoint, one
light, a price hour, a minute tick) to an App in Classic and one in Sleek, and asserts **identical changed-region key
sets**, with the hourly spark case as the one documented exception. That makes "diffing doesn't depend on the style" a
test instead of a structural promise.

### 3.3 Firmware changes, file by file

| Area | File(s) | Change |
|---|---|---|
| Style value | **new** `src/app/style.h` | `enum class Look : uint8_t {Classic, Archivo, Bricolage, Fraunces, Geist}`; `struct StyleMetrics` (top bar 58/64, grid padding, gap, cell size, tile radius, `fk`). |
| Palette (OQ1 as one table) | `src/app/gfx/canvas.h/.cpp` | `Ink` is the raw 2-bit level; keep it. Add `enum class Tone {Ink, G1, G2, Surf, Paper}` and a `ToneMap` table `{level, pattern}`; `fill`/`box`/`circle` overloads that take a `Tone` and do the pattern fill. Record the tone code in `rec()`. The SURF decision becomes one table row, as `EINK_NOTES.md` asks. |
| Grid | `src/core/logic.h:31`, `logic.cpp:51` `gridRects()`; `app.cpp:227–255` (never-linked and empty-screen rects) | `gridRects(const Screen&, const GridMetrics& = kClassicGrid)`. Sleek: bar 64 with no rule, padding 2/14/14/14, gap 10, cells 185.5 × 195 (alternate 186/185 px as the proof does). The default argument keeps every Classic test and test vector unchanged. Emulator counterpart: `gridLayout` in `emulator/src/core`. |
| Fonts | `src/app/gfx/font.h`, `canvas.cpp findFont()`, `tools/fontgen.py`, `src/app/gen/fonts*.cpp` | `FontData` and `Font` gain a `face`. `findFont(face, weight, size)`. `fontgen.py` SPECS gain a face column and variable-font instancing (`tools/sleek_fontgen.py` already has the code). One generated file per face; a build flag selects the faces (OQ2). Add a test that every (face, weight, size) a Sleek painter asks for exists **exactly**: `findFont()` silently falls back to the nearest size today. |
| Cards | **new** `src/app/ui_sleek.cpp`; dispatch in `ui_tiles.cpp:393 tile()` | `if (a.look != Look::Classic && sleek::tile(c, a, w, r)) return;` for stat, clock, price, gauge, bars, thermo, light, scene, setting. Classic painters untouched, so Classic stays pixel-identical (`render.sh` PNGs and the signature tests prove it). |
| Lists | `ui_tiles.cpp:454–511` (`zoneRow`, `lightHeaderRow`, `lightRow`, `listRegions`) | Sleek row painters (room cards 5 × 2, light capsules) with the **same keys and rects**. Room cards are a 5 × 2 grid instead of Classic's rows, so the rects differ by style but the keys don't. |
| Top bar | `ui_chrome.cpp:55 topBar()`; `app.cpp:216` bar region height | Sleek bar (title button, battery bar, clock in display face, pager capsule with dots). |
| Fallback screens | `ui_chrome.cpp:20–46` (`tileFrame`, `button`, `roundButton`, `label`), `ui_system.cpp` | Style-aware helpers: borderless SURF cards, sentence-case labels, paper pills. Most of `sleek-fallback.css` maps onto these four helpers, which is why OQ5's "keep Classic layout" option is cheap. |
| Style switch | `app.cpp:598 settingsChanged()`, `app.cpp:748 setCfg()`, `App::setSettings()` | `fullRefresh("style")` when look changes. |
| Ghosting | `app.cpp:303 partialRefresh()` | Optional: full refresh when > 50 % of the page flips between black and white (package `EINK_NOTES.md` §3). |

### 3.4 Settings, API, YAML

Recommended placement (OQ3): a device setting, next to the other display settings.
- `firmware/src/app/app.h:14 DisplaySettings`: `std::string style = "classic"` (+ `typeface` only if OQ2 ships more
  than one).
- `firmware/src/net/storage.cpp:180–250` `settingsToJson` / `settingsFromJson` (422 message `display.style must be …`).
- `firmware/src/net/web_server.cpp` GET/PUT `/api/v1/settings` (already passes `DisplaySettings` through).
- `spec/openapi.yaml:315` settings `display` schema.
- `emulator/src/core/settings.ts`: `DisplaySettings`, `DISPLAY_FIELDS`, `displayError()`, `cfgToDisplay`/`displayToCfg`.
- Web console: `emulator/src/webconsole/pages/DeviceTab.tsx` (renders from `DISPLAY_FIELDS`).
- Device: Settings › Display gets a `setting` widget `key: style` → `firmware/src/core/catalog.cpp:74` (label),
  `config.cpp` default Display screen, `spec/SCHEMA.md:58` key list, emulator `data.ts SETTINGS`, `app.cpp setCfg()`.
- If OQ3 = also YAML: `display: {style, typeface}` in `spec/SCHEMA.md`, both parsers (`emulator/src/core/config.ts`,
  `firmware/src/core/config.cpp`) and new `spec/test-vectors/`. More work, and a config push would then change the look.

---

## 4. Fonts budget

Measured with `tools/sleek_fontgen.py budget` (same 2 bpp format and charsets as `fontgen.py`: digits-only above
44 px, letters for titles/room names, full Latin-1 for text). Display sizes are the token sizes × the face's `fk`,
rounded. Text sizes: 600 at 12, 13, 14, 15, 16, 17, 20 px; 400 at 12–16 px.

| Typeface | Display sizes (px) | Display | Text | **Cards total** |
|---|---|---|---|---|
| Archivo (condensed display, `fk` 1.12) | 20, 22, 25, 27, 30, 34, 38, 43, 45, 54, 63, 65, 69, 116, 168 | 106 KB | 77 KB | **183 KB** |
| Bricolage Grotesque (`fk` 0.92) | 17 … 138 | 90 KB | 76 KB | **166 KB** |
| Fraunces display + Geist text (`fk` 0.95) | 17 … 142 | 100 KB | 78 KB | **177 KB** |
| Geist (`fk` 0.92) | 17 … 138 | 98 KB | 78 KB | **176 KB** |

Fallback screens (travel, updates, Wi-Fi, HA, About) in Sleek use the Sleek face at the Classic sizes. Upper bound:
Atkinson's whole Classic set, 390 KB, so **≤ ~400 KB per face including fallback screens**, realistically ~250 KB
because Sleek and Classic text sizes overlap.

| Scenario | Fonts | Firmware (today 2,306,710 B incl. 390 KB fonts) | App slot 6.25 MB |
|---|---|---|---|
| Classic only (today) | 390 KB | 2.3 MB | 35 % |
| Classic + 1 Sleek face | +180 … 400 KB | 2.5 – 2.7 MB | 40 – 43 % |
| Classic + all 4 faces | +0.7 … 1.6 MB | 3.0 – 3.9 MB | 48 – 62 % |

Flash is not the constraint. The costs of four faces are OTA download size and four times the visual QA on the panel.
Licences: all four are SIL OFL 1.1. Keep `OFL-*.txt` next to the TTFs in `firmware/assets/fonts/` (Archivo's is in).

---

## 5. Milestones and effort

Estimates are for one person (or one agent with review) who knows this codebase. Panel time is extra.

| # | Milestone | Effort |
|---|---|---|
| M0 | Owner answers OQ1–6. One hardware test first: Sleek Home page full refresh, then partial refreshes of one card, photographed (§6, R1). | 0.5 d + device |
| M1 | Emulator: `skin.ts` + tests, `look` state, Display style row, Sleek top bar, 11 card templates, fallback CSS, panel-preview mode (4-level + B/W after partial). | 2 d |
| M2 | Firmware foundation: `style.h`, `Tone` palette table, `GridMetrics` in `gridRects`, `Font.face` + multi-face `fontgen.py`, settings plumbing (DisplaySettings, storage, API, openapi, console, Settings screen), style switch = full refresh, parity test. | 2 d |
| M3 | Firmware cards: top bar, stat (+spark), clock, price, gauge ring, bars chart. `render.sh` gets Sleek snapshots. | 1.5 d |
| M4 | Firmware: thermo dial, room cards, light capsules, favourite light, scene, setting stepper. | 2 d |
| M5 | Fallback styling (system tiles, app switcher, ghost, link card, setup screens). | 1 d |
| M6 | Panel tuning: B/W-safe tracks (per OQ1/OQ6), text weights, strip widths; `make qemu-contract` for the API field. | 1 d + device |

Total ≈ **10 working days** for Classic + one Sleek face; each extra face ≈ +0.5 d (fontgen entry, `fk` check,
snapshots, panel look). The proof code (`tools/sleek_proof.cpp`) is a head start for M3: its stat/clock/price/ring
geometry is what `ui_sleek.cpp` needs, minus the hard-coded values.

---

## 6. Risks

- **R1. Gray does not survive partial refresh (high).** Covered above. Mitigations, best first: (a) find out on the
  device whether the controllers can do a windowed partial with the gray overlay (the display library's partial mode
  is already "experimental" and untested on hardware, `docs/STATUS.md`); (b) make Sleek B/W-safe: SURF as a pure B/W
  pattern (option D) or outline (C with a G1/ink outline, which goes to black instead of vanishing), tracks as
  outlined or hatched shapes; (c) in Sleek, upgrade any partial that touches a gray card to a full refresh. That costs
  a black flash on every data change and is not recommended.
- **R2. Some controller batches have no gray at all.** `X4Display::begin()` sets `gray_ = false` when the controller
  doesn't advertise overlay grayscale, and then every refresh is B/W. Sleek on such a device looks like the
  `_partial` images all the time.
- **R3. Ghosting from big black cards** (clock hero, heating rooms, lights on) on partial refresh. Keep `fullEvery`;
  consider the "> 50 % flips" full-refresh rule.
- **R4. Thin small text.** 12–14 px at weight 400 rasterised to 2 bits is lighter than in the browser. Tune on the panel.
- **R5. Silent font fallback.** `findFont()` picks the nearest size, so a missing Sleek size renders slightly wrong
  instead of failing. Mitigated by the exact-size test in M2.
- **R6. Emulator ≠ firmware on hourly spark redraw** (§3.1). Documented, low impact.
- **R7. Concurrent edits.** M2 touches `storage.cpp`, `web_server.cpp`, `openapi.yaml` and the console. Coordinate
  with whoever is in `src/net/` at the time.

---

## 7. Open questions for the owner (Daan), with recommendations

Recommendations only. Not implemented, not decided.

**OQ1. Card surface on the panel: light gray, dithered, or white with an outline?**
→ *Needs owner decision.* Recommendation: don't pick from A/B/C as posed. On this hardware all three lose the card on
every partial refresh (finding 1). First run the M0 device test. If windowed gray partial refresh works, choose **B
(25 % dither)**: it is closest to the design (`sleek_compare.png`) and keeps G2 elements visible. If it doesn't, choose
a B/W-stable mapping: **D (1-in-16 black dots)** if the texture looks acceptable on the panel, otherwise **C with a
1 px G1 outline** (turns black on partial instead of vanishing). PAPER-on-card controls then need their own outline.

**OQ2. Which typeface(s) ship: one fixed, or all four with a picker?**
→ *Needs owner decision.* Recommendation: **one, Archivo** (the design's default). Its condensed numerals are what
let "20.4 °C" and "€0.18" sit at 63–69 px in a 185 px card. Flash would allow all four (§4), but each face is another
round of panel tuning, and differences between faces shrink at 2 bits. Keep the face as a table entry so adding one
later is a fontgen line and a build flag.

**OQ3. Where does the style live: device setting only, or also `screens.yaml` and `/api/v1/config`?**
→ *Needs owner decision.* Recommendation: **device setting only** (`display.style` in `/api/v1/settings`, the console's
Device tab and Settings › Display). `screens.yaml` describes what is shown; the look belongs to this display, like
brightness. The settings path already has validation, a 422 contract and a Settings-screen widget. YAML would add
parser work in two languages, new test vectors, and a config push that can change the look as a side effect.

**OQ4. Default for new devices: Classic or Sleek?**
→ *Needs owner decision.* Recommendation: **Classic** until Sleek has been seen on a real panel (R1, R2). Existing
devices keep Classic after an OTA in any case, so an update never changes the look on its own. Revisit after M6.

**OQ5. Remaining screens (travel, updates, Wi-Fi, HA, About): Sleek designs, or Classic layout + Sleek typeface?**
→ *Needs owner decision.* Recommendation: **Classic layout with the Sleek face and helpers** for v1. These are setup
and system screens seen rarely, the fallback is about one day (M5) because it goes through four shared helpers, and
it can be replaced screen by screen once there are designs.

**OQ6. Must Sleek work in 1-bit?**
→ *Needs owner decision.* Recommendation: **yes, it must at least be legible in black/white.** On this device B/W is
not an edge case: every partial refresh is B/W until the next full one (R1), and some controller batches have no gray
at all (R2). Concretely: no information carried only by G2 (tracks, future bars, normal price cells, the clock card's
date/axis), and a SURF mapping from OQ1 that keeps card shapes in B/W.

## Owner decisions (2026-10-14, Daan)

1. Card surface: build both B (25 % level-2 dither) and D (1-in-16 black dots) behind one palette entry; choose on the real panel after testing gray partial refresh.
2. Typefaces: all four (Archivo, Bricolage, Fraunces, Geist) with a picker on the device and in the web console.
3. Style is a device setting only (Settings › Display, web console Device tab, `PUT /settings`). Not in screens.yaml.
4. Default for new devices: Classic, until Sleek has been seen on a real panel.
5. Remaining screens: Classic layout with the Sleek typeface and softened controls (recommendation accepted by default).
6. Sleek must stay readable in black/white (partial refresh is B/W) (recommendation accepted by default).
