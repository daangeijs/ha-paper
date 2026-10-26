# OTA version line width is estimated (issue #215)

The OTA install screen fits the version with core `fitMiddle` (sizes 28/24/20/18 px, max 720 px), like the firmware.
The emulator has no glyph metrics in the DOM render path, so it estimates 0.6 em per codepoint for bold sans; the
firmware measures its real glyphs. Near the limit the two can pick a different size step or cut point.
