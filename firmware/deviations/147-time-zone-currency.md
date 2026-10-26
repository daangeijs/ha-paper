# Clock time zone and price currency from Home Assistant (issue #147)

- The `tz` setting moved from NVS `x4dev/tz` to userdata `/tz`; a value in NVS from before is still read as the
  override until the first `PUT tz`. HA's zone lives in `/tz_ha`, the currency in `/currency` (cleared on unlink;
  the zone stays so the clock stays right).
- An HA zone outside the table is logged once (`HA time zone X unknown · keeping …`) and not stored: `tz_ha` shows the
  last zone the display understood.
- Sleek price card: the digits-only display face has only `€`, so `$`, `£` and letter codes are drawn in the text face
  (B 24) instead of DS 24. Fonts were not regenerated.
