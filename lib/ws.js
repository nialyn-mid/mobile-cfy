// Minimal RFC6455 WebSocket client - Node built-ins only.
// Enough to carry ComfyUI's progress messages; no extensions, no fragmentation
// beyond simple continuation, no binary payloads.
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WsClient extends EventEmitter {
  #sock = null;
  #buf = Buffer.alloc(0);
  #fragments = [];
  #fragOp = 0;
  #closed = false;
  #emitClose = false;
  #key = '';

  constructor(url) {
    super();
    this.url = url;
  }

  connect({ timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(this.url);
      } catch (err) {
        return reject(new Error(`bad websocket url: ${this.url}`));
      }
      if (u.protocol !== 'ws:') return reject(new Error(`unsupported scheme ${u.protocol}`));

      this.#key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': this.#key,
          'Sec-WebSocket-Version': '13',
        },
      });

      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('websocket handshake timed out'));
      }, timeoutMs);
      timer.unref?.();

      req.on('upgrade', (res, socket) => {
        clearTimeout(timer);
        const expect = crypto
          .createHash('sha1')
          .update(this.#key + GUID)
          .digest('base64');
        if (res.headers['sec-websocket-accept'] !== expect) {
          socket.destroy();
          return reject(new Error('bad Sec-WebSocket-Accept'));
        }
        socket.setNoDelay(true);
        this.#sock = socket;
        socket.on('data', (d) => this.#onData(d));
        socket.on('close', () => this.#finish(1006, 'socket closed'));
        socket.on('error', (e) => this.emit('error', e));
        this.emit('open');
        resolve(this);
      });

      // ComfyUI-Login answers a bad/missing token here rather than upgrading.
      req.on('response', (res) => {
        clearTimeout(timer);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          const err = new Error(`websocket rejected: HTTP ${res.statusCode} ${body}`);
          err.status = res.statusCode;
          reject(err);
        });
      });

      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.end();
    });
  }

  #onData(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) break;
      this.#handleFrame(frame);
    }
  }

  #readFrame() {
    const b = this.#buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > 8n * 1024n * 1024n) {
        this.close(1009, 'frame too large');
        return null;
      }
      len = Number(big);
      off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.#buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: {
        // binary
        this.#fragments.push(payload);
        if (!fin) {
          this.#fragOp = opcode;
          return;
        }
        const full = Buffer.concat(this.#fragments);
        this.#fragments = [];
        if (this.#fragOp !== 0x1) return; // we only care about text
        this.emit('message', full.toString('utf8'));
        return;
      }
      case 0x8: // close
        this.close(1000, '');
        return;
      case 0x9: // ping -> pong
        this.#send(0xa, payload);
        return;
      case 0xa: // pong
        this.emit('pong');
        return;
      default:
        this.close(1002, `bad opcode ${opcode}`);
    }
  }

  #send(opcode, payload = Buffer.alloc(0)) {
    const sock = this.#sock;
    if (!sock || this.#closed || sock.destroyed) return false;
    const len = payload.length;
    const head =
      len < 126
        ? Buffer.from([0x80 | opcode, 0x80 | len])
        : len < 65536
          ? Buffer.concat([Buffer.from([0x80 | opcode, 0xfe]), len16(len)])
          : Buffer.concat([Buffer.from([0x80 | opcode, 0xff]), len64(len)]);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try {
      sock.write(Buffer.concat([head, mask, masked]));
      return true;
    } catch (e) {
      this.emit('error', e);
      return false;
    }
  }

  sendText(str) {
    return this.#send(0x1, Buffer.from(str, 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sock && !this.#sock.destroyed) {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2, 'utf8');
      this.#send(0x8, body);
      this.#sock.end();
    }
    this.#finish(code, reason);
  }

  #finish(code, reason) {
    if (this.#emitClose) return;
    this.#emitClose = true;
    this.#closed = true;
    this.emit('close', code, reason);
  }
}

function len16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function len64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}