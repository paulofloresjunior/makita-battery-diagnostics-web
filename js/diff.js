// Compares two dumps (or two reads of the same pack): labelled byte diff for the stored
// message, decoded-field diff for everything.

import { fromHex, toHex } from './bytes.js';
import { BYTE_LABELS_PT } from './catalog.js';
import { decodeStoredRead } from './decode.js';
import { romOfDump } from './dump.js';
import { baseReadName } from './protocol.js';

// Byte-level only where the bytes are stored state; live data (voltages, temperatures)
// changes on every read, so for those only decoded values are compared.
const BYTE_DIFF_BASES = new Set(['lxt_msg']);
// Timing-sweep reads from old OBI probe dumps: same bytes as lxt_msg's ROM, only noise here.
const IGNORED_PREFIX = 'rom@';

export function byteDiff(name, beforeHex, afterHex) {
  const before = fromHex(beforeHex);
  const after = fromHex(afterHex);
  const labels = baseReadName(name) === 'lxt_msg' ? BYTE_LABELS_PT : {};
  const changes = [];
  const length = Math.max(before.length, after.length);
  for (let offset = 0; offset < length; offset++) {
    if (before[offset] === after[offset]) continue;
    changes.push({
      offset,
      before: offset < before.length ? toHex([before[offset]]) : null,
      after: offset < after.length ? toHex([after[offset]]) : null,
      label: labels[offset] ?? '',
    });
  }
  return changes;
}

// {a: {b: 1}} -> {"a.b": 1}; arrays are compared as a whole value.
function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out[prefix] = Array.isArray(value) ? value.join(' ') : value;
    return out;
  }
  for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

export function fieldDiff(beforeDecoded, afterDecoded) {
  const before = flatten(beforeDecoded);
  const after = flatten(afterDecoded);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }));
}

// calibrationBefore/After: each dump's top-level calibration, so CXT voltages compare as each
// dump decodes them on its own.
export function diffReads(before, after, { calibrationBefore = null, calibrationAfter = null } = {}) {
  const bytes = BYTE_DIFF_BASES.has(baseReadName(before.name)) && before.ok && after.ok
    ? byteDiff(before.name, before.response, after.response)
    : [];
  const fields = fieldDiff(decodeStoredRead(before, { calibration: calibrationBefore }), decodeStoredRead(after, { calibration: calibrationAfter }));
  return { name: before.name, bytes, fields };
}

function readsByName(dump) {
  return new Map(dump.reads.filter((read) => !read.name.startsWith(IGNORED_PREFIX)).map((read) => [read.name, read]));
}

export function diffDumps(dumpA, dumpB) {
  const readsA = readsByName(dumpA);
  const readsB = readsByName(dumpB);
  const reads = [];
  for (const [name, readA] of readsA) {
    const readB = readsB.get(name);
    if (!readB) continue;
    const diff = diffReads(readA, readB, { calibrationBefore: dumpA.calibration ?? null, calibrationAfter: dumpB.calibration ?? null });
    if (diff.bytes.length || diff.fields.length) reads.push(diff);
  }
  const romA = romOfDump(dumpA);
  const romB = romOfDump(dumpB);
  return {
    romA,
    romB,
    samePack: romA !== null && romA === romB,
    reads,
    onlyInA: [...readsA.keys()].filter((name) => !readsB.has(name)),
    onlyInB: [...readsB.keys()].filter((name) => !readsA.has(name)),
  };
}
