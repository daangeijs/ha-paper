// Emulator demo only (#145): the showcase's travel screen and its mock timetables. Never imported by src/core, the
// web console or the device simulator: a real display shows the user's own routes (label + mode + entity).
import type { Screen } from '../core/config.ts';

export type DemoRoute = { mode: 'train' | 'bus' | 'car'; title: string; offsets?: number[]; info?: string[]; typical?: number; notes: string[] };
/** Keyed by the demo widgets' `route` id. Departures are absolute clock times, never countdowns. */
export const DEMO_ROUTES: Record<string, DemoRoute> = {
  central_riverside: { mode: 'train', title: 'Central → Riverside', offsets: [4, 11, 19, 26, 34, 41, 49, 56], info: ['IC · spoor 5', 'Sprinter · spoor 4'],
    notes: ['All trains on time', 'Small delays, under 5 min', 'Delays of 5–10 min', 'Disruption: fewer trains to Riverside'] },
  home_centre: { mode: 'bus', title: 'Home → Centre', offsets: [7, 22, 37, 52], info: ['Bus [LINE] · to Central station'],
    notes: ['On schedule this hour', 'Running a few minutes late', 'Delays up to 10 min', 'Diversion: some stops skipped'] },
  junction_airport: { mode: 'train', title: 'Junction → Airport', offsets: [13, 43], info: ['IC · spoor 2 · 1 transfer'],
    notes: ['All trains on time', 'Small delays, under 5 min', 'Delays of 5–10 min', 'Disruption: expect +30 min'] },
  car: { mode: 'car', title: 'Car · Home → Riverside', typical: 21,
    notes: ['Traffic is normal · Google Maps', 'A bit busier than usual · Google Maps', 'Slow traffic on the way · Google Maps', 'Heavy congestion — consider the train'] },
};
/** Mock delay sets per simulated level: d = delays of the next 3 departures, c = index of a cancelled one. */
export const DELAY_SETS: { d: number[]; c?: number }[] = [{ d: [0, 0, 0] }, { d: [3, 0, 2] }, { d: [8, 6, 0] }, { d: [0, 18, 25], c: 0 }];
export const TRAVEL: Record<string, Record<string, number>> = {
  calm: { central_riverside: 1, home_centre: 1, junction_airport: 1, car: 1 },
  mixed: { central_riverside: 1, home_centre: 2, junction_airport: 3, car: 4 },
  bad: { central_riverside: 4, home_centre: 3, junction_airport: 4, car: 3 },
};
/** The demo's Travel screen: user routes shaped like a real config, fed by the mock above instead of HA. */
export const demoTravelScreen = (): Screen => ({ id: 'travel', app: 'travel', title: 'Travel', widgets: Object.entries(DEMO_ROUTES).map(([route, r]) =>
  ({ type: 'route', route, label: r.title, mode: r.mode, entity: 'sensor.demo_route_' + route, cs: 2 })) });
