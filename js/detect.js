// Automatic family detection, exactly as spec/cxt.json "family_detection": CXT (E1, passive:
// only measures) -> LXT (D0 reset presence with the line idle high: drives only D6) -> XGT (E0
// with wake reading xgt_cycles: transmits on D5, so it goes last). The first match wins and the
// later probes are skipped, so nothing transmits on D5 when an earlier family answered.
// A firmware without a probe's command answers an empty payload: that means "not this family",
// never an abort, so an old firmware still gets the probes it does support.

import { CMD } from './catalog.js';
import { FAMILY_ORDER } from './cxt-catalog.js';
import { CXT_NO_COMMAND_PT, decodeCxtPayload } from './cxt-decode.js';
import { readCxtAdc } from './cxt-reader.js';
import { fromHex } from './bytes.js';
import { formatNumber, formatVolts } from './format.js';
import { LINE_PROBE_DATA, LINE_PROBE_RSP_LEN, runRequest } from './reader.js';
import { decodeXgtRead } from './xgt-decode.js';
import { xgtStepRequest, xgtSteps } from './xgt-reader.js';

/** @typedef {'cxt'|'lxt'|'xgt'} Family */
/**
 * @typedef {object} ProbeResult
 * @property {Family} family
 * @property {'match'|'no_match'|'unsupported'|'error'|'skipped'} outcome
 *   unsupported = the firmware answered an empty payload (no such command); error = the Arduino
 *   itself didn't answer; skipped = an earlier family already matched.
 * @property {string} detail_pt  one line for the "Detectado" strip
 * @property {{name: string, request: string, ok: boolean, response: string, error: string}|null} read
 *   the probe's exchange in dump-read shape (null when skipped)
 */
/** @typedef {{family: Family|null, probes: ProbeResult[]}} DetectionResult */

export const FAMILY_NAMES_PT = Object.freeze({ cxt: 'CXT (12V)', lxt: 'LXT (18V/14,4V)', xgt: 'XGT (40V)' });

const XGT_PROBE_STEP = 'xgt_cycles';
const PRESENCE_SKIPPED = 0xff;

function result(family, outcome, detailPt, read) {
  return { family, outcome, detail_pt: detailPt, read };
}

function bridgeError(family, read) {
  return result(family, 'error', `não testado: o Arduino não respondeu (${read.error})`, read);
}

async function probeCxt(link, calibration) {
  const read = await readCxtAdc(link);
  if (!read.ok) return bridgeError('cxt', read);
  const decoded = decodeCxtPayload(fromHex(read.response), { vccMv: calibration?.vcc_mv ?? null });
  if (decoded.status === 'no_command') return result('cxt', 'unsupported', CXT_NO_COMMAND_PT, read);
  if (decoded.status !== 'ok') return result('cxt', 'no_match', `resposta inválida do 0xE1 (${decoded.detail})`, read);
  const cells = decoded.cells_v.map((volts) => formatNumber(volts, 2)).join(' / ');
  if (decoded.is_cxt) return result('cxt', 'match', `pack de ${formatVolts(decoded.pack_v, 2)}, células ${cells} V`, read);
  return result('cxt', 'no_match', `entradas analógicas sem pack CXT (pack ${formatVolts(decoded.pack_v, 2)}, células ${cells} V)`, read);
}

async function probeLxt(link) {
  const read = await runRequest(link, 'lxt_presence', { cmd: CMD.DEBUG_RAW, data: LINE_PROBE_DATA, rspLen: LINE_PROBE_RSP_LEN });
  if (!read.ok) return bridgeError('lxt', read);
  const payload = fromHex(read.response);
  if (payload.length === 0) return result('lxt', 'unsupported', 'firmware sem o comando 0xD0', read);
  if (payload.length !== LINE_PROBE_RSP_LEN) {
    return result('lxt', 'no_match', `resposta do 0xD0 com ${payload.length} bytes; esperados ${LINE_PROBE_RSP_LEN}`, read);
  }
  const [idleLevel, presence] = payload;
  if (idleLevel !== 1) return result('lxt', 'no_match', `linha de dados em nível ${idleLevel} em repouso (esperado 1)`, read);
  if (presence === 0 || presence === PRESENCE_SKIPPED) return result('lxt', 'no_match', 'sem pulso de presença no 1-Wire', read);
  return result('lxt', 'match', 'chip 1-Wire respondeu ao reset (pulso de presença)', read);
}

async function probeXgt(link) {
  const step = xgtSteps().find((candidate) => candidate.name === XGT_PROBE_STEP);
  const read = await runRequest(link, XGT_PROBE_STEP, xgtStepRequest(step, true));
  if (!read.ok) return bridgeError('xgt', read);
  const decoded = decodeXgtRead(XGT_PROBE_STEP, fromHex(read.response));
  switch (decoded.status) {
    case 'ok': return result('xgt', 'match', `quadro válido no TR (${decoded.cycles} ciclos de carga)`, read);
    case 'no_command': return result('xgt', 'unsupported', 'firmware sem o comando 0xE0', read);
    case 'silent': return result('xgt', 'no_match', 'sem resposta no TR', read);
    default: return result('xgt', 'no_match', `resposta inválida no TR (${decoded.detail ?? decoded.error})`, read);
  }
}

const PROBES = { cxt: probeCxt, lxt: probeLxt, xgt: probeXgt };

/**
 * Runs the probes in spec order over an ObiLink (anything with request()).
 * @param {{calibration?: {vcc_mv: number}|null, onProbe?: (family: Family) => void}} options
 *   calibration feeds the CXT criteria with the measured Vcc, like the CXT view does
 * @returns {Promise<DetectionResult>}
 */
export async function detectFamily(link, { calibration = null, onProbe = () => {} } = {}) {
  const probes = [];
  let found = null;
  for (const family of FAMILY_ORDER) {
    if (found) {
      probes.push(result(family, 'skipped', `${FAMILY_NAMES_PT[found]} já foi detectada; nada foi enviado para esta linha`, null));
      continue;
    }
    onProbe(family);
    const probe = await PROBES[family](link, calibration);
    probes.push(probe);
    if (probe.outcome === 'match') found = family;
  }
  return { family: found, probes };
}

// One sentence for the progress line and the strip when nothing matched.
export function detectionSummaryPt(detection) {
  if (detection.family) return `Detectado: ${FAMILY_NAMES_PT[detection.family]}.`;
  const outcomes = detection.probes.map((probe) => probe.outcome);
  if (outcomes.every((outcome) => outcome === 'error')) {
    return 'Nenhuma bateria detectada: o Arduino não respondeu a nenhum teste. Confira o cabo USB e a porta.';
  }
  if (outcomes.every((outcome) => outcome === 'unsupported' || outcome === 'error')) {
    return 'Nenhuma bateria detectada: o firmware não tem os comandos de detecção (0xE1, 0xD0, 0xE0). Grave o firmware atual (pasta firmware/) ou escolha LXT no seletor para ler com os comandos antigos.';
  }
  return 'Nenhuma bateria detectada. Confira a ligação de cada linha em docs/hardware.md e se só um pack está ligado (todas as linhas dividem o GND do Nano).';
}
