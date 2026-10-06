// Byte helpers shared by every module. Hex strings use the spec convention: upper case,
// space-separated bytes ("CC D7 00 00 FF").

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function fromHex(text) {
  const clean = String(text).replace(/[,\s]+/g, ' ').trim();
  if (clean === '') return new Uint8Array(0);
  const parts = clean.split(' ');
  const bytes = new Uint8Array(parts.length);
  parts.forEach((part, index) => {
    if (!/^[0-9a-fA-F]{2}$/.test(part)) {
      throw new Error(`invalid hex byte "${part}" at position ${index}; expected two hex digits like "CC"`);
    }
    bytes[index] = parseInt(part, 16);
  });
  return bytes;
}

export function u16le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function u32le(bytes, offset) {
  // >>> 0 keeps values with the top bit set positive.
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function nibbleSwap(byte) {
  return ((byte & 0xf0) >> 4) | ((byte & 0x0f) << 4);
}

// A silent 1-Wire line reads 0xFF (nobody pulls it low); a line held low reads 0x00.
export function blankKind(bytes) {
  if (bytes.length === 0) return null;
  if (bytes.every((b) => b === 0xff)) return 'ff';
  if (bytes.every((b) => b === 0x00)) return '00';
  return null;
}

export function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
