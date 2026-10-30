# Guest Wi-Fi tile: text fit and one QR library (issue #329)

- **Text fit.** The emulator draws the network and password at 28 px bold and ellipsizes; the firmware steps the bold
  value down 28 → 24 → 20 → 18 → 16 px until it fits, then ellipsizes. "No password" (open network) is regular 26 px,
  18 px when narrow. Status messages wrap to at most 3 centred lines on both (firmware: greedy word wrap, 22 px lines).
- **Tile size.** The emulator takes the tile size from `gridSpan(grid, 0, 0, cs, rs)` (column 0); the firmware uses the
  tile's real rect, which can be 1 px wider in other columns. The QR modules and px per module come out the same.
- **QR library.** The firmware's other QR codes (setup Wi-Fi, console address, link page) moved from ricmoo/QRCode to
  the same vendored qrcodegen (`firmware/lib/qrcodegen`), so there is one encoder on the device and the emulator's
  TypeScript port gives bit-identical modules (`spec/test-vectors/guest-wifi.json` `qr`). Their masks can differ from
  before; the codes stay ECC M, smallest version ≤ 10.
