// Per-key trailing debounce (climate setpoints: one climate.set_temperature 1.5 s after the last tap).
// Framework-free; uses the global setTimeout so tests can drive it with fake timers.

export const TADO_DEBOUNCE_MS = 1500;

export class KeyedDebouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** (Re)start the timer for `key`; only the last scheduled `fn` runs. */
  schedule(key: string, ms: number, fn: () => void): void {
    const t = this.timers.get(key); if (t !== undefined) clearTimeout(t);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); fn(); }, ms));
  }
  pending(key: string): boolean { return this.timers.has(key); }
  clear(): void { this.timers.forEach(clearTimeout); this.timers.clear(); }
}

/** New setpoint after a ± tap: 0.5 steps, clamped to 5–25 °C, one decimal. */
export const nextSetpoint = (set: number, delta: number): number => Math.max(5, Math.min(25, +(set + delta).toFixed(1)));
