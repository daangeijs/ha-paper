# Power measurement hooks in the device simulator (issue #178)

- The simulator runs no glance wakes: `power.redraws`, `power.failedWakes` stay 0 and `power.lastWake` null. `wakes`,
  `asleepS`, `awakeS` and `refreshes` count the simulator's own sleeps and wakes.
- `POST /device/sleep` really sleeps the simulator for `seconds` (no answer until then); `POST /__sim/control
  {"wake": "timer" | "button"}` ends a sleep early for tests.
