// zlib container (RFC 1950).

import { adler32 } from './checksum.js';
import { type DeflateOptions, deflateRaw } from './deflate/index.js';
import { fail } from './errors.js';
import { type InflateOptions, inflateRawAt } from './inflate.js';

export interface ZlibDecompressOptions extends InflateOptions {
  /** Accept bytes after the Adler-32 trailer (default false: reject with TRAILING_DATA). */
  allowTrailingData?: boolean;
}

/** Compress into a zlib stream. */
export function zlibCompress(input: Uint8Array, options: DeflateOptions = {}): Uint8Array {
  const level = options.level ?? 6;
  const body = deflateRaw(input, options);
  const dict = options.dictionary;
  const hasDict = !!dict && dict.length > 0;
  const out = new Uint8Array(2 + (hasDict ? 4 : 0) + body.length + 4);
  const cmf = 0x78; // CM = 8 (deflate), CINFO = 7 (32 KiB window)
  const flevel = level < 2 ? 0 : level < 6 ? 1 : level === 6 ? 2 : 3;
  let flg = (flevel << 6) | (hasDict ? 0x20 : 0);
  flg |= 31 - ((cmf * 256 + flg) % 31);
  out[0] = cmf;
  out[1] = flg;
  let p = 2;
  if (hasDict) {
    writeU32BE(out, p, adler32(dict));
    p += 4;
  }
  out.set(body, p);
  p += body.length;
  writeU32BE(out, p, adler32(input));
  return out;
}

export interface ZlibResult {
  data: Uint8Array;
  /** Byte offset just past the Adler-32 trailer. */
  end: number;
}

/** Decompress a zlib stream starting at `start`, reporting where it ended. */
export function zlibDecompressAt(
  input: Uint8Array,
  start: number,
  options: ZlibDecompressOptions = {},
): ZlibResult {
  if (input.length - start < 2) fail('UNEXPECTED_EOF', 'zlib header truncated');
  const cmf = input[start];
  const flg = input[start + 1];
  if ((cmf * 256 + flg) % 31 !== 0) fail('BAD_HEADER', 'incorrect header check');
  if ((cmf & 15) !== 8) fail('BAD_HEADER', 'unknown compression method');
  if (cmf >>> 4 > 7) fail('BAD_HEADER', 'invalid window size');
  let p = start + 2;
  let dictionary: Uint8Array | undefined;
  if (flg & 0x20) {
    if (input.length - p < 4) fail('UNEXPECTED_EOF', 'zlib dictionary id truncated');
    const id = readU32BE(input, p);
    p += 4;
    if (!options.dictionary) fail('NEED_DICTIONARY', 'stream needs a preset dictionary');
    if (adler32(options.dictionary) !== id) fail('NEED_DICTIONARY', 'preset dictionary does not match');
    dictionary = options.dictionary;
  }
  const r = inflateRawAt(input, p, { ...options, dictionary });
  p = r.end;
  if (input.length - p < 4) fail('UNEXPECTED_EOF', 'zlib trailer truncated');
  if (readU32BE(input, p) !== adler32(r.data)) fail('BAD_CHECKSUM', 'incorrect data check (Adler-32)');
  p += 4;
  return { data: r.data, end: p };
}

/** Decompress a complete zlib stream. */
export function zlibDecompress(input: Uint8Array, options: ZlibDecompressOptions = {}): Uint8Array {
  const r = zlibDecompressAt(input, 0, options);
  if (r.end !== input.length && !options.allowTrailingData)
    fail('TRAILING_DATA', `${input.length - r.end} bytes after the end of the zlib stream`);
  return r.data;
}

export function writeU32BE(b: Uint8Array, p: number, v: number): void {
  b[p] = v >>> 24;
  b[p + 1] = (v >>> 16) & 0xff;
  b[p + 2] = (v >>> 8) & 0xff;
  b[p + 3] = v & 0xff;
}

export function readU32BE(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}
