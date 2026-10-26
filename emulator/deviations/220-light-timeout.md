# Front light timeout; Clock tile moves to Display style (issue #220)

Not in the handoff (Daan, 2026-10-26). `display.lightTimeout` (seconds: 30, 60, 120, 300, 0 = never; default 60)
turns the front light off after that long without a key or touch; the brightness setting stays. The first key or tap
after that (not Power, which goes to standby as before) only turns the light back on, like ambient's "chrome back";
Home Assistant updates and redraws never wake it. Night mode and standby keep the light off as before. Nothing is
redrawn when the light goes off. Rules: `src/core/frontlight.ts`, vectors `spec/test-vectors/frontlight.json`.

Settings › Display was full (8 cells), so its "Light off" tile takes the Clock tile's place and the Clock (24/12-hour)
tile moves to Settings › Display style. The web console's Settings page follows the device menu.
