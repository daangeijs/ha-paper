// Remote input spec (#214) for POST /api/v1/debug/input (and QEMU's /__qemu/input): = firmware core/input_spec.cpp.
export type InputSpec = { kind: 'tap'; x: number; y: number } | { kind: 'key'; key: 'prev' | 'next' | 'home' | 'power' } | { kind: 'swipe'; dir: -1 | 1 };
export const INPUT_SPEC_ERROR = 'use ?tap=x,y | ?key=prev|next|home|power | ?swipe=-1|1';

/** `q`: the query parameters; the last of tap / key / swipe present wins (firmware order). null = bad spec. */
export function parseInputSpec(q: { get(k: string): string | null }): InputSpec | null {
  let spec: InputSpec | null | undefined;
  for (const k of ['tap', 'key', 'swipe'] as const) {
    const v = q.get(k); if (v === null) continue;
    if (k === 'tap') { const c = v.indexOf(','); spec = c < 0 ? null : { kind: 'tap', x: parseInt(v.slice(0, c), 10) || 0, y: parseInt(v.slice(c + 1), 10) || 0 }; }
    else if (k === 'key') spec = ['prev', 'next', 'home', 'power'].includes(v) ? { kind: 'key', key: v as 'prev' } : null;
    else spec = { kind: 'swipe', dir: (parseInt(v, 10) || 0) < 0 ? -1 : 1 };
  }
  return spec ?? null;
}
