// Decoders for XGT reads (names xgt_*, spec/xgt.json). Fed the raw 0xE0 payload stored in the
// dump (count | received bytes), never stored decodes, like decode.js does for LXT.

import { fromHex, round, u16le } from './bytes.js';
import { findXgtStep, isXgtReadName, XGT_MODEL_PARAMS, XGT_MODEL_READ, XGT_STEP_NAMES } from './xgt-catalog.js';
import { checkShortFrame, parseLongFrame, parseReadResponseParams, reversedAscii, splitXgtPayload, XgtFrameError } from './xgt-protocol.js';

const MODEL_LEN = 8;
const KELVIN_OFFSET = 273.15;
const CHARGE_SCALE = 255;
const CELL_CAPACITY_STEP_MAH = 100;
export const XGT_CELL_COUNT = 10;
export const XGT_HIST_BINS = 6;

function u16Value(reply) {
  return u16le(reply, 4);
}

function histogram(base, reply) {
  // xgt_temp_hist1 -> bins 3 and 4: two 8-bit bins per read.
  const first = 2 * Number(base.at(-1)) + 1;
  return { first_bin: first, bins: [reply[4], reply[5]], [`bin${first}`]: reply[4], [`bin${first + 1}`]: reply[5] };
}

const VALUE_DECODERS = {
  xgt_cycles: (reply) => ({ cycles: u16Value(reply) }),
  xgt_lockout: (reply) => ({ locked: reply[4] !== 0, raw: reply[4] }),
  xgt_capacity: (reply) => ({ capacity_mah: u16Value(reply) }),
  // raw / 255 is already the percentage (raw 25500 = 100 %).
  xgt_charge: (reply) => ({ charge_pct: round(u16Value(reply) / CHARGE_SCALE, 2), raw: u16Value(reply) }),
  xgt_temp1: (reply) => ({ temp_c: round(u16Value(reply) / 10 - KELVIN_OFFSET, 2), raw: u16Value(reply) }),
  xgt_temp2: (reply) => ({ temp_c: round(u16Value(reply) / 10 - KELVIN_OFFSET, 2), raw: u16Value(reply) }),
  xgt_pack_voltage: (reply) => ({ pack_v: u16Value(reply) / 1000, mv: u16Value(reply) }),
  xgt_cell_capacity: (reply) => ({ cell_capacity_mah: reply[5] * CELL_CAPACITY_STEP_MAH }),
  xgt_pack_config: (reply) => ({ parallel: reply[4], series: reply[5] }),
};

function valueDecoder(base) {
  if (VALUE_DECODERS[base]) return VALUE_DECODERS[base];
  if (/^xgt_cell\d+$/.test(base)) return (reply) => ({ cell_v: u16Value(reply) / 1000, mv: u16Value(reply) });
  if (/^xgt_(temp|current)_hist\d$/.test(base)) return (reply) => histogram(base, reply);
  return null;
}

function invalid(error) {
  if (!(error instanceof XgtFrameError)) throw error;
  return { status: 'invalid', error: error.code, detail: error.message };
}

// Model from a long reply: a known model parameter if the params parse, else the spec's rule
// (the 8 bytes right before the checksum).
export function decodeModelFrame(frame) {
  const parsed = parseLongFrame(frame);
  let params = null;
  try {
    params = parseReadResponseParams(parsed.params);
  } catch (error) {
    if (!(error instanceof XgtFrameError)) throw error;
  }
  const paramId = XGT_MODEL_PARAMS.find((id) => params?.[id]);
  const modelBytes = paramId ? fromHex(params[paramId].replace(/(..)/g, '$1 ')) : parsed.params.slice(-MODEL_LEN);
  return { status: 'ok', model: reversedAscii(modelBytes), command: parsed.command, message_id: parsed.message_id, params };
}

// Decodes the frame the battery sent (no 0xE0 count byte), as in test-vectors/xgt.json.
export function decodeXgtReply(name, reply) {
  if (name === XGT_MODEL_READ.name) {
    try {
      return decodeModelFrame(reply);
    } catch (error) {
      return invalid(error);
    }
  }
  const decode = valueDecoder(name);
  if (!decode) return { status: 'unknown' };
  try {
    checkShortFrame(reply);
  } catch (error) {
    return invalid(error);
  }
  return { status: 'ok', ...decode(reply) };
}

// Decodes a stored 0xE0 payload.
export function decodeXgtRead(name, payload) {
  const split = splitXgtPayload(payload);
  if (split.kind === 'no_command') return { status: 'no_command', error: 'firmware answered an empty payload; expected the 0xE0 (XGT) command' };
  if (split.kind === 'inconsistent') return { status: 'invalid', error: 'count', detail: `count byte says ${split.count}; got ${split.received.length} bytes` };
  if (split.kind === 'silent') return { status: 'silent' };
  return decodeXgtReply(name, split.received);
}

export function decodeXgtStoredRead(read) {
  if (!read.ok) return { status: 'error', error: read.error || 'falha sem mensagem' };
  try {
    return decodeXgtRead(read.name, fromHex(read.response));
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

export function isXgtDump(dump) {
  return dump.reads.some((read) => isXgtReadName(read.name));
}

export function xgtStepLabel(name) {
  return findXgtStep(name)?.label_pt ?? null;
}

// --- whole-pack report ---------------------------------------------------------------------

function okValue(decodedByName, name) {
  const decoded = decodedByName.get(name);
  return decoded?.status === 'ok' ? decoded : null;
}

function histogramBins(decodedByName, kind) {
  const bins = new Array(XGT_HIST_BINS).fill(null);
  for (let part = 0; part < XGT_HIST_BINS / 2; part++) {
    const decoded = okValue(decodedByName, `xgt_${kind}_hist${part}`);
    if (decoded) bins.splice(2 * part, 2, ...decoded.bins);
  }
  return bins.every((bin) => bin === null) ? null : bins;
}

// Everything the XGT view and diagnosis need, from a dump's reads.
export function buildXgtReport(reads) {
  const xgtReads = reads.filter((read) => isXgtReadName(read.name));
  const decodedByName = new Map(xgtReads.map((read) => [read.name, decodeXgtStoredRead(read)]));
  const value = (name) => okValue(decodedByName, name);
  const cells = Array.from({ length: XGT_CELL_COUNT }, (_, index) => {
    const decoded = value(`xgt_cell${index + 1}`);
    return { index, mv: decoded ? decoded.mv : null };
  });
  const cellsRead = cells.filter((cell) => cell.mv !== null);
  const packRegister = value('xgt_pack_voltage');
  const cellCapacity = value('xgt_cell_capacity');
  const config = value('xgt_pack_config');
  const temps = ['xgt_temp1', 'xgt_temp2'].map((name) => value(name)?.temp_c ?? null);
  const statuses = [...decodedByName.values()].map((decoded) => decoded.status);
  return {
    decodedByName,
    expected: XGT_STEP_NAMES.length,
    attempted: xgtReads.length,
    answered: statuses.filter((status) => status === 'ok').length,
    firmwareMissing: statuses.includes('no_command'),
    allSilent: statuses.length > 0 && statuses.every((status) => status === 'silent' || status === 'error'),
    model: value(XGT_MODEL_READ.name)?.model || null,
    cycles: value('xgt_cycles')?.cycles ?? null,
    locked: value('xgt_lockout')?.locked ?? null,
    capacity_mah: value('xgt_capacity')?.capacity_mah ?? null,
    charge_pct: value('xgt_charge')?.charge_pct ?? null,
    temps_c: temps,
    pack_mv: packRegister ? packRegister.mv : null,
    cells,
    cells_sum_mv: cellsRead.length === XGT_CELL_COUNT ? cellsRead.reduce((sum, cell) => sum + cell.mv, 0) : null,
    cell_capacity_mah: cellCapacity?.cell_capacity_mah ?? null,
    parallel: config?.parallel ?? null,
    series: config?.series ?? null,
    design_capacity_mah: cellCapacity && config ? cellCapacity.cell_capacity_mah * config.parallel : null,
    temp_hist: histogramBins(decodedByName, 'temp'),
    current_hist: histogramBins(decodedByName, 'current'),
    problems: xgtReads.filter((read) => decodedByName.get(read.name).status !== 'ok').map((read) => ({ name: read.name, decoded: decodedByName.get(read.name) })),
  };
}

// Labels nobody typed don't identify a pack.
const DEFAULT_LABEL = 'bateria';

/**
 * XGT has no ROM-like id (spec dump.identity): a pack is matched by label + model, as python/
 * does. kind: 'mixed' (XGT vs LXT), 'different_model', 'same_pack' (same non-default label and
 * same model) or 'unknown'.
 */
export function compareXgtPacks(dumpA, dumpB) {
  const xgtA = isXgtDump(dumpA);
  const xgtB = isXgtDump(dumpB);
  if (xgtA !== xgtB) return { kind: 'mixed', modelA: null, modelB: null };
  const modelA = buildXgtReport(dumpA.reads).model;
  const modelB = buildXgtReport(dumpB.reads).model;
  if (modelA && modelB && modelA !== modelB) return { kind: 'different_model', modelA, modelB };
  const labelA = String(dumpA.label ?? '').trim();
  const labelB = String(dumpB.label ?? '').trim();
  const sameLabel = labelA !== '' && labelA !== DEFAULT_LABEL && labelA === labelB;
  return { kind: sameLabel && modelA && modelA === modelB ? 'same_pack' : 'unknown', modelA, modelB };
}
