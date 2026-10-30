# Bin day tile text fit (issue #317)

- Headline: B36 → B30 → B26 (Classic), D30 → D26 → D24 (Modern), then the ellipsis; 1-wide value: 28 → 26 → 24 → 22.
  The emulator keeps one size and ellipsizes. The Modern display face stays at token 30 and below because the larger
  display sizes are digits-only in some typefaces (Geist 31, Fraunces 32), which drew nothing for "Paper".
- Rest list: only whole "Label Thu 29" items, like the emulator.
- `bins::view` runs on every draw from the EntityStore (no cache, no new buffer); `upcoming` is parsed with core/json
  only when the state and `daysTo` give no day.
