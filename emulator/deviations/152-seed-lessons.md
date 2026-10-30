# Seed lessons from a real house (issue #152)

- The seed template answers three more things: `weather` (weather.* ids with a numeric temperature), a third light
  column (`g` when the light is a group: HA group `entity_id`, `is_hue_group`, `is_deconz_group` or Hue `lights`), and
  climate rows `[id, friendly name, area_id, state]` instead of bare ids (bare ids still parse).
- Outside: temperatures with a forecast token (max, min, today, tomorrow, forecast, feels, dew …, whole tokens) are no
  Outside and no room. No outdoor thermometer left = the first weather entity (stat tile, its `temperature`, eink-ha-os#161);
  report rule `found`.
- Imported / exported today by name must also name the grid (`GRID_DAY`), used today the house or a total
  (`HOUSE_DAY`). An appliance plug's "Today consumption" fills neither; lifetime-only P1 meters give no today tile
  (deriving a day from recorder statistics is not done).
- Lights: the seeded lightList is no longer always "all lights". Per area the first group (a second group of the same
  area is a duplicate) or else its bulbs; lights without an area are left out. Written as `entities:` (picks in area
  order) or, when only area-less lights were dropped, `areas:`. No light with an area = every light, as before.
- Zones: one per area or friendly name (case-insensitive); of duplicates (e.g. a Better Thermostat wrapper next to the
  thermostat it wraps) the first that is not off / unavailable / unknown is kept. A lone off zone stays (heating off in
  summer). Any duplicate dropped = the zoneList names the rest in `entities`, like a vehicle climate (eink-ha-os#136).
- Not done: zone names. The display already shows each climate's friendly_name (entity id only when HA has none);
  the seed writes no `labels`.
