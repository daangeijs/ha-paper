# Panel text: values keep their decimals, m³ draws, thermo names fit (issue #162)

- Stat value + unit (core/logic.cpp `fitValue`, spec/test-vectors/format.json fitValue): over the size steps, decimals
  drop while 3 significant digits stay, then while 2 stay; the first size that fits wins. Classic steps 50 → 46 → 44
  → 40 → 36 → 34, Sleek 62 → 56 → 48 → 40 → 38 → 30 (from the size its length picks). Only when nothing fits does the
  smallest size drop decimals further. Before, eink-ha-os#151 dropped decimals to any length first: "0.2534 €/kWh" drew as
  "0.3 €/kWh" (Classic) or "0.…" (Sleek); now "0.25 €/kWh", and a gas price "1.23 €/m³" steps down instead of "1.2".
  "28.30 kWh" still becomes "28.3 kWh" at full size.
- Fonts: the text-ish glyph set (Classic Bold 34–52, Sleek unit DS(20) and display text sizes) gains ² and ³, so a
  unit "m³" no longer draws "m?" (firmware/tools/fontgen.py TEXTISH). Flash only, a few hundred bytes.
- Thermo tile: `label` overrides the zone name (Classic and Sleek). Names that do not fit keep their last word
  (`fitKeepTail`, "Slaapka… voor"); Classic leaves room for the flame. Sleek moved the name out of the ring (62 px) to
  a card-wide line under the ring's open bottom.
