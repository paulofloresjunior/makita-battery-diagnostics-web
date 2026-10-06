// Findings for an XGT report (xgt-decode.buildXgtReport). Same thresholds and wording as the
// LXT diagnosis (spec/protocol.json "diagnosis"); only the pack-level findings differ.

import { cellFindings, cellSpread, classifyCells, SEVERITY_ORDER, spreadFinding, temperatureFindings, worst } from './diagnosis.js';
import { XGT_CELL_COUNT } from './xgt-decode.js';

function silenceFindings(report) {
  if (report.firmwareMissing) {
    return [{ severity: 'bad', code: 'xgt_no_firmware', title: 'Firmware sem suporte a XGT', detail: 'O Arduino respondeu vazio ao comando 0xE0: grave o firmware atual deste projeto (pasta firmware/) e leia de novo.' }];
  }
  if (report.attempted > 0 && report.answered === 0) {
    return [{ severity: 'bad', code: 'no_answer', title: 'A bateria não respondeu', detail: 'Nenhum quadro válido chegou pelo TR. Confira o fio do TR (pelo resistor até o D5), o GND no B−, se a bateria está encaixada e tente um resistor menor (2,2 kΩ, depois 1 kΩ).' }];
  }
  return [];
}

function lockFindings(report) {
  if (report.locked !== true) return [];
  return [{
    severity: 'bad', code: 'xgt_locked', title: 'Bateria travada (lockout)',
    detail: 'O BMS marcou a trava (registrador 0x0060): carregadores e ferramentas recusam o pack. O reset da trava não é implementado de propósito; descubra a causa (células, temperaturas) antes de qualquer coisa.',
  }];
}

function incompleteFindings(report) {
  if (report.answered === 0) return [];
  const failed = report.problems.length;
  const missing = report.expected - report.attempted;
  if (failed === 0 && missing <= 0) return [];
  const parts = [];
  if (failed) parts.push(`${failed} sem resposta válida (${report.problems.map((problem) => problem.name).join(', ')})`);
  if (missing > 0) parts.push(`${missing} não lidas`);
  return [{ severity: 'warn', code: 'xgt_incomplete', title: 'Leitura incompleta', detail: `Das ${report.expected} leituras, ${parts.join('; ')}. Veja os quadros brutos.` }];
}

// Cells that were read, classified with the LXT thresholds; indexes stay 0..9 when some failed.
export function classifyXgtCells(report) {
  const read = report.cells.filter((cell) => cell.mv !== null);
  if (read.length === 0) return [];
  const packMv = report.pack_mv ?? read.reduce((sum, cell) => sum + cell.mv, 0);
  return classifyCells(packMv, read.map((cell) => cell.mv), XGT_CELL_COUNT)
    .map((cell, position) => ({ ...cell, index: read[position].index }));
}

export function diagnoseXgt(report) {
  const findings = [...silenceFindings(report), ...lockFindings(report), ...incompleteFindings(report)];
  const cells = classifyXgtCells(report);
  const spread = cellSpread(cells);
  findings.push(
    ...cellFindings(cells),
    ...spreadFinding(spread, report.charge_pct ?? undefined),
    ...temperatureFindings(report.temps_c.filter((celsius) => celsius !== null)),
  );
  const hasProblem = findings.some((finding) => finding.severity === 'warn' || finding.severity === 'bad');
  if (!hasProblem && report.answered > 0) {
    const detail = cells.length ? 'Sem trava, células dentro da faixa e equilibradas.' : 'Sem trava. As células não foram lidas.';
    findings.unshift({ severity: 'ok', code: 'healthy', title: 'Nenhum problema encontrado', detail });
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));
  return { severity: worst(findings.map((finding) => finding.severity)), findings, cells, spread };
}
