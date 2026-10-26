# Scene tile runs an HA scene or script (issue #146)

- Same behaviour as the emulator (emulator/deviations/146-scene-tile-entity.md): `core/config.cpp` `sceneAction()`
  (host-tested against `spec/test-vectors/scene-action.json`) decides the call, `App::Impl::runScene()` sends it;
  no entity goes through `allOff()` as before (optimistic light overrides). Offline: nothing sent, a log line.
- The HA entity-list template (`net/ha_client.cpp`) has the scene / script budgets and keeps unknown scenes pickable.
- No new HA attribute is read: the tile uses `friendly_name`, already kept at ingest. The scene / script entity is
  subscribed like any entity field in the config (`DeviceServices::entityIdsOf`).
- Not checked on a real panel yet; QEMU taps the three kinds and the fake HA sees the three calls.
