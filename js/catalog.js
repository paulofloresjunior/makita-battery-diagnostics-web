// Own copy of the tables in spec/protocol.json. Kept in the spec's shape (hex strings, same
// keys) so tests/catalog.test.mjs can compare them field by field; the browser can't read
// files outside web/ when served from it, which is why the site doesn't load the spec itself.

export const SERIAL = Object.freeze({
  baud: 9600,
  boot_wait_ms: 2000,
  response_timeout_ms: 3000,
  max_payload: 253,
});

export const CMD = Object.freeze({
  VERSION: 0x01,
  WITH_ROM: 0x33,
  SKIP_ROM: 0xcc,
  DEBUG_RAW: 0xd0,
  SESSION: 0xd1,
});

export const READS = Object.freeze([
  { name: 'lxt_msg', cmd: '33', data: 'AA 00', rsp_len: 40, group: 'standard' },
  { name: 'lxt_model', cmd: 'CC', data: 'DC 0C', rsp_len: 16, group: 'standard' },
  { name: 'lxt_data', cmd: 'CC', data: 'D7 00 00 FF', rsp_len: 29, group: 'standard' },
  { name: 'f0513_model', cmd: '31', data: '', rsp_len: 2, group: 'f0513' },
  { name: 'f0513_version', cmd: '32', data: '', rsp_len: 2, group: 'f0513' },
  { name: 'f0513_vcell1', cmd: 'CC', data: '31', rsp_len: 2, group: 'f0513' },
  { name: 'f0513_vcell2', cmd: 'CC', data: '32', rsp_len: 2, group: 'f0513' },
  { name: 'f0513_vcell3', cmd: 'CC', data: '33', rsp_len: 2, group: 'f0513' },
  { name: 'f0513_vcell4', cmd: 'CC', data: '34', rsp_len: 2, group: 'f0513' },
  { name: 'f0513_vcell5', cmd: 'CC', data: '35', rsp_len: 2, group: 'f0513' },
  { name: 'f0513_temp', cmd: 'CC', data: '52', rsp_len: 2, group: 'f0513' },
  { name: 'type0_id', cmd: 'CC', data: 'DC 0B', rsp_len: 17, group: 'memory' },
  { name: 'type3_id', cmd: 'CC', data: 'D4 2C 00 02', rsp_len: 3, group: 'memory' },
  { name: 'd4_assembly_date', cmd: 'CC', data: 'D4 00 00 03', rsp_len: 4, group: 'memory' },
  { name: 'd4_0150', cmd: 'CC', data: 'D4 50 01 02', rsp_len: 3, group: 'memory' },
  { name: 'd4_od_events', cmd: 'CC', data: 'D4 BA 00 01', rsp_len: 2, group: 'memory' },
  { name: 'd4_overload', cmd: 'CC', data: 'D4 8D 00 07', rsp_len: 8, group: 'memory' },
  { name: 'd7_charge_level', cmd: 'CC', data: 'D7 19 00 04', rsp_len: 5, group: 'memory' },
  { name: 'd7_current', cmd: 'CC', data: 'D7 61 03 02', rsp_len: 3, group: 'memory' },
  { name: 'lxt_data_ext', cmd: 'CC', data: 'D7 00 00 FF', rsp_len: 112, group: 'memory' },
]);

// Short pt-BR description per read, shown next to the raw bytes.
export const READ_TITLES_PT = Object.freeze({
  lxt_msg: 'ROM + mensagem de 32 bytes',
  lxt_model: 'Modelo (ASCII)',
  lxt_data: 'Tensões, temperaturas e carga',
  f0513_model: 'Modelo (chip F0513)',
  f0513_version: 'Versão (chip F0513)',
  f0513_vcell1: 'Célula 1 (F0513)',
  f0513_vcell2: 'Célula 2 (F0513)',
  f0513_vcell3: 'Célula 3 (F0513)',
  f0513_vcell4: 'Célula 4 (F0513)',
  f0513_vcell5: 'Célula 5 (F0513)',
  f0513_temp: 'Temperatura (F0513)',
  type0_id: 'Identificação BMS tipo 0',
  type3_id: 'Identificação BMS tipo 3',
  d4_assembly_date: 'Data de montagem',
  d4_0150: 'Capacidade estimada pelo BMS (D4 0x150)',
  d4_od_events: 'Eventos de sobredescarga',
  d4_overload: 'Contadores de sobrecarga',
  d7_charge_level: 'Contador coulomb',
  d7_current: 'Corrente média (não verificado)',
  lxt_data_ext: 'Bloco de dados estendido',
});

// spec read_plan: every regular command raises ENABLE and waits 400 ms, so the LXT read groups
// these reads in one 0xD1 session (in this order, gap_ms before each read after the first) and
// pays the wake-up once.
// lxt_data_ext (112 bytes) doesn't fit next to them and goes as a regular command; the f0513
// group is read only on F0513 chips or when lxt_msg didn't answer.
export const READ_PLAN = Object.freeze({
  session: Object.freeze([
    'lxt_msg', 'lxt_data', 'lxt_model',
    'type0_id', 'type3_id', 'd4_assembly_date', 'd4_0150', 'd4_od_events', 'd4_overload', 'd7_charge_level', 'd7_current',
  ]),
  // Pause before each read after the first: a read that takes fewer bytes than the BMS sends
  // leaves it busy, and on a real BL1840B the next read came back as garbage without it.
  gap_ms: 20,
  after_session: Object.freeze(['lxt_data_ext']),
  f0513_group: 'f0513',
  session_payload_len: 142,
});

export const TESTMODE = Object.freeze({
  enter: 'CC D9 96 A5',
  exit: 'CC D9 FF FF',
  enter_settle_ms: 20,
  gap_ms: 30,
  skip: Object.freeze(['lxt_data_ext']),
  prefix: 'tm_',
});

export const CLEAR_ERRORS = Object.freeze({
  steps: Object.freeze([
    { cmd: '33', data: 'D9 96 A5', rsp_len: 9 },
    { cmd: '33', data: 'DA 04', rsp_len: 9 },
  ]),
});

export const MSG_OFFSET = 8;
export const MSG_LEN = 32;

export const CHECKSUMS = Object.freeze([
  { name: 'CS0', first: 0, last: 15, stored_at: 41, primary: true },
  { name: 'CS1', first: 16, last: 31, stored_at: 42, primary: true },
  { name: 'CS2', first: 32, last: 40, stored_at: 43, primary: true },
  { name: 'AUX0', first: 44, last: 47, stored_at: 62, primary: false },
  { name: 'AUX1', first: 48, last: 61, stored_at: 63, primary: false },
]);

export const NYBBLE = Object.freeze({
  CHARGER_LOCK: 34,
  FAILURE_CODE: 40,
  DAMAGE_RATING: 46,
  CHARGE_COUNT: 52,
  SECOND_COUNTER: 56,
});

// Message flags byte (nibble_swap(msg[17])) -> cell count, rosvall's thresholds; failure
// code 5 is only a warning (BTC04 calls the pack dead when the code is neither 0 nor 5).
export const MSG_FLAGS = Object.freeze({
  BYTE: 17,
  FOUR_CELL_MAX: 12,
  FIVE_CELL_MAX: 29,
  TYPE6: 0x1e,
});
export const FAILURE_CODE_WARNING = 5;
export const FAILURE_SEVERITY_PT = Object.freeze({ ok: 'sem falha', aviso: 'aviso (não trava)', travada: 'trava' });

// lxt_data bytes 25-28: coulomb counter, 2880 counts per mAh (same memory as D7 19 00 04).
export const COUNTS_PER_MAH = 2880;

// lxt_data temperature sensors @14 and @16 (drakosha's labels; unconfirmed hypothesis).
export const TEMP_LABELS_PT = Object.freeze(['células?', 'placa/MOSFET?']);

export const LOCK_CAUSES_PT = Object.freeze({
  failure_code: 'Código de falha diferente de 0 e de 5',
  inverted_checksums: 'CS0, CS1 e CS2 gravados invertidos (trava do BMS)',
  checksum_mismatch: 'Checksum não confere',
  charger_lock: 'Nybble 34 diferente de zero (carregadores recusam)',
});

// Keys are lxt_msg payload offsets (ROM included), as in the spec.
export const BYTE_LABELS_PT = Object.freeze({
  0: 'data de fabricação', 1: 'data de fabricação', 2: 'data de fabricação',
  6: 'número de série', 7: 'número de série',
  16: 'regravado na carga/desbloqueio', 17: 'regravado na carga/desbloqueio',
  24: 'capacidade', 25: 'flags (nº de células; 0x1E = tipo 6); nybble baixo = trava de carregador',
  27: 'código do modelo', 28: 'código de falha + CS0', 29: 'CS1 + CS2',
  31: 'índice de dano', 32: 'índice de sobredescarga', 33: 'índice de sobrecarga',
  34: 'contador de cargas', 35: 'contador de cargas',
  36: 'segundo contador', 37: 'segundo contador',
  38: 'regravado na carga', 39: 'AUX0 + AUX1',
});

export const ACK = 0x06;

export const DIAGNOSIS = Object.freeze({
  cell_dead_v: 2.0,
  cell_deep_discharge_v: 2.5,
  cell_low_v: 3.0,
  open_sense_cell_v: 0.5,
  open_sense_pack_v: 10,
  spread_warn_v: 0.15,
  spread_bad_v: 0.3,
  temp_plausible_c: Object.freeze([-20, 80]),
  temp_sensor_diverge_c: 10,
  // The prompt's 4-cell rule: cell 5 < 0.1 V while every other cell is above 1 V.
  four_cell_absent_v: 0.1,
  four_cell_others_v: 1.0,
});

export const DUMP_FORMAT = Object.freeze({ format: 'mbd-dump', version: 1 });

export const TOOL_NAME = 'mbd-web 0.1.0';

const READ_BY_NAME = new Map(READS.map((read) => [read.name, read]));

export function findRead(name) {
  return READ_BY_NAME.get(name) ?? null;
}
