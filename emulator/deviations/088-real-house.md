# Real-shaped fake HA house (issue #88)

- Fake HA house `real` (`server/fake-ha-real.ts`) has a device registry: `config/device_registry/list` answers, the entity
  registry's `area_id` is the entity's own (null when the area comes from its device, like HA), `area_id()` in templates
  resolves the device's. `device_entities` answers the firmware's device discovery template from it; the other houses
  still answer `[]` per meter.
- Device simulator `GET /ha/entities`: an entity's `area` is now its own, else its device's (`config/device_registry/list`),
  like the firmware's `area_id(s.entity_id)`. Before, lights whose area came from their device had none in the simulator.
- Still different (found with this house, not changed): the simulator's values view ignores the entity registry's
  `display_precision` (always one decimal, e.g. `51.9 %` for a humidity with precision 0); the firmware applies it (eink-ha-os#85).
