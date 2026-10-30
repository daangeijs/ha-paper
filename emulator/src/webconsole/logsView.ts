// Advanced › Device log (eink-ha-os#200): GET /api/v1/logs polled every 2 s with since = the last seq, filtered in the browser.
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { logText, type LogLine } from '../core/logs.ts';
import type { StrKey } from '../core/strings.ts';
import type { DeviceApi } from './DeviceApi.ts';

export const LOGS_EVERY_MS = 2000;
export const LOGS_KEEP = 2000;
type Level = 'all' | 'W' | 'E';

/** Lines the page shows: level (that level and worse) and a comma list of tags, case-insensitive. */
export function logsShown(lines: LogLine[], level: Level, tags: string): LogLine[] {
  const want = tags.split(',').map((x) => x.trim().toUpperCase()).filter((x) => x);
  return lines.filter((l) => (level === 'all' || l.level === 'E' || (level === 'W' && l.level === 'W')) && (!want.length || want.includes(l.tag.toUpperCase())));
}

/** One poll: append new lines. A seq lower than ours, or an uptime going backwards, means the display restarted:
 *  start over from its first line. */
export function logsMerge(have: LogLine[], since: number, r: { seq: number; lines: LogLine[] }): { lines: LogLine[]; seq: number; restarted: boolean } {
  const last = have[have.length - 1];
  if (r.seq < since || (last && r.lines.length && r.lines[0].ms < last.ms)) return { lines: [], seq: 0, restarted: true };
  return { lines: r.lines.length ? [...have, ...r.lines].slice(-LOGS_KEEP) : have, seq: r.seq, restarted: false };
}

const seg = (on: boolean) => ({ bg: on ? '#1d1d1f' : '#fff', fg: on ? '#fff' : '#1d1d1f' });

export function useDeviceLogs(api: DeviceApi, on: boolean, t: (k: StrKey, ...a: (string | number)[]) => string, tm: (m: string) => string) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [level, setLevel] = useState<Level>('all');
  const [tags, setTags] = useState('');
  const [paused, setPaused] = useState(false);
  const [prev, setPrev] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const have = useRef<LogLine[]>([]);
  const view = useRef('');
  const tmRef = useRef(tm);
  tmRef.current = tm;
  useEffect(() => {
    if (view.current !== String(on) + prev) {   // page opened or boot switched: start from the oldest line held
      view.current = String(on) + prev;
      seq.current = 0; have.current = []; setLines([]); setDropped(false); setErr('');
    }
    if (!on) return;
    let alive = true, busy = false;
    const pull = async () => {
      if (busy) return;
      busy = true;
      try {
        for (let more = true, n = 0; more && alive && n < 10; n++) {
          const r = await api.getLogs(seq.current, prev);
          if (!alive) return;
          if (r.dropped) setDropped(true);
          const m = logsMerge(have.current, seq.current, r);
          seq.current = m.seq; have.current = m.lines; setLines(m.lines);
          more = r.more || m.restarted;
        }
        setErr('');
      } catch (e) { if (alive) setErr(tmRef.current((e as Error).message)); } finally { busy = false; }
    };
    void pull();
    const timer = prev || paused ? undefined : setInterval(pull, LOGS_EVERY_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [api, on, prev, paused]);
  const shown = logsShown(lines, level, tags);
  return {
    logsNote: t(prev ? 'logsPrevNote' : 'logsNote'),
    logsLevels: ([['all', 'logsAll'], ['W', 'logsWarn'], ['E', 'logsErr']] as [Level, StrKey][]).map(([k, key]) => ({ label: t(key), ...seg(level === k), pick: () => setLevel(k) })),
    logsBoots: ([[false, 'logsThisBoot'], [true, 'logsPrevBoot']] as [boolean, StrKey][]).map(([k, key]) => ({ label: t(key), ...seg(prev === k), pick: () => setPrev(k) })),
    logsTag: tags, setLogsTag: (e: ChangeEvent<HTMLInputElement>) => setTags(e.target.value),
    logsCanPause: !prev, logsPauseLabel: t(paused ? 'logsResume' : 'logsPause'), logsTogglePause: () => setPaused((p) => !p),
    logsStatus: err || (prev ? '' : t(paused ? 'logsPaused' : 'logsLive')), logsStatusColor: err ? '#B3261E' : '#5c5a55',
    logsDropped: dropped, logsEmpty: !shown.length,
    logsLines: shown.map((l) => ({ key: l.seq, text: logText(l), color: l.level === 'E' ? '#ff9c8a' : l.level === 'W' ? '#e5c07b' : '#d9d6ce' })),
    logsDownload: () => {
      const blob = new Blob([shown.map(logText).join('\n') + '\n'], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'x4-log-' + (prev ? 'previous' : 'current') + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };
}
