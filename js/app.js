// UI wiring. Everything rendered comes from a dump (live or opened from a file), so the
// offline viewer and the live reader share one code path.

import { fromHex, toHex } from './bytes.js';
import { BYTE_LABELS_PT, CHECKSUMS, COUNTS_PER_MAH, FAILURE_SEVERITY_PT, LOCK_CAUSES_PT, READ_TITLES_PT, READS, TEMP_LABELS_PT, TESTMODE } from './catalog.js';
import { btc04ChargeBars, btc04HealthScore, buildReport, decodeStoredRead } from './decode.js';
import { diagnose, unlockRefusal } from './diagnosis.js';
import { CXT_ADC, CXT_CALIBRATION_MV, CXT_CHANNELS, CXT_NTC, CXT_STEP_NAME } from './cxt-catalog.js';
import { buildCxtReport, CXT_NO_COMMAND_PT, dividerRatio, isCxtDump } from './cxt-decode.js';
import { diagnoseCxt } from './cxt-diagnosis.js';
import { readCxtBattery } from './cxt-reader.js';
import { detectFamily, detectionSummaryPt, FAMILY_NAMES_PT } from './detect.js';
import { diffDumps, diffReads } from './diff.js';
import { createDump, dumpFileName, parseDump, serializeDump, withCalibration } from './dump.js';
import { formatDate, formatNumber, formatVolts } from './format.js';
import { baseReadName } from './protocol.js';
import { clearErrors, readBattery, readTestMode } from './reader.js';
import { isWebSerialSupported, ObiLink, WebSerialTransport } from './serial.js';
import { findXgtStep, isXgtReadName, XGT_MODEL_READ, XGT_STEP_NAMES, XGT_WIRING } from './xgt-catalog.js';
import { buildXgtReport, compareXgtPacks, decodeXgtStoredRead, isXgtDump } from './xgt-decode.js';
import { diagnoseXgt } from './xgt-diagnosis.js';
import { frameFromRequestHex, XGT_CMD } from './xgt-protocol.js';
import { readXgtBattery, XgtBridgeError } from './xgt-reader.js';

// Fill scale for the cell drawing: empty at the deep-discharge limit, full at 4.2 V.
const CELL_EMPTY_V = 2.5;
const CELL_FULL_V = 4.2;

const SEVERITY_PT = { ok: 'Sem problemas', info: 'Observação', warn: 'Atenção', bad: 'Problema' };
const CELL_STATE_PT = { ok: 'ok', low: 'baixa', deep: 'descarga profunda', dead: 'morta', open: 'fio aberto', absent: 'não existe' };

// The page always opens on LXT, the line most users have; the choice is not remembered on purpose.
const DEFAULT_FAMILY = 'lxt';

const state = {
  transport: null,
  link: null,
  firmware: null,
  busy: false,
  closingByUser: false,
  dumps: [], // [{id, title, dump, live}]
  currentId: null,
  unlock: null, // {before, steps, after} from the last unlock in this session
  nextId: 1,
  // 'auto' | 'lxt' | 'xgt' | 'cxt': what "Ler bateria" reads and which welcome is shown
  family: DEFAULT_FAMILY,
  xgtWiringAcked: false, // XGT safety checklist confirmed for the current connection
  detectionMiss: null, // last detection that found no pack (shown above the welcome)
  calibrationMv: null, // Vcc measured at the Nano 5V pin, remembered per browser for CXT reads
};

const FAMILIES = ['auto', 'lxt', 'xgt', 'cxt'];
const CALIBRATION_STORAGE_KEY = 'mbd.cxt.vcc_mv';
const FAMILY_SUBTITLE_PT = {
  auto: 'Automático: detecta CXT, LXT ou XGT pela interface Arduino USB, 9600 baud',
  lxt: 'LXT: interface Arduino USB ↔ 1-Wire, 9600 baud',
  xgt: 'XGT: interface Arduino USB ↔ UART no contato TR (D5), 9600 baud',
  cxt: 'CXT: entradas analógicas A0–A3 do Arduino (sem linha de dados), 9600 baud',
};
const FAMILY_CHOSEN_PT = {
  auto: 'Modo automático: “Ler bateria” testa CXT, LXT e XGT, nessa ordem, e lê o que encontrar.',
  lxt: 'Linha LXT (18V/14,4V) escolhida.',
  xgt: 'Linha XGT (40V) escolhida. Leia o painel de segurança antes de ligar a bateria.',
  cxt: 'Linha CXT (12V) escolhida. Monte os divisores do painel de ligação antes de encaixar a bateria.',
};

function dumpFamily(dump) {
  if (isCxtDump(dump)) return 'cxt';
  return isXgtDump(dump) ? 'xgt' : 'lxt';
}

// The family on screen: the shown dump's, else the selector's (which may be 'auto').
function viewFamily() {
  const entry = currentEntry();
  return entry ? dumpFamily(entry.dump) : state.family;
}

const $ = (id) => document.getElementById(id);

// --- tiny DOM builder (no innerHTML: dumps are user files) -------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'style') el.setAttribute('style', value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(el, children);
  return el;
}

// replaceChildren() would print null/false as text; this skips them like h() does.
function setChildren(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// --- status / busy -----------------------------------------------------------------------

function setProgress(text, isError = false) {
  const el = $('progress');
  el.textContent = text;
  el.classList.toggle('error-text', isError);
}

function setLinkStatus(kind, text) {
  $('link-status').dataset.state = kind;
  $('link-status-text').textContent = text;
}

function currentEntry() {
  return state.dumps.find((entry) => entry.id === state.currentId) ?? null;
}

function refreshButtons() {
  const connected = Boolean(state.link);
  const entry = currentEntry();
  $('btn-connect').textContent = connected ? 'Desconectar' : 'Conectar';
  $('btn-connect').disabled = state.busy || !isWebSerialSupported();
  $('btn-read').disabled = state.busy || !connected;
  // Test mode and unlock append to a live read of the pack on the bench.
  const liveReady = connected && entry?.live && dumpFamily(entry.dump) === 'lxt';
  // Test mode and unlock exist only for LXT: XGT is read-only (lockout reset intentionally not
  // implemented) and CXT has no data line at all.
  const family = viewFamily();
  $('btn-testmode').hidden = family !== 'lxt';
  $('btn-unlock').hidden = family !== 'lxt';
  const readonlyNote = READONLY_NOTE_PT[family] ?? '';
  $('readonly-note').hidden = !readonlyNote;
  $('readonly-note').textContent = readonlyNote;
  $('btn-testmode').disabled = state.busy || !liveReady;
  $('btn-unlock').disabled = state.busy || !liveReady;
  $('btn-save').disabled = state.busy || !entry;
  $('btn-open').disabled = state.busy;
}

const READONLY_NOTE_PT = {
  xgt: 'Somente leitura: o reset da trava XGT não é implementado.',
  cxt: 'Somente leitura: a CXT é lida pelas entradas analógicas, sem chip de dados.',
};

async function exclusive(label, action) {
  if (state.busy) return;
  state.busy = true;
  refreshButtons();
  setProgress(label);
  try {
    await action();
  } catch (error) {
    console.error(error);
    setProgress(`Erro: ${error.message}`, true);
  } finally {
    state.busy = false;
    refreshButtons();
  }
}

// --- confirmation dialog (a real in-page dialog, not window.confirm) ----------------------

function confirmDialog({ title, body, confirmLabel, danger = false, ackText = '' }) {
  const dialog = $('confirm-dialog');
  const ok = $('confirm-ok');
  const ack = $('confirm-ack');
  $('confirm-title').textContent = title;
  setChildren($('confirm-body'), body);
  ok.textContent = confirmLabel;
  dialog.classList.toggle('dialog--danger', danger);
  $('confirm-ack-wrap').hidden = !ackText;
  $('confirm-ack-text').textContent = ackText;
  ack.checked = false;
  ok.disabled = Boolean(ackText);
  ack.onchange = () => { ok.disabled = !ack.checked; };
  return new Promise((resolve) => {
    // Resolved from the clicks themselves: Chrome delays the dialog's "close" event in
    // background tabs, which would leave the action hanging.
    const finish = (confirmed) => {
      ok.onclick = null;
      $('confirm-cancel').onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(confirmed);
    };
    ok.onclick = () => finish(true);
    $('confirm-cancel').onclick = () => finish(false);
    dialog.oncancel = (event) => { // Esc
      event.preventDefault();
      finish(false);
    };
    dialog.showModal();
    // Destructive actions start on "Cancelar" so Enter doesn't confirm by accident.
    (danger ? $('confirm-cancel') : ok).focus();
  });
}

// --- names and value formatting ------------------------------------------------------------

function readTitle(name) {
  if (isXgtReadName(name)) return findXgtStep(name)?.label_pt ?? 'Leitura XGT desconhecida';
  if (name === CXT_STEP_NAME) return 'Entradas analógicas CXT (0xE1)';
  if (name.startsWith('clear_errors_')) return `Limpar erros, passo ${name.slice('clear_errors_'.length)}`;
  if (name === `${TESTMODE.prefix}enter`) return 'Entrar no modo de teste';
  if (name === `${TESTMODE.prefix}exit`) return 'Sair do modo de teste';
  if (name === `${TESTMODE.prefix}session`) return 'Sessão do modo de teste';
  if (name.startsWith('rom@')) return 'ROM com outro tempo entre bytes (dump antigo)';
  const base = READ_TITLES_PT[baseReadName(name)] ?? 'Leitura desconhecida';
  if (name.startsWith(TESTMODE.prefix)) return `${base} (modo de teste)`;
  if (name.startsWith('before_')) return `${base} (antes do desbloqueio)`;
  if (name.startsWith('after_')) return `${base} (depois do desbloqueio)`;
  return base;
}

const FIELD_LABELS_PT = {
  status: 'situação da leitura', error: 'erro', blank: 'linha vazia',
  rom: 'ROM', serial: 'número de série', chip: 'chip', manufacture_date: 'data de fabricação',
  capacity_code: 'código de capacidade', capacity_ah: 'capacidade (Ah)', charge_count: 'contador de cargas',
  second_counter: 'segundo contador', failure_code: 'código de falha', locked: 'travada (código de falha)',
  failure_severity: 'gravidade do código de falha', flags: 'flags', cell_count: 'células (pelas flags)',
  charge_counter_raw: 'contador coulomb (bruto)', remaining_mah: 'carga restante (mAh)',
  charger_lock_nybble: 'nybble 34 (trava de carregador)', lock_causes: 'causas da trava', model_code: 'código do modelo',
  battery_type: 'tipo de bateria', damage_rating: 'índice de dano', overdischarge_idx: 'índice de sobredescarga',
  overload_idx: 'índice de sobrecarga', pack_mv: 'tensão do pack (mV)', cells_mv: 'células (mV)',
  temps_raw: 'temperaturas (1/10 K)', temps_c: 'temperaturas (°C)', soc_raw: 'carga (bruto)', soc_pct: 'carga (%)',
  real_capacity_mah: 'capacidade estimada pelo BMS (mAh)', ack: 'ACK', count: 'contagem', counters: 'contadores', value: 'valor',
  amps: 'corrente (A)', date: 'data', text: 'texto', mv: 'tensão (mV)', temp_c: 'temperatura (°C)', temp_raw: 'temperatura (1/10 K)',
  'extended.target_capacity_mah': 'capacidade-alvo 0x1D (mAh, significado incerto)', 'extended.error_status': 'status de erro',
  'extended.error_counters': 'contadores de erro', 'extended.stability_count': 'contador de estabilidade',
};
// XGT decodes (xgt-decode.js); "locked" means the lockout flag here, not the LXT failure code.
const XGT_FIELD_LABELS_PT = {
  status: 'situação da leitura', error: 'erro', detail: 'detalhe', raw: 'valor bruto',
  model: 'modelo', command: 'comando da resposta', message_id: 'id da mensagem',
  cycles: 'ciclos de carga', locked: 'travada (lockout)', capacity_mah: 'capacidade (mAh)',
  charge_pct: 'carga (%)', temp_c: 'temperatura (°C)', pack_v: 'tensão do pack (V)', cell_v: 'tensão da célula (V)',
  mv: 'tensão (mV)', cell_capacity_mah: 'capacidade nominal da célula (mAh)', parallel: 'conjuntos em paralelo',
  series: 'células em série', bins: 'faixas', first_bin: 'primeira faixa',
};
// CXT ADC decode (cxt-decode.js).
const CXT_FIELD_LABELS_PT = {
  status: 'situação da leitura', error: 'erro', detail: 'detalhe', samples: 'amostras', sums: 'somas brutas (A0 A1 A2 A3 bandgap)',
  vcc_source: 'origem do Vcc', vcc_v: 'Vcc usado (V)', bandgap_vcc_v: 'Vcc pelo bandgap (V)', tap_v: 'taps (V)',
  cells_v: 'células (V)', pack_v: 'tensão do pack (V)', ntc_v: 'tensão no termistor (V)', ntc_state: 'termistor',
  temp_c: 'temperatura (°C)', is_cxt: 'parece CXT',
};
const NTC_STATE_PT = { ok: 'respondendo', open: 'aberto', short: 'em curto' };
const VCC_SOURCE_PT = { bandgap: 'estimado pelo bandgap de 1,1 V', calibration: 'medido no pino 5V' };

const CHECKSUM_PART_PT = { stored: 'gravado', calc: 'calculado', ok: 'confere', inverted: 'invertido', primary: 'primário' };

function fieldLabel(key, readName = '') {
  if (readName === CXT_STEP_NAME) return CXT_FIELD_LABELS_PT[key] ?? key;
  if (isXgtReadName(readName)) {
    const bin = key.match(/^bin(\d)$/);
    if (bin) return `faixa ${bin[1]}`;
    const param = key.match(/^params\.(\w+)$/);
    if (param) return `parâmetro ${param[1]}`;
    return XGT_FIELD_LABELS_PT[key] ?? key;
  }
  const checksum = key.match(/^checksums\.(\w+)\.(\w+)$/);
  if (checksum) return `${checksum[1]} ${CHECKSUM_PART_PT[checksum[2]] ?? checksum[2]}`;
  return FIELD_LABELS_PT[key] ?? key;
}

function fieldValue(key, value) {
  if (value === null || value === undefined) return '—';
  // fieldDiff joins arrays with spaces; lock causes read better as the pt-BR sentences.
  if (key === 'lock_causes' && value) return value.split(' ').map((cause) => LOCK_CAUSES_PT[cause] ?? cause).join('; ');
  if (key === 'ntc_state') return NTC_STATE_PT[value] ?? value;
  if (key === 'vcc_source') return VCC_SOURCE_PT[value] ?? value;
  if (value === true) return 'sim';
  if (value === false) return 'não';
  if (value === '') return '(vazio)';
  return String(value);
}

function hexCode(value) {
  return `0x${toHex([value])}`;
}

function statusText(decoded) {
  if (decoded.status === 'error') return { text: decoded.error, tone: 'bad' };
  if (decoded.status === 'short') return { text: `Tamanho inesperado: ${decoded.error}`, tone: 'warn' };
  if (decoded.status === 'silent') {
    return decoded.blank === 'ff'
      ? { text: 'Sem resposta (tudo FF)', tone: 'muted' }
      : { text: 'Linha em nível baixo (tudo 00)', tone: 'warn' };
  }
  return null;
}

// D4 50 01 02: the BMS capacity estimate, plus the BTC04 health score derived from it.
function healthText(decoded, msg) {
  const parts = [`${decoded.value} mAh`];
  const score = msg ? btc04HealthScore(decoded.value, msg.capacity_code) : null;
  if (score !== null) parts.push(`saúde estilo BTC04 ${score}/4`);
  return parts.join('; ');
}

function memoryValueText(name, decoded, msg) {
  switch (baseReadName(name)) {
    case 'type0_id': return decoded.ack ? 'É BMS tipo 0' : 'Não é tipo 0';
    case 'type3_id': return decoded.ack ? 'É BMS tipo 3' : 'Não é tipo 3';
    case 'd4_assembly_date': return formatDate(decoded.date);
    case 'd4_0150': return healthText(decoded, msg);
    case 'd7_charge_level': return `${decoded.value} (${formatNumber(decoded.value / COUNTS_PER_MAH, 0)} mAh)`;
    case 'd4_od_events': return `${decoded.count} eventos`;
    case 'd4_overload': return decoded.counters.join(' / ');
    case 'd7_current': return `${formatNumber(decoded.amps, 2)} A`;
    case 'lxt_data_ext': {
      const ext = decoded.extended;
      if (!ext) return 'Bloco curto, sem a parte estendida';
      return `Capacidade-alvo 0x1D (significado incerto) ${ext.target_capacity_mah} mAh; status de erro ${hexCode(ext.error_status)}; contadores ${ext.error_counters}; estabilidade ${ext.stability_count}`;
    }
    default: return '';
  }
}

function tag(text, tone) {
  return h('span', { class: `tag tag--${tone}` }, text);
}

function decodedCell(read, msg) {
  if (!read) return h('td', { class: 'tag--muted' }, '—');
  const decoded = decodeStoredRead(read);
  const problem = statusText(decoded);
  if (problem) return h('td', {}, tag(problem.text, problem.tone));
  const ack = decoded.ack === undefined ? null : decoded.ack ? tag('ACK', 'ok') : tag('sem ACK', 'warn');
  return h('td', {}, memoryValueText(read.name, decoded, msg), ' ', ack);
}

// --- pack view -----------------------------------------------------------------------------

function renderPack() {
  const view = $('pack-view');
  const entry = currentEntry();
  if (!entry) {
    setChildren(view, state.detectionMiss ? renderDetection(state.detectionMiss) : null, renderWelcome());
    return;
  }
  const { dump } = entry;
  const detection = entry.detection ? renderDetection(entry.detection) : null;
  if (isCxtDump(dump)) {
    setChildren(view, detection, renderCxtPack(entry));
    return;
  }
  if (isXgtDump(dump)) {
    setChildren(view, detection, renderXgtPack(entry));
    return;
  }
  const report = buildReport(dump.reads, dump.line);
  const diagnosis = diagnose(report);
  setChildren(view,
    detection,
    h('p', { class: 'panel__note', style: 'margin:0 0 1rem' }, sourceLine(entry)),
    h('div', { class: 'pack-grid' },
      h('div', { class: 'pack-cols' },
        h('div', { class: 'pack-col' }, renderPlate(report, diagnosis, dump), renderCells(report, diagnosis), renderMessage(report)),
        h('div', { class: 'pack-col' }, renderDiagnosis(diagnosis), renderLive(report))),
      state.unlock && entry.live ? renderUnlock(state.unlock) : null,
      renderMemory(dump.reads, report.msg),
      renderRaw(dump.reads),
    ),
  );
}

function sourceLine(entry) {
  const { dump } = entry;
  const when = dump.timestamp ? dump.timestamp.replace('T', ' às ') : 'data desconhecida';
  const firmware = dump.firmware ? `firmware ${dump.firmware}` : 'firmware desconhecido';
  return entry.live
    ? `Leitura desta sessão, ${when}, ${firmware}.`
    : `Dump aberto de arquivo: “${dump.label}”, ${when}, ${firmware}, gerado por ${dump.tool ?? 'ferramenta desconhecida'}.`;
}

function renderWelcome() {
  if (state.family === 'xgt') return renderXgtWelcome();
  if (state.family === 'cxt') return renderCxtWelcome();
  if (state.family === 'auto') return renderAutoWelcome();
  const steps = [
    'Grave o firmware no Arduino (pasta firmware/) e ligue-o pelo USB.',
    'Conecte o fio de dados e o GND aos contatos da bateria.',
    'Clique em “Conectar”, escolha a porta do Arduino e depois em “Ler bateria”.',
  ];
  return h('div', { class: 'welcome' },
    h('h2', {}, 'Nenhuma bateria lida ainda'),
    h('ol', {}, steps.map((step) => h('li', {}, step))),
    h('p', { class: 'muted' }, 'Sem o hardware à mão? Use “Abrir dumps…” para ver um dump salvo, ou abra dois para compará-los. Tudo roda no navegador, sem internet.'),
  );
}

const VOLTAGE_CLASS_BY_CELLS = { 4: '14,4 V', 5: '18 V', 10: '36 V' };

function voltageClass(report, diagnosis) {
  const fromFlags = VOLTAGE_CLASS_BY_CELLS[report.msg?.cell_count];
  if (fromFlags) return fromFlags;
  if (diagnosis.cells.length === 0) return null;
  return diagnosis.cells.some((cell) => cell.state === 'absent') ? '14,4 V' : '18 V';
}

function renderPlate(report, diagnosis, dump) {
  const msg = report.msg;
  const model = report.model?.text ?? (msg ? `Modelo ${hexCode(msg.model_code)}` : 'Bateria sem identificação');
  const rating = [msg ? `${formatNumber(msg.capacity_ah, 1)} Ah` : null, voltageClass(report, diagnosis)].filter(Boolean).join(' / ');
  const locked = msg ? msg.lock_causes.length > 0 : null;
  const facts = [
    ['Fabricação', msg ? formatDate(msg.manufacture_date) : '—'],
    ['Número de série', msg ? msg.serial : '—', 'hex'],
    ['Cargas', msg ? String(msg.charge_count) : '—'],
    ['Chip', msg ? (msg.chip === 'f0513' ? 'F0513 (antigo)' : 'LXT') : report.readings?.source === 'f0513' ? 'F0513 (antigo)' : '—'],
    ['ROM', msg ? msg.rom : '—', 'hex'],
    ['Firmware', dump.firmware ?? '—'],
  ];
  return h('section', { class: 'plate area-plate', 'aria-labelledby': 'plate-model' },
    h('div', { class: 'plate__band' },
      h('h2', { class: 'plate__model', id: 'plate-model' }, model),
      rating ? h('span', { class: 'plate__rating' }, rating) : null,
      locked === null ? null : h('span', { class: 'plate__lock', 'data-locked': String(locked) }, locked ? 'Travada' : 'Destravada'),
    ),
    h('dl', { class: 'plate__facts' },
      facts.map(([label, value, kind]) => h('div', {}, h('dt', {}, label), h('dd', { class: kind ?? null }, value))),
    ),
    locked ? h('ul', { class: 'plate__causes', 'aria-label': 'Causas da trava' }, msg.lock_causes.map((cause) => h('li', {}, LOCK_CAUSES_PT[cause]))) : null,
  );
}

function renderDiagnosis(diagnosis) {
  const headline = { ok: 'Bateria sem problemas aparentes', info: 'Sem problemas, com observações', warn: 'Requer atenção', bad: 'Problemas encontrados' }[diagnosis.severity];
  return h('section', { class: 'panel area-diag', 'aria-labelledby': 'diag-title' },
    h('h2', { id: 'diag-title' }, 'Diagnóstico'),
    diagnosis.findings.length === 0
      ? h('p', {}, 'Nada para avaliar nesta leitura.')
      : [
        h('p', { class: 'verdict', 'data-sev': diagnosis.severity }, h('span', { class: 'sev-dot', 'aria-hidden': 'true' }), headline),
        h('ul', { class: 'findings' }, diagnosis.findings.map((finding) =>
          h('li', { class: 'finding', 'data-sev': finding.severity },
            h('p', { class: 'finding__title' }, finding.title, ' ', h('span', { class: 'finding__sev' }, `(${SEVERITY_PT[finding.severity]})`)),
            h('p', { class: 'finding__detail' }, finding.detail),
          ))),
      ],
  );
}

function renderCells(report, diagnosis) {
  const readings = report.readings;
  if (!readings) {
    return h('section', { class: 'panel area-cells', 'aria-labelledby': 'cells-title' },
      h('h2', { id: 'cells-title' }, 'Células'),
      h('p', {}, 'As tensões das células não foram lidas: nem lxt_data nem os comandos do F0513 responderam.'));
  }
  const usable = diagnosis.cells.filter((cell) => cell.state !== 'absent' && cell.state !== 'open');
  const max = usable.length ? Math.max(...usable.map((cell) => cell.v)) : null;
  const min = usable.length ? Math.min(...usable.map((cell) => cell.v)) : null;
  return h('section', { class: 'panel area-cells', 'aria-labelledby': 'cells-title' },
    h('h2', { id: 'cells-title' }, 'Células'),
    cellList(diagnosis.cells),
    h('div', { class: 'cells-summary' },
      readout('Pack', formatNumber(readings.pack_mv / 1000, 2), 'V'),
      spreadReadouts(diagnosis.spread, max, min),
    ),
    readings.source === 'f0513'
      ? h('p', { class: 'panel__note' }, 'Chip F0513: as células vêm dos comandos CC 31 a CC 35 e o pack é a soma delas.')
      : h('p', { class: 'panel__note' }, 'Barra cheia = 4,2 V; vazia = 2,5 V. Julgue o equilíbrio com a bateria quase descarregada.'),
  );
}

function cellList(cells, extraClass = '') {
  return h('ol', { class: `cells ${extraClass}`.trim(), style: 'list-style:none;margin:0;padding:0' }, cells.map((cell) => {
    const fill = Math.max(0, Math.min(1, (cell.v - CELL_EMPTY_V) / (CELL_FULL_V - CELL_EMPTY_V)));
    const label = `Célula ${cell.index + 1}: ${formatVolts(cell.v)}, ${CELL_STATE_PT[cell.state]}`;
    return h('li', { class: 'cell', 'data-state': cell.state, 'aria-label': label },
      h('span', { class: 'cell__name', 'aria-hidden': 'true' }, `C${cell.index + 1}`),
      h('span', { class: 'cell__can', 'aria-hidden': 'true' }, h('span', { class: 'cell__fill', style: `height:${(fill * 100).toFixed(1)}%` })),
      h('span', { class: 'cell__v', 'aria-hidden': 'true' }, formatNumber(cell.v, 3)),
      h('span', { class: 'cell__flag', 'aria-hidden': 'true' }, CELL_STATE_PT[cell.state]),
    );
  }));
}

function spreadReadouts(spread, max, min) {
  return [
    readout('Diferença', spread === null ? '—' : formatNumber(spread * 1000, 0), spread === null ? '' : 'mV'),
    readout('Maior', max === null ? '—' : formatNumber(max, 3), max === null ? '' : 'V'),
    readout('Menor', min === null ? '—' : formatNumber(min, 3), min === null ? '' : 'V'),
  ];
}

function readout(label, value, unit) {
  return h('div', { class: 'readout' },
    h('span', { class: 'readout__label' }, label),
    h('span', { class: 'readout__value' }, value, unit ? h('small', {}, ` ${unit}`) : null));
}

function renderLive(report) {
  const readings = report.readings;
  const items = [];
  if (readings) {
    const labelled = readings.source === 'lxt_data';
    readings.temps_c.forEach((celsius, index) => {
      const label = labelled && TEMP_LABELS_PT[index] ? `Temperatura ${index + 1} (${TEMP_LABELS_PT[index]})` : `Temperatura ${index + 1}`;
      items.push(readout(label, formatNumber(celsius, 1), '°C'));
    });
    if (readings.soc_pct !== undefined) items.push(readout('Carga (SOC)', formatNumber(readings.soc_pct, 1), '%'));
    if (readings.remaining_mah !== undefined) items.push(readout('Carga restante', formatNumber(readings.remaining_mah, 0), 'mAh'));
    if (readings.real_capacity_mah !== undefined) items.push(readout('Capacidade estimada pelo BMS', String(readings.real_capacity_mah), 'mAh'));
    const bars = report.msg && readings.charge_counter_raw !== undefined ? btc04ChargeBars(readings.charge_counter_raw, report.msg.capacity_code) : null;
    if (bars !== null) items.push(readout('Barras estilo BTC04', String(bars), 'de 7'));
  }
  return h('section', { class: 'panel area-live', 'aria-labelledby': 'live-title' },
    h('h2', { id: 'live-title' }, 'Medições'),
    items.length ? h('div', { class: 'readouts' }, items) : h('p', {}, 'Sem medições nesta leitura.'),
    readings?.source === 'f0513' ? h('p', { class: 'panel__note' }, 'Temperatura pelo comando CC 52 do F0513. Carga e capacidade estimada não existem neste chip.') : null,
    readings?.source === 'lxt_data' ? h('p', { class: 'panel__note' }, 'Os rótulos dos sensores de temperatura são hipótese (drakosha). A carga restante vem do contador coulomb (bytes 25 a 28, 2880 por mAh); as barras estilo BTC04 são a porcentagem do nominal em décimos, até 7.') : null,
    report.msg && readings?.real_capacity_mah !== undefined
      ? h('p', { class: 'panel__note' }, `Nominal ${formatNumber(report.msg.capacity_ah, 1)} Ah; a capacidade estimada é corrigida pelo BMS a cada ciclo completo e só faz sentido depois de alguns ciclos num pack remontado.`)
      : null,
  );
}

function renderMessage(report) {
  const msg = report.msg;
  if (!msg) {
    const status = report.msgStatus ? statusText(report.msgStatus) : null;
    return h('section', { class: 'panel area-msg', 'aria-labelledby': 'msg-title' },
      h('h2', { id: 'msg-title' }, 'Mensagem do BMS'),
      h('p', {}, status ? status.text : 'A mensagem (lxt_msg) não foi lida.'));
  }
  const checksumRows = CHECKSUMS.map((checksum) => {
    const value = msg.checksums[checksum.name];
    const verdict = value.ok ? tag('confere', 'ok') : value.inverted ? tag('invertido', 'bad') : tag('diferente', 'bad');
    return h('tr', {},
      h('th', { scope: 'row' }, checksum.name),
      h('td', {}, `${checksum.first}–${checksum.last}`),
      h('td', { class: 'num' }, value.stored.toString(16).toUpperCase()),
      h('td', { class: 'num' }, value.calc.toString(16).toUpperCase()),
      h('td', {}, verdict));
  });
  const details = [
    ['Código de falha', `${msg.failure_code} (${FAILURE_SEVERITY_PT[msg.failure_severity]})`],
    ['Nybble 34 (trava de carregador)', String(msg.charger_lock_nybble)],
    ['Flags', `${hexCode(msg.flags)} (${msg.cell_count === null ? 'nº de células desconhecido' : `${msg.cell_count} células`})`],
    ['Código do modelo', `${hexCode(msg.model_code)} (${msg.model_code})`],
    ['Tipo de bateria', String(msg.battery_type)],
    ['Índice de dano (0 a 7)', String(msg.damage_rating)],
    ['Índice de sobredescarga', String(msg.overdischarge_idx)],
    ['Índice de sobrecarga', String(msg.overload_idx)],
    ['Segundo contador', String(msg.second_counter)],
    ['Código de capacidade', String(msg.capacity_code)],
  ];
  return h('section', { class: 'panel area-msg', 'aria-labelledby': 'msg-title' },
    h('h2', { id: 'msg-title' }, 'Mensagem do BMS'),
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('caption', {}, 'Checksums: soma dos nybbles da faixa, 4 bits'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Checksum'), h('th', { scope: 'col' }, 'Nybbles'), h('th', { scope: 'col', class: 'num' }, 'Gravado'), h('th', { scope: 'col', class: 'num' }, 'Calculado'), h('th', { scope: 'col' }, 'Situação'))),
        h('tbody', {}, checksumRows))),
    h('dl', { class: 'kv', style: 'margin-top:1rem' }, details.map(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
    h('p', { class: 'panel__note' }, 'Índice de dano menor que 3 indica saúde plena. Os índices de sobredescarga/sobrecarga ainda não têm significado confirmado.'),
  );
}

function renderMemory(reads, msg) {
  const byName = new Map(reads.map((read) => [read.name, read]));
  const memoryNames = READS.filter((read) => read.group === 'memory').map((read) => read.name)
    .filter((name) => byName.has(name) || byName.has(TESTMODE.prefix + name));
  const hasTestmode = reads.some((read) => read.name.startsWith(TESTMODE.prefix));
  const sessionError = byName.get(`${TESTMODE.prefix}session`);
  return h('section', { class: 'panel area-mem', 'aria-labelledby': 'mem-title' },
    h('h2', { id: 'mem-title' }, 'Leituras de memória'),
    memoryNames.length === 0 ? h('p', {}, 'Este dump não tem leituras de memória.') : h('div', { class: 'table-wrap' },
      h('table', {},
        h('caption', {}, 'Respostas com ACK (06) no fim. Significados vêm de outros projetos e nem todos foram confirmados.'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Leitura'),
          h('th', { scope: 'col' }, 'Normal'),
          hasTestmode ? h('th', { scope: 'col' }, 'Modo de teste') : null)),
        h('tbody', {}, memoryNames.map((name) => h('tr', {},
          h('th', { scope: 'row' }, READ_TITLES_PT[name]),
          decodedCell(byName.get(name), msg),
          hasTestmode ? decodedCell(byName.get(TESTMODE.prefix + name), msg) : null))))),
    sessionError ? h('p', { class: 'panel__note error-text' }, `Modo de teste falhou: ${sessionError.error}`) : null,
    hasTestmode && !sessionError ? h('p', { class: 'panel__note' }, `Entrada no modo de teste: ${ackWord(byName.get(`${TESTMODE.prefix}enter`))}; saída: ${ackWord(byName.get(`${TESTMODE.prefix}exit`))}.`) : null,
  );
}

function ackWord(read) {
  if (!read) return 'não registrada';
  const decoded = decodeStoredRead(read);
  return decoded.status === 'ok' && decoded.ack ? 'confirmada (06)' : `sem ACK (${read.response || 'vazio'})`;
}

function renderUnlock(unlock) {
  const before = decodeStoredRead(unlock.before);
  const after = decodeStoredRead(unlock.after);
  const lockWord = (decoded) => (decoded.status !== 'ok' ? 'ilegível' : decoded.lock_causes.length ? 'travada' : 'destravada');
  const diff = diffReads(unlock.before, unlock.after);
  const unlocked = after.status === 'ok' && after.lock_causes.length === 0;
  return h('section', { class: 'panel area-unlock', 'aria-labelledby': 'unlock-title' },
    h('h2', { id: 'unlock-title' }, 'Resultado do desbloqueio'),
    h('p', { class: 'verdict', 'data-sev': unlocked ? 'ok' : 'bad' }, h('span', { class: 'sev-dot', 'aria-hidden': 'true' }),
      `Antes: ${lockWord(before)}. Depois: ${lockWord(after)}.`),
    h('ul', {}, unlock.steps.map((step) => h('li', {}, `${readTitle(step.name)}: `, step.ok ? `resposta ${step.response}` : h('span', { class: 'error-text' }, step.error)))),
    renderDiffTables(diff, 'Antes', 'Depois'),
    h('p', { class: 'panel__note' }, 'Clique em “Ler bateria” para atualizar todos os painéis com o novo estado.'),
  );
}

function renderRaw(reads) {
  return h('section', { class: 'panel area-raw', 'aria-labelledby': 'raw-title' },
    h('h2', { id: 'raw-title' }, 'Bytes brutos'),
    h('div', { class: 'raw-list' }, reads.map((read) => {
      const bytes = read.ok ? fromHex(read.response) : new Uint8Array(0);
      const meta = read.ok ? `${bytes.length} bytes` : 'erro';
      return h('details', { class: 'raw-item' },
        h('summary', {},
          h('span', { class: 'raw-name' }, read.name),
          h('span', { class: 'raw-title' }, readTitle(read.name)),
          h('span', { class: 'raw-meta' }, meta)),
        h('div', { class: 'raw-body' },
          read.request ? h('p', { class: 'req' }, 'Pedido: ', h('span', { class: 'hex' }, read.request)) : null,
          read.ok ? hexGrid(bytes, baseReadName(read.name) === 'lxt_msg' ? BYTE_LABELS_PT : {}) : h('p', { class: 'error-text' }, read.error || 'Falhou sem mensagem.')));
    })),
  );
}

function hexGrid(bytes, labels) {
  if (bytes.length === 0) return h('p', { class: 'req' }, 'Resposta vazia.');
  const cells = [];
  bytes.forEach((byte, offset) => {
    if (offset % 16 === 0) cells.push(h('span', { class: 'off', 'aria-hidden': 'true' }, offset.toString().padStart(3, '0')));
    if (offset % 16 === 8) {
      cells.push(h('span', { class: 'gap', 'aria-hidden': 'true' }));
      // Narrow screens wrap at 8 bytes; this label then starts the second row.
      cells.push(h('span', { class: 'off off--mid', 'aria-hidden': 'true' }, offset.toString().padStart(3, '0')));
    }
    const label = labels[offset];
    cells.push(h('span', { class: byte === 0xff ? 'b ff' : 'b', title: label ? `byte ${offset}: ${label}` : null }, toHex([byte])));
  });
  return h('div', { class: 'hexgrid', role: 'group', 'aria-label': `${bytes.length} bytes: ${toHex(bytes)}` }, cells);
}

// --- diffs (shared by unlock and compare) --------------------------------------------------

function renderDiffTables(diff, labelA, labelB) {
  const blocks = [];
  if (diff.bytes.length) {
    blocks.push(h('div', { class: 'table-wrap' }, h('table', {},
      h('caption', {}, 'Bytes alterados (posição na resposta, ROM incluída)'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'num' }, 'Byte'), h('th', { scope: 'col' }, 'Significado'), h('th', { scope: 'col' }, labelA), h('th', { scope: 'col' }, labelB))),
      h('tbody', {}, diff.bytes.map((change) => h('tr', {},
        h('td', { class: 'num' }, String(change.offset)),
        h('td', {}, change.label || '—'),
        h('td', { class: 'hex diff-before' }, change.before ?? '—'),
        h('td', { class: 'hex diff-after' }, change.after ?? '—')))))));
  }
  if (diff.fields.length) {
    blocks.push(h('div', { class: 'table-wrap' }, h('table', {},
      h('caption', {}, 'Valores decodificados que mudaram'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Campo'), h('th', { scope: 'col' }, labelA), h('th', { scope: 'col' }, labelB))),
      h('tbody', {}, diff.fields.map((field) => h('tr', {},
        h('td', {}, fieldLabel(field.key, diff.name)),
        h('td', { class: 'diff-before' }, fieldValue(field.key, field.before)),
        h('td', { class: 'diff-after' }, fieldValue(field.key, field.after))))))));
  }
  if (blocks.length === 0) blocks.push(h('p', {}, 'Nenhuma diferença.'));
  return h('div', { class: 'diff-block' }, blocks);
}

function renderCompareOptions() {
  for (const [selectId, fallbackIndex] of [['compare-a', -2], ['compare-b', -1]]) {
    const select = $(selectId);
    const previous = select.value;
    setChildren(select, state.dumps.map((entry) => h('option', { value: String(entry.id) }, entry.title)));
    const keep = state.dumps.some((entry) => String(entry.id) === previous);
    const fallback = state.dumps.at(fallbackIndex) ?? state.dumps.at(-1);
    select.value = keep ? previous : fallback ? String(fallback.id) : '';
  }
}

function renderCompare() {
  const view = $('compare-view');
  if (state.dumps.length < 2) {
    setChildren(view, h('p', {}, 'Abra pelo menos dois dumps (ou leia a bateria e abra um dump) para comparar. Use “Abrir dumps…”; dá para escolher vários arquivos de uma vez.'));
    return;
  }
  const entryA = state.dumps.find((entry) => String(entry.id) === $('compare-a').value);
  const entryB = state.dumps.find((entry) => String(entry.id) === $('compare-b').value);
  if (!entryA || !entryB) return;
  if (entryA === entryB) {
    setChildren(view, h('p', {}, 'Escolha dois dumps diferentes.'));
    return;
  }
  const diff = diffDumps(entryA.dump, entryB.dump);
  const familyA = dumpFamily(entryA.dump);
  const familyB = dumpFamily(entryB.dump);
  const packNote = familyA !== familyB && (familyA === 'cxt' || familyB === 'cxt')
    ? h('div', { class: 'notice notice--warn', style: 'margin:0 0 1rem' }, h('p', {}, `Linhas diferentes: A é ${FAMILY_NAMES_PT[familyA]}, B é ${FAMILY_NAMES_PT[familyB]}. São baterias diferentes, e só leituras com o mesmo nome são comparadas.`))
    : familyA === 'cxt'
    ? cxtPackNote(entryA.dump, entryB.dump)
    : familyA === 'xgt' || familyB === 'xgt'
    ? xgtPackNote(entryA.dump, entryB.dump)
    : diff.samePack
    ? h('p', { class: 'verdict', 'data-sev': 'ok' }, h('span', { class: 'sev-dot', 'aria-hidden': 'true' }), `Mesmo pack (ROM ${diff.romA}).`)
    : h('div', { class: 'notice notice--warn', style: 'margin:0 0 1rem' }, h('p', {}, `Packs diferentes ou sem ROM: A = ${diff.romA ?? 'sem ROM'}, B = ${diff.romB ?? 'sem ROM'}.`));
  setChildren(view,
    packNote,
    diff.reads.length === 0 ? h('p', {}, 'Nenhuma diferença nas leituras em comum.') : null,
    ...diff.reads.map((readDiff) => h('section', { class: 'panel', style: 'margin-bottom:1rem' },
      h('h2', {}, readTitle(readDiff.name), ' ', h('span', { class: 'hex tag--muted', style: 'font-size:0.8em;font-weight:400' }, readDiff.name)),
      renderDiffTables(readDiff, 'A', 'B'))),
    diff.onlyInA.length ? h('p', { class: 'panel__note' }, `Só em A: ${diff.onlyInA.join(', ')}.`) : null,
    diff.onlyInB.length ? h('p', { class: 'panel__note' }, `Só em B: ${diff.onlyInB.join(', ')}.`) : null,
  );
}

function renderAll() {
  renderPack();
  renderCompareOptions();
  renderCompare();
  refreshButtons();
}

// --- dump registry -------------------------------------------------------------------------

function addDump(dump, live) {
  const entry = { id: state.nextId++, dump, live, title: `${dump.label} (${dump.timestamp.replace('T', ' ') || 'sem data'})${live ? ', esta sessão' : ''}` };
  state.dumps.push(entry);
  state.currentId = entry.id;
  $('dump-label').value = dump.label;
  state.detectionMiss = null;
  // Automático stays selected: the view follows the dump's family anyway.
  if (state.family !== 'auto') setFamily(dumpFamily(dump), { keepCurrent: true });
  return entry;
}

function replaceLiveDump(dump) {
  const entry = currentEntry();
  entry.dump = dump;
}

// --- actions -------------------------------------------------------------------------------

async function connect() {
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (error) {
    // NotFoundError = the user closed the picker without choosing a port.
    setProgress(error.name === 'NotFoundError' ? 'Nenhuma porta escolhida.' : `Erro ao escolher a porta: ${error.message}`, error.name !== 'NotFoundError');
    return;
  }
  const transport = new WebSerialTransport(port);
  setLinkStatus('busy', 'Conectando…');
  setProgress('Abrindo a porta e aguardando o Arduino reiniciar (2 s)…');
  try {
    await transport.open();
  } catch (error) {
    setLinkStatus('off', 'Desconectado');
    throw new Error(`não foi possível abrir a porta (${error.message}). Outro programa ou aba pode estar usando o Arduino: feche o monitor serial e tente de novo.`);
  }
  const link = new ObiLink(transport);
  try {
    state.firmware = await link.version();
  } catch (error) {
    await transport.close().catch(() => {});
    setLinkStatus('off', 'Desconectado');
    throw new Error(`o dispositivo não respondeu ao pedido de versão (${error.message}). Confira se o firmware está gravado e se a porta é a do Arduino.`);
  }
  transport.onClose = (failure) => {
    if (state.closingByUser) return;
    dropLink();
    setProgress(`Conexão perdida${failure ? ` (${failure.message})` : ''}. Reconecte o cabo e clique em “Conectar”.`, true);
  };
  state.transport = transport;
  state.link = link;
  setLinkStatus('on', `Conectado, firmware ${state.firmware}`);
  setProgress('Pronto. Encaixe a bateria e clique em “Ler bateria”.');
}

function dropLink() {
  state.transport = null;
  state.link = null;
  state.xgtWiringAcked = false;
  setLinkStatus('off', 'Desconectado');
  refreshButtons();
}

async function disconnect() {
  state.closingByUser = true;
  try {
    await state.transport?.close();
  } finally {
    state.closingByUser = false;
    dropLink();
    setProgress('Desconectado.');
  }
}

const READERS = { lxt: readBattery, xgt: readXgtBattery, cxt: readCxtBattery };

function currentCalibration() {
  return state.calibrationMv === null ? null : { vcc_mv: state.calibrationMv };
}

// Automático: probes in spec order; null (and the miss on screen) when no family answered.
async function detectForRead() {
  const detection = await detectFamily(state.link, {
    calibration: currentCalibration(),
    onProbe: (family) => setProgress(`Detectando a linha da bateria: testando ${FAMILY_NAMES_PT[family]}…`),
  });
  if (detection.family) return detection;
  state.detectionMiss = detection;
  state.currentId = null;
  state.unlock = null;
  renderAll();
  setProgress(detectionSummaryPt(detection), true);
  return null;
}

async function readPack() {
  let family = state.family;
  let detection = null;
  if (family === 'auto') {
    detection = await detectForRead();
    if (!detection) return;
    family = detection.family;
    setProgress(`${detectionSummaryPt(detection)} Lendo…`);
  }
  // In Automático the XGT probe sent one read frame; the full read still waits for the check.
  if (family === 'xgt' && !(await confirmXgtWiring())) {
    setProgress(detection ? 'XGT detectada; leitura completa cancelada.' : 'Leitura XGT cancelada. Nada foi enviado à bateria.');
    return;
  }
  const progress = ({ done, total, name }) => {
    setProgress(name ? `Lendo ${done + 1} de ${total}: ${readTitle(name)}…` : 'Leitura concluída.');
  };
  let result;
  try {
    result = await READERS[family](state.link, progress);
  } catch (error) {
    if (!(error instanceof XgtBridgeError)) throw error;
    throw new Error(`o Arduino não completou a primeira leitura XGT (${error.message}). Confira se o firmware gravado tem o comando 0xE0 (versão atual da pasta firmware/) e se a porta é a do Arduino.`);
  }
  const dump = createDump({
    label: $('dump-label').value.trim(), firmware: result.firmware, line: result.line, reads: result.reads,
    calibration: family === 'cxt' ? currentCalibration() : null,
  });
  state.unlock = null;
  const entry = addDump(dump, true);
  entry.detection = detection;
  setProgress(readSummary(family, result.reads));
  renderAll();
}

function readSummary(family, reads) {
  if (family === 'cxt' && reads[0]?.ok && reads[0].response === '') {
    return `Leitura CXT sem dados: ${CXT_NO_COMMAND_PT}. Grave o firmware atual num Uno ou Nano.`;
  }
  const failed = reads.filter((read) => !read.ok).length;
  return failed ? `Leitura concluída; ${failed} leituras falharam (veja “Bytes brutos”).` : 'Leitura concluída.';
}

async function readPackInTestMode() {
  const confirmed = await confirmDialog({
    title: 'Ler no modo de teste?',
    body: [
      h('p', {}, 'Algumas leituras de memória só respondem com o BMS em modo de teste. A ferramenta entra no modo (CC D9 96 A5), repete as leituras de memória e sai (CC D9 FF FF), tudo numa única sessão.'),
      h('p', {}, 'Enquanto estiver no modo de teste, os checksums aparecem como errados. Ao terminar, a alimentação do chip é cortada, o que também encerra o modo.'),
    ],
    confirmLabel: 'Entrar e ler',
  });
  if (!confirmed) {
    setProgress('Leitura no modo de teste cancelada.');
    return;
  }
  setProgress('Lendo no modo de teste…');
  const reads = await readTestMode(state.link);
  const entry = currentEntry();
  const kept = entry.dump.reads.filter((read) => !read.name.startsWith(TESTMODE.prefix));
  replaceLiveDump({ ...entry.dump, reads: [...kept, ...reads] });
  setProgress(reads[0].ok ? 'Leitura no modo de teste concluída.' : `Modo de teste falhou: ${reads[0].error}`, !reads[0].ok);
  renderAll();
}

async function unlockPack() {
  const entry = currentEntry();
  const report = buildReport(entry.dump.reads, entry.dump.line);
  const diagnosis = diagnose(report);
  const refusal = unlockRefusal(report);
  if (refusal) {
    setProgress(`Desbloqueio recusado: ${refusal}`, true);
    return;
  }
  const badCells = diagnosis.findings.filter((finding) => finding.code.startsWith('cell_') && finding.severity === 'bad');
  const confirmed = await confirmDialog({
    title: 'Desbloquear a bateria?',
    danger: true,
    body: [
      h('p', {}, 'Isto envia ao BMS a mesma sequência do botão “Clear errors” do OBI: 33 D9 96 A5 e depois 33 DA 04. Ela apaga o registro de erros e grava a memória do BMS.'),
      h('ul', {},
        h('li', {}, 'A mensagem é lida antes e depois, e as diferenças aparecem em seguida.'),
        h('li', {}, 'Funcionou em packs travados pelo BMS (código de falha + checksums invertidos). Não conserta células ruins.'),
        h('li', {}, `Causas da trava agora: ${report.msg.lock_causes.map((cause) => LOCK_CAUSES_PT[cause]).join('; ')}.`),
        badCells.length ? h('li', {}, h('strong', { class: 'error-text' }, `Atenção: ${badCells.map((f) => f.title.toLowerCase()).join(', ')}. Desbloquear libera a carga de células danificadas, com risco de aquecimento e incêndio.`)) : null,
      ),
    ],
    confirmLabel: 'Desbloquear',
    ackText: 'Entendo que isto altera a memória do BMS e assumo o risco.',
  });
  if (!confirmed) {
    setProgress('Desbloqueio cancelado. Nada foi enviado à bateria.');
    return;
  }
  setProgress('Desbloqueando: lendo a mensagem, enviando a sequência e lendo de novo…');
  const result = await clearErrors(state.link);
  state.unlock = result;
  const unlockNames = new Set(['before_lxt_msg', 'after_lxt_msg', 'clear_errors_1', 'clear_errors_2']);
  const kept = entry.dump.reads.filter((read) => !unlockNames.has(read.name));
  replaceLiveDump({ ...entry.dump, reads: [...kept, result.before, ...result.steps, result.after] });
  setProgress('Desbloqueio executado. Veja o resultado abaixo.');
  renderAll();
  $('unlock-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function saveDump() {
  const entry = currentEntry();
  const label = $('dump-label').value.trim() || 'bateria';
  entry.dump = { ...entry.dump, label };
  const blob = new Blob([serializeDump(entry.dump)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: dumpFileName(entry.dump) });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked later: some browsers start the download asynchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setProgress(`Dump salvo como ${dumpFileName(entry.dump)}.`);
}

async function openDumps(files) {
  const errors = [];
  let opened = 0;
  for (const file of files) {
    try {
      addDump(parseDump(await file.text()), false);
      opened++;
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
    }
  }
  renderAll();
  if (errors.length) {
    setProgress(`Não foi possível abrir ${errors.length} arquivo(s). ${errors.join(' | ')}`, true);
    return;
  }
  setProgress(opened > 1 ? `${opened} dumps abertos. Veja a aba “Comparar dumps”.` : 'Dump aberto.');
}

// --- XGT (40V) -----------------------------------------------------------------------------
// Read-only view. Facts and confidence levels come from spec/xgt.json via xgt-catalog.js.

const CONFIDENCE_PT = {
  A: { tone: 'ok', text: 'conferido contra a ferramenta da Makita' },
  B: { tone: 'muted', text: 'captura de um testador Makita, usada por código independente' },
  C: { tone: 'warn', text: 'fonte única ou significado em disputa' },
};

function confidenceTag(level) {
  const info = CONFIDENCE_PT[level];
  if (!info) return null;
  return h('span', { class: `tag tag--${info.tone}`, title: `Confiança ${level}: ${info.text}` }, `conf. ${level}`);
}

function setFamily(family, { keepCurrent = false } = {}) {
  state.family = FAMILIES.includes(family) ? family : DEFAULT_FAMILY;
  for (const input of document.querySelectorAll('input[name="family"]')) input.checked = input.value === state.family;
  $('masthead-sub').textContent = FAMILY_SUBTITLE_PT[state.family];
  if (keepCurrent) return;
  // Show the latest dump of the chosen line (any line in Automático), or that line's welcome.
  const latest = state.dumps.filter((entry) => state.family === 'auto' || dumpFamily(entry.dump) === state.family).at(-1);
  state.currentId = latest ? latest.id : null;
  state.unlock = null;
  state.detectionMiss = null;
}

function setupFamily() {
  setFamily(DEFAULT_FAMILY);
  for (const input of document.querySelectorAll('input[name="family"]')) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      setFamily(input.value);
      setProgress(FAMILY_CHOSEN_PT[state.family]);
      renderAll();
    });
  }
}

function xgtPackNote(dumpA, dumpB) {
  const pack = compareXgtPacks(dumpA, dumpB);
  const warn = (text) => h('div', { class: 'notice notice--warn', style: 'margin:0 0 1rem' }, h('p', {}, text));
  const who = (dump, model) => `“${dump.label}”${model ? ` (${model})` : ''}`;
  switch (pack.kind) {
    case 'mixed': return warn('Um dump é XGT e o outro é LXT: são baterias diferentes, e só leituras com o mesmo nome são comparadas.');
    case 'different_model': return warn(`Modelos diferentes: A = ${pack.modelA}, B = ${pack.modelB}. Não é a mesma bateria.`);
    case 'same_pack': return h('p', { class: 'verdict', 'data-sev': 'ok' }, h('span', { class: 'sev-dot', 'aria-hidden': 'true' }), `Mesmo pack pelo nome e modelo: ${who(dumpA, pack.modelA)}.`);
    default: return warn(`XGT não tem identificador de pack conhecido (como a ROM do LXT): o pack é reconhecido pelo nome dado ao dump e pelo modelo. A = ${who(dumpA, pack.modelA)}, B = ${who(dumpB, pack.modelB)}.`);
  }
}

function renderXgtSafety({ compact }) {
  const [rMin, rMax] = XGT_WIRING.series_resistor_ohm.map((ohm) => formatNumber(ohm / 1000, ohm % 1000 ? 1 : 0));
  const volts = XGT_WIRING.voltages;
  const rules = [
    [h('strong', {}, `Até ${volts.pack_v[1]} V entre B+ e B−.`), ' O pack tem 10 células em série e entrega dezenas de ampères. Só TR e B− vão para a placa.'],
    [h('strong', {}, 'TR → resistor → D5.'), ` Resistor de ${rMin} a ${rMax} kΩ em série e zener de 5,1 V do D5 ao GND, do lado da placa (no ESP32-C3: GPIO3 e grampo Schottky para 3V3). Sem pull-up e nunca no D6, que tem o pull-up do LXT.`],
    [h('strong', {}, `Nunca ligue o DT (~${formatNumber(volts.dt_v_full, 1)} V com o pack cheio).`), ' Ele fica ao lado do TR. DS, CS e B+ também não vão para a placa.'],
    [h('strong', {}, 'GND só no B−.'), ' Nada de garras jacaré em B+ ou B−: uma garra que escorrega vira curto.'],
    [h('strong', {}, 'Meça o TR antes.'), ` Em repouso fica perto de 0 V; packs originais ficam abaixo de ${volts.tr_genuine_max_v} V, mas um clone mostrou ${volts.tr_clone_seen_v} V. Acima de ${volts.tr_genuine_max_v} V, não ligue essa bateria.`],
  ];
  const diagram = [
    'Arduino            Bateria XGT',
    `D5 ──┬──[ ${rMin}–${rMax} kΩ ]──── TR`,
    '     Z  zener 5,1 V',
    'GND ─┴──────────────── B−',
    '            B+, DT, DS, CS: NÃO ligar',
  ].join('\n');
  const body = [
    h('ul', { class: 'safety__rules' }, rules.map((rule) => h('li', {}, rule))),
    h('pre', { class: 'safety__diagram', 'aria-label': `Ligação: D5 pelo resistor de ${rMin} a ${rMax} kΩ até o TR, zener de 5,1 V do D5 ao GND, GND no B−. B+, DT, DS e CS não são ligados.` }, diagram),
    h('p', { class: 'panel__note' }, 'Desenho dos contatos, proteção do ESP32-C3 e o primeiro experimento: docs/xgt.md, seções “Contatos”, “Segurança” e “Ligação”.'),
  ];
  if (compact) {
    return h('details', { class: 'safety safety--compact' },
      h('summary', {}, h('strong', {}, 'Segurança XGT: '), `só TR (pelo resistor, no D5) e B−. Nunca o DT (~${formatNumber(volts.dt_v_full, 1)} V).`),
      h('div', { class: 'safety__body' }, body));
  }
  return h('section', { class: 'safety', 'aria-labelledby': 'safety-title' },
    h('h2', { id: 'safety-title' }, 'Antes de ligar uma bateria XGT (40V)'),
    h('div', { class: 'safety__body' }, body));
}

function renderXgtWelcome() {
  const steps = [
    'Grave o firmware atual no Arduino (pasta firmware/): ele tem o comando 0xE0, que fala XGT no pino D5.',
    'Monte a ligação do painel acima com a bateria fora, meça o TR e só então encaixe a bateria.',
    'Clique em “Conectar”, escolha a porta do Arduino e depois em “Ler bateria”.',
  ];
  return h('div', { class: 'welcome welcome--xgt' },
    renderXgtSafety({ compact: false }),
    h('h2', {}, 'Nenhuma bateria XGT lida ainda'),
    h('p', { class: 'muted' }, 'Suporte experimental e somente leitura: nada foi conferido ainda numa bateria do autor; cada valor mostra o nível de confiança da fonte.'),
    h('ol', {}, steps.map((step) => h('li', {}, step))),
    h('p', { class: 'muted' }, 'Sem o hardware à mão? Use “Abrir dumps…” para ver um dump XGT salvo, ou abra dois para compará-los. Tudo roda no navegador, sem internet.'),
  );
}

async function confirmXgtWiring() {
  if (state.xgtWiringAcked) return true;
  const confirmed = await confirmDialog({
    title: 'Ler uma bateria XGT (40V)?',
    danger: true,
    body: [
      h('p', {}, 'A leitura só envia pedidos de leitura pelo TR. Antes, confira a ligação:'),
      h('ul', {},
        h('li', {}, 'Só TR (pelo resistor em série, no D5) e B− estão ligados na placa.'),
        h('li', {}, `DT (~${formatNumber(XGT_WIRING.voltages.dt_v_full, 1)} V), DS, CS e B+ não encostam em nada da placa.`),
        h('li', {}, `O TR mediu menos de ${XGT_WIRING.voltages.tr_genuine_max_v} V em relação ao B−.`)),
    ],
    confirmLabel: 'Ler bateria',
    ackText: 'Conferi a ligação e medi o TR.',
  });
  state.xgtWiringAcked = confirmed;
  return confirmed;
}

function xgtStatus(decoded) {
  switch (decoded.status) {
    case 'ok': return null;
    case 'silent': return { text: 'Sem resposta', tone: 'muted' };
    case 'no_command': return { text: 'Firmware sem o comando 0xE0', tone: 'bad' };
    case 'error': return { text: decoded.error, tone: 'bad' };
    case 'invalid': {
      const kind = { crc: 'CRC errado', checksum: 'Checksum errado', length: 'Tamanho errado', framing: 'Quadro malformado', count: 'Contagem inconsistente', params: 'Parâmetros ilegíveis' }[decoded.error] ?? 'Resposta inválida';
      return { text: `${kind}: ${decoded.detail}`, tone: 'bad' };
    }
    default: return { text: 'Leitura desconhecida', tone: 'muted' };
  }
}

function xgtValueText(name, decoded) {
  if (name === XGT_MODEL_READ.name) return decoded.model || '(vazio)';
  if (/^xgt_cell\d+$/.test(name)) return `${formatNumber(decoded.cell_v, 3)} V`;
  if (/_hist\d$/.test(name)) return decoded.bins.map((count, index) => `faixa ${decoded.first_bin + index} = ${count}`).join('; ');
  switch (name) {
    case 'xgt_cycles': return String(decoded.cycles);
    case 'xgt_lockout': return decoded.locked ? `travada (byte 4 = ${hexCode(decoded.raw)})` : 'livre (byte 4 = 00)';
    case 'xgt_capacity': return `${decoded.capacity_mah} mAh (significado em disputa: restante ou total atual)`;
    case 'xgt_charge': return `${formatNumber(decoded.charge_pct, 1)} %`;
    case 'xgt_temp1':
    case 'xgt_temp2': return `${formatNumber(decoded.temp_c, 1)} °C`;
    case 'xgt_pack_voltage': return `${formatNumber(decoded.pack_v, 3)} V`;
    case 'xgt_cell_capacity': return `${decoded.cell_capacity_mah} mAh por célula`;
    case 'xgt_pack_config': return `${decoded.parallel} em paralelo, ${decoded.series} em série`;
    default: return '';
  }
}

function renderXgtPack(entry) {
  const { dump } = entry;
  const report = buildXgtReport(dump.reads);
  const diagnosis = diagnoseXgt(report);
  return [
    h('p', { class: 'panel__note', style: 'margin:0 0 1rem' }, sourceLine(entry)),
    h('div', { class: 'pack-grid' },
      renderXgtSafety({ compact: true }),
      h('div', { class: 'pack-cols' },
        h('div', { class: 'pack-col' }, renderXgtPlate(report, dump), renderXgtCells(report, diagnosis)),
        h('div', { class: 'pack-col' }, renderDiagnosis(diagnosis), renderXgtLive(report), renderXgtLockout(report))),
      renderXgtHistograms(report),
      renderXgtRegisters(dump.reads, report),
      renderXgtRaw(dump.reads, report),
    ),
  ];
}

function renderXgtPlate(report, dump) {
  const rating = ['40V max',
    report.series !== null && report.parallel !== null ? `${report.series}S${report.parallel}P` : null,
    report.design_capacity_mah !== null ? `${formatNumber(report.design_capacity_mah / 1000, 1)} Ah` : null,
  ].filter(Boolean).join(' / ');
  const facts = [
    ['Ciclos de carga', report.cycles === null ? '—' : String(report.cycles)],
    ['Capacidade (em disputa)', report.capacity_mah === null ? '—' : `${report.capacity_mah} mAh`],
    ['Nominal', report.design_capacity_mah === null ? '—' : `${report.design_capacity_mah} mAh`],
    ['Carga', report.charge_pct === null ? '—' : `${formatNumber(report.charge_pct, 1)} %`],
    ['Linha', 'XGT (experimental)'],
    ['Firmware', dump.firmware ?? '—'],
  ];
  return h('section', { class: 'plate area-plate', 'aria-labelledby': 'plate-model' },
    h('div', { class: 'plate__band' },
      h('h2', { class: 'plate__model', id: 'plate-model' }, report.model ?? 'XGT sem identificação'),
      h('span', { class: 'plate__rating' }, rating),
      report.locked === null ? null : h('span', { class: 'plate__lock', 'data-locked': String(report.locked) }, report.locked ? 'Travada' : 'Sem trava'),
    ),
    h('dl', { class: 'plate__facts' },
      facts.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))),
    ),
  );
}

function renderXgtCells(report, diagnosis) {
  if (diagnosis.cells.length === 0) {
    return h('section', { class: 'panel area-cells', 'aria-labelledby': 'cells-title' },
      h('h2', { id: 'cells-title' }, 'Células'),
      h('p', {}, 'As tensões das células não foram lidas (registradores 0x0302 a 0x0314).'));
  }
  const usable = diagnosis.cells.filter((cell) => cell.state !== 'absent' && cell.state !== 'open');
  const max = usable.length ? Math.max(...usable.map((cell) => cell.v)) : null;
  const min = usable.length ? Math.min(...usable.map((cell) => cell.v)) : null;
  const missing = report.cells.length - diagnosis.cells.length;
  return h('section', { class: 'panel area-cells', 'aria-labelledby': 'cells-title' },
    h('h2', { id: 'cells-title' }, 'Células'),
    cellList(diagnosis.cells, 'cells--many'),
    h('div', { class: 'cells-summary' },
      readout('Pack', report.pack_mv === null ? '—' : formatNumber(report.pack_mv / 1000, 2), report.pack_mv === null ? '' : 'V'),
      readout('Soma das células', report.cells_sum_mv === null ? '—' : formatNumber(report.cells_sum_mv / 1000, 2), report.cells_sum_mv === null ? '' : 'V'),
      spreadReadouts(diagnosis.spread, max, min),
    ),
    missing > 0 ? h('p', { class: 'panel__note error-text' }, `${missing} célula(s) sem leitura válida; veja os quadros brutos.`) : null,
    h('p', { class: 'panel__note' }, 'Barra cheia = 4,2 V; vazia = 2,5 V. Mesmos limites do LXT. “Pack” é o registrador 0x0300; se o BMS o mede à parte ou soma as células, ainda não se sabe.'),
  );
}

function renderXgtLive(report) {
  const items = [];
  report.temps_c.forEach((celsius, index) => {
    if (celsius !== null) items.push(readout(`Temperatura ${index + 1}`, formatNumber(celsius, 1), '°C'));
  });
  if (report.charge_pct !== null) items.push(readout('Carga', formatNumber(report.charge_pct, 1), '%'));
  if (report.capacity_mah !== null) items.push(readout('Capacidade (em disputa)', String(report.capacity_mah), 'mAh'));
  if (report.cell_capacity_mah !== null) items.push(readout('Por célula', String(report.cell_capacity_mah), 'mAh'));
  return h('section', { class: 'panel area-live', 'aria-labelledby': 'live-title' },
    h('h2', { id: 'live-title' }, 'Medições'),
    items.length ? h('div', { class: 'readouts' }, items) : h('p', {}, 'Sem medições nesta leitura.'),
    h('p', { class: 'panel__note' }, 'Capacidade (registrador 0x0064, confiança C): significado em disputa, restante ou total atual (m5din e Belik dizem restante; o twaymouth usa como total atual). A nominal é a capacidade por célula vezes os conjuntos em paralelo.'),
  );
}

function renderXgtLockout(report) {
  const status = report.locked === null ? 'não lida' : report.locked ? 'travada' : 'sem trava';
  return h('section', { class: 'panel area-lockout', 'aria-labelledby': 'lockout-title' },
    h('h2', { id: 'lockout-title' }, 'Trava (lockout)'),
    h('p', {}, `Registrador 0x0060: ${status}.`),
    h('p', { style: 'margin-top:0.6rem' }, h('strong', {}, 'O reset da trava não está implementado, de propósito.'), ' Esta página só lê; os quadros de reset são recusados mesmo se alguém tentar enviá-los. Por quê:'),
    h('ul', { class: 'lockout__reasons' },
      h('li', {}, 'segundo o twaymouth, o reset apaga todos os dados, inclusive a contagem de ciclos, e pode danificar o BMS de vez;'),
      h('li', {}, 'segundo o m5din, em geral também é preciso jumpear o fusível da placa, o que anula a proteção que atuou;'),
      h('li', {}, 'a trava tem uma causa (célula fraca, desequilíbrio, temperatura) que zerar o flag não resolve;'),
      h('li', {}, 'não temos leituras próprias de antes e depois para saber o que mais muda.')),
    h('p', { class: 'panel__note' }, 'Texto completo em docs/xgt.md, seção “Reset da trava (documentado, NÃO implementado)”.'),
  );
}

// Tallest bar; the value label sits right on top of each bar.
const HIST_BAR_MAX_REM = 6;

function histogramChart(title, bins, names) {
  const levels = names.map((name) => findXgtStep(name)?.confidence).filter(Boolean);
  const read = bins ? bins.filter((count) => count !== null) : [];
  const peak = Math.max(1, ...read);
  return h('figure', { class: 'hist' },
    h('figcaption', {}, h('span', { class: 'hist__title' }, title), ' ', [...new Set(levels)].map(confidenceTag)),
    bins === null
      ? h('p', { class: 'panel__note' }, 'Não lido.')
      : h('ol', { class: 'hist__bars', 'aria-label': `${title}: ${bins.map((count, index) => `faixa ${index + 1} = ${count ?? 'não lida'}`).join(', ')}` },
        bins.map((count, index) => h('li', { class: 'hist__bar', 'data-missing': count === null ? 'true' : null, title: `Faixa ${index + 1}: ${count ?? 'não lida'}` },
          h('span', { class: 'hist__track', 'aria-hidden': 'true' },
            h('span', { class: 'hist__value' }, count === null ? '—' : String(count)),
            h('span', { class: 'hist__fill', style: `height:${count === null ? 0 : ((count / peak) * HIST_BAR_MAX_REM).toFixed(2)}rem` })),
          h('span', { class: 'hist__label', 'aria-hidden': 'true' }, String(index + 1))))),
  );
}

function renderXgtHistograms(report) {
  return h('section', { class: 'panel area-hist', 'aria-labelledby': 'hist-title' },
    h('h2', { id: 'hist-title' }, 'Histogramas de uso'),
    h('div', { class: 'hist-grid' },
      histogramChart('Corrente', report.current_hist, ['xgt_current_hist0', 'xgt_current_hist1', 'xgt_current_hist2']),
      histogramChart('Temperatura', report.temp_hist, ['xgt_temp_hist0', 'xgt_temp_hist1', 'xgt_temp_hist2'])),
    h('p', { class: 'panel__note' }, 'Contagens de 8 bits por faixa. A faixa de corrente ou temperatura de cada barra é desconhecida. O histograma de corrente foi conferido contra uma captura do ADP12 da Makita (faixas 1 e 2).'),
  );
}

function renderXgtRegisters(reads, report) {
  const byName = new Map(reads.map((read) => [read.name, read]));
  return h('section', { class: 'panel area-registers', 'aria-labelledby': 'registers-title' },
    h('h2', { id: 'registers-title' }, 'Leituras'),
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('caption', {}, 'Todas as leituras XGT, na ordem do procedimento. Confiança A, B ou C conforme spec/xgt.json.'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Leitura'), h('th', { scope: 'col' }, 'Valor'), h('th', { scope: 'col' }, 'Confiança'))),
        h('tbody', {}, XGT_STEP_NAMES.map((name) => {
          const read = byName.get(name);
          const decoded = report.decodedByName.get(name);
          const problem = decoded ? xgtStatus(decoded) : null;
          let value;
          if (!read) value = tag('não lida', 'muted');
          else if (problem) value = tag(problem.text, problem.tone);
          else value = xgtValueText(name, decoded);
          return h('tr', {},
            h('th', { scope: 'row' }, readTitle(name)),
            h('td', {}, value),
            h('td', {}, confidenceTag(findXgtStep(name)?.confidence)));
        })))),
  );
}

// Byte roles in a short reply; bytes 2-3 echo the request in m5din's emulator (unverified).
const XGT_SHORT_REPLY_LABELS = { 0: 'início (CC)', 1: 'CRC', 2: 'comando (eco?)', 3: 'endereço (eco?)', 4: 'valor, byte baixo', 5: 'valor, byte alto', 6: 'reservado', 7: 'fim (33)' };

function renderXgtRaw(reads, report) {
  return h('section', { class: 'panel area-raw', 'aria-labelledby': 'raw-title' },
    h('h2', { id: 'raw-title' }, 'Quadros brutos'),
    h('p', { class: 'panel__note', style: 'margin:0 0 0.75rem' }, 'Pedido = quadro serial completo para o Arduino (01, tamanho, rsp_len, E0, flags, espera do despertar, tempo limite, quadro XGT). Resposta = contagem de bytes recebidos + bytes da bateria.'),
    h('div', { class: 'raw-list' }, reads.map((read) => {
      const decoded = report.decodedByName.get(read.name) ?? decodeXgtStoredRead(read);
      const problem = xgtStatus(decoded);
      const payload = read.ok ? fromHex(read.response) : new Uint8Array(0);
      const received = payload.slice(1);
      const request = read.request ? fromHex(read.request) : null;
      const sentFrame = read.request ? frameFromRequestHex(read.request) : null;
      const woke = request && request[3] === XGT_CMD && request.length > 4 ? (request[4] & 1) === 1 : null;
      return h('details', { class: 'raw-item' },
        h('summary', {},
          h('span', { class: 'raw-name' }, read.name),
          h('span', { class: 'raw-title' }, readTitle(read.name)),
          h('span', { class: 'raw-meta' }, problem ? tag(problem.text.split(':')[0], problem.tone) : tag('válido', 'ok'))),
        h('div', { class: 'raw-body' },
          read.request ? h('p', { class: 'req' }, 'Pedido serial: ', h('span', { class: 'hex' }, read.request)) : null,
          sentFrame ? h('p', { class: 'req' }, `Quadro XGT enviado${woke ? ' (depois do byte de despertar 00)' : ''}: `, h('span', { class: 'hex' }, toHex(sentFrame))) : null,
          problem && decoded.status === 'invalid' ? h('p', { class: 'error-text' }, problem.text) : null,
          !read.ok
            ? h('p', { class: 'error-text' }, read.error || 'Falhou sem mensagem.')
            : payload.length === 0
              ? h('p', { class: 'req' }, 'Resposta vazia: o firmware não conhece o comando 0xE0.')
              : [h('p', { class: 'req' }, `Resposta: ${payload[0]} byte(s) recebido(s)`), hexGrid(received, read.name === XGT_MODEL_READ.name ? {} : XGT_SHORT_REPLY_LABELS)]));
    })),
  );
}

// --- automatic detection ------------------------------------------------------------------

const PROBE_OUTCOME_PT = {
  match: { text: 'detectada', tone: 'ok' },
  no_match: { text: 'não é', tone: 'muted' },
  unsupported: { text: 'sem o comando', tone: 'warn' },
  error: { text: 'erro', tone: 'bad' },
  skipped: { text: 'não testada', tone: 'muted' },
};

function probeRaw(probe) {
  if (!probe.read) return null;
  const text = probe.read.ok ? (probe.read.response || 'vazia') : 'nenhuma';
  return h('span', { class: 'detect__raw' }, 'resposta: ', h('span', { class: 'hex' }, text));
}

function renderDetection(detection) {
  const title = detection.family ? `Detectado: ${FAMILY_NAMES_PT[detection.family]}` : 'Nenhuma bateria detectada';
  return h('section', { class: 'detect', 'data-found': String(Boolean(detection.family)), 'aria-labelledby': 'detect-title' },
    h('h2', { class: 'detect__title', id: 'detect-title' }, title),
    h('ol', { class: 'detect__probes', 'aria-label': 'Testes, na ordem em que foram feitos' }, detection.probes.map((probe) => {
      const outcome = PROBE_OUTCOME_PT[probe.outcome];
      return h('li', { class: 'detect__probe', 'data-outcome': probe.outcome },
        h('span', { class: 'detect__family' }, probe.family.toUpperCase()),
        tag(outcome.text, outcome.tone),
        h('span', { class: 'detect__detail' }, probe.detail_pt),
        probeRaw(probe));
    })),
    detection.family ? null : h('p', { class: 'panel__note' }, detectionSummaryPt(detection)),
  );
}

function renderAutoWelcome() {
  const steps = [
    'Grave o firmware atual no Arduino (pasta firmware/) e ligue-o pelo USB.',
    'Ligue uma bateria só, pelo chicote da linha dela: LXT no D6 (dados) e D8 (ENABLE); XGT pelo TR, com resistor, no D5; CXT pelos divisores em A0 a A3. Todas usam o GND do Nano.',
    'Clique em “Conectar”, escolha a porta do Arduino e depois em “Ler bateria”: a página descobre a linha e lê.',
  ];
  return h('div', { class: 'welcome welcome--wide' },
    h('h2', {}, 'Nenhuma bateria lida ainda'),
    h('ol', {}, steps.map((step) => h('li', {}, step))),
    h('p', { class: 'muted' }, 'A detecção vai da mais passiva para a que transmite: CXT (0xE1, só mede as entradas analógicas), LXT (0xD0, um pulso de reset no D6) e XGT (0xE0, um pedido de leitura no D5). A primeira que responder é lida e as outras nem são testadas. Uma bateria XGT ainda pede para confirmar a ligação antes da leitura completa.'),
    renderXgtSafety({ compact: true }),
    renderCxtSafety({ compact: true }),
    h('p', { class: 'muted' }, 'Sem o hardware à mão? Use “Abrir dumps…” para ver um dump salvo (LXT, XGT ou CXT), ou abra dois para compará-los. Tudo roda no navegador, sem internet.'),
  );
}

// --- CXT (12V) -----------------------------------------------------------------------------
// Analog read through A0..A3 (spec/cxt.json via cxt-catalog.js); nothing is sent to the pack.

function kiloOhms(ohm) {
  return `${formatNumber(ohm / 1000, 0)} kΩ`;
}

const [CXT_TAP1, CXT_TAP2, CXT_PACK, CXT_NTC_CHANNEL] = CXT_CHANNELS;
const CXT_DIVIDERS = [CXT_TAP1, CXT_TAP2, CXT_PACK];
const CXT_DIAGRAM_NAMES = { tap1: 'tap 1', tap2: 'tap 2', pack: 'pack +' };

function cxtDiagram() {
  const lines = ['Bateria CXT            Arduino'];
  let column = 0;
  for (const channel of CXT_DIVIDERS) {
    const head = `${CXT_DIAGRAM_NAMES[channel.name].padEnd(7)}─[${kiloOhms(channel.r_top_ohm)}]─`;
    column = head.length;
    lines.push(`${head}┬─ ${channel.pin}`);
    lines.push(`${' '.repeat(column)}└─[${kiloOhms(channel.r_bottom_ohm)}]─ GND`);
  }
  lines.push(`${'termistor '.padEnd(column, '─')}┬─ ${CXT_NTC_CHANNEL.pin}`);
  lines.push(`${' '.repeat(column)}└─[${kiloOhms(CXT_NTC_CHANNEL.pullup_ohm)}]─ 5V`);
  lines.push(`${'pack − '.padEnd(column + 3, '─')} GND`);
  return lines.join('\n');
}

function renderCxtSafety({ compact }) {
  const dividers = CXT_DIVIDERS.map((channel) =>
    h('li', {}, `${channel.contact}: ${kiloOhms(channel.r_top_ohm)} até o ${channel.pin} e ${kiloOhms(channel.r_bottom_ohm)} do ${channel.pin} ao GND (divide por ${formatNumber(dividerRatio(channel), 0)}).`));
  const rules = [
    [h('strong', {}, 'Os taps vão direto nas células, sem proteção.'), ' Um curto num tap é corrente sem limite: pontas finas, nada de garra jacaré, e sempre um resistor em série (o de cima de cada divisor faz esse papel; nunca ligue um tap direto num pino).'],
    [h('strong', {}, 'Divisores, com o resistor de baixo na placa:'), h('ul', {}, dividers)],
    [h('strong', {}, `Termistor no ${CXT_NTC_CHANNEL.pin}:`), ` resistor de ${kiloOhms(CXT_NTC_CHANNEL.pullup_ohm)} do 5V do Nano até o ${CXT_NTC_CHANNEL.pin}, e o ${CXT_NTC_CHANNEL.pin} no contato do termistor.`],
    [h('strong', {}, 'GND do Nano no − do pack.')],
    [h('strong', {}, 'Uma bateria por vez.'), ' LXT, XGT e CXT dividem o GND do Nano. Ligue o pack depois que o Nano estiver alimentado pelo USB e desligue-o depois da leitura: os divisores drenam menos de 0,4 mA, sem parar.'],
  ];
  const body = [
    h('ul', { class: 'safety__rules' }, rules.map((rule) => h('li', {}, rule))),
    h('pre', { class: 'safety__diagram', 'aria-label': 'Ligação: tap 1, tap 2 e pack + por divisores até A0, A1 e A2, cada um com o resistor de baixo ao GND; termistor no A3 com 10 kΩ até o 5V; − do pack no GND.' }, cxtDiagram()),
    h('p', { class: 'panel__note' }, 'Pinagem, primeiro experimento com multímetro e perguntas em aberto: docs/cxt.md.'),
  ];
  if (compact) {
    return h('details', { class: 'safety safety--warn safety--compact' },
      h('summary', {}, h('strong', {}, 'Ligação CXT: '), 'divisores 10k/10k, 20k/10k e 30k/10k em A0 a A2, termistor com pull-up de 10 kΩ no A3, GND no − do pack.'),
      h('div', { class: 'safety__body' }, body));
  }
  return h('section', { class: 'safety safety--warn', 'aria-labelledby': 'cxt-safety-title' },
    h('h2', { id: 'cxt-safety-title' }, 'Antes de ligar uma bateria CXT (12V)'),
    h('div', { class: 'safety__body' }, body));
}

function renderCxtWelcome() {
  const steps = [
    'Grave o firmware atual num Uno ou Nano (pasta firmware/): ele tem o comando 0xE1, que lê A0 a A3. O ESP32-C3 não lê CXT.',
    'Monte os divisores do painel acima, alimente o Nano pelo USB e só então encoste os contatos da bateria.',
    'Se tiver multímetro, meça o pino 5V do Nano e digite o valor no campo de calibração que aparece depois da leitura.',
    'Clique em “Conectar”, escolha a porta do Arduino e depois em “Ler bateria”.',
  ];
  return h('div', { class: 'welcome welcome--wide' },
    renderCxtSafety({ compact: false }),
    h('h2', {}, 'Nenhuma bateria CXT lida ainda'),
    h('p', { class: 'muted' }, 'Leitura experimental pelas entradas analógicas: a ligação e as contas vêm da pinagem publicada, sem conferência num pack real.'),
    h('ol', {}, steps.map((step) => h('li', {}, step))),
    h('p', { class: 'muted' }, 'Sem o hardware à mão? Use “Abrir dumps…” para ver um dump CXT salvo, ou abra dois para compará-los. Tudo roda no navegador, sem internet.'),
  );
}

function ntcText(decoded) {
  if (decoded.ntc_state === 'ok') return { value: formatNumber(decoded.temp_c, 1), unit: '°C' };
  return { value: NTC_STATE_PT[decoded.ntc_state], unit: '' };
}

function renderCxtPack(entry) {
  const { dump } = entry;
  const report = buildCxtReport(dump.reads, dump.calibration ?? null);
  const diagnosis = diagnoseCxt(report);
  const decoded = report.decoded?.status === 'ok' ? report.decoded : null;
  return [
    h('p', { class: 'panel__note', style: 'margin:0 0 1rem' }, sourceLine(entry)),
    h('div', { class: 'pack-grid' },
      renderCxtSafety({ compact: true }),
      h('div', { class: 'pack-cols' },
        h('div', { class: 'pack-col' }, renderCxtPlate(decoded, dump), renderCxtCells(decoded, diagnosis)),
        h('div', { class: 'pack-col' }, renderDiagnosis(diagnosis), renderCxtLive(decoded), renderCxtCalibration(entry, report))),
      renderCxtRaw(report),
    ),
  ];
}

function renderCxtPlate(decoded, dump) {
  const seen = decoded?.is_cxt === true;
  const ntc = decoded ? ntcText(decoded) : null;
  const facts = [
    ['Pack', decoded ? formatVolts(decoded.pack_v, 2) : '—'],
    ['Vcc usado', decoded ? formatVolts(decoded.vcc_v, 3) : '—'],
    ['Origem do Vcc', decoded ? (decoded.vcc_source === 'calibration' ? 'medido' : 'bandgap') : '—'],
    ['Termistor', ntc ? `${ntc.value}${ntc.unit ? ` ${ntc.unit}` : ''}` : '—'],
    ['Linha', 'CXT (experimental)'],
    ['Firmware', dump.firmware ?? '—'],
  ];
  return h('section', { class: 'plate area-plate', 'aria-labelledby': 'plate-model' },
    h('div', { class: 'plate__band' },
      h('h2', { class: 'plate__model', id: 'plate-model' }, 'CXT'),
      h('span', { class: 'plate__rating' }, '12V max / 3 células em série'),
      decoded ? h('span', { class: 'plate__lock', 'data-locked': String(!seen) }, seen ? 'Pack reconhecido' : 'Sem pack') : null,
    ),
    h('dl', { class: 'plate__facts' },
      facts.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))),
    ),
  );
}

function renderCxtCells(decoded, diagnosis) {
  const section = (...children) => h('section', { class: 'panel area-cells', 'aria-labelledby': 'cells-title' }, h('h2', { id: 'cells-title' }, 'Células'), children);
  if (!decoded) return section(h('p', {}, 'As tensões não foram lidas: veja o diagnóstico e os bytes brutos.'));
  if (diagnosis.cells.length === 0) {
    return section(
      h('p', {}, 'Nenhum pack CXT reconhecido nas entradas: as células não são classificadas. Valores medidos:'),
      h('div', { class: 'cells-summary' },
        decoded.cells_v.map((volts, index) => readout(`Célula ${index + 1}`, formatNumber(volts, 3), 'V')),
        readout('Pack', formatNumber(decoded.pack_v, 2), 'V')),
    );
  }
  const max = Math.max(...diagnosis.cells.map((cell) => cell.v));
  const min = Math.min(...diagnosis.cells.map((cell) => cell.v));
  return section(
    cellList(diagnosis.cells),
    h('div', { class: 'cells-summary' },
      readout('Pack', formatNumber(decoded.pack_v, 2), 'V'),
      spreadReadouts(diagnosis.spread, max, min)),
    h('p', { class: 'panel__note' }, `Célula 1 = ${CXT_TAP1.pin}, célula 2 = ${CXT_TAP2.pin} − ${CXT_TAP1.pin}, célula 3 = ${CXT_PACK.pin} − ${CXT_TAP2.pin}, já multiplicadas pelos divisores. Barra cheia = 4,2 V; vazia = 2,5 V. Julgue o equilíbrio com a bateria quase descarregada. No BL1041B (3S2P) cada “célula” é um par em paralelo.`),
  );
}

function renderCxtLive(decoded) {
  const items = [];
  if (decoded) {
    const ntc = ntcText(decoded);
    items.push(
      readout('Pack', formatNumber(decoded.pack_v, 2), 'V'),
      readout('Tap 1', formatNumber(decoded.tap_v[0], 3), 'V'),
      readout('Tap 2', formatNumber(decoded.tap_v[1], 3), 'V'),
      readout('Termistor', ntc.value, ntc.unit),
      readout(`Tensão no ${CXT_NTC_CHANNEL.pin}`, formatNumber(decoded.ntc_v, 3), 'V'),
      readout(decoded.vcc_source === 'calibration' ? 'Vcc (medido)' : 'Vcc (bandgap)', formatNumber(decoded.vcc_v, 3), 'V'),
    );
  }
  return h('section', { class: 'panel area-live', 'aria-labelledby': 'live-title' },
    h('h2', { id: 'live-title' }, 'Medições'),
    items.length ? h('div', { class: 'readouts' }, items) : h('p', {}, 'Sem medições nesta leitura.'),
    h('p', { class: 'panel__note' }, `Temperatura pelo NTC de ${kiloOhms(CXT_NTC.r25_ohm)} e β ${CXT_NTC.beta} presumido (confiança ${CXT_NTC.confidence}): o único relato medido não bate com esse modelo, então a temperatura pode errar alguns graus até medirmos um pack real.`),
  );
}

function renderCxtCalibration(entry, report) {
  const decoded = report.decoded?.status === 'ok' ? report.decoded : null;
  const [min, max] = CXT_CALIBRATION_MV;
  const inUse = decoded
    ? `Em uso: ${formatVolts(decoded.vcc_v, 3)} (${VCC_SOURCE_PT[decoded.vcc_source]}).${decoded.bandgap_vcc_v !== null && decoded.vcc_source === 'calibration' ? ` O bandgap estimaria ${formatVolts(decoded.bandgap_vcc_v, 3)}.` : ''}`
    : 'Sem leitura para recalcular.';
  const input = h('input', {
    type: 'number', id: 'cxt-vcc', inputmode: 'numeric', min: String(min), max: String(max), step: '1', placeholder: 'ex.: 4950',
    value: report.calibrationVccMv === null ? null : String(report.calibrationVccMv),
    onchange: (event) => applyCalibration(event.target.value),
  });
  return h('section', { class: 'panel area-calib', 'aria-labelledby': 'calib-title' },
    h('h2', { id: 'calib-title' }, 'Calibração do Vcc'),
    h('p', {}, 'O ADC mede em relação ao 5V do Nano, que pelo USB costuma ficar entre 4,6 e 5,1 V. Sem calibração, o Vcc é estimado pela referência interna de 1,1 V, que varia cerca de 10 % de um chip para outro.'),
    h('div', { class: 'calib' },
      h('label', { for: 'cxt-vcc' }, 'Vcc medido no pino 5V (mV)'),
      h('div', { class: 'calib__row' },
        input,
        h('button', { type: 'button', class: 'btn', onclick: () => applyCalibration(''), disabled: report.calibrationVccMv === null }, 'Limpar'))),
    h('p', { class: 'calib__status', role: 'status' }, inUse),
    h('p', { class: 'panel__note' }, `Meça entre o pino 5V e o GND do Nano com um multímetro, com o USB ligado, e digite em milivolts (${min} a ${max}). O valor fica guardado neste navegador para as próximas leituras CXT, recalcula esta leitura e vai no dump salvo (campo calibration).`),
  );
}

function applyCalibration(text) {
  const trimmed = String(text).trim();
  const [min, max] = CXT_CALIBRATION_MV;
  let vccMv = null;
  if (trimmed !== '') {
    vccMv = Number(trimmed);
    if (!Number.isInteger(vccMv) || vccMv < min || vccMv > max) {
      setProgress(`Vcc medido inválido: “${trimmed}”. Use milivolts inteiros entre ${min} e ${max} (por exemplo 4950).`, true);
      renderPack();
      return;
    }
  }
  state.calibrationMv = vccMv;
  saveCalibration();
  const entry = currentEntry();
  if (entry && isCxtDump(entry.dump)) entry.dump = withCalibration(entry.dump, currentCalibration());
  setProgress(vccMv === null ? 'Calibração removida: o Vcc volta a ser estimado pelo bandgap.' : `Vcc medido de ${formatVolts(vccMv / 1000, 3)} aplicado.`);
  renderAll();
}

function loadCalibration() {
  let saved = null;
  try {
    saved = localStorage.getItem(CALIBRATION_STORAGE_KEY);
  } catch {
    // Storage blocked: the calibration just isn't remembered between visits.
  }
  const value = saved === null ? NaN : Number(saved);
  const [min, max] = CXT_CALIBRATION_MV;
  state.calibrationMv = Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function saveCalibration() {
  try {
    if (state.calibrationMv === null) localStorage.removeItem(CALIBRATION_STORAGE_KEY);
    else localStorage.setItem(CALIBRATION_STORAGE_KEY, String(state.calibrationMv));
  } catch {
    // See loadCalibration.
  }
}

// Byte roles in the E1 payload.
const CXT_PAYLOAD_LABELS = Object.fromEntries([
  [0, 'amostras'],
  ...[...CXT_CHANNELS.map((channel) => `soma do ${channel.pin}`), 'soma do bandgap'].flatMap((label, index) => [
    [1 + 2 * index, `${label}, byte baixo`],
    [2 + 2 * index, `${label}, byte alto`],
  ]),
]);

function cxtChannelRows(decoded) {
  const pinV = (sum) => (sum / decoded.samples) * decoded.vcc_v / CXT_ADC.full_scale;
  const rows = CXT_CHANNELS.map((channel, index) => {
    const sum = decoded.sums[index];
    const divided = channel.r_top_ohm !== undefined;
    const value = divided ? decoded.tap_v[index] : decoded.ntc_v;
    return h('tr', {},
      h('th', { scope: 'row' }, `${channel.pin} (${channel.contact})`),
      h('td', { class: 'num' }, String(sum)),
      h('td', { class: 'num' }, formatNumber(sum / decoded.samples, 1)),
      h('td', { class: 'num' }, formatNumber(pinV(sum), 3)),
      h('td', { class: 'num' }, divided ? `× ${formatNumber(dividerRatio(channel), 0)}` : '—'),
      h('td', { class: 'num' }, formatNumber(value, 3)));
  });
  const bandgap = decoded.sums[CXT_CHANNELS.length];
  rows.push(h('tr', {},
    h('th', { scope: 'row' }, `Bandgap interno (${formatNumber(CXT_ADC.bandgap_v, 1)} V)`),
    h('td', { class: 'num' }, String(bandgap)),
    h('td', { class: 'num' }, formatNumber(bandgap / decoded.samples, 1)),
    h('td', { class: 'num' }, '—'),
    h('td', { class: 'num' }, '—'),
    h('td', { class: 'num' }, decoded.bandgap_vcc_v === null ? '—' : `Vcc ${formatNumber(decoded.bandgap_vcc_v, 3)}`)));
  return rows;
}

function renderCxtRaw(report) {
  const { read, decoded } = report;
  const body = [];
  if (read) {
    const payload = read.ok ? fromHex(read.response) : new Uint8Array(0);
    if (read.request) body.push(h('p', { class: 'req' }, 'Pedido serial: ', h('span', { class: 'hex' }, read.request)));
    if (!read.ok) body.push(h('p', { class: 'error-text' }, read.error || 'Falhou sem mensagem.'));
    else if (payload.length === 0) body.push(h('p', { class: 'req' }, `Resposta vazia: ${CXT_NO_COMMAND_PT}.`));
    else body.push(hexGrid(payload, CXT_PAYLOAD_LABELS));
    if (decoded?.status === 'invalid') body.push(h('p', { class: 'error-text' }, decoded.detail));
    if (decoded?.status === 'ok') {
      body.push(h('div', { class: 'table-wrap' }, h('table', {},
        h('caption', {}, `${decoded.samples} amostras por canal; Vcc ${formatNumber(decoded.vcc_v, 3)} V (${VCC_SOURCE_PT[decoded.vcc_source]}), ADC de ${CXT_ADC.bits} bits.`),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Canal'), h('th', { scope: 'col', class: 'num' }, 'Soma'), h('th', { scope: 'col', class: 'num' }, 'Média'),
          h('th', { scope: 'col', class: 'num' }, 'No pino (V)'), h('th', { scope: 'col', class: 'num' }, 'Divisor'), h('th', { scope: 'col', class: 'num' }, 'Tensão (V)'))),
        h('tbody', {}, cxtChannelRows(decoded)))));
    }
  }
  return h('section', { class: 'panel area-raw', 'aria-labelledby': 'raw-title' },
    h('h2', { id: 'raw-title' }, 'Bytes brutos'),
    h('p', { class: 'panel__note', style: 'margin:0 0 0.75rem' }, 'Pedido = quadro serial completo (01, tamanho, rsp_len, E1, amostras). Resposta = amostras + somas de 16 bits (little-endian) de A0, A1, A2, A3 e do bandgap; as contas ficam aqui no navegador.'),
    read ? h('details', { class: 'raw-item', open: true },
      h('summary', {},
        h('span', { class: 'raw-name' }, read.name),
        h('span', { class: 'raw-title' }, readTitle(read.name)),
        h('span', { class: 'raw-meta' }, read.ok ? `${fromHex(read.response).length} bytes` : 'erro')),
      h('div', { class: 'raw-body' }, body)) : h('p', {}, 'Este dump não tem a leitura cxt_adc.'),
  );
}

// CXT has no identifier stored in the pack: only the dump label can say it is the same one.
function cxtPackNote(dumpA, dumpB) {
  const labelA = String(dumpA.label ?? '').trim();
  const labelB = String(dumpB.label ?? '').trim();
  if (labelA !== '' && labelA !== 'bateria' && labelA === labelB) {
    return h('p', { class: 'verdict', 'data-sev': 'info' }, h('span', { class: 'sev-dot', 'aria-hidden': 'true' }), `Mesmo nome de dump: “${labelA}”. A CXT não tem identificador gravado; só o nome diz que é o mesmo pack.`);
  }
  return h('div', { class: 'notice notice--warn', style: 'margin:0 0 1rem' },
    h('p', {}, `A CXT não tem identificador gravado (nem ROM, nem modelo): o pack só é reconhecido pelo nome dado ao dump. A = “${labelA}”, B = “${labelB}”.`));
}

// --- tabs ----------------------------------------------------------------------------------

function selectTab(tab) {
  for (const candidate of document.querySelectorAll('[role="tab"]')) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    $(candidate.getAttribute('aria-controls')).hidden = !selected;
  }
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });
}

// --- boot ----------------------------------------------------------------------------------

function init() {
  setupTabs();
  setupFamily();
  loadCalibration();
  if (!isWebSerialSupported()) $('serial-unsupported').hidden = false;
  $('btn-connect').addEventListener('click', () => exclusive('Conectando…', () => (state.link ? disconnect() : connect())));
  $('btn-read').addEventListener('click', () => exclusive('Lendo a bateria…', readPack));
  $('btn-testmode').addEventListener('click', () => exclusive('Aguardando confirmação…', readPackInTestMode));
  $('btn-unlock').addEventListener('click', () => exclusive('Aguardando confirmação…', unlockPack));
  $('btn-save').addEventListener('click', saveDump);
  $('btn-open').addEventListener('click', () => $('file-open').click());
  $('file-open').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = ''; // lets the same file be opened again
    if (files.length) exclusive('Abrindo dumps…', () => openDumps(files));
  });
  $('compare-a').addEventListener('change', renderCompare);
  $('compare-b').addEventListener('change', renderCompare);
  if (isWebSerialSupported()) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (state.transport?.port !== event.target) return;
      dropLink();
      setProgress('O Arduino foi desconectado do USB.', true);
    });
  }
  renderAll();
}

init();
