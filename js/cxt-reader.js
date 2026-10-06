// CXT reading procedure over an ObiLink: one passive E1 read of A0..A3 + bandgap. Returns dump
// reads in the shape of reader.js, step name cxt_adc, request = the full serial frame, response
// = the E1 payload. ENABLE stays low for E1 (the firmware skips it), and nothing is written to
// the pack: the analog pins only measure.

import { CXT_FIRMWARE_COMMAND, CXT_STEP_NAME } from './cxt-catalog.js';
import { runRequest } from './reader.js';

export const CXT_CMD = parseInt(CXT_FIRMWARE_COMMAND.cmd, 16);

export function cxtAdcRequest(samples = CXT_FIRMWARE_COMMAND.default_samples) {
  const [min, max] = CXT_FIRMWARE_COMMAND.samples_range;
  if (!Number.isInteger(samples) || samples < min || samples > max) {
    throw new RangeError(`samples=${samples}; expected an integer ${min}..${max}`);
  }
  // rsp_len is exactly the payload: the firmware refuses (empty reply) anything shorter.
  return { cmd: CXT_CMD, data: Uint8Array.of(samples), rspLen: CXT_FIRMWARE_COMMAND.payload_len };
}

export function readCxtAdc(link, samples) {
  return runRequest(link, CXT_STEP_NAME, cxtAdcRequest(samples));
}

/**
 * "Ler bateria" for CXT: firmware version, then the E1 read. An empty payload (firmware without
 * E1, or an ESP32-C3 build) is kept as an ok read with an empty response, so the dump records
 * it and the diagnosis names it; the bridge failing outright is a failed read.
 */
export async function readCxtBattery(link, onProgress = () => {}) {
  const firmware = await link.version();
  onProgress({ done: 0, total: 1, name: CXT_STEP_NAME });
  const read = await readCxtAdc(link);
  onProgress({ done: 1, total: 1, name: '' });
  return { firmware, line: null, reads: [read] };
}
