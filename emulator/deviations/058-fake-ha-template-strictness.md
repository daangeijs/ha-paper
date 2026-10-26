# Fake HA template strictness (issue #58)

- The fake HA has no Jinja. `templateWarnings` (server/fake-ha.ts) approximates HA's undefined handling: a direct
  `x.attributes.name` read (not `.get()`, not `| default`) inside a `{% for x in states[.domain] %}` loop is reported
  for every looped entity without that attribute, with HA's message (`'homeassistant.util.read_only_dict.ReadOnlyDict
  object' has no attribute 'name'`). report_errors → a WARNING event per read, then the result; strict → template
  error. Undefined reads outside such loops (e.g. `states.sensor.x.attributes.y`) are not detected.
- A failed seed template (ERROR event, failed result, non-object answer) now saves nothing in both emulator and
  firmware: default screens stay unsaved, `seed_pending` stays true, the next HA connection seeds again.
