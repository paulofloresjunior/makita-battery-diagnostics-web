// Turns a report from decode.buildReport into findings with a severity. Thresholds come from
// spec/protocol.json "diagnosis" (copied in catalog.DIAGNOSIS).

import { DIAGNOSIS as T, LOCK_CAUSES_PT } from './catalog.js';
import { round } from './bytes.js';
import { formatCelsius, formatNumber, formatVolts } from './format.js';

export const SEVERITY_ORDER = ['ok', 'info', 'warn', 'bad'];

export function worst(severities) {
  return severities.reduce((acc, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(acc) ? s : acc), 'ok');
}

function volts(mv) {
  return mv / 1000;
}

// 4-cell packs (14.4 V) report cell 5 as ~0 V: it doesn't exist, so it must not count as
// dead nor enter the spread. The message flags decide when lxt_msg was read; without it
// (F0513 dump, no message) the voltage heuristic does.
function cell5Absent(cellsV, cellCount) {
  if (cellCount !== null && cellCount !== undefined) return cellCount === 4 && cellsV.length === 5;
  return cellsV.length === 5 && cellsV[4] < T.four_cell_absent_v &&
    cellsV.slice(0, 4).every((v) => v > T.four_cell_others_v);
}

// Per-cell state used by both the findings and the cell bars in the UI.
export function classifyCells(packMv, cellsMv, cellCount = null) {
  const packV = volts(packMv);
  const cellsV = cellsMv.map(volts);
  const fourCell = cell5Absent(cellsV, cellCount);
  return cellsV.map((v, index) => {
    if (fourCell && index === 4) return { index, v, state: 'absent' };
    // A near-zero cell inside a charged pack is a broken balance lead, not an empty cell:
    // the cells are in series, so the pack voltage proves the cell has charge.
    if (v < T.open_sense_cell_v && packV > T.open_sense_pack_v) return { index, v, state: 'open' };
    if (v < T.cell_dead_v) return { index, v, state: 'dead' };
    if (v < T.cell_deep_discharge_v) return { index, v, state: 'deep' };
    if (v < T.cell_low_v) return { index, v, state: 'low' };
    return { index, v, state: 'ok' };
  });
}

const CELL_FINDINGS = {
  open: { severity: 'bad', title: 'Fio de medição aberto', detail: 'lê perto de 0 V com o pack acima de 10 V: confira o fio/solda de balanceamento desta célula.' },
  dead: { severity: 'bad', title: 'Célula morta', detail: `abaixo de ${formatVolts(T.cell_dead_v, 1)}. Recuperar é arriscado; substitua a célula.` },
  deep: { severity: 'bad', title: 'Descarga profunda', detail: `abaixo de ${formatVolts(T.cell_deep_discharge_v, 1)}. Carregue devagar e acompanhe o aquecimento.` },
  low: { severity: 'warn', title: 'Célula baixa', detail: `abaixo de ${formatVolts(T.cell_low_v, 1)}. Recarregue antes de usar.` },
};

export function cellFindings(cells) {
  const findings = [];
  for (const [state, template] of Object.entries(CELL_FINDINGS)) {
    const matching = cells.filter((cell) => cell.state === state);
    if (matching.length === 0) continue;
    const list = matching.map((cell) => `célula ${cell.index + 1} (${formatVolts(cell.v)})`).join(', ');
    findings.push({ severity: template.severity, code: `cell_${state}`, title: template.title, detail: `${capitalize(list)}: ${template.detail}` });
  }
  return findings;
}

export function cellSpread(cells) {
  const usable = cells.filter((cell) => cell.state !== 'absent' && cell.state !== 'open');
  if (usable.length < 2) return null;
  const values = usable.map((cell) => cell.v);
  return round(Math.max(...values) - Math.min(...values), 3);
}

export function spreadFinding(spread, socPct) {
  if (spread === null) return [];
  const text = `Diferença entre a maior e a menor célula: ${formatVolts(spread)}.`;
  if (spread >= T.spread_bad_v) return [{ severity: 'bad', code: 'spread_bad', title: 'Células muito desequilibradas', detail: text }];
  if (spread >= T.spread_warn_v) return [{ severity: 'warn', code: 'spread_warn', title: 'Células desequilibradas', detail: text }];
  // A full pack hides capacity mismatch: cells only drift apart near empty.
  if (socPct !== undefined && socPct > 80) {
    return [{ severity: 'info', code: 'spread_full', title: 'Equilíbrio bom, mas o pack está cheio', detail: `${text} Para julgar o equilíbrio, leia de novo com pouca carga.` }];
  }
  return [];
}

// namesNtc: LXT only. The raw 2430 / 3980 signatures of an open / shorted NTC come from LXT packs
// (OBI repo issues); XGT and CXT keep the generic out-of-range finding.
export function temperatureFindings(tempsC, { namesNtc = false } = {}) {
  const findings = [];
  const [min, max] = T.temp_plausible_c;
  tempsC.forEach((c, index) => {
    const sensor = `Sensor de temperatura ${index + 1}`;
    if (namesNtc && c <= T.ntc_open_c) {
      findings.push({ severity: 'warn', code: 'ntc_open', title: `${sensor}: termistor aberto`, detail: `Lê ${formatCelsius(c)}: o termistor (NTC) está aberto ou desconectado. O BMS pode travar a carga por isso.` });
    } else if (namesNtc && c >= T.ntc_short_c) {
      findings.push({ severity: 'warn', code: 'ntc_short', title: `${sensor}: termistor em curto`, detail: `Lê ${formatCelsius(c)}: o termistor (NTC) está em curto.` });
    } else if (c < min || c > max) {
      findings.push({ severity: 'warn', code: 'temp_implausible', title: `${sensor} fora da faixa`, detail: `Lê ${formatCelsius(c)}; esperado entre ${min} e ${max} °C.` });
    }
  });
  if (tempsC.length === 2 && Math.abs(tempsC[0] - tempsC[1]) > T.temp_sensor_diverge_c) {
    findings.push({ severity: 'warn', code: 'temp_diverge', title: 'Sensores de temperatura discordam', detail: `Diferença de ${formatNumber(Math.abs(tempsC[0] - tempsC[1]), 1)} °C (limite ${T.temp_sensor_diverge_c} °C).` });
  }
  return findings;
}

function messageNotes(msg) {
  if (!msg) return [];
  const notes = [];
  if (msg.failure_severity === 'aviso') {
    notes.push({ severity: 'warn', code: 'failure_warning', title: 'Código de falha 5 (aviso)', detail: 'O BMS gravou um aviso, não uma trava: o BTC04 só considera a bateria morta com código diferente de 0 e de 5.' });
  }
  if (msg.cell_count === 10) {
    notes.push({ severity: 'info', code: 'type6', title: 'Pack de 10 células (tipo 6)', detail: 'Flags 0x1E: provável BL36xx. As leituras D7 cobrem só 5 células, e o nybble 34 aqui faz parte das flags, não é trava de carregador.' });
  }
  return notes;
}

function lockFindings(msg) {
  if (!msg || msg.lock_causes.length === 0) return [];
  const causes = msg.lock_causes.map((cause) => LOCK_CAUSES_PT[cause]).join('; ');
  // OBI repo issues: 10 packs like this; the old OBI UI said UNLOCKED and chargers refused them.
  const silent = msg.failure_code === 0 && msg.lock_causes.includes('inverted_checksums')
    ? ' O código de falha é 0, então a interface antiga do OBI mostraria "UNLOCKED", mas o carregador recusa.'
    : '';
  return [{ severity: 'bad', code: 'locked', title: 'Bateria travada', detail: `${causes}. Carregadores recusam o pack até os erros serem limpos.${silent}` }];
}

// The BMS measures the pack after the output fuse/FET (OBI repo #140): far below the cell sum
// means that path is open, not that the cells are empty. The F0513 pack is the cell sum itself.
export function outputPathOpen(readings) {
  if (readings.source === 'f0513') return false;
  const cellSum = readings.cells_mv.reduce((sum, mv) => sum + mv, 0);
  return cellSum >= T.open_sense_pack_v * 1000 && readings.pack_mv < cellSum * T.pack_below_cells_ratio;
}

function implausibleCellFindings(readings) {
  const findings = [];
  readings.cells_mv.forEach((mv, index) => {
    // OBI repo #203: the web UI showed 0.204/0.716 V, i.e. CC 00/CC 02 echoed back.
    const echo = readings.source === 'f0513' && mv <= T.f0513_echo_max_mv && (mv & 0xff) === T.f0513_echo_low_byte;
    if (!echo && volts(mv) <= T.cell_implausible_v) return;
    const reason = echo ? 'eco do comando CC, não uma tensão' : 'impossível para Li-ion';
    findings.push({ severity: 'warn', code: 'cell_implausible', title: `Célula ${index + 1} com leitura impossível`, detail: `Lê ${formatVolts(volts(mv))}: ${reason}. Leia de novo e não confie nas tensões desta leitura.` });
  });
  return findings;
}

function silenceFinding(report) {
  if (report.msg || report.readings) return [];
  return [{ severity: 'bad', code: 'no_answer', title: 'A bateria não respondeu', detail: silenceDetail(report) }];
}

function silenceDetail(report) {
  const lineLow = report.line?.idle_level === 0 || (report.msgStatus?.status === 'silent' && report.msgStatus.blank === '00');
  if (lineLow) return 'A linha de dados está presa em nível baixo: curto, fiação invertida ou BMS ocupado.';
  // OneWire reset() returns 1 when a chip answered with a presence pulse.
  if (report.line?.presence === 0) return 'Sem pulso de presença: nenhum chip 1-Wire neste contato. Confira os contatos e se a bateria está encaixada.';
  if (report.line?.presence) return 'O chip responde ao reset, mas todas as leituras vieram vazias (FF). Pode ser um BMS de outro tipo.';
  return 'Nenhum chip respondeu. Confira os contatos, o resistor de pull-up e se a bateria está encaixada.';
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function diagnose(report) {
  const findings = [...silenceFinding(report), ...lockFindings(report.msg), ...messageNotes(report.msg)];
  let cells = [];
  let spread = null;
  const readings = report.readings;
  const cellCount = report.msg?.cell_count ?? null;
  const implausible = readings ? implausibleCellFindings(readings) : [];
  if (readings) {
    cells = classifyCells(readings.pack_mv, readings.cells_mv, cellCount);
    findings.push(...implausible, ...temperatureFindings(readings.temps_c, { namesNtc: true }));
  }
  // The voltages aren't real (an echoed command, or beyond Li-ion): judging cells, balance or the
  // pack from them would invent problems (OBI repo #203 read as "deep discharge").
  if (readings && implausible.length === 0) {
    spread = cellSpread(cells);
    findings.push(...cellFindings(cells), ...spreadFinding(spread, readings.soc_pct));
    if (cells.some((cell) => cell.state === 'absent')) {
      const source = cellCount === null ? 'pela tensão da célula 5' : 'pelas flags do BMS';
      findings.push({ severity: 'info', code: 'four_cell', title: 'Pack de 4 células', detail: `A célula 5 não existe (pack de 14,4 V, ${source}); ela fica fora da análise.` });
    }
    if (outputPathOpen(readings)) {
      const cellSum = readings.cells_mv.reduce((sum, mv) => sum + mv, 0);
      findings.push({ severity: 'bad', code: 'output_path_open', title: 'Saída do pack aberta', detail: `O pack lê ${formatVolts(volts(readings.pack_mv))} com as células somando ${formatVolts(volts(cellSum))}. O BMS mede o pack depois do fusível/MOSFET de saída, então esse caminho está aberto; as células estão boas.` });
    } else if (volts(readings.pack_mv) < 1) {
      findings.push({ severity: 'info', code: 'pack_zero', title: 'Pack praticamente em 0 V', detail: 'O chip ainda responde porque é alimentado pelo ENABLE (5 V do carregador ou da ponte), não pelas células; isso não indica que as células estejam boas.' });
    }
  }
  const hasProblem = findings.some((f) => f.severity === 'warn' || f.severity === 'bad');
  if (!hasProblem && (report.msg || readings)) {
    const detail = readings ? 'Destravada, células dentro da faixa e equilibradas.' : 'Destravada. As células não foram lidas.';
    findings.unshift({ severity: 'ok', code: 'healthy', title: 'Nenhum problema encontrado', detail });
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));
  return { severity: worst(findings.map((f) => f.severity)), findings, cells, spread };
}

// Shared rule with python/: unlocking only runs when the last read shows a lock cause
// (any of them), even though a checksum mismatch or charger lock alone leaves `locked` false.
export function unlockRefusal(report) {
  if (!report.msg) return 'a mensagem do BMS (lxt_msg) não foi lida. Leia a bateria de novo.';
  if (report.msg.lock_causes.length === 0) {
    if (report.msg.failure_severity === 'aviso') return 'esta bateria não está travada: o código de falha 5 é só um aviso (o BTC04 não a considera morta).';
    return 'esta bateria não está travada, não há o que limpar.';
  }
  return null;
}
