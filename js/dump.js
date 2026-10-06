// Dump format v1 (spec: dump_format). Decoded values are never stored, so a dump stays valid
// when the decoders improve. Also loads the OBI fork's probe dumps, which have "steps".

import { blankKind, fromHex, toHex } from './bytes.js';
import { DUMP_FORMAT, MSG_OFFSET, TOOL_NAME } from './catalog.js';
import { calibrationVccMv } from './cxt-decode.js';

const LEGACY_TOOL = 'obi_probe (formato antigo)';

export class DumpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DumpError';
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// ISO 8601 in local time without offset, seconds precision — what Python's
// datetime.now().isoformat(timespec="seconds") writes, so web and Python dumps sort together.
export function localIsoSeconds(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// `calibration` ({vcc_mv}, spec dump_format.fields.calibration) is optional: the key is only
// written when given, so LXT/XGT dumps keep exactly the v1 fields.
export function createDump({ label, firmware = null, line = null, reads, date = new Date(), tool = TOOL_NAME, calibration = null }) {
  const dump = {
    format: DUMP_FORMAT.format,
    version: DUMP_FORMAT.version,
    label: label || 'bateria',
    timestamp: localIsoSeconds(date),
    tool,
    firmware,
    line,
    reads: reads.map(normalizeRead),
  };
  return withCalibration(dump, calibration);
}

/** Returns the dump with `calibration` set to {vcc_mv}, or without the key when vcc_mv is null. */
export function withCalibration(dump, calibration) {
  const { calibration: _previous, ...rest } = dump;
  const vccMv = normalizeCalibration(calibration);
  return vccMv === null ? rest : { ...rest, calibration: { vcc_mv: vccMv } };
}

function normalizeCalibration(calibration) {
  if (calibration !== null && calibration !== undefined && typeof calibration !== 'object') {
    throw new DumpError(`"calibration" is ${JSON.stringify(calibration)}; expected {"vcc_mv": int} or absent`);
  }
  try {
    return calibrationVccMv(calibration);
  } catch (error) {
    throw new DumpError(error.message);
  }
}

export function serializeDump(dump) {
  return `${JSON.stringify(dump, null, 2)}\n`;
}

export function dumpFileName(dump) {
  const safeLabel = String(dump.label).trim().replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'bateria';
  const stamp = dump.timestamp.replace(/[-:]/g, '').replace('T', '-');
  return `${safeLabel}_${stamp}.json`;
}

function normalizeRead(read, index) {
  if (typeof read?.name !== 'string' || read.name === '') {
    throw new DumpError(`read #${index} has name ${JSON.stringify(read?.name)}; expected a non-empty string`);
  }
  if (typeof read.ok !== 'boolean') {
    throw new DumpError(`read "${read.name}" has ok=${JSON.stringify(read.ok)}; expected true or false`);
  }
  const response = typeof read.response === 'string' ? read.response.trim() : '';
  // Parse once here so a corrupt dump fails on open instead of in the middle of rendering.
  try {
    fromHex(response);
  } catch (error) {
    throw new DumpError(`read "${read.name}": ${error.message}`);
  }
  return {
    name: read.name,
    request: typeof read.request === 'string' ? read.request : '',
    ok: read.ok,
    response: response.toUpperCase(),
    error: typeof read.error === 'string' ? read.error : '',
  };
}

function fromLegacy(report) {
  return {
    format: DUMP_FORMAT.format,
    version: DUMP_FORMAT.version,
    label: typeof report.label === 'string' ? report.label : 'bateria',
    timestamp: typeof report.timestamp === 'string' ? report.timestamp : '',
    tool: LEGACY_TOOL,
    firmware: typeof report.firmware === 'string' ? report.firmware : null,
    line: report.line ?? null,
    // The old "decoded" and "summary" fields are dropped: everything is re-decoded.
    reads: report.steps.map(normalizeRead),
  };
}

export function parseDump(source) {
  let parsed = source;
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new DumpError(`not valid JSON (${error.message}); expected a dump saved by this tool`);
    }
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new DumpError(`dump is ${parsed === null ? 'null' : typeof parsed}; expected a JSON object`);
  }
  if (parsed.format === DUMP_FORMAT.format) {
    if (parsed.version !== DUMP_FORMAT.version) {
      throw new DumpError(`dump version ${JSON.stringify(parsed.version)}; expected ${DUMP_FORMAT.version}`);
    }
    if (!Array.isArray(parsed.reads)) {
      throw new DumpError(`"reads" is ${typeof parsed.reads}; expected an array`);
    }
    return withCalibration({ ...parsed, reads: parsed.reads.map(normalizeRead) }, parsed.calibration);
  }
  if (Array.isArray(parsed.steps)) return fromLegacy(parsed);
  throw new DumpError(`format ${JSON.stringify(parsed.format ?? null)} without "steps"; expected "${DUMP_FORMAT.format}" v${DUMP_FORMAT.version} or an OBI probe dump`);
}

// The ROM (lxt_msg bytes 0-7) identifies a physical pack.
export function romOfDump(dump) {
  const read = dump.reads.find((candidate) => candidate.name === 'lxt_msg' && candidate.ok && candidate.response);
  if (!read) return null;
  const rom = fromHex(read.response).slice(0, MSG_OFFSET);
  if (rom.length < MSG_OFFSET || blankKind(rom)) return null;
  return toHex(rom);
}
