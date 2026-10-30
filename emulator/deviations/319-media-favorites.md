# Now playing favorites in the console (issue #319)

- The console does not offer HA's `media_player.browse_media`. The display would have to proxy a WebSocket
  `media_player/browse_media` answer (a tree that can run to hundreds of KB for a Spotify or Music Assistant library)
  through its 65–90 KB of free internal RAM, per click. Instead the favorites editor takes free entries
  `type:id` (`music:http://…/stream.mp3`, `playlist:spotify:playlist:…`) and offers the house's scripts and scenes
  (`script.*` / `scene.*`) from the entity list in a picker; a name left empty takes the script's or scene's HA name.
- `media_player` joined the console's entity list (`core/entityList.ts`, firmware `kEntityListTemplate`) with a budget
  of 10, taken from `sensor` (310 → 300), so the list still stops at 800.
- The in-browser emulator's demo speaker (`media_player.living_room`, `data.ts` DEMO_MEDIA) steps through a three-track
  queue like the fake HA; other players have no state there and show Idle · Nothing playing.
