// XGT reading procedure over an ObiLink (or anything with request(cmd, data, rspLen)). Read
// only: every frame goes through xgt-protocol.assertReadOnlyFrame. Returns dump reads in the
// same shape as reader.js ({name, request, ok, response, error}), named as spec/xgt.json
// dump.step_names, with request = the full serial frame and response = the 0xE0 payload.
// Same policy as python/src/makita_diag/xgt_procedures.py, so dumps from both are alike.

import { fromHex, toHex } from './bytes.js';
import { XGT_ATTEMPTS, XGT_LONG_TIMEOUT_MS, XGT_MODEL_READ, XGT_REGISTERS, XGT_SHORT_FRAME } from './xgt-catalog.js';
import { decodeXgtRead } from './xgt-decode.js';
import { buildXgtRequest, xgtRequestHex } from './xgt-protocol.js';

// The Arduino itself failed (no answer, or firmware without 0xE0), not the battery.
export class XgtBridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XgtBridgeError';
  }
}

// The procedure's steps in dump order: the model (long frame) first, then every register.
export function xgtSteps() {
  return [
    { name: XGT_MODEL_READ.name, frame: fromHex(XGT_MODEL_READ.frame), expectedLen: XGT_MODEL_READ.rsp_len - 1, timeoutMs: XGT_LONG_TIMEOUT_MS },
    ...XGT_REGISTERS.map((register) => ({ name: register.name, frame: fromHex(register.frame), expectedLen: XGT_SHORT_FRAME.length, timeoutMs: XGT_SHORT_FRAME.suggested_timeout_ms })),
  ];
}

export function xgtStepRequest(step, wake) {
  return buildXgtRequest(step.frame, { wake, timeoutMs: step.timeoutMs, expectedLen: step.expectedLen });
}

/**
 * Sends reads with the wake byte while the BMS may be asleep (first transaction, and again after
 * a read got no reply at all) and retries bad replies: up to `attempts` per read, keeping the
 * first valid reply, else the last attempt.
 */
export class XgtReader {
  constructor(link, { attempts = XGT_ATTEMPTS } = {}) {
    if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`attempts=${attempts}; expected an integer >= 1`);
    this.link = link;
    this.attempts = attempts;
    this.awake = false;
  }

  // Throws XgtBridgeError when the Arduino fails; every other outcome is a stored read.
  async read(step) {
    let last = null;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const request = xgtStepRequest(step, !this.awake);
      let payload;
      try {
        payload = await this.link.request(request.cmd, request.data, request.rspLen);
      } catch (error) {
        throw new XgtBridgeError(error.message);
      }
      const decoded = decodeXgtRead(step.name, payload);
      if (decoded.status === 'no_command') {
        throw new XgtBridgeError('firmware answered an empty payload to cmd 0xE0; expected the XGT command (flash the current firmware)');
      }
      last = { name: step.name, request: xgtRequestHex(request), ok: true, response: toHex(payload), error: '' };
      if (decoded.status === 'silent') {
        this.awake = false;
        continue;
      }
      this.awake = true; // garbled or not, something answered
      if (decoded.status === 'ok') return last;
    }
    return last;
  }
}

// "Ler bateria" for XGT: firmware version, then every step. A bridge failure on the first step
// aborts (old firmware or dead bridge: every other read would fail the same way); later ones are
// recorded as failed reads and the procedure goes on.
export async function readXgtBattery(link, onProgress = () => {}, { attempts = XGT_ATTEMPTS } = {}) {
  const firmware = await link.version();
  const reader = new XgtReader(link, { attempts });
  const steps = xgtSteps();
  const reads = [];
  for (const [index, step] of steps.entries()) {
    onProgress({ done: index, total: steps.length, name: step.name });
    try {
      reads.push(await reader.read(step));
    } catch (error) {
      if (!(error instanceof XgtBridgeError) || index === 0) throw error;
      reads.push({ name: step.name, request: xgtRequestHex(xgtStepRequest(step, !reader.awake)), ok: false, response: '', error: error.message });
    }
  }
  onProgress({ done: steps.length, total: steps.length, name: '' });
  return { firmware, line: null, reads };
}
