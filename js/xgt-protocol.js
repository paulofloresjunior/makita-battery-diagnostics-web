// Makita XGT framing (spec/xgt.json). Pure functions only: the firmware's 0xE0 command is a dumb
// UART bridge on the TR line, so building frames, checksums and validating replies happens here.
//
// Short frame (8 bytes): CC | crc | cmd | a0 | a1 | a2 | a3 | 33
// Long frame:            A5 A5 | w1 length | w2 message id | 4D 4C | w4 | w5 command |
//                        w6 param length | params | checksum | FF padding
// 0xE0 request data:     flags | wake_ms | reply_timeout_ms | frame...
// 0xE0 payload:          count | received bytes[count]

import { fromHex, toHex } from './bytes.js';
import { SERIAL } from './catalog.js';
import { buildFrame } from './protocol.js';
import {
  XGT_FIRMWARE_COMMAND, XGT_LONG_COMMANDS, XGT_LONG_PARAM_LEN, XGT_NOT_IMPLEMENTED_WRITES,
  XGT_READ_COMMANDS, XGT_SHORT_FRAME, XGT_WAKE,
} from './xgt-catalog.js';

export const XGT_CMD = parseInt(XGT_FIRMWARE_COMMAND.cmd, 16);

const SHORT_START = 0xcc;
const SHORT_END = 0x33;
const LONG_SYNC = 0xa5;
const LONG_MAGIC = [0x4d, 0x4c];
const LONG_HEADER_LEN = 14; // words 0..6
const LONG_BASE_LEN = 16;
const LONG_CHECKSUM_LEN = 2;
const LONG_PADDING_MASK = 0x0f;
const LONG_SIZE_MASK = 0xf0;
const LONG_PAD_BYTE = 0xff;
const READ_REQUEST_TAG = 0x0003;
const READ_RESPONSE_TAG = 0x0001;
const READ_RESPONSE_HEADER_LEN = 4; // 0001 0000

export class XgtFrameError extends Error {
  /** @param {'length'|'framing'|'crc'|'checksum'|'params'} code */
  constructor(code, message) {
    super(message);
    this.name = 'XgtFrameError';
    this.code = code;
  }
}

export function reverseBits(byte) {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) reversed |= ((byte >> bit) & 1) << (7 - bit);
  return reversed;
}

// --- short frame -------------------------------------------------------------------------------

// byte7 (33) is part of the sum: every published frame (m5din, twaymouth, the ADP12 capture)
// only checks that way, although Belik's PROTOCOL.md says bytes 2..6.
export function shortFrameCrc(frame) {
  let sum = frame[0];
  for (let index = 2; index < XGT_SHORT_FRAME.length; index++) sum += frame[index];
  return sum & 0xff;
}

export function buildShortFrame(cmd, args = []) {
  const argBytes = typeof args === 'string' ? fromHex(args) : Uint8Array.from(args);
  if (!Number.isInteger(cmd) || cmd < 0 || cmd > 0xff) throw new XgtFrameError('framing', `cmd=${cmd}; expected a byte 0x00..0xFF`);
  if (argBytes.length > 4) throw new XgtFrameError('length', `${argBytes.length} argument bytes; expected at most 4`);
  const frame = new Uint8Array(XGT_SHORT_FRAME.length);
  frame[0] = SHORT_START;
  frame[2] = cmd;
  frame.set(argBytes, 3);
  frame[7] = SHORT_END;
  frame[1] = shortFrameCrc(frame);
  return frame;
}

// Throws XgtFrameError naming what was received and what was expected.
export function checkShortFrame(frame) {
  if (frame.length !== XGT_SHORT_FRAME.length) {
    throw new XgtFrameError('length', `${frame.length} bytes; expected ${XGT_SHORT_FRAME.length}`);
  }
  if (frame[0] !== SHORT_START || frame[7] !== SHORT_END) {
    throw new XgtFrameError('framing', `starts with ${toHex([frame[0]])} and ends with ${toHex([frame[7]])}; expected CC … 33`);
  }
  const crc = shortFrameCrc(frame);
  if (frame[1] !== crc) {
    throw new XgtFrameError('crc', `CRC ${toHex([frame[1]])}; expected ${toHex([crc])}`);
  }
  return frame;
}

// --- long frame --------------------------------------------------------------------------------

function word(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function wordHex(value) {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

export function longFrameChecksum(bytes, end) {
  let sum = 0;
  for (let index = 2; index < end; index++) sum += bytes[index];
  return sum & 0xffff;
}

// Word 1: bits 0-3 = FF padding bytes; bits 4-7 add 16/32/64/128 bytes to the 16-byte base.
export function longFrameTotal(lengthByte) {
  return LONG_BASE_LEN + (lengthByte & LONG_SIZE_MASK);
}

export function parseLongFrame(bytes) {
  if (bytes.length < LONG_BASE_LEN) {
    throw new XgtFrameError('length', `${bytes.length} bytes; a long frame has at least ${LONG_BASE_LEN}`);
  }
  if (bytes[0] !== LONG_SYNC || bytes[1] !== LONG_SYNC || bytes[6] !== LONG_MAGIC[0] || bytes[7] !== LONG_MAGIC[1]) {
    throw new XgtFrameError('framing', `header ${toHex(bytes.slice(0, 8))}; expected A5 A5 .. .. .. .. 4D 4C (AD AD instead of A5 A5 means the bit order is inverted)`);
  }
  const total = longFrameTotal(bytes[3]);
  const padding = bytes[3] & LONG_PADDING_MASK;
  // The trailing FF padding carries nothing; a reply cut inside it still holds the whole frame.
  if (bytes.length > total || bytes.length < total - padding) {
    throw new XgtFrameError('length', `${bytes.length} bytes; the length word ${toHex(bytes.slice(2, 4))} says ${total} (${padding} of them FF padding)`);
  }
  const paramLen = word(bytes, 12);
  const checksumAt = total - padding - LONG_CHECKSUM_LEN;
  if (LONG_HEADER_LEN + paramLen !== checksumAt) {
    throw new XgtFrameError('length', `parameter length ${paramLen} puts the checksum at byte ${LONG_HEADER_LEN + paramLen}; the length word puts it at ${checksumAt}`);
  }
  const checksum = word(bytes, checksumAt);
  const calc = longFrameChecksum(bytes, checksumAt);
  if (checksum !== calc) {
    throw new XgtFrameError('checksum', `checksum ${wordHex(checksum)}; expected ${wordHex(calc)}`);
  }
  return {
    length: total,
    padding,
    message_id: wordHex(word(bytes, 4)),
    w4: wordHex(word(bytes, 8)),
    command: wordHex(word(bytes, 10)),
    param_len: paramLen,
    params: bytes.slice(LONG_HEADER_LEN, checksumAt),
    checksum: wordHex(checksum),
  };
}

export function buildLongFrame({ messageId, w4, command, params = new Uint8Array(0) }) {
  const body = Uint8Array.from(params);
  const used = LONG_HEADER_LEN + body.length + LONG_CHECKSUM_LEN;
  const total = Math.ceil(used / LONG_BASE_LEN) * LONG_BASE_LEN;
  if (total - LONG_BASE_LEN > LONG_SIZE_MASK) {
    throw new XgtFrameError('length', `${body.length} parameter bytes need a ${total}-byte frame; expected at most ${LONG_BASE_LEN + LONG_SIZE_MASK}`);
  }
  const padding = total - used;
  const frame = new Uint8Array(total).fill(LONG_PAD_BYTE);
  frame.set([LONG_SYNC, LONG_SYNC, 0x00, (total - LONG_BASE_LEN) | padding,
    messageId >> 8, messageId & 0xff, ...LONG_MAGIC, w4 >> 8, w4 & 0xff,
    command >> 8, command & 0xff, body.length >> 8, body.length & 0xff]);
  frame.set(body, LONG_HEADER_LEN);
  const checksumAt = LONG_HEADER_LEN + body.length;
  const checksum = longFrameChecksum(frame, checksumAt);
  frame.set([checksum >> 8, checksum & 0xff], checksumAt);
  return frame;
}

// Read request params: 0003 | count | ids[count].
export function parseReadRequestParams(params) {
  if (params.length < 4 || word(params, 0) !== READ_REQUEST_TAG) {
    throw new XgtFrameError('params', `request parameters start with ${toHex(params.slice(0, 2))}; expected 00 03`);
  }
  const count = word(params, 2);
  if (params.length !== 4 + 2 * count) {
    throw new XgtFrameError('params', `${params.length} parameter bytes for ${count} ids; expected ${4 + 2 * count}`);
  }
  return Array.from({ length: count }, (_, index) => wordHex(word(params, 4 + 2 * index)));
}

// Read response params: 0001 0000 | (id, value)... The value length is not in the frame, so an
// id missing from XGT_LONG_PARAM_LEN ends the parse.
export function parseReadResponseParams(params) {
  if (params.length < READ_RESPONSE_HEADER_LEN || word(params, 0) !== READ_RESPONSE_TAG) {
    throw new XgtFrameError('params', `response parameters start with ${toHex(params.slice(0, 2))}; expected 00 01`);
  }
  const values = {};
  let offset = READ_RESPONSE_HEADER_LEN;
  while (offset < params.length) {
    const id = wordHex(word(params, offset));
    const length = XGT_LONG_PARAM_LEN[id];
    if (length === undefined) throw new XgtFrameError('params', `parameter ${id} at byte ${offset} has no known length; expected one of the spec's long_frame.params`);
    if (offset + 2 + length > params.length) throw new XgtFrameError('params', `parameter ${id} needs ${length} bytes; only ${params.length - offset - 2} left`);
    values[id] = toHex(params.slice(offset + 2, offset + 2 + length)).replace(/ /g, '');
    offset += 2 + length;
  }
  return values;
}

// Models are stored as reversed ASCII ("20 46 30 35 30 34 4C 42" -> "BL4050F ").
export function reversedAscii(bytes) {
  return String.fromCharCode(...Array.from(bytes).reverse()).trim();
}

export function isLongReadCommand(commandHex) {
  return XGT_LONG_COMMANDS.some((command) => command.id === commandHex && command.kind === 'read');
}

// --- safety ------------------------------------------------------------------------------------

const REFUSED_FRAMES = new Set(XGT_NOT_IMPLEMENTED_WRITES.flatMap((write) => write.frames));

// Reads only: lockout reset, calibration reset and any non-read command are refused here, so no
// code path can send them by accident.
export function assertReadOnlyFrame(frame) {
  const hex = toHex(frame);
  if (REFUSED_FRAMES.has(hex)) {
    throw new XgtFrameError('framing', `refused ${hex}: lockout/calibration resets are documented but intentionally not implemented`);
  }
  if (frame[0] === SHORT_START) {
    const cmd = toHex([frame[2]]);
    if (frame.length !== XGT_SHORT_FRAME.length || !XGT_READ_COMMANDS.includes(cmd)) {
      throw new XgtFrameError('framing', `refused short frame ${hex}: command ${cmd}; expected a read (${XGT_READ_COMMANDS.join(' or ')})`);
    }
    return frame;
  }
  if (frame[0] === LONG_SYNC) {
    const { command } = parseLongFrame(frame);
    if (!isLongReadCommand(command)) {
      throw new XgtFrameError('framing', `refused long frame with command ${command}; expected a read command`);
    }
    return frame;
  }
  throw new XgtFrameError('framing', `refused ${hex}: expected a short (CC) or long (A5 A5) read frame`);
}

// --- firmware command 0xE0 ---------------------------------------------------------------------

// wake_ms is 0 without the wake flag, as in docs/xgt.md's examples, so web and Python dumps
// carry the same request bytes.
export function buildXgtRequest(frame, { wake = false, wakeMs = wake ? XGT_WAKE.wait_ms : 0, timeoutMs = XGT_SHORT_FRAME.suggested_timeout_ms, expectedLen }) {
  assertReadOnlyFrame(frame);
  for (const [field, value] of [['wake_ms', wakeMs], ['timeout_ms', timeoutMs]]) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new XgtFrameError('length', `${field}=${value}; expected 0..255`);
  }
  if (!Number.isInteger(expectedLen) || expectedLen < 1 || expectedLen > XGT_FIRMWARE_COMMAND.max_received) {
    throw new XgtFrameError('length', `expected reply of ${expectedLen} bytes; the firmware receives 1..${XGT_FIRMWARE_COMMAND.max_received}`);
  }
  const rspLen = 1 + expectedLen;
  if (rspLen > SERIAL.max_payload) throw new XgtFrameError('length', `rsp_len=${rspLen}; expected at most ${SERIAL.max_payload}`);
  const data = Uint8Array.from([wake ? XGT_FIRMWARE_COMMAND.flag_wake : 0, wakeMs, timeoutMs, ...frame]);
  return { cmd: XGT_CMD, data, rspLen };
}

export function xgtRequestHex(request) {
  return toHex(buildFrame(request.cmd, request.data, request.rspLen));
}

// Splits the 0xE0 payload. Old firmware answers an empty payload to the unknown command.
export function splitXgtPayload(payload) {
  if (payload.length === 0) return { kind: 'no_command' };
  const count = payload[0];
  const received = payload.slice(1);
  if (received.length !== count) {
    return { kind: 'inconsistent', count, received };
  }
  return { kind: count === 0 ? 'silent' : 'reply', count, received };
}

// The frame a dump request carried: data after cmd, flags, wake_ms and timeout.
export function frameFromRequestHex(requestHex) {
  const bytes = fromHex(requestHex);
  if (bytes.length < 7 || bytes[3] !== XGT_CMD) return null;
  return bytes.slice(7);
}
