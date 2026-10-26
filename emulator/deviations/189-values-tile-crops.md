# Values view: tile cards cut from preview.png (issue #189)

- On a display (HTTP console) each Values card shows its tile cut from `GET /screens/{id}/preview.png` at the tile's
  panel rectangle (`core/paging.ts` `rects()` with the Classic or Sleek grid from `display.style`), asked every 15 s;
  a 503 holds the next request for `Retry-After` seconds. The one-line value from `/values` stays as the fallback
  and in the card's accessible name.
- The emulator's console has no `screenPreview` (its device draws HTML, not a frame): its Values cards keep the
  one-line value, so list and chart tiles there still show a count or their name.
- The device simulator's preview.png draws the layout only (#168), so on the simulator the cards show empty tile frames.
- A card falls back to the one-line value while the draft tile differs from the pushed one (source, size, place), for
  a tile that needs an entity, and for a pinned tile (`col`/`row`: the firmware auto-places it elsewhere).
