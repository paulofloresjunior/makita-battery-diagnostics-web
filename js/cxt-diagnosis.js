// Findings for a CXT report (cxt-decode.buildCxtReport). Same cell thresholds and wording as the
// LXT diagnosis (spec/protocol.json "diagnosis"), applied to the 3 series groups, plus the NTC
// open/short states of spec/cxt.json. Nothing here has been checked against a real pack yet.

import { CXT_CELL_COUNT, CXT_DETECTION } from './cxt-catalog.js';
import { CXT_NO_COMMAND_PT, cxtCriteriaFailure } from './cxt-decode.js';
import { cellFindings, cellSpread, classifyCells, SEVERITY_ORDER, spreadFinding, temperatureFindings, worst } from './diagnosis.js';
import { formatNumber, formatVolts } from './format.js';

const UNVALIDATED = {
  severity: 'info', code: 'cxt_unvalidated', title: 'Leitura CXT ainda não validada',
  detail: 'Divisores, conversão do termistor e critérios vêm da pinagem publicada, sem conferência num pack real. Confira as tensões com um multímetro antes de confiar no diagnóstico.',
};

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function readFindings(report) {
  const decoded = report.decoded;
  if (!decoded) {
    return [{ severity: 'bad', code: 'cxt_not_read', title: 'Entradas analógicas não lidas', detail: 'Este dump não tem a leitura cxt_adc.' }];
  }
  switch (decoded.status) {
    case 'ok': return [];
    case 'no_command':
      return [{ severity: 'bad', code: 'cxt_no_firmware', title: capitalize(CXT_NO_COMMAND_PT), detail: 'O Arduino respondeu vazio ao comando 0xE1. Grave o firmware atual deste projeto (pasta firmware/) num Uno ou Nano: o ESP32-C3 não tem a leitura CXT.' }];
    case 'invalid':
      return [{ severity: 'bad', code: 'cxt_invalid', title: 'Resposta do 0xE1 inválida', detail: decoded.detail }];
    default:
      return [{ severity: 'bad', code: 'cxt_read_failed', title: 'A leitura das entradas analógicas falhou', detail: decoded.error }];
  }
}

const [PACK_MIN, PACK_MAX] = CXT_DETECTION.pack_v;
const [CELL_MIN, CELL_MAX] = CXT_DETECTION.cell_v;

// Names the spec detection_as_cxt criterion that failed, with the measured values.
function criterionText(decoded) {
  const failure = cxtCriteriaFailure(decoded.tap_v, decoded.cells_v);
  const [tap1, tap2, pack] = decoded.tap_v.map((volts) => formatVolts(volts, 2));
  switch (failure?.criterion) {
    case 'pack_range': return `o pack mede ${pack}, fora da faixa de ${formatNumber(PACK_MIN, 1)} a ${formatNumber(PACK_MAX, 1)} V`;
    case 'tap_order': return `os taps não sobem em ordem (tap 1 = ${tap1}, tap 2 = ${tap2}, pack = ${pack}; esperado 0 < tap 1 < tap 2 < pack)`;
    case 'cell_range': return `a célula ${failure.cell + 1} mede ${formatVolts(decoded.cells_v[failure.cell], 2)}, fora da faixa de ${formatNumber(CELL_MIN, 1)} a ${formatNumber(CELL_MAX, 1)} V`;
    default: return 'os critérios de detecção não foram atendidos';
  }
}

function notDetectedFinding(decoded) {
  return {
    severity: 'bad', code: 'cxt_not_detected', title: 'Nenhum pack CXT nas entradas analógicas',
    detail: `${capitalize(criterionText(decoded))}. As células não são avaliadas. Confira o chicote, o GND no − do pack e se a bateria está encaixada; um pack abaixo de ~1 V por célula também cai aqui.`,
  };
}

function ntcFindings(decoded) {
  if (decoded.ntc_state === 'open') {
    return [{ severity: 'warn', code: 'cxt_ntc_open', title: 'Termistor aberto', detail: `A3 lê ${formatVolts(decoded.ntc_v, 2)}, quase o Vcc: sem termistor no contato do meio, contato sem encostar ou NTC rompido. Carregadores recusam pack sem termistor.` }];
  }
  if (decoded.ntc_state === 'short') {
    return [{ severity: 'warn', code: 'cxt_ntc_short', title: 'Termistor em curto', detail: `A3 lê ${formatVolts(decoded.ntc_v, 2)}, quase 0 V: o contato do termistor está em curto com o − do pack (ou o fio do A3 está solto do resistor de 10 kΩ).` }];
  }
  return temperatureFindings([decoded.temp_c]);
}

/**
 * @returns {{severity: string, findings: object[], cells: object[], spread: number|null}}
 *   cells use the classifyCells shape ({index, v, state}); empty when no CXT pack was seen.
 */
export function diagnoseCxt(report) {
  const findings = readFindings(report);
  let cells = [];
  let spread = null;
  const decoded = report.decoded;
  if (decoded?.status === 'ok') {
    if (!decoded.is_cxt) {
      findings.push(notDetectedFinding(decoded));
    } else {
      cells = classifyCells(Math.round(decoded.pack_v * 1000), decoded.cells_v.map((volts) => Math.round(volts * 1000)), CXT_CELL_COUNT);
      spread = cellSpread(cells);
      findings.push(...cellFindings(cells), ...spreadFinding(spread, undefined), ...ntcFindings(decoded));
    }
  }
  findings.push(UNVALIDATED);
  const hasProblem = findings.some((finding) => finding.severity === 'warn' || finding.severity === 'bad');
  if (!hasProblem) {
    findings.unshift({ severity: 'ok', code: 'healthy', title: 'Nenhum problema encontrado', detail: 'Células dentro da faixa e equilibradas, termistor respondendo.' });
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));
  return { severity: worst(findings.map((finding) => finding.severity)), findings, cells, spread };
}
