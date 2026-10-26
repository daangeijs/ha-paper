# Scene tile runs an HA scene or script (issue #146)

- The design handoff's scene tile had one action: all lights off (`scene: all_off`). It now takes an optional
  `entity` (`scene.*` or `script.*`) and `label`; a tap calls `scene.turn_on` / `script.turn_on` with
  `service_data: {entity_id}` (`sceneAction()` in `src/core/config.ts`, `spec/test-vectors/scene-action.json`).
  No entity, or the older `scene: all_off`, is still all lights off (`light.turn_off`, `entity_id: all`); an entity
  wins over `scene:`. Another domain fails with the line (vectors `63`–`65`). The `scene:` value is not checked, as
  before, so no older file stops parsing.
- The tile shows "Scene" or "Script", the label (else HA's name) and "Tap to run"; nothing changes on the panel after
  a tap (no state to show). All lights off keeps its lights-on count.
- Scene tiles are never in `entity_gaps`: a scene is "unknown" in HA until it first runs.
- The entity list (#150) gives scene and script 30 places each (sensor 370 → 310); a never-run (unknown) scene counts
  as pickable, an unavailable one does not.
- Web console: the palette adds "Scene or script"; the picker lists HA's scenes and scripts after a built-in
  "All lights off" row (which removes the entity again). The label field works like on the other entity tiles.
- Device simulator: `POST /__sim/control {tap: n}` taps tile n of the shown screen; only scene tiles act (409
  otherwise). The fake HA records the call, sets a scene's state to the run time and a script's `last_triggered`, and
  expands `entity_id: all` to every entity of the domain (before, all lights off failed there with not_found).
  The demo house adds `scene.movie_night` and `script.good_night` (turns the demo lights off).
