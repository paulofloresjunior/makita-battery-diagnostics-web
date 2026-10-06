// Own copy of the tables in spec/xgt.json (Makita XGT, 40V max). Same shape as the spec (hex
// strings, same keys) so tests/xgt-catalog.test.mjs can compare them field by field; the site is
// served from web/ and can't read the spec itself. Every fact comes from other projects and is
// still unconfirmed on our packs: see docs/xgt.md for sources and confidence levels.

export const XGT_STATUS = 'experimental';

export const XGT_WIRING = Object.freeze({
  needed: Object.freeze(['TR', 'B-']),
  never_to_board: Object.freeze(['B+', 'DT', 'DS', 'CS']),
  avr_pin: 'D5',
  esp32c3_pin: 'GPIO3 (build flag ESP_XGT_PIN)',
  series_resistor_ohm: Object.freeze([1000, 4700]),
  voltages: Object.freeze({
    pack_v: Object.freeze([30, 42]),
    dt_v_full: 34.3,
    tr_genuine_max_v: 5,
    tr_clone_seen_v: 33,
  }),
});

export const XGT_FIRMWARE_COMMAND = Object.freeze({
  cmd: 'E0',
  flag_wake: 0x01,
  max_received: 252,
  rx_total_max_ms: 1500,
});

export const XGT_WAKE = Object.freeze({ byte: '00', wait_ms: 100 });

export const XGT_SHORT_FRAME = Object.freeze({
  length: 8,
  reply_time_ms: 10,
  suggested_timeout_ms: 50,
});

export const XGT_REGISTERS = Object.freeze([
  { name: 'xgt_cycles', label_pt: 'Ciclos de carga', frame: 'CC 13 C0 00 54 00 00 33', cmd: 'C0', args: '00 54', decode: 'u16le(reply[4:6])', unit: 'count', confidence: 'B' },
  { name: 'xgt_lockout', label_pt: 'Trava (lockout)', frame: 'CC 1F C0 00 60 00 00 33', cmd: 'C0', args: '00 60', decode: 'reply[4]; 0 = not locked, other = locked', unit: 'flag', confidence: 'B' },
  { name: 'xgt_capacity', label_pt: 'Capacidade', frame: 'CC 23 C0 00 64 00 00 33', cmd: 'C0', args: '00 64', decode: 'u16le(reply[4:6])', unit: 'mAh', confidence: 'C' },
  { name: 'xgt_charge', label_pt: 'Estado de carga', frame: 'CC C8 C0 01 08 00 00 33', cmd: 'C0', args: '01 08', decode: 'u16le(reply[4:6]) / 255', unit: '%', confidence: 'B' },
  { name: 'xgt_temp1', label_pt: 'Temperatura 1', frame: 'CC DC C0 03 1A 00 00 33', cmd: 'C0', args: '03 1A', decode: 'u16le(reply[4:6]) / 10 - 273.15', unit: '°C', confidence: 'B' },
  { name: 'xgt_temp2', label_pt: 'Temperatura 2', frame: 'CC DE C0 03 1C 00 00 33', cmd: 'C0', args: '03 1C', decode: 'u16le(reply[4:6]) / 10 - 273.15', unit: '°C', confidence: 'B' },
  { name: 'xgt_pack_voltage', label_pt: 'Tensão do pack', frame: 'CC C2 C0 03 00 00 00 33', cmd: 'C0', args: '03 00', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell1', label_pt: 'Célula 1', frame: 'CC C4 C0 03 02 00 00 33', cmd: 'C0', args: '03 02', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell2', label_pt: 'Célula 2', frame: 'CC C6 C0 03 04 00 00 33', cmd: 'C0', args: '03 04', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell3', label_pt: 'Célula 3', frame: 'CC C8 C0 03 06 00 00 33', cmd: 'C0', args: '03 06', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell4', label_pt: 'Célula 4', frame: 'CC CA C0 03 08 00 00 33', cmd: 'C0', args: '03 08', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell5', label_pt: 'Célula 5', frame: 'CC CC C0 03 0A 00 00 33', cmd: 'C0', args: '03 0A', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell6', label_pt: 'Célula 6', frame: 'CC CE C0 03 0C 00 00 33', cmd: 'C0', args: '03 0C', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell7', label_pt: 'Célula 7', frame: 'CC D0 C0 03 0E 00 00 33', cmd: 'C0', args: '03 0E', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell8', label_pt: 'Célula 8', frame: 'CC D2 C0 03 10 00 00 33', cmd: 'C0', args: '03 10', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell9', label_pt: 'Célula 9', frame: 'CC D4 C0 03 12 00 00 33', cmd: 'C0', args: '03 12', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell10', label_pt: 'Célula 10', frame: 'CC D6 C0 03 14 00 00 33', cmd: 'C0', args: '03 14', decode: 'u16le(reply[4:6]) / 1000', unit: 'V', confidence: 'B' },
  { name: 'xgt_cell_capacity', label_pt: 'Capacidade nominal da célula', frame: 'CC E4 DD 08 00 00 00 33', cmd: 'DD', args: '08', decode: 'reply[5] * 100', unit: 'mAh', confidence: 'B' },
  { name: 'xgt_pack_config', label_pt: 'Configuração do pack', frame: 'CC E6 DD 0A 00 00 00 33', cmd: 'DD', args: '0A', decode: 'parallel = reply[4]; series = reply[5]', unit: 'cells', confidence: 'B' },
  { name: 'xgt_temp_hist0', label_pt: 'Histograma de temperatura, faixas 1 e 2', frame: 'CC 7F C0 00 C0 00 00 33', cmd: 'C0', args: '00 C0', decode: 'bin1 = reply[4]; bin2 = reply[5]', unit: 'count', confidence: 'C' },
  { name: 'xgt_temp_hist1', label_pt: 'Histograma de temperatura, faixas 3 e 4', frame: 'CC 81 C0 00 C2 00 00 33', cmd: 'C0', args: '00 C2', decode: 'bin3 = reply[4]; bin4 = reply[5]', unit: 'count', confidence: 'C' },
  { name: 'xgt_temp_hist2', label_pt: 'Histograma de temperatura, faixas 5 e 6', frame: 'CC 83 C0 00 C4 00 00 33', cmd: 'C0', args: '00 C4', decode: 'bin5 = reply[4]; bin6 = reply[5]', unit: 'count', confidence: 'C' },
  { name: 'xgt_current_hist0', label_pt: 'Histograma de corrente, faixas 1 e 2', frame: 'CC 97 C0 00 D8 00 00 33', cmd: 'C0', args: '00 D8', decode: 'bin1 = reply[4]; bin2 = reply[5]', unit: 'count', confidence: 'A' },
  { name: 'xgt_current_hist1', label_pt: 'Histograma de corrente, faixas 3 e 4', frame: 'CC 99 C0 00 DA 00 00 33', cmd: 'C0', args: '00 DA', decode: 'bin3 = reply[4]; bin4 = reply[5]', unit: 'count', confidence: 'B' },
  { name: 'xgt_current_hist2', label_pt: 'Histograma de corrente, faixas 5 e 6', frame: 'CC 9B C0 00 DC 00 00 33', cmd: 'C0', args: '00 DC', decode: 'bin5 = reply[4]; bin6 = reply[5]', unit: 'count', confidence: 'B' },
].map(Object.freeze));

// Long-frame (A5 A5) commands. Only `read` ones may ever be sent; the host sends just xgt_model.
export const XGT_LONG_COMMANDS = Object.freeze([
  { id: '1200', reply: 'B200', kind: 'write' },
  { id: '1201', reply: '3201', kind: 'read' },
  { id: '1203', reply: '3203', kind: 'read' },
  { id: '1204', reply: 'B204', kind: 'write' },
  { id: '1205', reply: '3205', kind: 'read' },
  { id: '1206', reply: 'B206', kind: 'write' },
  { id: '120C', reply: 'B20C', kind: 'write' },
  { id: '120D', reply: '320D', kind: 'read' },
  { id: '1300', reply: 'B300', kind: 'write' },
  { id: '1302', reply: '3302', kind: 'read' },
  { id: '1304', reply: '3304', kind: 'read' },
  { id: '1306', reply: 'B306', kind: 'write' },
  { id: '1307', reply: '3307', kind: 'read' },
].map(Object.freeze));

// Value length (bytes) per long-frame parameter id: replies don't say how long each value is.
export const XGT_LONG_PARAM_LEN = Object.freeze({
  1201: 2, 1202: 8, 1203: 4, 1204: 2, 1205: 2, 1206: 2, 1207: 2, 1208: 2, 1209: 2,
  '120A': 4, '120B': 4, '120C': 2, '120D': 2, '120E': 2, '120F': 2, 1210: 2,
  1301: 2, 1302: 2, 1303: 2, 1304: 2, 1306: 2, 1307: 2, 1308: 2, 1309: 2,
  '130A': 2, '130B': 8, '130C': 1, '130D': 2, '130E': 4, '130F': 46, 1310: 2, 1311: 2,
  2102: 8, 3104: 8,
});

// Parameters that hold a model name as reversed ASCII.
export const XGT_MODEL_PARAMS = Object.freeze(['130B', '1202']);

export const XGT_MODEL_READ = Object.freeze({
  name: 'xgt_model',
  label_pt: 'Modelo',
  frame: 'A5 A5 00 1A 50 2B 4D 4C 00 CB 13 07 00 06 00 03 00 01 13 0B 02 3B FF FF FF FF FF FF FF FF FF FF',
  rsp_len: 33,
  confidence: 'B',
});

export const XGT_STEP_NAMES = Object.freeze([XGT_MODEL_READ.name, ...XGT_REGISTERS.map((register) => register.name)]);

// Documented in spec/xgt.json and docs/xgt.md, refused by xgt-protocol.assertReadOnlyFrame.
export const XGT_NOT_IMPLEMENTED_WRITES = Object.freeze([
  { name: 'lockout_reset', frames: Object.freeze(['CC 13 D9 96 A5 00 00 33', 'CC 00 D2 2F 00 00 00 33']) },
  { name: 'full_calibration_reset', frames: Object.freeze(['CC DD DE 00 00 00 00 33', 'CC E0 DF 01 01 00 00 33', 'CC D1 D2 00 00 00 00 33']) },
].map(Object.freeze));

// Short-frame commands that only read (register read, pack info).
export const XGT_READ_COMMANDS = Object.freeze(['C0', 'DD']);

// Host-side policy, not in the spec: m5din retries up to 16 times, twaymouth twice; 3 attempts
// keep a silent pack from stalling the UI for long.
export const XGT_ATTEMPTS = 3;
// The model reply is 32 bytes; the docs' first experiment uses 100 ms for it.
export const XGT_LONG_TIMEOUT_MS = 100;

const STEP_BY_NAME = new Map([[XGT_MODEL_READ.name, XGT_MODEL_READ], ...XGT_REGISTERS.map((register) => [register.name, register])]);

export function findXgtStep(name) {
  return STEP_BY_NAME.get(name) ?? null;
}

export function isXgtReadName(name) {
  return typeof name === 'string' && name.startsWith('xgt_');
}
