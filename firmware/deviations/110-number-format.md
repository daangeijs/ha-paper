# Number format (issue #110)

- `core/logic` `fmtNum`/`fmtValue`/`kw` (and the price texts, now `fmtNum(p, "", 2)`) write in one number format
  (`setNumFormat`, `spec/test-vectors/format.json` `numberFormatOf`/`localized`). Source: the auth user's profile
  `number_format`, WebSocket `frontend/get_user_data` key `language` after every `auth_ok`, kept in userdata `/numfmt`.
  `comma_decimal` / `decimal_comma` / `space_comma` group every 3 integer digits ("1.250 W"); `none` is a point;
  `language`, `system`, unset or an HA without the command follow the display language: Dutch "2,1 kW", else "2.1 kW",
  never grouped ("1250 W"). HA's own `language` setting would group Dutch numbers; we don't, on purpose (tile width).
- A changed result is one full refresh (logged as `language`). Unlink clears `/numfmt`. HA states are parsed with a
  point as always; the deadband and gauges compare numbers, never the text. `space_comma` uses a plain space.
