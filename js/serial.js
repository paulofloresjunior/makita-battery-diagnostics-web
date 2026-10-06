// Transport + request layer. WebSerialTransport talks to the browser's Web Serial API;
// ObiLink only needs an object with write / readExact / discardInput, so tests drive it with
// a fake firmware instead (tests/fakes.mjs).

import { CMD, SERIAL } from './catalog.js';
import { buildFrame, checkPayload, checkResponseHeader, decodeSession, encodeSession, formatCmd, ProtocolError, versionString } from './protocol.js';

export function isWebSerialSupported(nav = globalThis.navigator) {
  return Boolean(nav && 'serial' in nav);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WebSerialTransport {
  constructor(port) {
    this.port = port;
    this.buffer = [];
    this.waiters = new Set();
    this.reader = null;
    this.readLoopDone = null;
    this.onClose = () => {};
  }

  async open() {
    await this.port.open({ baudRate: SERIAL.baud });
    this.readLoopDone = this.readLoop();
    // Opening the port pulses DTR, which reboots the Nano; its bootloader eats early bytes.
    await sleep(SERIAL.boot_wait_ms);
    this.discardInput();
  }

  async readLoop() {
    let failure = null;
    try {
      while (this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) return;
            for (const byte of value) this.buffer.push(byte);
            this.wakeWaiters();
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      // The cable was pulled or the device reset: tell the UI instead of hanging requests.
      failure = error;
    } finally {
      this.wakeWaiters();
      this.onClose(failure);
    }
  }

  wakeWaiters() {
    for (const wake of this.waiters) wake();
  }

  discardInput() {
    this.buffer = [];
  }

  async write(bytes) {
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  // Resolves with up to `count` bytes; fewer means the deadline passed.
  readExact(count, timeoutMs) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(Uint8Array.from(this.buffer.splice(0, Math.min(count, this.buffer.length))));
      };
      const check = () => {
        if (this.buffer.length >= count || !this.port.readable) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  async close() {
    try {
      await this.reader?.cancel();
      await this.readLoopDone;
    } finally {
      await this.port.close();
    }
  }
}

export class ObiLink {
  constructor(transport, { timeoutMs = SERIAL.response_timeout_ms } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    // One frame at a time: the firmware has no request ids, so overlapping requests would
    // read each other's answers.
    this.queue = Promise.resolve();
    // Frames written so far; the UI shows how many a read took (each costs the 400 ms wake-up).
    this.commandCount = 0;
  }

  request(cmd, data, rspLen, timeoutMs = this.timeoutMs) {
    const run = () => this.exchange(cmd, data, rspLen, timeoutMs);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async exchange(cmd, data, rspLen, timeoutMs) {
    const frame = buildFrame(cmd, data, rspLen);
    this.transport.discardInput();
    await this.transport.write(frame);
    this.commandCount += 1;
    const header = await this.transport.readExact(2, timeoutMs);
    if (header.length < 2) {
      throw new ProtocolError(`no response to cmd ${formatCmd(cmd)} within ${timeoutMs} ms (got ${header.length} of 2 header bytes)`);
    }
    const length = checkResponseHeader(header, cmd);
    return checkPayload(await this.transport.readExact(length, timeoutMs), length, cmd);
  }

  async version() {
    return versionString(await this.request(CMD.VERSION, [], 3));
  }

  async session(transactions) {
    const { data, rspLen, totalDelayMs } = encodeSession(transactions);
    // The firmware answers only after running every delay.
    const payload = await this.request(CMD.SESSION, data, rspLen, this.timeoutMs + totalDelayMs);
    return decodeSession(transactions, payload);
  }
}
