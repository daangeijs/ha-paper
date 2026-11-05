# Battery % and days left on the glance sleep face (issue #30)

- ha-paper#30. The glance sleep face gains one line under the Today row: "Battery 64% · about 58 days left", or
  "Battery 64% · charging" on a charger or USB host. Same pure rules and vectors on both sides
  (`emulator/src/core/batteryDays.ts`, `firmware/src/core/battery_days.cpp`, `spec/test-vectors/battery-days.json`).
- Model: 1100 mAh (A27), 0.2 mA asleep (A32 target), 40 mA awake. The awake share comes from the wake tally (RTC
  memory, `awakeMs` / `asleepS`) once it covers 6 h, else 11 min a day. None of these are measured yet
  (docs/POWER_BUDGET.md); the measured drain replaces them.
- Measured drain: the first filtered gauge % seen unplugged with a known clock is the anchor, kept in the glance RTC
  record (`glance::Rtc::battAnchor`): it survives deep sleep but not a power-on or a power loss in sleep. After 1 h the
  drop since the anchor gives a rate; its weight is drop / 10 points or days / 7, whichever is larger, up to 1.
- The emulator UI has no wake tally and no gauge history (its battery is a fixed number): the face and its
  `/diagnostics` use the default model only. The device simulator keeps the anchor but uses the default model.
- Adding the anchor changes the RTC record size, so the first boot after this update starts the record (snapshot,
  wake tally, timer rate) from zero once.
- Only on the glance face; the quiet face, Nobody home and standby keep their lines.
