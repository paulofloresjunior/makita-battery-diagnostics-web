// What the buttons do, expressed against an ObiLink. Every operation returns dump reads
// ({name, request, ok, response, error}) so the UI, dumps and diffs share one shape.

import { concatBytes, fromHex, toHex } from './bytes.js';
import { CLEAR_ERRORS, CMD, findRead, READ_PLAN, READ_TITLES_PT, READS } from './catalog.js';
import { chipFromRom } from './decode.js';
import { buildFrame, bulkSessionGroups, encodeTransaction, readsInGroups, requestForRead, testmodeTransactions } from './protocol.js';

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

// Idle level and presence pulse from a 0xD0 line-probe payload; null when the firmware has no
// 0xD0 (empty payload) or answered something else.
export function lineFromProbePayload(payload) {
  if (payload.length !== LINE_PROBE_RSP_LEN) return null;
  const [idleLevel, presence] = payload;
  return { idle_level: idleLevel, presence: presence === 0xff ? null : presence };
}

// Firmware without 0xD0 answers an empty payload, which the dump format records as line = null.
export async function probeLine(link) {
  const outcome = await attempt(() => link.request(CMD.DEBUG_RAW, LINE_PROBE_DATA, LINE_PROBE_RSP_LEN));
  if (outcome.error) return null;
  return lineFromProbePayload(outcome.payload);
}

// spec read_plan "f0513": the f0513_* reads are for F0513 chips (ROM byte 3 < 100) and for packs
// whose lxt_msg brought no ROM back (failed, short, blank), where the chip is unknown.
function isF0513Candidate(lxtMsgRead) {
  if (!lxtMsgRead?.ok) return true;
  return chipFromRom(fromHex(lxtMsgRead.response)) !== 'lxt';
}

// One 0xD1 session with the spec's bulk reads. Each group is stored as its catalog read:
// request = its transaction record(s), response = its read bytes concatenated, so lxt_msg is
// 8 ROM bytes + 32 message bytes exactly like the 0x33 command. Presence bytes are dropped
// like the regular commands drop them. Returns null when the firmware has no 0xD1 (empty
// payload) or the session failed, so the caller falls back to regular commands.
async function readBulkSession(link) {
  const groups = bulkSessionGroups();
  const outcome = await attempt(() => link.session(groups.flatMap((group) => group.transactions)));
  if (outcome.error) return null;
  let next = 0;
  return groups.map((group) => {
    const replies = outcome.payload.slice(next, next + group.transactions.length);
    next += group.transactions.length;
    const request = toHex(concatBytes(group.transactions.map(encodeTransaction)));
    return storedRead(group.name, request, { payload: concatBytes(replies.map((reply) => reply.read)) });
  });
}

/**
 * "Ler bateria" for LXT, spec read_plan: version, line probe (unless `line` is given, e.g. the
 * detection's own 0xD0 result), one bulk 0xD1 session, lxt_data_ext, and the f0513 reads only on
 * F0513 chips or when lxt_msg didn't answer. Without 0xD1 every read goes as a regular command.
 * Reads come back in plan order (session reads, lxt_data_ext, f0513_*), like python/ records them.
 * @param {(progress: {done: number, total: number, name: string, label_pt: string}) => void} onProgress
 * @param {{line?: {idle_level: number, presence: number|null}|null}} options
 * @returns {Promise<{firmware: string, line: object|null, reads: object[], mode: 'session'|'per_command'}>}
 */
export async function readBattery(link, onProgress = () => {}, { line } = {}) {
  const report = (name, labelPt) => onProgress({ done: 0, total: 0, name, label_pt: labelPt });
  report('version', 'Lendo a versão do firmware…');
  const firmware = await link.version();
  if (line === undefined) {
    report('line', 'Testando a linha 1-Wire (0xD0)…');
    line = await probeLine(link);
  }
  report('session', 'Lendo mensagem, modelo, dados e memória numa única sessão (0xD1)…');
  const sessionReads = await readBulkSession(link);
  if (!sessionReads) {
    const reads = await readPerCommand(link, onProgress);
    return { firmware, line, reads, mode: 'per_command' };
  }
  const reads = [...sessionReads];
  const regular = READ_PLAN.after_session.map(findRead);
  if (isF0513Candidate(sessionReads.find((read) => read.name === 'lxt_msg'))) {
    regular.push(...readsInGroups(READ_PLAN.f0513_group));
  }
  for (const [index, read] of regular.entries()) {
    onProgress({ done: index, total: regular.length, name: read.name, label_pt: `Lendo ${index + 1} de ${regular.length} fora da sessão: ${READ_TITLES_PT[read.name]}…` });
    reads.push(await runCatalogRead(link, read));
  }
  onProgress({ done: regular.length, total: regular.length, name: '', label_pt: 'Leitura concluída.' });
  return { firmware, line, reads, mode: 'session' };
}

// Fallback for firmware without 0xD1 (e.g. the original OBI's): the same reads as regular
// commands, lxt_msg first. Memory reads are left out on F0513 candidates (each regular command
// costs ~0.4 s and they mean nothing there) and the f0513_* reads on LXT chips.
async function readPerCommand(link, onProgress) {
  const [lxtMsg, ...sessionRest] = READ_PLAN.session.map(findRead);
  const progress = (index, total, read) => onProgress({
    done: index, total, name: read.name,
    label_pt: `Firmware sem sessão (0xD1): lendo comando a comando, ${index + 1} de ${total}: ${READ_TITLES_PT[read.name]}…`,
  });
  const planned = [...sessionRest, ...READ_PLAN.after_session.map(findRead)];
  progress(0, 1 + planned.length, lxtMsg);
  const reads = [await runCatalogRead(link, lxtMsg)];
  const f0513 = isF0513Candidate(reads[0]);
  const rest = f0513
    ? [...planned.filter((read) => read.group !== 'memory'), ...readsInGroups(READ_PLAN.f0513_group)]
    : planned;
  for (const [index, read] of rest.entries()) {
    progress(index + 1, 1 + rest.length, read);
    reads.push(await runCatalogRead(link, read));
  }
  onProgress({ done: reads.length, total: reads.length, name: '', label_pt: 'Leitura concluída.' });
  return reads;
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
