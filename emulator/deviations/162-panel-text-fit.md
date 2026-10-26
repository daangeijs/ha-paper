# Panel text fitting in the emulator (issue #162)

- `fitValue` (core/format.ts, spec/test-vectors/format.json) is the firmware's rule to fit a stat value and its unit
  (decimals drop while 3, then 2 significant digits stay, over the size steps). The emulator draws tiles with CSS at
  one size and does not apply it.
- Thermo tile: `label` overrides the zone name; Sleek shows the name card-wide under the ring, as the firmware does.
  The firmware keeps the last word of a long name (`fitKeepTail`); the emulator's CSS ellipsis cuts the end.
