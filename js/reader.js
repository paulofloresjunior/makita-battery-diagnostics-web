// What the buttons do, expressed against an ObiLink. Every operation returns dump reads
// ({name, request, ok, response, error}) so the UI, dumps and diffs share one shape.

import { toHex } from './bytes.js';
import { CLEAR_ERRORS, CMD, READS } from './catalog.js';
import { buildFrame, encodeTransaction, requestForRead, testmodeTransactions } from './protocol.js';

// 0xD0 timing that matches the regular commands: 400 µs after reset (x10 µs units), 90 µs
// between bytes.
// Also the LXT probe of the family detection (detect.js).
export const LINE_PROBE_DATA = Object.freeze([0x01, 40, 90]);
export const LINE_PROBE_RSP_LEN = 2;

function storedRead(name, request, outcome) {
  if (outcome.error) return { name, request, ok: false, response: '', error: outcome.error.message };
  return { name, request, ok: true, response: toHex(outcome.payload), error: '' };
}

async function attempt(action) {
  try {
    return { payload: await action() };
  } catch (error) {
    return { error };
  }
}

export async function runRequest(link, name, { cmd, data, rspLen }) {
  const request = toHex(buildFrame(cmd, data, rspLen));
  return storedRead(name, request, await attempt(() => link.request(cmd, data, rspLen)));
}

export function runCatalogRead(link, read, name = read.name) {
  return runRequest(link, name, requestForRead(read));
}

// Idle level and presence pulse via 0xD0. Firmware without 0xD0 answers an empty payload,
// which the dump format records as line = null.
export async function probeLine(link) {
  const outcome = await attempt(() => link.request(CMD.DEBUG_RAW, LINE_PROBE_DATA, LINE_PROBE_RSP_LEN));
  if (outcome.error || outcome.payload.length !== LINE_PROBE_RSP_LEN) return null;
  const [idleLevel, presence] = outcome.payload;
  return { idle_level: idleLevel, presence: presence === 0xff ? null : presence };
}

// "Ler bateria": version, line probe, then every catalog read in order.
export async function readBattery(link, onProgress = () => {}) {
  const firmware = await link.version();
  const line = await probeLine(link);
  const reads = [];
  for (const [index, read] of READS.entries()) {
    onProgress({ done: index, total: READS.length, name: read.name });
    reads.push(await runCatalogRead(link, read));
  }
  onProgress({ done: READS.length, total: READS.length, name: '' });
  return { firmware, line, reads };
}

// Memory reads inside test mode, one 0xD1 session so ENABLE never drops in between.
export async function readTestMode(link) {
  const transactions = testmodeTransactions();
  const outcome = await attempt(() => link.session(transactions));
  if (outcome.error) {
    return [{ name: 'tm_session', request: 'D1', ok: false, response: '', error: outcome.error.message }];
  }
  return transactions.map((tx, index) =>
    storedRead(tx.name, toHex(encodeTransaction(tx)), { payload: outcome.payload[index].read }),
  );
}

// Same sequence as the OBI web UI "Clear errors", bracketed by lxt_msg reads for the diff.
export async function clearErrors(link) {
  const lxtMsg = READS.find((read) => read.name === 'lxt_msg');
  const before = await runCatalogRead(link, lxtMsg, 'before_lxt_msg');
  if (!before.ok) {
    throw new Error(`could not read lxt_msg before unlocking (${before.error}); nothing was sent to the battery`);
  }
  const steps = [];
  for (const [index, step] of CLEAR_ERRORS.steps.entries()) {
    steps.push(await runCatalogRead(link, step, `clear_errors_${index + 1}`));
  }
  const after = await runCatalogRead(link, lxtMsg, 'after_lxt_msg');
  return { before, steps, after };
}
