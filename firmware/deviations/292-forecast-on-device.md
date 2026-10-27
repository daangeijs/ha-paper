# History tile from an attribute list or weather.get_forecasts on the device (issue #292)

- Attribute series are parsed from the entity mirror (`core/history_series.cpp`, a streaming scan into PSRAM samples,
  at most 400 per tile) on every event of the entity whose attribute text changed, and again at each bucket boundary.
  The device simulator reads them with one `get_states` per history pass (every 10 min) instead.
- The attribute is kept for that entity only (`setExtraAttrs`, next to the fixed `keepAttr` list). When a tile is added
  for an entity already mirrored without the attribute, the device subscribes that entity once more so HA sends its
  full state; the extra subscription is dropped at the next full resubscribe.
- `weather.get_forecasts` is asked once an hour per forecast tile (`kForecastMs`; the sim asks every 10 min). Between
  answers the span follows now and the same samples are bucketed again.
- `span: both` (past recorder history and future attribute values in one chart, ha-paper#13) is not in the spec yet:
  follow-up.
