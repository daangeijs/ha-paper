// Improv Wi-Fi over serial (https://www.improv-wifi.com/serial/, eink-ha-os#31): after installing, the page sends the Wi-Fi
// name and password to the display over the same USB port, so nobody has to join the setup hotspot. Device side:
// firmware/src/core/improv.cpp. Vectors: spec/test-vectors/improv.json. The port also carries the firmware's log
// lines; the parser skips everything that is not an "IMPROV" frame.

export const TYPE = { state: 0x01, error: 0x02, rpc: 0x03, result: 0x04 } as const;
export const CMD = { wifi: 0x01, getState: 0x02, getInfo: 0x03, scan: 0x04 } as const;
export const STATE = { stopped: 0x00, ready: 0x02, provisioning: 0x03, provisioned: 0x04 } as const;
export const ERROR = { none: 0x00, invalidRpc: 0x01, unknownRpc: 0x02, unableToConnect: 0x03 } as const;

const HEADER = [0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56]; // "IMPROV"
const VERSION = 1;

/** "IMPROV", version, type, length, data, checksum (sum of all previous bytes mod 256), "\n". */
export function encodeFrame(type: number, data: ArrayLike<number>): Uint8Array {
  const f = new Uint8Array(HEADER.length + 3 + data.length + 2);
  f.set(HEADER, 0);
  f.set([VERSION, type, data.length], HEADER.length);
  f.set(data, HEADER.length + 3);
  let sum = 0;
  for (let i = 0; i < f.length - 2; i++) sum += f[i];
  f[f.length - 2] = sum & 0xff;
  f[f.length - 1] = 0x0a;
  return f;
}

export function encodeStrings(strings: string[]): number[] {
  const out: number[] = [];
  for (const s of strings) {
    const b = new TextEncoder().encode(s);
    if (b.length > 255) throw new Error(`"${s.slice(0, 20)}…" is longer than 255 bytes.`);
    out.push(b.length, ...b);
  }
  return out;
}

export function rpcFrame(command: number, strings: string[] = []): Uint8Array {
  const payload = encodeStrings(strings);
  if (payload.length > 253) throw new Error("Network name and password are too long together.");
  return encodeFrame(TYPE.rpc, [command, payload.length, ...payload]);
}

/** Length-prefixed strings; null when the payload is not exactly that. */
export function decodeStrings(payload: Uint8Array): string[] | null {
  const out: string[] = [];
  const dec = new TextDecoder();
  let i = 0;
  while (i < payload.length) {
    const n = payload[i++];
    if (n > payload.length - i) return null;
    out.push(dec.decode(payload.subarray(i, i + n)));
    i += n;
  }
  return out;
}

export interface Packet {
  type: number;
  data: Uint8Array;
}

/** RPC result data: command, length, strings. */
export function decodeResult(data: Uint8Array): { command: number; strings: string[] } | null {
  if (data.length < 2 || data[1] !== data.length - 2) return null;
  const strings = decodeStrings(data.subarray(2));
  return strings ? { command: data[0], strings } : null;
}

/** Stream parser: feed any chunks, get whole frames with a good checksum. Same rules as core/improv.cpp. */
export class FrameParser {
  private buf: number[] = [];

  push(bytes: Uint8Array): Packet[] {
    const out: Packet[] = [];
    for (const b of bytes) {
      const i = this.buf.length;
      const ok = i < HEADER.length ? b === HEADER[i] : i === HEADER.length ? b === VERSION : true;
      if (!ok) {
        this.buf = b === HEADER[0] ? [b] : [];
        continue;
      }
      if (i < HEADER.length + 3 || i < HEADER.length + 3 + this.buf[HEADER.length + 2]) {
        this.buf.push(b);
        continue;
      }
      const sum = this.buf.reduce((a, x) => a + x, 0) & 0xff;
      if (sum === b) out.push({ type: this.buf[HEADER.length + 1], data: Uint8Array.from(this.buf.slice(HEADER.length + 3)) });
      this.buf = [];
    }
    return out;
  }
}

/** What the client needs of a Web Serial port (open already). */
export interface SerialLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export interface Network {
  ssid: string;
  rssi: number;
  secure: boolean;
}

export class ImprovError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImprovError";
  }
}

type Waiter = (p: Packet) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ImprovClient {
  /** Set when the read loop stops (port closed, device reset). */
  ended = false;
  private readonly port: SerialLike;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly parser = new FrameParser();
  private readonly waiters = new Set<Waiter>();
  private loop: Promise<void> | null = null;

  constructor(port: SerialLike) {
    this.port = port;
  }

  start(): void {
    if (this.loop || !this.port.readable) return;
    const reader = this.port.readable.getReader();
    this.reader = reader;
    this.loop = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) for (const p of this.parser.push(value)) for (const w of [...this.waiters]) w(p);
        }
      } catch {
        // port lost (the chip reset) or cancelled by close()
      } finally {
        this.ended = true;
        reader.releaseLock();
      }
    })();
  }

  async close(): Promise<void> {
    await this.reader?.cancel().catch(() => {});
    await this.loop;
  }

  private async send(frame: Uint8Array): Promise<void> {
    const w = this.port.writable?.getWriter();
    if (!w) throw new ImprovError("The serial port is not writable.");
    try {
      await w.write(frame);
    } finally {
      w.releaseLock();
    }
  }

  /**
   * Sends `frame` (again every `retryMs`) until `pick` returns a value, the time is up (undefined) or the port is gone.
   * `pick` may throw to fail the wait.
   */
  private request<T>(frame: Uint8Array, pick: (p: Packet) => T | undefined, timeoutMs: number, retryMs = 0): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let finished = false;
      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        this.waiters.delete(waiter);
        fn();
      };
      const waiter: Waiter = (p) => {
        try {
          const v = pick(p);
          if (v !== undefined) finish(() => resolve(v));
        } catch (e) {
          finish(() => reject(e));
        }
      };
      this.waiters.add(waiter);
      const deadline = Date.now() + timeoutMs;
      void (async () => {
        while (!finished && !this.ended && Date.now() < deadline) {
          await this.send(frame).catch(() => {});
          const next = retryMs > 0 ? Math.min(retryMs, deadline - Date.now()) : deadline - Date.now();
          for (let t = 0; t < next && !finished && !this.ended; t += 50) await sleep(Math.min(50, next - t));
        }
        finish(() => resolve(undefined));
      })();
    });
  }

  /** Current state (STATE.*), asking every `retryMs` (the firmware answers once its main loop runs), or null. */
  async detect(timeoutMs = 10_000, retryMs = 1000): Promise<{ state: number; urls: string[] } | null> {
    let state = -1;
    const r = await this.request(
      rpcFrame(CMD.getState),
      (p) => {
        if (p.type === TYPE.state) {
          state = p.data[0];
          if (state !== STATE.provisioned) return { state, urls: [] };
        }
        const res = p.type === TYPE.result ? decodeResult(p.data) : null;
        if (state === STATE.provisioned && res?.command === CMD.wifi) return { state, urls: res.strings };
        return undefined;
      },
      timeoutMs,
      retryMs,
    );
    return r ?? (state === STATE.provisioned ? { state, urls: [] } : null);
  }

  /** Firmware name, version, chip, device name. */
  async info(timeoutMs = 3000): Promise<string[] | null> {
    const r = await this.request(
      rpcFrame(CMD.getInfo),
      (p) => {
        const res = p.type === TYPE.result ? decodeResult(p.data) : null;
        return res?.command === CMD.getInfo ? res.strings : undefined;
      },
      timeoutMs,
    );
    return r ?? null;
  }

  /** Networks the display sees, strongest first, one entry per name. */
  async scan(timeoutMs = 15_000): Promise<Network[]> {
    const seen: Network[] = [];
    const r = await this.request(
      rpcFrame(CMD.scan),
      (p) => {
        const res = p.type === TYPE.result ? decodeResult(p.data) : null;
        if (res?.command !== CMD.scan) return undefined;
        if (res.strings.length === 0) return seen;
        const [ssid, rssi, auth] = res.strings;
        if (ssid && !seen.some((n) => n.ssid === ssid)) seen.push({ ssid, rssi: Number(rssi), secure: auth === "YES" });
        return undefined;
      },
      timeoutMs,
    );
    return (r ?? seen).sort((a, b) => b.rssi - a.rssi);
  }

  /**
   * Sends the Wi-Fi name and password and waits for the join (the firmware tries for up to 20 s, then looks for Home
   * Assistant for ~3 s). Resolves with the device URLs; throws ImprovError when the join fails or nothing comes back.
   */
  async provision(ssid: string, password: string, timeoutMs = 45_000): Promise<string[]> {
    const wifi = rpcFrame(CMD.wifi, [ssid, password]);
    let sawProvisioning = false;
    let provisioned = false;
    const pick = (p: Packet): string[] | undefined => {
      if (p.type === TYPE.error && p.data[0] === ERROR.unableToConnect) {
        throw new ImprovError(`The display could not join "${ssid}". Check the network name and password.`);
      }
      if (p.type === TYPE.error && p.data[0] !== ERROR.none) {
        throw new ImprovError(`The display rejected the request (Improv error ${p.data[0]}).`);
      }
      if (p.type === TYPE.state) {
        if (p.data[0] === STATE.provisioning) sawProvisioning = true;
        else if (p.data[0] === STATE.provisioned) provisioned = sawProvisioning; // not the network it was already on
        else if (p.data[0] === STATE.ready && sawProvisioning) {
          throw new ImprovError(`The display could not join "${ssid}". Check the network name and password.`);
        }
      }
      const res = p.type === TYPE.result ? decodeResult(p.data) : null;
      if (provisioned && res?.command === CMD.wifi) return res.strings;
      return undefined;
    };
    await this.send(wifi);
    // A lost answer is recovered by asking for the state: Provisioned comes with the URLs again.
    const urls = await this.request(rpcFrame(CMD.getState), pick, timeoutMs, 5000);
    if (urls === undefined) {
      throw new ImprovError(
        this.ended ? "The USB connection to the display was lost." : "The display did not answer in time.",
      );
    }
    return urls;
  }
}
