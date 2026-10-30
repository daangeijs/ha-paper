# Tap to page: B/W fast refresh, press feedback folded in, last input wins (issue #212)

Measured on the real X4 Pro (main bf929d4): a tap took ~1.7 s to change page: a 565 ms press-feedback partial, then a
1092 ms fast refresh of which ~500 ms was the gray pass. Taps made meanwhile sat in the 32-deep x4input queue and were
replayed one by one.

| Topic | Before (eink-ha-os#197) | Now | Why |
|---|---|---|---|
| Grays after a fast refresh | fast base + gray overlay pass; RED seeded after a gray frame | **B/W only**: the frame is thresholded like a partial (dark gray black, light gray white), no gray pass (`core/epd_sequence.h` `grayPassFor`; a Fast ignores `grayPass`). The RED seed still clears the grays a clean left on the glass. Grays come back on the next clean (every 10th navigation, the scheduled clean, wake, …). UC8179/UC8279 after a gray frame: a B/W clean instead of the gray clean, so the next navigation is a fast again. Emulator `bwAfter({ kind: 'fast' })` = whole screen B/W | Saves the ~500 ms gray pass per page. Sleek's card surfaces and AA edges look B/W between cleans. |
| Press feedback | inverted control, one partial (~565 ms) before every tapped action, a second one to restore when the action drew nothing | the action runs first; a navigation (fast/clean) or a partial that redraws the control is the feedback. Only an action that leaves the control unchanged (scene, script) gets the invert + restore partials, after the action | One panel refresh per tap instead of two. |
| Input queued during a refresh | `App::loop` took ≤ 16 events per pass and handled each; the rest came next pass | the whole queue is drained each pass and only the last event is handled (`coalesceInput`, emulator `core/refresh.ts`, vectors `refresh.json` `input`); the recovery hold still sees every key. Log: `input · N stale dropped · last wins` | Last intent wins: five quick taps on › give at most two page changes. A quick double tap on a stepper (+/−) during a refresh counts once. |
| Refresh log lines | `EPD <kind> (<reason>) · <ms> ms`; hw `EPD <kind> refresh <ms> ms` | app: `… · <panel ms> ms · render <ms> ms` (framebuffer draw); hw: `EPD <kind> refresh <panel ms> ms · bw <ms> ms[ · gray pass][ · grays thresholded][ · red seeded]` (bw = 2-bit → 1-bit conversion + masks) | Separates draw time from panel time. |
