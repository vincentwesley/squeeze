// CRC-32 (ISO-HDLC / PNG / gzip polynomial 0xEDB88320, reflected) and Adler-32 (RFC 1950).

/** Slicing-by-8 tables: CRC_TABLES[k][b] is the CRC contribution of byte b, k positions back. */
const CRC_TABLES: Int32Array[] = (() => {
  const tables: Int32Array[] = [];
  const t0 = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c;
  }
  tables.push(t0);
  for (let k = 1; k < 8; k++) {
    const prev = tables[k - 1];
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) t[n] = (prev[n] >>> 8) ^ t0[prev[n] & 0xff];
    tables.push(t);
  }
  return tables;
})();

/**
 * Update a running CRC-32 with `data[start, end)`. Start from `crc = 0`.
 * Returns an unsigned 32-bit value.
 */
export function crc32(data: Uint8Array, crc = 0, start = 0, end = data.length): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
  let c = ~crc;
  let i = start;
  const end8 = start + ((end - start) & ~7);
  for (; i < end8; i += 8) {
    const a = c ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24));
    c =
      t7[a & 0xff] ^
      t6[(a >>> 8) & 0xff] ^
      t5[(a >>> 16) & 0xff] ^
      t4[a >>> 24] ^
      t3[data[i + 4]] ^
      t2[data[i + 5]] ^
      t1[data[i + 6]] ^
      t0[data[i + 7]];
  }
  for (; i < end; i++) c = t0[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Update a running Adler-32 with `data[start, end)`. Start from `adler = 1`. */
export function adler32(data: Uint8Array, adler = 1, start = 0, end = data.length): number {
  let a = adler & 0xffff;
  let b = (adler >>> 16) & 0xffff;
  let i = start;
  while (i < end) {
    // 3800 is safely below NMAX (5552) and keeps b below 2^31 in float-free int math.
    const n = Math.min(end - i, 3800);
    const stop = i + n;
    for (; i < stop; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
