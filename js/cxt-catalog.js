// Own copy of the tables in spec/cxt.json (Makita CXT, 12V max, read through the Arduino ADC).
// Same shape as the spec where the spec has numbers; the formulas that the spec states as text
// are coded in cxt-decode.js and their constants pulled out here. tests/cxt-catalog.test.mjs
// compares everything with the spec. Designed from the published pinout, NOT yet checked on a
// real pack (docs/cxt.md).

export const CXT_FIRMWARE_COMMAND = Object.freeze({
  cmd: 'E1',
  default_samples: 32,
  // From the spec's data field "[samples 1..64]": 64 x 1023 still fits the firmware's u16 sums.
  samples_range: Object.freeze([1, 64]),
  // samples + 5 little-endian u16 sums (A0, A1, A2, A3, bandgap).
  payload_len: 11,
});

export const CXT_ADC = Object.freeze({
  bits: 10,
  full_scale: 1024,
  bandgap_v: 1.1,
});

export const CXT_CHANNELS = Object.freeze([
  { name: 'tap1', pin: 'A0', contact: 'tap da célula 1 (~4,2 V máx.)', r_top_ohm: 10000, r_bottom_ohm: 10000 },
  { name: 'tap2', pin: 'A1', contact: 'tap da célula 2 (~8,4 V máx.)', r_top_ohm: 20000, r_bottom_ohm: 10000 },
  { name: 'pack', pin: 'A2', contact: 'pack + (~12,6 V máx.)', r_top_ohm: 30000, r_bottom_ohm: 10000 },
  { name: 'ntc', pin: 'A3', contact: 'termistor (para o − do pack)', pullup_ohm: 10000, pullup_to: '5V do Nano' },
].map(Object.freeze));

export const CXT_CELL_COUNT = 3;

export const CXT_NTC = Object.freeze({
  r25_ohm: 10000,
  beta: 3435,
  confidence: 'C',
  // "open_if": v >= 0.98 * vcc_v; "short_if": v <= 0.02 * vcc_v.
  open_fraction: 0.98,
  short_fraction: 0.02,
});

export const CXT_DETECTION = Object.freeze({
  pack_v: Object.freeze([3.0, 13.5]),
  cell_v: Object.freeze([0.5, 4.5]),
});

// spec family_detection.order: passive first, the one that transmits last.
export const FAMILY_ORDER = Object.freeze(['cxt', 'lxt', 'xgt']);

export const CXT_STEP_NAME = 'cxt_adc';

// Host-side policy, not in the spec: accepted range for the measured Vcc typed by the user. A
// USB-powered Nano sits around 4.6-5.1 V; anything outside this is a typo.
export const CXT_CALIBRATION_MV = Object.freeze([3000, 6000]);

export function isCxtReadName(name) {
  return name === CXT_STEP_NAME;
}
