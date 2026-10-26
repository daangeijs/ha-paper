# List picks (issue #127)

- Subscriptions: picked light / climate entities come with the config's entity ids (uncapped). Area picks resolve
  through the one-shot discovery template (light → `area_id()`, entity or device area): when every lightList has a
  pick, only lights of picked areas are subscribed; otherwise all lights, climate first, 80 in total as before. Before
  this, a big house (fake HA: 14 climate + 149 lights) silently lost every light past the cap in HA's entity_id order
  (66 of 149 subscribed); a pick is now the way to choose which ones.
- A room header's All on / All off sends `area_id` when the tile shows the whole area, else the shown `entity_id`s.
  The list header's "All lights off" stays house-wide; the away toggle still sets every climate entity.
- GET /ha/entities rows carry `area` and include `climate.*`; `areas` comes from the connect-time
  `config/area_registry/list` answer. QEMU big house: 800 entities, 100278 B (PSRAM).
