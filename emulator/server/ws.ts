// Minimal RFC 6455 WebSocket server side (text frames, ping/pong, close) on top of node:http 'upgrade'.
// Enough for the fake Home Assistant /api/websocket. The client side uses Node's built-in WebSocket.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type WsConn = {
  send(text: string): void;
  close(code?: number): void;
  /** Destroy the TCP socket without a close frame (a dropped connection, not a goodbye). */
  drop(): void;
  onMessage: (text: string) => void;
  onClose: () => void;
  readonly open: boolean;
};

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

/** Completes the handshake and returns the connection, or null (400) when it is not a WebSocket upgrade. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  let buf = Buffer.alloc(0); let open = true; let frag: Buffer[] = []; let fragOp = 0;
  const conn: WsConn = {
    send(text) { if (open) socket.write(frame(1, Buffer.from(text))); },
    close(code = 1000) {
      if (!open) return; open = false;
      const p = Buffer.alloc(2); p.writeUInt16BE(code);
      socket.end(frame(8, p));
      conn.onClose();
    },
    drop() { socket.destroy(); },
    onMessage: () => {},
    onClose: () => {},
    get open() { return open; },
  };
  const shut = () => { if (open) { open = false; conn.onClose(); } };
  socket.on('close', shut);
  socket.on('error', shut);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i & 3])); }
      buf = buf.subarray(need);
      if (op === 8) { conn.close(); return; }
      if (op === 9) { socket.write(frame(10, payload)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { frag = [payload]; fragOp = op; } else if (op === 0) frag.push(payload);
      if (fin && fragOp === 1) { const text = Buffer.concat(frag).toString('utf8'); frag = []; conn.onMessage(text); }
    }
  });
  return conn;
}
