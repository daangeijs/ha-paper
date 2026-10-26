import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CMD,
  decodeResult,
  decodeStrings,
  encodeFrame,
  FrameParser,
  ImprovClient,
  ImprovError,
  type Packet,
  rpcFrame,
  STATE,
  TYPE,
} from "../src/improv.ts";

// Shared with the firmware's native tests (firmware/test/test_improv).
const v = JSON.parse(readFileSync(new URL("../../spec/test-vectors/improv.json", import.meta.url), "utf8")) as {
  frames: { name: string; type: number; data: string; hex: string }[];
  streams: { name: string; hex: string; packets: { type: number; data: string }[] }[];
  bad: { name: string; hex: string }[];
  rpcs: { name: string; data: string; command?: number; strings?: string[] | null; valid?: boolean }[];
};
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const text = (s: string) => new TextEncoder().encode(s);

describe("Improv frames (spec/test-vectors/improv.json)", () => {
  it.each(v.frames)("$name", (f) => {
    expect(hex(encodeFrame(f.type, unhex(f.data)))).toBe(f.hex);
    expect(new FrameParser().push(unhex(f.hex)).map((p) => [p.type, hex(p.data)])).toEqual([[f.type, f.data]]);
  });

  it("builds the client RPCs", () => {
    expect(hex(rpcFrame(CMD.getState))).toBe(v.frames[0].hex);
    expect(hex(rpcFrame(CMD.wifi, ["MyWirelessAP", "mysecurepassword"]))).toBe(v.frames[1].hex);
  });

  it.each(v.streams)("$name, one byte at a time and in one chunk", (s) => {
    const want = s.packets.map((p) => [p.type, p.data]);
    const bytes = unhex(s.hex);
    const p1 = new FrameParser();
    const one: Packet[] = [];
    for (const b of bytes) one.push(...p1.push(Uint8Array.of(b)));
    expect(one.map((p) => [p.type, hex(p.data)])).toEqual(want);
    expect(new FrameParser().push(bytes).map((p) => [p.type, hex(p.data)])).toEqual(want);
  });

  it.each(v.bad)("$name: no packet", (b) => {
    expect(new FrameParser().push(unhex(b.hex))).toEqual([]);
  });

  it.each(v.rpcs)("$name", (r) => {
    const d = unhex(r.data);
    const res = decodeResult(d);
    if (r.valid === false) return expect(res).toBeNull();
    if (r.strings === null) return expect(decodeStrings(d.subarray(2))).toBeNull();
    expect(res).toEqual({ command: r.command, strings: r.strings });
  });

  it("refuses strings over 255 bytes", () => {
    expect(() => rpcFrame(CMD.wifi, ["x".repeat(256), ""])).toThrow(/255 bytes/);
  });
});

// A display on the other end of the USB cable: answers like core/improv.cpp, wraps frames in log lines and splits
// its output at odd places, like the USB-Serial/JTAG console does.
class FakeDisplay {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  received: Packet[] = [];
  state: number = STATE.ready;
  joinOk = true;
  answer = true;
  networks = [
    ["Home", "-50", "YES"],
    ["Guest", "-82", "NO"],
    ["Home", "-70", "YES"],
  ];
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private readonly parser = new FrameParser();

  constructor() {
    this.readable = new ReadableStream({ start: (c) => void (this.out = c) });
    this.writable = new WritableStream({ write: (chunk) => this.onBytes(chunk) });
  }

  unplug() {
    this.out.error(new Error("device lost"));
  }

  private emit(...frames: Uint8Array[]) {
    const all = [text("[I][NET] heap 180 KB\n"), ...frames, text("[I][WIFI] scan done\n")];
    const bytes = new Uint8Array(all.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of all) {
      bytes.set(f, o);
      o += f.length;
    }
    for (let i = 0; i < bytes.length; i += 7) this.out.enqueue(bytes.slice(i, i + 7));
  }

  private result(cmd: number, strings: string[]) {
    const p: number[] = [];
    for (const s of strings) p.push(text(s).length, ...text(s));
    return encodeFrame(TYPE.result, [cmd, p.length, ...p]);
  }

  private onBytes(chunk: Uint8Array) {
    for (const p of this.parser.push(chunk)) {
      this.received.push(p);
      if (!this.answer || p.type !== TYPE.rpc) continue;
      const none = encodeFrame(TYPE.error, [0]);
      const urls = ["http://ha-paper-1a2b.local/", "http://192.168.1.23/"];
      switch (p.data[0]) {
        case CMD.getState:
          if (this.state === STATE.provisioned) this.emit(none, encodeFrame(TYPE.state, [this.state]), this.result(CMD.wifi, urls));
          else this.emit(none, encodeFrame(TYPE.state, [this.state]));
          break;
        case CMD.getInfo:
          this.emit(none, this.result(CMD.getInfo, ["HA Paper", "0.2.0", "xteink-x4-pro/esp32-s3", "ha-paper-1a2b"]));
          break;
        case CMD.scan:
          this.emit(none, ...this.networks.map((n) => this.result(CMD.scan, n)), this.result(CMD.scan, []));
          break;
        case CMD.wifi:
          this.state = STATE.provisioning;
          this.emit(none, encodeFrame(TYPE.state, [this.state]));
          setTimeout(() => {
            this.state = this.joinOk ? STATE.provisioned : STATE.ready;
            if (this.joinOk) this.emit(encodeFrame(TYPE.state, [this.state]), this.result(CMD.wifi, urls));
            else this.emit(encodeFrame(TYPE.error, [3]), encodeFrame(TYPE.state, [this.state]));
          }, 30);
          break;
        default:
          this.emit(encodeFrame(TYPE.error, [2]));
      }
    }
  }
}

describe("ImprovClient against a fake display", () => {
  it("detects, reads info and scans", async () => {
    const d = new FakeDisplay();
    const c = new ImprovClient(d);
    c.start();
    expect(await c.detect(1000)).toEqual({ state: STATE.ready, urls: [] });
    expect(await c.info()).toEqual(["HA Paper", "0.2.0", "xteink-x4-pro/esp32-s3", "ha-paper-1a2b"]);
    expect(await c.scan()).toEqual([
      { ssid: "Home", rssi: -50, secure: true },
      { ssid: "Guest", rssi: -82, secure: false },
    ]);
    await c.close();
  });

  it("asks again until the firmware's loop answers", async () => {
    const d = new FakeDisplay();
    d.answer = false;
    setTimeout(() => void (d.answer = true), 120);
    const c = new ImprovClient(d);
    c.start();
    expect(await c.detect(2000, 50)).toEqual({ state: STATE.ready, urls: [] });
    expect(d.received.length).toBeGreaterThan(1);
    await c.close();
  });

  it("gives up after the timeout when nothing speaks Improv", async () => {
    const d = new FakeDisplay();
    d.answer = false;
    const c = new ImprovClient(d);
    c.start();
    const t0 = Date.now();
    expect(await c.detect(300, 100)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    await c.close();
  });

  it("reports a display that is already on Wi-Fi with its URLs", async () => {
    const d = new FakeDisplay();
    d.state = STATE.provisioned;
    const c = new ImprovClient(d);
    c.start();
    expect(await c.detect(1000)).toEqual({ state: STATE.provisioned, urls: ["http://ha-paper-1a2b.local/", "http://192.168.1.23/"] });
    await c.close();
  });

  it("joins and returns the device URLs", async () => {
    const d = new FakeDisplay();
    const c = new ImprovClient(d);
    c.start();
    expect(await c.provision("Home", "hunter22")).toEqual(["http://ha-paper-1a2b.local/", "http://192.168.1.23/"]);
    const wifi = d.received.find((p) => p.data[0] === CMD.wifi)!;
    expect(decodeStrings(wifi.data.subarray(2))).toEqual(["Home", "hunter22"]);
    await c.close();
  });

  it("reports a failed join on a display that was already online", async () => {
    const d = new FakeDisplay();
    d.state = STATE.provisioned;
    d.joinOk = false;
    const c = new ImprovClient(d);
    c.start();
    await expect(c.provision("Home", "wrong")).rejects.toThrow(/could not join "Home"/);
    await c.close();
  });

  it("fails with a clear message on a wrong password", async () => {
    const d = new FakeDisplay();
    d.joinOk = false;
    const c = new ImprovClient(d);
    c.start();
    await expect(c.provision("Home", "wrong")).rejects.toBeInstanceOf(ImprovError);
    await c.close();
  });

  it("stops waiting when the port goes away", async () => {
    const d = new FakeDisplay();
    d.answer = false;
    const c = new ImprovClient(d);
    c.start();
    setTimeout(() => d.unplug(), 50);
    await expect(c.provision("Home", "pw", 5000)).rejects.toThrow(/lost/);
    expect(c.ended).toBe(true);
  });
});
