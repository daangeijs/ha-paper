// Weather tile (eink-ha-os#318): renders in both looks, full screen and top half, with the demo forecast of weather.home.
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Emulator, type EmuState } from './Emulator.tsx';

function emu(widgets: Record<string, unknown>[], look: 'classic' | 'sleek', patch: Partial<EmuState> = {}) {
  const e = new Emulator({});
  const screens = [{ id: 'wx', app: 'home', title: 'Weather', widgets }, ...e.state.screens.filter((s) => s.app === 'settings')];
  (e as any).state = { ...e.state, mode: 'main', setup: null, offline: false, simHour: 13, wifi: { ...e.state.wifi, connected: 'HomeNet' }, ha: { ...e.state.ha, linked: true },
    screens, idx: 0, sub: 0, cfg: { ...e.state.cfg, style: look, typeface: 'geist' }, ...patch };
  return renderToString(e.render());
}

describe('weather tile (eink-ha-os#318)', () => {
  for (const look of ['classic', 'sleek'] as const) {
    it(look + ': full screen has the hero and a 5-day strip', () => {
      const out = emu([{ type: 'weather', entity: 'weather.home', cs: 4, rs: 2 }], look);
      expect(out).toContain('data-x4-wxhero');
      expect(out).toContain('data-x4-wxstrip');
      expect((out.match(/data-x4-wx="/g) || []).length).toBe(6);   // hero + 5 days
      expect(out).toContain('4 Bft SW');
    });
    it(look + ': top half has the hero only', () => {
      const out = emu([{ type: 'weather', entity: 'weather.home', cs: 4 }, { type: 'clock', cs: 4 }], look);
      expect(out).toContain('data-x4-wxhero');
      expect(out).not.toContain('data-x4-wxstrip');
    });
  }
  it('an entity without a forecast says so', () => {
    expect(emu([{ type: 'weather', entity: 'weather.forecast_home', cs: 4, rs: 2 }], 'classic')).toContain('No forecast');
  });
});
