# History tile series from an attribute or a weather forecast (issue #283)

- The browser emulator has no HA, so an attribute / forecast tile draws `core/historyChart.ts demoForecast`: a list
  of `{‹time›: ISO, ‹value›: n}` entries (5 min for an attribute, 1 h / 1 d for a forecast) that goes through the real
  parser (`attrSamples`, `fromSamples`). A rain-like field (`precipitation`, `rain…`) gets a shower about an hour ahead,
  anything else a daily temperature curve. The tile's summary is the value of the bucket holding now.
- The console's attribute, value and time fields are text inputs with common names as suggestions: the entity list
  (`GET /api/v1/ha/entities`) carries no attribute names, so there is no per-entity attribute picker yet.
