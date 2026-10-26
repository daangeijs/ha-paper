2. **Parser own-key lookups.** `parseYaml` uses own-property checks for entity, route and app, and a `Set` for duplicate ids. The original used plain
   object indexing, so `entity: constructor` passed and an id `constructor` was reported as a duplicate. This only affects JS prototype names.
   All other behaviour is identical, including the quirks kept for parity: `cs: 0` and `rs: 0` are accepted, CRLF breaks `app:`/`title:` lines, and a missing
   type says "undefined". These are recorded in `spec/test-vectors/config/`.
