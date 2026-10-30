# Recipe: rare birds nearby (waarneming.nl / observation.org)

A Home Assistant sensor, `sensor.rare_birds_nearby`, with the latest rare bird sightings around your home and in the
waarneming.nl areas you follow. The display shows it with the **List from attributes** tile (`attrList`, see
`spec/SCHEMA.md`); the tile's defaults read exactly this shape. Issues eink-ha-os#332, eink-ha-os#375.

## Recommended: the ha-waarneming integration

Install [ha-waarneming](https://github.com/daangeijs/ha-waarneming) (0.2.0 or later, a custom integration via HACS)
and set it up from Settings → Devices & services. It does what the YAML below does (both sources, the filters, newest
first, at most 10) and adds display-ready fields per sighting: `title` ("3× Kraanvogel ?"), `subtitle`
("Heidebos · 3,2 km") and `ts` (epoch seconds). Those are the tile's defaults, so a List from attributes tile on its
sensor needs no field settings: Home Assistant formats, the display only says how long ago and cuts long text.

The YAML recipe below stays as the alternative without a custom integration. Its sightings have no `title`,
`subtitle` or `ts`; the tile then falls back to `species`, `place distance_km` and `observed_at`.

## Alternative: the YAML recipe

observation.org agreed to this use: a personal Home Assistant polling the public API every 30 minutes. Keep the
interval at 30 minutes or more, and keep the attribution on the tile.

### What it fetches

Two kinds of source, both anonymous `GET`s on `https://waarneming.nl/api/v1/`, each answering
`{count, next, previous, results[]}`:

| source | route | filters |
|---|---|---|
| around a point | `observations/around-point/` | `coordinates=lat,lon`, `radius` (metres, max 10000), `days`, `species_group=1` (birds), `min_rarity`, `limit` |
| a waarneming.nl area | `locations/<id>/observations/` | `species_group=1`, `rarity` (a minimum on this route), `date_after=YYYY-MM-DD`, `limit` |

The area id is the number in the area's page address: `https://waarneming.nl/locations/701925/` is
Oostvaardersplassen - N2000 (the example below). An area includes its sub-areas (hides, paths). The area route ignores
`days`, `min_rarity` and `ordering`, so the recipe sends `date_after` and `rarity` there and sorts in the template.

Send `Accept-Language: nl` on every request: the API then answers `Content-Language: nl` and `species_detail.name` is
the Dutch name ("Klapekster"). The template falls back to the scientific name only when there is no Dutch one.

Rarity (per species at that place): 1 algemeen, 2 vrij algemeen, 3 zeldzaam, 4 zeer zeldzaam. The recipe keeps 3 and up
(2 floods the list) and drops escaped birds (`is_escape`). Uncertain sightings stay, with " ?" after the name.

### configuration.yaml

The point is your Home zone, read by the template at request time: no coordinate is written in this file. To use another
point, replace the `coordinates` template with fixed numbers, e.g. `coordinates: "52.45,5.40"` (a made-up point in the
example national park).

```yaml
rest:
  # around home: 10 km, the last 3 days, rarity 3+
  - resource: https://waarneming.nl/api/v1/observations/around-point/
    scan_interval: 1800
    timeout: 30
    headers:
      Accept-Language: nl
    params:
      coordinates: "{{ state_attr('zone.home', 'latitude') }},{{ state_attr('zone.home', 'longitude') }}"
      radius: 10000
      days: 3
      species_group: 1
      min_rarity: 3
      limit: 25
    sensor:
      - name: Waarneming rond huis
        unique_id: waarneming_rond_huis
        value_template: "{{ value_json.count }}"
        json_attributes: [results]

  # a waarneming.nl area by id (https://waarneming.nl/locations/701925/); copy this block per area
  - resource: https://waarneming.nl/api/v1/locations/701925/observations/
    scan_interval: 1800
    timeout: 30
    headers:
      Accept-Language: nl
    params:
      species_group: 1
      rarity: 3
      date_after: "{{ (now() - timedelta(days=3)).strftime('%Y-%m-%d') }}"
      limit: 25
    sensor:
      - name: Waarneming Oostvaardersplassen
        unique_id: waarneming_701925
        value_template: "{{ value_json.count }}"
        json_attributes: [results]

template:
  - trigger:
      - trigger: state
        entity_id:
          - sensor.waarneming_rond_huis
          - sensor.waarneming_oostvaardersplassen
      - trigger: homeassistant
        event: start
    action:
      - variables:
          # source sensor → the region name each sighting carries
          sources:
            sensor.waarneming_rond_huis: Rond huis
            sensor.waarneming_oostvaardersplassen: Oostvaardersplassen
          found: >-
            {% set ns = namespace(rows=[], ids=[]) %}
            {% for src, region in sources.items() %}
              {% for r in state_attr(src, 'results') or [] %}
                {% if r.id not in ns.ids and not r.is_escape and (r.rarity or 0) >= 3 %}
                  {% set ns.ids = ns.ids + [r.id] %}
                  {% set c = r.point.coordinates if r.point else none %}
                  {% set ns.rows = ns.rows + [{
                    'species': (r.species_detail.name or r.species_detail.scientific_name) ~ ('' if r.is_certain else ' ?'),
                    'scientific': r.species_detail.scientific_name,
                    'count': r.number,
                    'place': r.location_detail.name,
                    'distance_km': (distance(c[1], c[0]) | round(1)) if c else none,
                    'observed_at': r.date ~ ('T' ~ r.time ~ ':00' if r.time else ''),
                    'rarity': r.rarity,
                    'certain': r.is_certain,
                    'region': region,
                    'url': r.permalink
                  }] %}
                {% endif %}
              {% endfor %}
            {% endfor %}
            {{ ns.rows | sort(attribute='observed_at', reverse=true) }}
    sensor:
      - name: Rare birds nearby
        unique_id: rare_birds_nearby
        icon: mdi:bird
        unit_of_measurement: waarnemingen   # with a unit the display's entity picker lists it first (big houses)
        state: "{{ found | count }}"
        attributes:
          sightings: "{{ found[:10] }}"
          radius_km: 10
          min_rarity: 3
          days: 3
          attribution: "Data: waarneming.nl / observation.org"

recorder:
  exclude:
    entities:   # the raw answers are 20–40 KB of attributes; the recorder skips anything over 16 KB anyway
      - sensor.waarneming_rond_huis
      - sensor.waarneming_oostvaardersplassen
```

More areas: copy the second `rest` block with the new id and name, then add its sensor to the trigger's `entity_id` and
to `sources`. Only areas: drop the first block and its two lines. Sightings that both sources return (an area inside
your radius) show once, with the region of the first source in `sources`.

`observed_at` is the local date and time as the site gives it, without an offset; the display reads it as local time.
`distance_km` is measured from your Home zone, also for area sightings.

## The entity

`sensor.rare_birds_nearby`: state = number of sightings found (all sources, after the filters); attributes:

- `sightings`: newest first, at most 10, each `{species, scientific, count, place, distance_km, observed_at, rarity,
  certain, region, url}`; from ha-waarneming 0.2.0 also `{title, subtitle, ts}`
- `radius_km`, `min_rarity`, `days`, `attribution`

## On the display

In the web console add **List from attributes** and pick `sensor.rare_birds_nearby`. A 2 × 2 tile shows 6 sightings
(title and "2 h ago", then the subtitle), a 4 × 2 tile 10 on one line each; the attribution sits in the foot,
with "+N more" when the list is longer than the tile. The display keeps only the `sightings` and `attribution`
attributes of this entity, at most 10 items / 3 KB. With both the old and the new fields a sighting is about 340 bytes,
so 9 typical sightings fit; the new fields alone are about 90 bytes each.

To show another list-shaped attribute, set the tile's fields: `attribute`, `title`, `subtitle` (up to 3 field names),
`time`, `empty` (see `spec/SCHEMA.md`, attrList).
