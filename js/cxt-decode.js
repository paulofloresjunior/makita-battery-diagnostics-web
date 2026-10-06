// Decoder for the CXT ADC read (cmd 0xE1, step cxt_adc). The firmware only sums raw ADC counts;
// Vcc, divider ratios, cell maths and the NTC conversion all happen here, from spec/cxt.json.
// Fed the raw payload stored in the dump plus the dump-level calibration, never stored decodes.

import { fromHex, round, u16le } from './bytes.js';
import { CXT_ADC, CXT_CALIBRATION_MV, CXT_CHANNELS, CXT_DETECTION, CXT_FIRMWARE_COMMAND, CXT_NTC, CXT_STEP_NAME, isCxtReadName } from './cxt-catalog.js';

const KELVIN_25C = 298.15;
const KELVIN_OFFSET = 273.15;
const ADC_MAX_COUNT = CXT_ADC.full_scale - 1;
const SUM_COUNT = 5; // A0..A3 + bandgap

// Shown wherever an empty E1 payload ends up: the reader, the diagnosis, the detection strip.
export const CXT_NO_COMMAND_PT = 'firmware sem o comando 0xE1 ou placa ESP32-C3';

const [tapOne, tapTwo, packChannel, ntcChannel] = CXT_CHANNELS;

export function dividerRatio(channel) {
  return (channel.r_top_ohm + channel.r_bottom_ohm) / channel.r_bottom_ohm;
}

/**
 * Measured Vcc in mV from a dump's top-level `calibration`, or null when absent. Throws on a
 * malformed value so dump.js can reject the file instead of silently decoding with the bandgap.
 */
export function calibrationVccMv(calibration) {
  if (calibration === null || calibration === undefined) return null;
  const vccMv = calibration.vcc_mv;
  if (vccMv === null || vccMv === undefined) return null;
  const [min, max] = CXT_CALIBRATION_MV;
  if (!Number.isInteger(vccMv) || vccMv < min || vccMv > max) {
    throw new RangeError(`calibration.vcc_mv=${JSON.stringify(vccMv)}; expected an integer ${min}..${max} (mV measured at the Nano 5V pin)`);
  }
  return vccMv;
}

function invalid(error, detail) {
  return { status: 'invalid', error, detail };
}

function ntcState(volts, vccV) {
  if (volts >= CXT_NTC.open_fraction * vccV) return 'open';
  if (volts <= CXT_NTC.short_fraction * vccV) return 'short';
  return 'ok';
}

function ntcCelsius(volts, vccV) {
  const resistance = ntcChannel.pullup_ohm * volts / (vccV - volts);
  return 1 / (1 / KELVIN_25C + Math.log(resistance / CXT_NTC.r25_ohm) / CXT_NTC.beta) - KELVIN_OFFSET;
}

function inRange(value, [min, max]) {
  return value >= min && value <= max;
}

/**
 * First spec detection_as_cxt criterion that fails, or null when the reading looks like a CXT:
 * 'pack_range' (pack outside pack_v), 'tap_order' (not 0 < tap1 < tap2 < pack) or 'cell_range'
 * (a cell outside cell_v, with its index).
 */
export function cxtCriteriaFailure(tapV, cellsV) {
  const [tap1, tap2, pack] = tapV;
  if (!inRange(pack, CXT_DETECTION.pack_v)) return { criterion: 'pack_range' };
  if (!(tap1 > 0 && tap1 < tap2 && tap2 < pack)) return { criterion: 'tap_order' };
  const cell = cellsV.findIndex((volts) => !inRange(volts, CXT_DETECTION.cell_v));
  if (cell >= 0) return { criterion: 'cell_range', cell };
  return null;
}

export function looksLikeCxt(tapV, cellsV) {
  return cxtCriteriaFailure(tapV, cellsV) === null;
}

/**
 * Decodes an E1 payload: [samples, sum_A0, sum_A1, sum_A2, sum_A3, sum_bandgap] (u16le sums).
 * @param {Uint8Array} payload
 * @param {{vccMv?: number|null}} options  measured Vcc; overrides the bandgap estimate
 * @returns {{status: 'ok'|'no_command'|'invalid', ...}}
 */
export function decodeCxtPayload(payload, { vccMv = null } = {}) {
  if (payload.length === 0) return { status: 'no_command', error: CXT_NO_COMMAND_PT };
  if (payload.length !== CXT_FIRMWARE_COMMAND.payload_len) {
    return invalid('length', `${payload.length} bytes; expected ${CXT_FIRMWARE_COMMAND.payload_len}`);
  }
  const samples = payload[0];
  const [minSamples, maxSamples] = CXT_FIRMWARE_COMMAND.samples_range;
  if (samples < minSamples || samples > maxSamples) {
    return invalid('samples', `samples=${samples}; expected ${minSamples}..${maxSamples}`);
  }
  const sums = Array.from({ length: SUM_COUNT }, (_, index) => u16le(payload, 1 + 2 * index));
  const overflow = sums.findIndex((sum) => sum > samples * ADC_MAX_COUNT);
  if (overflow >= 0) {
    return invalid('range', `sum #${overflow} = ${sums[overflow]}; at most ${samples * ADC_MAX_COUNT} for ${samples} samples of 10 bits`);
  }
  const bandgapSum = sums[4];
  const bandgapVccV = bandgapSum > 0 ? CXT_ADC.bandgap_v * CXT_ADC.full_scale * samples / bandgapSum : null;
  if (vccMv === null && bandgapVccV === null) {
    return invalid('bandgap', 'bandgap sum is 0; expected the internal 1.1 V reference (pass a measured Vcc to decode anyway)');
  }
  const vccV = vccMv === null ? bandgapVccV : vccMv / 1000;
  const pinV = (sum) => (sum / samples) * vccV / CXT_ADC.full_scale;
  const tapV = [tapOne, tapTwo, packChannel].map((channel, index) => pinV(sums[index]) * dividerRatio(channel));
  const cellsV = [tapV[0], tapV[1] - tapV[0], tapV[2] - tapV[1]];
  const ntcV = pinV(sums[3]);
  const state = ntcState(ntcV, vccV);
  return {
    status: 'ok',
    samples,
    sums,
    vcc_source: vccMv === null ? 'bandgap' : 'calibration',
    vcc_v: round(vccV, 3),
    bandgap_vcc_v: bandgapVccV === null ? null : round(bandgapVccV, 3),
    tap_v: tapV.map((volts) => round(volts, 3)),
    cells_v: cellsV.map((volts) => round(volts, 3)),
    pack_v: round(tapV[2], 3),
    ntc_v: round(ntcV, 3),
    ntc_state: state,
    temp_c: state === 'ok' ? round(ntcCelsius(ntcV, vccV), 2) : null,
    is_cxt: looksLikeCxt(tapV, cellsV),
  };
}

// A stored read ({name, ok, response, error}) with the dump's calibration.
export function decodeCxtStoredRead(read, calibration = null) {
  if (!read.ok) return { status: 'error', error: read.error || 'falha sem mensagem' };
  try {
    return decodeCxtPayload(fromHex(read.response), { vccMv: calibrationVccMv(calibration) });
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

export function isCxtDump(dump) {
  return dump.reads.some((read) => isCxtReadName(read.name));
}

/** Everything the CXT view and diagnosis need: the last cxt_adc read of a dump, decoded. */
export function buildCxtReport(reads, calibration = null) {
  const read = reads.filter((candidate) => candidate.name === CXT_STEP_NAME).at(-1) ?? null;
  const decoded = read ? decodeCxtStoredRead(read, calibration) : null;
  let vccMv = null;
  try {
    vccMv = calibrationVccMv(calibration);
  } catch {
    // decodeCxtStoredRead already turned the bad calibration into a status 'error'.
  }
  return { read, decoded, calibrationVccMv: vccMv };
}
