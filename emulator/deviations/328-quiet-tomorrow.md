# Quiet face Tomorrow row (issue #328)

- The cheapest price window tomorrow is not on the row. The device keeps only today's 24 hourly prices (`HomeData.prices`);
  there is no price forecast for tomorrow to read without a fetch, and the face must not fetch. The row has weather,
  first event and bins only.
- "Tomorrow" is the day the window ends: from the end hour on (23:05) the next day, before it (a boot at 03:00) today,
  with the head "Today" instead of "Tomorrow".
- Sources are the first weather tile with an entity, the first agenda or next tile with a calendar and the first bins
  tile with a sensor, on any page (screen order). A house without these tiles gets "Back at 07:00" and the date only;
  the face no longer shows the Home page's first value tiles (stale overnight).
- One centred line per item (not the wrapping value pairs of #295): the weather drawing at the 44 px strip size, so the
  firmware needs no new bitmap. Classic and Modern draw the same face (standby and quiet faces keep the Classic look).
- Rain: the first wet hour of the kept hourly forecast on that day that is not over. The hourly list holds 16 hours from
  the last fetch, so at 23:00 it reaches about 15:00 the next day; no wet hour means no rain text, not "dry".
- In the emulator only the demo `weather.home` has forecasts (like the weather tile); other weather entities give no
  weather item.
