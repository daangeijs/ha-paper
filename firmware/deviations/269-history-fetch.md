# History tile fetch: firmware only, statistics + history tail, cadence (issue #269)

- The emulator draws demo series and never calls the recorder; the fetch exists only in the firmware
  (`core/history_fetch.{h,cpp}`, glue in `net/ha_client.cpp`). Its bucketing is checked against
  `spec/test-vectors/history.json` (the vector rows streamed through the scanner) and against `bucketize()` for live
  appends that shift the span (`test/test_history_fetch`).
- Statistics tile: HA compiles a period only once it ends, so the open part after the last compiled row comes from one
  `history/history_during_period` request (`include_start_time_state`), merged per bucket (mean weighted by time,
  min/max, change summed, last from the live part). A tail answer over the frame cap keeps the statistics alone.
- Refetch: per tile when the last fetch is older than max(10 min, bucket), on every reconnect, and for new or changed
  tiles; live appends from `subscribe_entities` fill the open bucket in between and publish at most every 30 s.
  Tiles of other apps keep their series but are not fetched until their app is shown.
- An answer over 512 KB is read and dropped by `WsClient` (no socket close); the tile shows `tooMany` and is not asked
  again until the config changes. A request unanswered for 60 s is given up and retried on the next pass. This holds
  for every frame: one over the cap used to close the socket (and the reconnect asked for it again); now it is lost
  alone and logged (`WS frame too large … dropped`).
- Diagnostics: `GET /__qemu/state` `history` (QEMU) and the serial log (`HIST ask`, `HEAP history <id> <bytes> B`).
  No `history` block in `/api/v1/console/state` yet (the plan's per-tile block; needs openapi + device-sim).
