// Serial framing for the firmware in firmware/src/main.cpp. Pure functions only: the transport
// (Web Serial or a test fake) lives in serial.js.
//
// Request:  01 | len(data) | rsp_len | cmd | data...
// Response: cmd | rsp_len | payload[rsp_len]

import { fromHex, toHex } from './bytes.js';
import { SERIAL, TESTMODE, findRead, READS } from './catalog.js';

const FRAME_START = 0x01;
const FLAG_RESET = 0x01;
const SESSION_HEADER_LEN = 4;
// The firmware reports "no reset issued" with this presence value.
const PRESENCE_SKIPPED = 0xff;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function buildFrame(cmd, data, rspLen) {
  const body = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (!Number.isInteger(cmd) || cmd < 0 || cmd > 0xff) {
    throw new ProtocolError(`cmd=${cmd}; expected a byte 0x00..0xFF`);
  }
  if (body.length > 255) {
    throw new ProtocolError(`data has ${body.length} bytes; the frame length field holds at most 255`);
  }
  if (!Number.isInteger(rspLen) || rspLen < 0 || rspLen > SERIAL.max_payload) {
    throw new ProtocolError(`rsp_len=${rspLen}; expected 0..${SERIAL.max_payload}`);
  }
  const frame = new Uint8Array(4 + body.length);
  frame.set([FRAME_START, body.length, rspLen, cmd]);
  frame.set(body, 4);
  return frame;
}

// Validates the 2-byte response header against the command that was sent.
export function checkResponseHeader(header, cmd) {
  if (header.length < 2) {
    throw new ProtocolError(`no response to cmd ${formatCmd(cmd)}: got ${header.length} of 2 header bytes`);
  }
  if (header[0] !== cmd) {
    throw new ProtocolError(`response echoes cmd ${formatCmd(header[0])}; expected ${formatCmd(cmd)}`);
  }
  return header[1];
}

// Parses a complete response buffer (header + payload); used by tests and offline tools.
export function parseResponse(bytes, cmd) {
  const length = checkResponseHeader(bytes.subarray(0, 2), cmd);
  return checkPayload(bytes.subarray(2, 2 + length), length, cmd);
}

export function checkPayload(payload, length, cmd) {
  if (payload.length !== length) {
    throw new ProtocolError(`cmd ${formatCmd(cmd)}: got ${payload.length} of ${length} payload bytes`);
  }
  return payload;
}

export function requestForRead(read) {
  return { cmd: parseInt(read.cmd, 16), data: fromHex(read.data), rspLen: read.rsp_len };
}

export function readsInGroups(...groups) {
  return READS.filter((read) => groups.includes(read.group));
}

export function versionString(payload) {
  if (payload.length !== 3) {
    throw new ProtocolError(`version reply has ${payload.length} bytes; expected 3 (major minor patch)`);
  }
  return Array.from(payload).join('.');
}

// --- Session (cmd 0xD1): several 1-Wire transactions while ENABLE stays high ---------------
// Every other command drops ENABLE when it answers, which ends test mode, so test-mode reads
// must share one frame with the entry.

export function transaction(write, readLen, { reset = true, delayMs = 0, name = '' } = {}) {
  return { name, write: write instanceof Uint8Array ? write : fromHex(write), readLen, reset, delayMs };
}

export function encodeTransaction(tx) {
  if (!Number.isInteger(tx.delayMs) || tx.delayMs < 0 || tx.delayMs > 255) {
    throw new ProtocolError(`delay_ms=${tx.delayMs}; expected 0..255`);
  }
  if (tx.write.length > 255 || !Number.isInteger(tx.readLen) || tx.readLen < 0 || tx.readLen > 255) {
    throw new ProtocolError(`transaction writes ${tx.write.length} and reads ${tx.readLen} bytes; expected at most 255 each`);
  }
  const encoded = new Uint8Array(SESSION_HEADER_LEN + tx.write.length);
  encoded.set([tx.reset ? FLAG_RESET : 0, tx.delayMs, tx.write.length, tx.readLen]);
  encoded.set(tx.write, SESSION_HEADER_LEN);
  return encoded;
}

export function encodeSession(transactions) {
  if (transactions.length === 0) {
    throw new ProtocolError('session has 0 transactions; expected at least 1');
  }
  const parts = transactions.map(encodeTransaction);
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  const rspLen = transactions.reduce((sum, tx) => sum + 1 + tx.readLen, 0);
  if (rspLen > SERIAL.max_payload) {
    throw new ProtocolError(`session reads ${rspLen} bytes incl. presence; expected at most ${SERIAL.max_payload}`);
  }
  const totalDelayMs = transactions.reduce((sum, tx) => sum + tx.delayMs, 0);
  return { data, rspLen, totalDelayMs };
}

export function decodeSession(transactions, payload) {
  if (payload.length === 0) {
    throw new ProtocolError('firmware rejected cmd 0xD1 (session): it predates the command or the request was malformed');
  }
  const expected = transactions.reduce((sum, tx) => sum + 1 + tx.readLen, 0);
  if (payload.length !== expected) {
    throw new ProtocolError(`session returned ${payload.length} bytes; expected ${expected}`);
  }
  let offset = 0;
  return transactions.map((tx) => {
    const presenceByte = payload[offset];
    const read = payload.slice(offset + 1, offset + 1 + tx.readLen);
    offset += 1 + tx.readLen;
    return { presence: presenceByte === PRESENCE_SKIPPED ? null : presenceByte, read };
  });
}

// Test-mode session from the spec: enter, every memory read except lxt_data_ext, exit.
export function testmodeTransactions() {
  const reads = readsInGroups('memory').filter((read) => !TESTMODE.skip.includes(read.name));
  const enter = transaction(TESTMODE.enter, 1, { name: `${TESTMODE.prefix}enter` });
  const middle = reads.map((read, index) =>
    transaction(`${read.cmd} ${read.data}`, read.rsp_len, {
      name: TESTMODE.prefix + read.name,
      delayMs: index === 0 ? TESTMODE.enter_settle_ms : TESTMODE.gap_ms,
    }),
  );
  const exit = transaction(TESTMODE.exit, 1, { name: `${TESTMODE.prefix}exit`, delayMs: TESTMODE.gap_ms });
  return [enter, ...middle, exit];
}

// The name a read is decoded as: tm_lxt_msg and after_lxt_msg decode like lxt_msg.
const NAME_PREFIXES = [TESTMODE.prefix, 'before_', 'after_'];

export function baseReadName(name) {
  const prefix = NAME_PREFIXES.find((candidate) => name.startsWith(candidate));
  return prefix ? name.slice(prefix.length) : name;
}

export function catalogEntryFor(name) {
  return findRead(baseReadName(name));
}

export function formatCmd(cmd) {
  return `0x${toHex([cmd])}`;
}
