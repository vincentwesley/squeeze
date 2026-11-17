// DEFLATE decoder (RFC 1951). Validation rules follow zlib's inflate.c/inftrees.c so that
// Squeeze accepts and rejects exactly the streams zlib does.

import { fail } from './errors.js';
import { buildDecodeTable, CodeKind, type DecodeTable } from './huffman.js';
import {
  CLEN_ORDER,
  DIST_BASE,
  DIST_EXTRA,
  FIXED_DIST_LENGTHS,
  FIXED_LITLEN_LENGTHS,
  LENGTH_BASE,
  LENGTH_EXTRA,
} from './tables.js';
import type { BlockType, Trace } from './trace.js';

export interface InflateOptions {
  /** Throw `OUTPUT_LIMIT` if the output would exceed this many bytes. Default: unlimited. */
  maxOutputLength?: number;
  /** Preset dictionary (only its last 32 KiB are used). */
  dictionary?: Uint8Array;
  /** Expected output size, used to size the output buffer. */
  sizeHint?: number;
  /** If given, blocks and tokens are recorded here. */
  trace?: Trace;
}

export interface InflateResult {
  data: Uint8Array;
  /** Byte offset just past the end of the deflate stream (the final block's last byte). */
  end: number;
}

let fixedLit: DecodeTable | null = null;
let fixedDist: DecodeTable | null = null;

function eof(): never {
  fail('UNEXPECTED_EOF', 'unexpected end of deflate stream');
}

/** Return a larger copy of `out` holding at least `need` bytes (never more than `maxCap`). */
function grow(out: Uint8Array, op: number, need: number, maxCap: number, limit: number): Uint8Array {
  if (need > maxCap) fail('OUTPUT_LIMIT', `output exceeds the limit of ${limit} bytes`);
  let size = out.length * 2;
  while (size < need) size *= 2;
  if (size > maxCap) size = maxCap;
  const next = new Uint8Array(size);
  next.set(out.subarray(0, op));
  return next;
}

/** Decode a raw DEFLATE stream. */
export function inflateRaw(input: Uint8Array, options: InflateOptions = {}): Uint8Array {
  return inflateRawAt(input, 0, options).data;
}

/** Decode a raw DEFLATE stream starting at `start`, reporting where it ended. */
export function inflateRawAt(input: Uint8Array, start: number, options: InflateOptions = {}): InflateResult {
  const inLen = input.length;
  const limit = options.maxOutputLength ?? Number.POSITIVE_INFINITY;
  const trace = options.trace ?? null;
  const tokens = trace ? trace.tokens : null;

  let dictLen = 0;
  const hint = Math.min(limit, Math.max(1024, Math.min(options.sizeHint ?? (inLen - start) * 4, 1 << 30)));
  let out: Uint8Array;
  if (options.dictionary && options.dictionary.length > 0) {
    const d = options.dictionary.subarray(Math.max(0, options.dictionary.length - 32768));
    dictLen = d.length;
    out = new Uint8Array(dictLen + hint);
    out.set(d);
  } else {
    out = new Uint8Array(hint);
  }
  const maxCap = dictLen + limit;
  let op = dictLen;

  let pos = start;
  let bitbuf = 0;
  let bitcnt = 0;

  let final = 0;
  do {
    while (bitcnt <= 24) {
      bitbuf |= (pos < inLen ? input[pos] : 0) << bitcnt;
      pos++;
      bitcnt += 8;
    }
    const blockBitStart = ((pos - start) << 3) - bitcnt;
    final = bitbuf & 1;
    const type = (bitbuf >>> 1) & 3;
    bitbuf >>>= 3;
    bitcnt -= 3;
    if (pos > inLen && (pos - inLen) << 3 > bitcnt) eof();
    const blockOutStart = op;
    const blockTokenStart = tokens ? tokens.count : 0;

    if (type === 0) {
      // Stored: skip to byte boundary, rewind the bit buffer to whole bytes.
      bitcnt -= bitcnt & 7;
      pos -= bitcnt >>> 3;
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > inLen) eof();
      const len = input[pos] | (input[pos + 1] << 8);
      const nlen = input[pos + 2] | (input[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) fail('BAD_STORED_LENGTH', 'stored block length check failed');
      pos += 4;
      if (pos + len > inLen) eof();
      if (op + len > out.length) out = grow(out, op, op + len, maxCap, limit);
      out.set(input.subarray(pos, pos + len), op);
      op += len;
      pos += len;
      if (trace) {
        const bitEnd = (pos - start) << 3;
        trace.blocks.push({
          type: 0,
          final: final === 1,
          bitStart: blockBitStart,
          headerBits: bitEnd - blockBitStart - len * 8,
          bitEnd,
          outStart: blockOutStart - dictLen,
          outEnd: op - dictLen,
          tokenStart: blockTokenStart,
          tokenEnd: blockTokenStart,
        });
      }
      continue;
    }
    if (type === 3) fail('BAD_BLOCK_TYPE', 'invalid block type');

    let lt: Int32Array;
    let lroot: number;
    let dt: Int32Array;
    let droot: number;
    let litLenLengths: Uint8Array | undefined;
    let distLengths: Uint8Array | undefined;
    let clenLengths: Uint8Array | undefined;
    if (type === 1) {
      if (!fixedLit) {
        fixedLit = buildDecodeTable(FIXED_LITLEN_LENGTHS, 0, 288, 10, CodeKind.Lens)!;
        fixedDist = buildDecodeTable(FIXED_DIST_LENGTHS, 0, 32, 8, CodeKind.Lens)!;
      }
      lt = fixedLit.table;
      lroot = fixedLit.rootBits;
      dt = fixedDist!.table;
      droot = fixedDist!.rootBits;
      if (trace) {
        litLenLengths = FIXED_LITLEN_LENGTHS.slice();
        distLengths = FIXED_DIST_LENGTHS.slice(0, 30);
      }
    } else {
      // Dynamic header.
      while (bitcnt <= 24) {
        bitbuf |= (pos < inLen ? input[pos] : 0) << bitcnt;
        pos++;
        bitcnt += 8;
      }
      const hlit = (bitbuf & 31) + 257;
      const hdist = ((bitbuf >>> 5) & 31) + 1;
      const hclen = ((bitbuf >>> 10) & 15) + 4;
      bitbuf >>>= 14;
      bitcnt -= 14;
      if (pos > inLen && (pos - inLen) << 3 > bitcnt) eof();
      if (hlit > 286 || hdist > 30) fail('TOO_MANY_SYMBOLS', 'too many length or distance symbols');
      const clens = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) {
        if (bitcnt < 3) {
          while (bitcnt <= 24) {
            bitbuf |= (pos < inLen ? input[pos] : 0) << bitcnt;
            pos++;
            bitcnt += 8;
          }
        }
        clens[CLEN_ORDER[i]] = bitbuf & 7;
        bitbuf >>>= 3;
        bitcnt -= 3;
      }
      if (pos > inLen && (pos - inLen) << 3 > bitcnt) eof();
      const ct = buildDecodeTable(clens, 0, 19, 7, CodeKind.Codes);
      if (!ct) fail('BAD_CODE_LENGTHS', 'invalid code lengths set');
      const ctab = ct.table;
      const cmask = (1 << ct.rootBits) - 1;
      const total = hlit + hdist;
      const lengths = new Uint8Array(total);
      let i = 0;
      while (i < total) {
        while (bitcnt <= 24) {
          bitbuf |= (pos < inLen ? input[pos] : 0) << bitcnt;
          pos++;
          bitcnt += 8;
        }
        const e = ctab[bitbuf & cmask];
        const n = e & 15;
        if (n === 0) fail('BAD_CODE_LENGTHS', 'invalid code lengths code');
        bitbuf >>>= n;
        bitcnt -= n;
        const sym = e >>> 8;
        if (sym < 16) {
          lengths[i++] = sym;
        } else {
          let rep: number;
          let val = 0;
          if (sym === 16) {
            if (i === 0) fail('BAD_CODE_LENGTHS', 'invalid bit length repeat');
            val = lengths[i - 1];
            rep = 3 + (bitbuf & 3);
            bitbuf >>>= 2;
            bitcnt -= 2;
          } else if (sym === 17) {
            rep = 3 + (bitbuf & 7);
            bitbuf >>>= 3;
            bitcnt -= 3;
          } else {
            rep = 11 + (bitbuf & 127);
            bitbuf >>>= 7;
            bitcnt -= 7;
          }
          if (i + rep > total) fail('BAD_CODE_LENGTHS', 'invalid bit length repeat');
          lengths.fill(val, i, i + rep);
          i += rep;
        }
        if (pos > inLen && (pos - inLen) << 3 > bitcnt) eof();
      }
      if (lengths[256] === 0) fail('MISSING_END_OF_BLOCK', 'invalid code -- missing end-of-block');
      const l = buildDecodeTable(lengths, 0, hlit, 10, CodeKind.Lens);
      if (!l) fail('BAD_CODE_LENGTHS', 'invalid literal/lengths set');
      const d = buildDecodeTable(lengths, hlit, hdist, 8, CodeKind.Lens);
      if (!d) fail('BAD_CODE_LENGTHS', 'invalid distances set');
      lt = l.table;
      lroot = l.rootBits;
      dt = d.table;
      droot = d.rootBits;
      if (trace) {
        litLenLengths = lengths.slice(0, hlit);
        distLengths = lengths.slice(hlit);
        clenLengths = clens;
      }
    }
    const headerEnd = ((pos - start) << 3) - bitcnt;
    const lmask = (1 << lroot) - 1;
    const dmask = (1 << droot) - 1;

    // Symbol loop. Refill only when fewer than 15 bits remain (one longest code).
    for (;;) {
      if (bitcnt < 15) {
        if (pos + 4 <= inLen) {
          while (bitcnt <= 24) {
            bitbuf |= input[pos++] << bitcnt;
            bitcnt += 8;
          }
        } else {
          while (bitcnt <= 24) {
            bitbuf |= (pos < inLen ? input[pos] : 0) << bitcnt;
            pos++;
            bitcnt += 8;
          }
        }
      }
      const tokenBitStart = tokens ? ((pos - start) << 3) - bitcnt : 0;
      let e = lt[bitbuf & lmask];
      if (e & 0x80) {
        bitbuf >>>= lroot;
        bitcnt -= lroot;
        e = lt[(e >>> 8) + (bitbuf & ((1 << (e & 15)) - 1))];
      }
      const n = e & 15;
      if (n === 0) fail('BAD_SYMBOL', 'invalid literal/length code');
      bitbuf >>>= n;
      bitcnt -= n;
      let sym = e >>> 8;
      if (sym < 256) {
        if (pos > inLen && (pos - inLen) << 3 > bitcnt) eof();
        if (op >= out.length) out = grow(out, op, op + 1, maxCap, limit);
        if (tokens) tokens.push(op - dictLen, 0, sym, ((pos - start) << 3) - bitcnt - tokenBitStart);
        out[op++] = sym;
        continue;
      }
      if (sym === 256) {
        if (pos > inLen && (pos - inLen) << 3 > bitcnt) eof();
        break;
      }
      sym -= 257;
      if (sym >= 29) fail('BAD_SYMBOL', 'invalid literal/length code');
      const lb = LENGTH_EXTRA[sym];
      if (bitcnt < lb + 15) {
        while (bitcnt <= 24) {
          bitbuf |= (pos < inLen ? input[pos] : 0) << bitcnt;
          pos++;
          bitcnt += 8;
        }
      }
      const len = LENGTH_BASE[sym] + (bitbuf & ((1 << lb) - 1));
      bitbuf >>>= lb;
      bitcnt -= lb;
      e = dt[bitbuf & dmask];
      if (e & 0x80) {
        bitbuf >>>= droot;
        bitcnt -= droot;
        e = dt[(e >>> 8) + (bitbuf & ((1 << (e & 15)) - 1))];
      }
      const dn = e & 15;
      if (dn === 0) fail('BAD_SYMBOL', 'invalid distance code');
      bitbuf >>>= dn;
      bitcnt -= dn;
      const dsym = e >>> 8;
      if (dsym >= 30) fail('BAD_SYMBOL', 'invalid distance code');
      const db = DIST_EXTRA[dsym];
      if (bitcnt < db) {
        while (bitcnt <= 24) {
          bitbuf |= (pos < inLen ? input[pos] : 0) << bitcnt;
          pos++;
          bitcnt += 8;
        }
      }
      const dist = DIST_BASE[dsym] + (bitbuf & ((1 << db) - 1));
      bitbuf >>>= db;
      bitcnt -= db;
      if (pos > inLen && (pos - inLen) << 3 > bitcnt) eof();
      if (dist > op) fail('DISTANCE_TOO_FAR', 'invalid distance too far back');
      if (op + len > out.length) out = grow(out, op, op + len, maxCap, limit);
      if (tokens) tokens.push(op - dictLen, len, dist, ((pos - start) << 3) - bitcnt - tokenBitStart);
      let from = op - dist;
      if (dist >= len && len > 32) {
        out.copyWithin(op, from, from + len);
        op += len;
      } else {
        const stop = op + len;
        while (op < stop) out[op++] = out[from++];
      }
    }
    if (trace) {
      trace.blocks.push({
        type: type as BlockType,
        final: final === 1,
        bitStart: blockBitStart,
        headerBits: headerEnd - blockBitStart,
        bitEnd: ((pos - start) << 3) - bitcnt,
        outStart: blockOutStart - dictLen,
        outEnd: op - dictLen,
        tokenStart: blockTokenStart,
        tokenEnd: tokens!.count,
        litLenLengths,
        distLengths,
        codeLengthLengths: clenLengths,
      });
    }
  } while (!final);

  const end = pos - (bitcnt >>> 3);
  return { data: out.subarray(dictLen, op), end };
}
