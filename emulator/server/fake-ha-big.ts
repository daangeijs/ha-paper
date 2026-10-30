// The fake HA's "big house" (eink-ha-os#57): the demo house plus ~1200 extra entities with the long attributes a real
// installation has (the first real HA: 800 entities; the entity picker list once fragmented the firmware's internal RAM
// below the TLS guard). `npm run fake-ha -- --house big`, or POST /__fake/big-house {n} on a running fake HA.
// Entity ids are `<domain>.bulk_<n>`, so they can be removed again.

export const BIG_HOUSE_EXTRA = 1200;

const ROOMS = ['Living room', 'Kitchen', 'Bedroom upstairs (east)', 'Garage', 'Garden shed', 'Attic', 'Hallway'];
const KINDS: { domain: string; dc?: string; unit?: string; state: (i: number) => string }[] = [
  { domain: 'sensor', dc: 'temperature', unit: '°C', state: (i) => (15 + (i % 100) / 10).toFixed(1) },
  { domain: 'sensor', dc: 'power', unit: 'W', state: (i) => String((i * 37) % 3000) },
  { domain: 'sensor', dc: 'signal_strength', unit: 'dBm', state: (i) => String(-40 - (i % 50)) },
  { domain: 'binary_sensor', dc: 'motion', state: (i) => (i % 3 ? 'off' : 'on') },
  { domain: 'switch', state: (i) => (i % 2 ? 'on' : 'off') },
  { domain: 'light', state: (i) => (i % 4 ? 'off' : 'on') },
  { domain: 'number', unit: '%', state: (i) => String(i % 100) },
  { domain: 'update', state: () => 'off' },   // not pickable: the template filters it out
  { domain: 'automation', state: () => 'on' },
];

/** `n` generated entities: [id, state, attributes]. */
export function bigHouseEntities(n = BIG_HOUSE_EXTRA): [string, string, Record<string, unknown>][] {
  const out: [string, string, Record<string, unknown>][] = [];
  for (let i = 0; i < n; i++) {
    const k = KINDS[i % KINDS.length]; const room = ROOMS[i % ROOMS.length];
    const attrs: Record<string, unknown> = {
      friendly_name: `${room} ${k.dc ?? k.domain} ${i} — Zigbee2MQTT 0x00158d00${(0x1000 + i).toString(16)} "${k.domain}"`,
      attribution: 'Data provided by a very long integration name that some custom components like to put here',
      icon: 'mdi:' + (k.dc ?? k.domain),
      linkquality: 100 + (i % 155),
      last_seen: '2026-10-16T09:' + String(i % 60).padStart(2, '0') + ':00+02:00',
      options: Array.from({ length: 6 }, (_, j) => `option ${j} for entity ${i}`),
    };
    if (k.dc) attrs.device_class = k.dc;
    if (k.unit) { attrs.unit_of_measurement = k.unit; attrs.state_class = 'measurement'; }
    if (k.domain === 'light') { attrs.supported_color_modes = ['brightness', 'color_temp']; attrs.brightness = i % 255; }
    if (k.domain === 'update') attrs.release_summary = 'x'.repeat(400);
    out.push([`${k.domain}.bulk_${i}`, k.state(i), attrs]);
  }
  return out;
}
