// Constant tables from RFC 1951 §3.2.5.

/** Base match length for length symbols 257..285 (index = symbol - 257). */
export const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227,
  258,
]);
/** Extra bits for length symbols 257..285. */
export const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
/** Base distance for distance symbols 0..29. */
export const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
  6145, 8193, 12289, 16385, 24577,
]);
/** Extra bits for distance symbols 0..29. */
export const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
/** Order in which code-length-code lengths are transmitted. */
export const CLEN_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/** Length (3..258) → length symbol index 0..28. */
export const LENGTH_TO_CODE: Uint8Array = (() => {
  const t = new Uint8Array(259);
  for (let c = 0; c < 29; c++) {
    const end = c === 28 ? 259 : LENGTH_BASE[c + 1];
    for (let l = LENGTH_BASE[c]; l < end && l < 259; l++) t[l] = c;
  }
  t[258] = 28;
  return t;
})();

/** Distance symbol (0..29) for distance 1..32768. */
export function distCode(d: number): number {
  if (d <= 256) return DIST_CODE_SMALL[d];
  return DIST_CODE_LARGE[(d - 1) >>> 7];
}
const DIST_CODE_SMALL = new Uint8Array(257);
const DIST_CODE_LARGE = new Uint8Array(256);
for (let c = 0; c < 30; c++) {
  const end = c === 29 ? 32769 : DIST_BASE[c + 1];
  for (let d = DIST_BASE[c]; d < end; d++) {
    if (d <= 256) DIST_CODE_SMALL[d] = c;
    else DIST_CODE_LARGE[(d - 1) >>> 7] = c;
  }
}

/** Fixed Huffman code lengths (RFC 1951 §3.2.6). */
export const FIXED_LITLEN_LENGTHS: Uint8Array = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  return l;
})();
export const FIXED_DIST_LENGTHS: Uint8Array = new Uint8Array(32).fill(5);
