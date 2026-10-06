// Decoders for every read in the catalog. Always fed raw payload bytes, never stored decodes,
// so old dumps benefit from decoder fixes (spec: dump_format.note).

import { blankKind, fromHex, nibbleSwap, round, toHex, u16le, u32le } from './bytes.js';
import { ACK, CHECKSUMS, COUNTS_PER_MAH, FAILURE_CODE_WARNING, MSG_FLAGS, MSG_LEN, MSG_OFFSET, NYBBLE, TESTMODE } from './catalog.js';
import { baseReadName, catalogEntryFor } from './protocol.js';
import { isCxtReadName } from './cxt-catalog.js';
import { calibrationVccMv, decodeCxtPayload } from './cxt-decode.js';
import { isXgtReadName } from './xgt-catalog.js';
import { decodeXgtRead } from './xgt-decode.js';

const LXT_MSG_LEN = MSG_OFFSET + MSG_LEN;
const LXT_DATA_MIN = 16;
const LXT_DATA_FULL = 25;
const LXT_DATA_WITH_COUNTER = 29;
// BTC04 scales (rosvall) and m5din's D4 50 high byte = 10 + bars.
const MAX_BARS = 7;
const BTC04_HEALTH_FULL_RATIO = 80;
const BTC04_HEALTH_OFFSET = 5;
const BTC04_HEALTH_MAX = 4;
const LXT_DATA_EXTENDED = 0x69;
// ROM byte 3 is 0x64 (100) on every LXT-chip pack and 0x02 on the F0513 one; synrais picks
// the protocol by "byte 3 < 100 -> F0513".
const F0513_ROM_BYTE3_LIMIT = 100;

function silentOrNull(payload) {
  const kind = blankKind(payload);
  return kind ? { status: 'silent', blank: kind } : null;
}

function shortRead(got, expected) {
  return { status: 'short', error: `${got} bytes; expected ${expected}` };
}

// --- lxt_msg -----------------------------------------------------------------------------

export function msgNybble(msg, n) {
  const byte = msg[n >> 1];
  return n & 1 ? byte >> 4 : byte & 0x0f;
}

function checksumCalc(msg, checksum) {
  let sum = 0;
  for (let n = checksum.first; n <= checksum.last; n++) sum += msgNybble(msg, n);
  return sum & 0x0f;
}

function decodeCounter(msg, firstNybble) {
  const n = [0, 1, 2, 3].map((i) => msgNybble(msg, firstNybble + i));
  // 13 bits: only bit 0 of the most significant nybble belongs to the counter.
  return ((n[0] & 0x1) << 12) | (n[1] << 8) | (n[2] << 4) | n[3];
}

function decodeCapacity(raw) {
  const code = nibbleSwap(raw);
  // Newer packs reportedly store whole Ah (PocketOBI/PackScope); none of ours do.
  const wholeAh = raw >= 1 && raw <= 8 && code > 60;
  return { capacity_code: code, capacity_ah: wholeAh ? raw : round(code / 10, 1) };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function decodeChecksums(msg) {
  const result = {};
  for (const checksum of CHECKSUMS) {
    const stored = msgNybble(msg, checksum.stored_at);
    const calc = checksumCalc(msg, checksum);
    result[checksum.name] = { stored, calc, ok: stored === calc, inverted: stored === (calc ^ 0x0f), primary: checksum.primary };
  }
  return result;
}

export function failureSeverity(failureCode) {
  if (failureCode === 0) return 'ok';
  return failureCode === FAILURE_CODE_WARNING ? 'aviso' : 'travada';
}

export function cellCountFromFlags(flags) {
  if (flags <= MSG_FLAGS.FOUR_CELL_MAX) return 4;
  if (flags <= MSG_FLAGS.FIVE_CELL_MAX) return 5;
  return flags === MSG_FLAGS.TYPE6 ? 10 : null;
}

function lockCauses(failureCode, checksums, chargerLock, flags) {
  const causes = [];
  if (failureSeverity(failureCode) === 'travada') causes.push('failure_code');
  const bad = Object.values(checksums).filter((c) => !c.ok);
  const primaryCount = CHECKSUMS.filter((c) => c.primary).length;
  // The BMS lock writes exactly the three primary checksums inverted; anything else is
  // a plain mismatch (corruption or a partial write).
  const bmsLock = bad.length === primaryCount && bad.every((c) => c.primary && c.inverted);
  if (bmsLock) causes.push('inverted_checksums');
  if (bad.length > 0 && !bmsLock) causes.push('checksum_mismatch');
  // Nybble 34 is the high half of the flags byte: on a type-6 pack (0x1E) it is 1 by design.
  if (chargerLock !== 0 && flags !== MSG_FLAGS.TYPE6) causes.push('charger_lock');
  return causes;
}

export function decodeLxtMsg(payload) {
  if (payload.length < LXT_MSG_LEN) return shortRead(payload.length, LXT_MSG_LEN);
  const silent = silentOrNull(payload);
  if (silent) return silent;

  const rom = payload.slice(0, MSG_OFFSET);
  const msg = payload.slice(MSG_OFFSET, LXT_MSG_LEN);
  const failureCode = msgNybble(msg, NYBBLE.FAILURE_CODE);
  const chargerLock = msgNybble(msg, NYBBLE.CHARGER_LOCK);
  const checksums = decodeChecksums(msg);
  const flags = nibbleSwap(msg[MSG_FLAGS.BYTE]);
  const severity = failureSeverity(failureCode);
  return {
    status: 'ok',
    rom: toHex(rom),
    serial: toHex(rom.slice(6, 8)),
    chip: rom[3] < F0513_ROM_BYTE3_LIMIT ? 'f0513' : 'lxt',
    manufacture_date: `20${pad2(rom[0])}-${pad2(rom[1])}-${pad2(rom[2])}`,
    ...decodeCapacity(msg[16]),
    charge_count: decodeCounter(msg, NYBBLE.CHARGE_COUNT),
    second_counter: decodeCounter(msg, NYBBLE.SECOND_COUNTER),
    failure_code: failureCode,
    failure_severity: severity,
    locked: severity === 'travada',
    charger_lock_nybble: chargerLock,
    flags,
    cell_count: cellCountFromFlags(flags),
    checksums,
    lock_causes: lockCauses(failureCode, checksums, chargerLock, flags),
    model_code: msg[19],
    battery_type: nibbleSwap(msg[11]),
    damage_rating: (msgNybble(msg, NYBBLE.DAMAGE_RATING) >> 1) & 0x07,
    overdischarge_idx: nibbleSwap(msg[24]),
    overload_idx: nibbleSwap(msg[25]),
  };
}

// --- lxt_data ----------------------------------------------------------------------------

function deciKelvinToCelsius(raw) {
  // 1/10 K (SBS convention); read as 1/100 °C every pack sat at ~30 °C even off the charger.
  return round(raw / 10 - 273.15, 2);
}

export function decodeLxtData(payload) {
  if (payload.length < LXT_DATA_MIN) return shortRead(payload.length, LXT_DATA_MIN);
  const silent = silentOrNull(payload);
  if (silent) return silent;

  const tempsRaw = [u16le(payload, 14)];
  if (payload.length >= 18) tempsRaw.push(u16le(payload, 16));
  const decoded = {
    status: 'ok',
    pack_mv: u16le(payload, 0),
    cells_mv: [2, 4, 6, 8, 10].map((offset) => u16le(payload, offset)),
    temps_raw: tempsRaw,
    temps_c: tempsRaw.map(deciKelvinToCelsius),
  };
  if (payload.length >= LXT_DATA_FULL) {
    decoded.soc_raw = u16le(payload, 21);
    decoded.soc_pct = round(decoded.soc_raw / 256, 1);
    decoded.real_capacity_mah = u16le(payload, 23);
  }
  if (payload.length >= LXT_DATA_WITH_COUNTER) {
    decoded.charge_counter_raw = u32le(payload, 25);
    decoded.remaining_mah = round(decoded.charge_counter_raw / COUNTS_PER_MAH, 1);
  }
  if (payload.length >= LXT_DATA_EXTENDED) {
    decoded.extended = {
      target_capacity_mah: u16le(payload, 0x1d),
      error_status: payload[0x30],
      error_counters: toHex(payload.slice(0x57, 0x5d)),
      stability_count: u16le(payload, 0x67),
    };
  }
  return decoded;
}

// --- memory reads: `len` bytes + 0x06 ACK --------------------------------------------------

const MEMORY_BODY_DECODERS = {
  type0_id: () => ({}),
  type3_id: () => ({}),
  d4_assembly_date: (body) => ({ date: `20${pad2(body[0])}-${pad2(body[1])}-${pad2(body[2])}` }),
  // Capacity estimated by the BMS, mAh: equals lxt_data 23-24 (BL1840B #1, docs/achados.md).
  d4_0150: (body) => {
    return { value: u16le(body, 0) };
  },
  d4_od_events: (body) => ({ count: body[0] }),
  // synrais' layout: three 10-bit counters (PocketOBI masks the third to 8 bits).
  d4_overload: (body) => ({
    counters: [
      (body[0] >> 6) | (body[1] << 2),
      body[3] | ((body[4] & 0x03) << 8),
      (body[5] >> 4) | ((body[6] & 0x3f) << 4),
    ],
  }),
  d7_charge_level: (body) => ({ value: u32le(body, 0) }),
  d7_current: (body) => ({ amps: round((32768 - u16le(body, 0)) / 100, 2) }),
};

export function decodeMemoryRead(name, payload) {
  const base = baseReadName(name);
  if (base === 'lxt_data_ext') return decodeLxtData(payload);
  const decoder = MEMORY_BODY_DECODERS[base];
  if (!decoder) throw new Error(`no memory decoder for "${name}"; expected one of ${Object.keys(MEMORY_BODY_DECODERS).join(', ')}`);
  const expected = catalogEntryFor(base).rsp_len;
  // The decoders index fixed offsets: a reply of another length is reported, not guessed at.
  if (payload.length !== expected) return shortRead(payload.length, expected);
  const silent = silentOrNull(payload);
  if (silent) return silent;
  const body = payload.slice(0, -1);
  return { status: 'ok', ack: payload[payload.length - 1] === ACK, ...decoder(body) };
}

// --- BTC04-style scores (rosvall's notes on the Makita BTC04 checker) ---------------------
// Integer math as on the checker's MCU; null when the capacity code is 0.

// "SOF" 0-7: percent of NOMINAL capacity left, in tenths, capped at 7.
export function btc04ChargeBars(chargeCounter, capacityCode) {
  if (!(capacityCode > 0)) return null;
  const ratio = Math.floor(chargeCounter / (capacityCode * COUNTS_PER_MAH));
  if (ratio === 0) return 0;
  if (ratio < 10) return 1;
  return Math.min(Math.floor(ratio / 10), MAX_BARS);
}

// Health 0-4 from D4 50 01 02 (hypothesis); clamped to 0 where rosvall's formula goes negative.
export function btc04HealthScore(healthRaw, capacityCode) {
  if (!(capacityCode > 0)) return null;
  const ratio = Math.floor(healthRaw / capacityCode);
  if (ratio > BTC04_HEALTH_FULL_RATIO) return BTC04_HEALTH_MAX;
  return Math.max(Math.floor(ratio / 10) - BTC04_HEALTH_OFFSET, 0);
}

// --- F0513 (older chip, e.g. BL1830) -------------------------------------------------------

function decodeF0513(base, payload) {
  if (payload.length !== 2) return shortRead(payload.length, 2);
  const silent = silentOrNull(payload);
  if (silent) return silent;
  const value = u16le(payload, 0);
  if (base === 'f0513_model' || base === 'f0513_version') {
    // The firmware stores these two bytes swapped; the OBI site renders them as "BL" + hex.
    return { status: 'ok', text: `BL${payload[0].toString(16).toUpperCase()}${payload[1].toString(16).toUpperCase()}` };
  }
  if (base === 'f0513_temp') return { status: 'ok', temp_raw: value, temp_c: deciKelvinToCelsius(value) };
  return { status: 'ok', mv: value };
}

function decodeAscii(payload) {
  const silent = silentOrNull(payload);
  if (silent) return silent;
  let text = '';
  for (const byte of payload) {
    if (byte < 0x20 || byte > 0x7e) break; // NUL-padded field
    text += String.fromCharCode(byte);
  }
  return { status: 'ok', text: text.trim() };
}

// `calibration` is the dump-level {vcc_mv}; only the CXT ADC read uses it.
export function decodeRead(name, payload, { calibration = null } = {}) {
  const base = baseReadName(name);
  // XGT reads store the 0xE0 payload, CXT the 0xE1 one; one entry point keeps diff.js and the
  // raw view family-blind.
  if (isXgtReadName(base)) return decodeXgtRead(base, payload);
  if (isCxtReadName(base)) return decodeCxtPayload(payload, { vccMv: calibrationVccMv(calibration) });
  const entry = catalogEntryFor(name);
  // Dump convention shared with python/: a catalog read of another length is reported
  // (got vs expected), never decoded from a partial or overlong frame.
  if (entry && payload.length !== entry.rsp_len) return shortRead(payload.length, entry.rsp_len);
  if (base === 'lxt_msg') return decodeLxtMsg(payload);
  if (base === 'lxt_data') return decodeLxtData(payload);
  if (base === 'lxt_model') return decodeAscii(payload);
  if (base.startsWith('f0513_')) return decodeF0513(base, payload);
  if (entry?.group === 'memory') return decodeMemoryRead(base, payload);
  if (base === 'enter' || base === 'exit') return decodeAckOnly(payload);
  return { status: 'unknown' };
}

// tm_enter / tm_exit answer a single 0x06.
function decodeAckOnly(payload) {
  const silent = silentOrNull(payload);
  if (silent) return silent;
  return { status: 'ok', ack: payload.length === 1 && payload[0] === ACK };
}

// Decodes a dump read ({name, ok, response, error}); failed reads keep their error text.
export function decodeStoredRead(read, options = {}) {
  if (!read.ok) return { status: 'error', error: read.error || 'falha sem mensagem' };
  try {
    return decodeRead(read.name, fromHex(read.response), options);
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

// --- whole-pack report ---------------------------------------------------------------------

function okDecode(decodedByName, name) {
  const decoded = decodedByName.get(name);
  return decoded?.status === 'ok' ? decoded : null;
}

function f0513Readings(decodedByName) {
  const cells = [1, 2, 3, 4, 5].map((i) => okDecode(decodedByName, `f0513_vcell${i}`));
  if (cells.some((cell) => cell === null)) return null;
  const cellsMv = cells.map((cell) => cell.mv);
  const temp = okDecode(decodedByName, 'f0513_temp');
  return {
    source: 'f0513',
    pack_mv: cellsMv.reduce((sum, mv) => sum + mv, 0),
    cells_mv: cellsMv,
    temps_c: temp ? [temp.temp_c] : [],
  };
}

function lxtReadings(data) {
  if (!data) return null;
  return {
    source: 'lxt_data',
    pack_mv: data.pack_mv,
    cells_mv: data.cells_mv,
    temps_c: data.temps_c,
    soc_pct: data.soc_pct,
    real_capacity_mah: data.real_capacity_mah,
    charge_counter_raw: data.charge_counter_raw,
    remaining_mah: data.remaining_mah,
  };
}

// Everything the UI and the diagnosis need, from a dump's reads and line probe.
export function buildReport(reads, line = null) {
  const decodedByName = new Map(reads.map((read) => [read.name, decodeStoredRead(read)]));
  const msg = okDecode(decodedByName, 'lxt_msg');
  const data = okDecode(decodedByName, 'lxt_data');
  const asciiModel = okDecode(decodedByName, 'lxt_model');
  const f0513Model = okDecode(decodedByName, 'f0513_model');
  const model = asciiModel?.text
    ? { source: 'lxt_model', text: asciiModel.text }
    : f0513Model ? { source: 'f0513', text: f0513Model.text } : null;
  const isMemory = (name) => catalogEntryFor(name)?.group === 'memory';
  return {
    decodedByName,
    line,
    msg,
    msgStatus: decodedByName.get('lxt_msg') ?? null,
    model,
    data,
    readings: lxtReadings(data) ?? f0513Readings(decodedByName),
    memory: reads.filter((read) => isMemory(read.name) && !read.name.startsWith(TESTMODE.prefix)),
    testmode: reads.filter((read) => read.name.startsWith(TESTMODE.prefix)),
  };
}
