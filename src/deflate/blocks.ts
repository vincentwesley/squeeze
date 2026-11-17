// Block writer: collects tokens, then emits each block as stored, fixed or dynamic Huffman,
// whichever is smallest in exact bits.

import { BitWriter } from '../bitio.js';
import { buildCodeLengths, canonicalCodesReversed } from '../huffman.js';
import {
  CLEN_ORDER,
  DIST_BASE,
  DIST_EXTRA,
  distCode,
  FIXED_DIST_LENGTHS,
  FIXED_LITLEN_LENGTHS,
  LENGTH_BASE,
  LENGTH_EXTRA,
  LENGTH_TO_CODE,
} from '../tables.js';
import type { BlockType, Trace } from '../trace.js';

const FIXED_LIT_CODES = canonicalCodesReversed(FIXED_LITLEN_LENGTHS);
const FIXED_DIST_CODES = canonicalCodesReversed(FIXED_DIST_LENGTHS);

/** Huffman code description for a dynamic block. */
export interface DynamicCode {
  litLens: Uint8Array;
  distLens: Uint8Array;
  hlit: number;
  hdist: number;
  /** RLE-coded code-length sequence: symbol 0..18 and its extra-bit value. */
  rleSyms: Uint8Array;
  rleExtra: Uint8Array;
  rleCount: number;
  clenLens: Uint8Array;
  hclen: number;
  headerBits: number;
}

/** Ensure at least two symbols have non-zero frequency (as zlib does), returning a copy. */
function atLeastTwo(freqs: Int32Array): Int32Array {
  const f = freqs.slice();
  let used = 0;
  for (let i = 0; i < f.length; i++) if (f[i]) used++;
  for (let i = 0; used < 2 && i < f.length; i++) {
    if (!f[i]) {
      f[i] = 1;
      used++;
    }
  }
  return f;
}

export function buildDynamicCode(litFreq: Int32Array, distFreq: Int32Array): DynamicCode {
  const litLens = buildCodeLengths(atLeastTwo(litFreq), 15);
  const distLens = buildCodeLengths(atLeastTwo(distFreq), 15);
  let hlit = 286;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(litLens.subarray(0, hlit));
  all.set(distLens.subarray(0, hdist), hlit);

  // Run-length encode the code lengths (RFC 1951 §3.2.7).
  const rleSyms = new Uint8Array(all.length);
  const rleExtra = new Uint8Array(all.length);
  let n = 0;
  const clenFreq = new Int32Array(19);
  for (let i = 0; i < all.length; ) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    i += run;
    if (v === 0) {
      while (run >= 11) {
        const r = Math.min(run, 138);
        rleSyms[n] = 18;
        rleExtra[n++] = r - 11;
        clenFreq[18]++;
        run -= r;
      }
      if (run >= 3) {
        rleSyms[n] = 17;
        rleExtra[n++] = run - 3;
        clenFreq[17]++;
        run = 0;
      }
    } else {
      rleSyms[n++] = v;
      clenFreq[v]++;
      run--;
      while (run >= 3) {
        const r = Math.min(run, 6);
        rleSyms[n] = 16;
        rleExtra[n++] = r - 3;
        clenFreq[16]++;
        run -= r;
      }
    }
    while (run > 0) {
      rleSyms[n++] = v;
      clenFreq[v]++;
      run--;
    }
  }
  const clenLens = buildCodeLengths(atLeastTwo(clenFreq), 7);
  let hclen = 19;
  while (hclen > 4 && clenLens[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  let headerBits = 5 + 5 + 4 + 3 * hclen;
  for (let s = 0; s < 19; s++) headerBits += clenFreq[s] * clenLens[s];
  headerBits += clenFreq[16] * 2 + clenFreq[17] * 3 + clenFreq[18] * 7;
  return { litLens, distLens, hlit, hdist, rleSyms, rleExtra, rleCount: n, clenLens, hclen, headerBits };
}

/** Bits to code the symbols (excluding block header) with the given lengths. */
export function dataBits(
  litFreq: Int32Array,
  distFreq: Int32Array,
  litLens: ArrayLike<number>,
  distLens: ArrayLike<number>,
): number {
  let bits = 0;
  for (let s = 0; s < 286; s++) {
    const f = litFreq[s];
    if (f) bits += f * (litLens[s] + (s > 256 ? LENGTH_EXTRA[s - 257] : 0));
  }
  for (let s = 0; s < 30; s++) {
    const f = distFreq[s];
    if (f) bits += f * (distLens[s] + DIST_EXTRA[s]);
  }
  return bits;
}

export interface BlockWriterOptions {
  /** Upper bound on tokens per block. */
  maxBlockTokens: number;
  /** Use the statistics-based block splitter. */
  split: boolean;
  trace?: Trace;
}

const NUM_OBS = 10;
const OBS_PER_CHECK = 512;
const MIN_BLOCK_BYTES = 10000;

/**
 * Accumulates literal/match tokens for the current block and writes blocks to a BitWriter.
 * `buf` is the full input (with any dictionary prefix); `blockStart` tracks the raw bytes the
 * pending tokens cover so a stored block can be emitted instead.
 */
export class BlockWriter {
  readonly w: BitWriter;
  readonly tokens: Uint32Array;
  ntok = 0;
  readonly litFreq = new Int32Array(286);
  readonly distFreq = new Int32Array(30);
  blockStart: number;
  rawPos: number;
  private readonly maxTokens: number;
  private readonly split: boolean;
  private readonly trace: Trace | null;
  private readonly dictLen: number;
  // Block-splitting statistics (after libdeflate's observation-based splitter).
  private readonly obs = new Float64Array(NUM_OBS);
  private readonly newObs = new Float64Array(NUM_OBS);
  private numObs = 0;
  private numNewObs = 0;

  constructor(
    readonly buf: Uint8Array,
    start: number,
    opts: BlockWriterOptions,
    w?: BitWriter,
  ) {
    this.w = w ?? new BitWriter(Math.max(1024, (buf.length - start) >>> 1));
    this.tokens = new Uint32Array(opts.maxBlockTokens);
    this.maxTokens = opts.maxBlockTokens;
    this.split = opts.split;
    this.trace = opts.trace ?? null;
    this.dictLen = start;
    this.blockStart = start;
    this.rawPos = start;
  }

  literal(b: number): void {
    this.tokens[this.ntok++] = b;
    this.litFreq[b]++;
    this.rawPos++;
    if (this.split) {
      this.newObs[((b >>> 5) & 6) | (b & 1)]++;
      if (++this.numNewObs >= OBS_PER_CHECK) this.checkSplit();
    }
    if (this.ntok >= this.maxTokens) this.flush(false);
  }

  match(len: number, dist: number): void {
    this.tokens[this.ntok++] = ((dist << 16) | len) >>> 0;
    this.litFreq[257 + LENGTH_TO_CODE[len]]++;
    this.distFreq[distCode(dist)]++;
    this.rawPos += len;
    if (this.split) {
      this.newObs[len >= 9 ? 9 : 8]++;
      if (++this.numNewObs >= OBS_PER_CHECK) this.checkSplit();
    }
    if (this.ntok >= this.maxTokens) this.flush(false);
  }

  private checkSplit(): void {
    const blockLength = this.rawPos - this.blockStart;
    if (blockLength >= MIN_BLOCK_BYTES && this.numObs > 0) {
      let totalDelta = 0;
      for (let i = 0; i < NUM_OBS; i++) {
        const expected = this.obs[i] * this.numNewObs;
        const actual = this.newObs[i] * this.numObs;
        totalDelta += Math.abs(actual - expected);
      }
      const numItems = this.numObs + this.numNewObs;
      let cutoff = ((this.numNewObs * 200) / 512) * this.numObs;
      if (blockLength < 10000 && numItems < 8192) cutoff += (cutoff * (8192 - numItems)) / 8192;
      if (totalDelta + Math.floor(blockLength / 4096) * this.numObs >= cutoff) {
        this.flush(false);
        return;
      }
    }
    for (let i = 0; i < NUM_OBS; i++) {
      this.obs[i] += this.newObs[i];
      this.newObs[i] = 0;
    }
    this.numObs += this.numNewObs;
    this.numNewObs = 0;
  }

  /** Emit the raw bytes [blockStart, rawPos) as stored block(s) (level 0). */
  flushStored(final: boolean): void {
    const blockBitStart = this.w.bitLength;
    const rawLen = this.rawPos - this.blockStart;
    this.writeStored(final, rawLen);
    this.trace?.blocks.push({
      type: 0,
      final,
      bitStart: blockBitStart,
      headerBits: this.w.bitLength - blockBitStart - rawLen * 8,
      bitEnd: this.w.bitLength,
      outStart: this.blockStart - this.dictLen,
      outEnd: this.rawPos - this.dictLen,
      tokenStart: this.trace.tokens.count,
      tokenEnd: this.trace.tokens.count,
    });
    this.blockStart = this.rawPos;
  }

  /** Emit the pending tokens as one block (an empty final block is allowed). */
  flush(final: boolean): void {
    if (this.ntok === 0 && !final) return;
    const w = this.w;
    const litFreq = this.litFreq;
    const distFreq = this.distFreq;
    litFreq[256]++;
    const rawLen = this.rawPos - this.blockStart;

    const dyn = buildDynamicCode(litFreq, distFreq);
    const dynBits = 3 + dyn.headerBits + dataBits(litFreq, distFreq, dyn.litLens, dyn.distLens);
    const fixedBits = 3 + dataBits(litFreq, distFreq, FIXED_LITLEN_LENGTHS, FIXED_DIST_LENGTHS);
    // Stored: first chunk pays alignment from the current bit position; later chunks are aligned.
    const chunks = Math.max(1, Math.ceil(rawLen / 65535));
    const pad = (8 - ((w.bitLength + 3) & 7)) & 7;
    const storedBits = 3 + pad + 32 + (chunks - 1) * 40 + rawLen * 8;

    const blockBitStart = w.bitLength;
    const tokStart = this.trace ? this.trace.tokens.count : 0;
    let type: BlockType;
    if (storedBits < fixedBits && storedBits < dynBits) {
      type = 0;
      this.writeStored(final, rawLen);
    } else if (fixedBits <= dynBits) {
      type = 1;
      w.writeBits(final ? 1 : 0, 1);
      w.writeBits(1, 2);
      this.writeSymbols(FIXED_LITLEN_LENGTHS, FIXED_LIT_CODES, FIXED_DIST_LENGTHS, FIXED_DIST_CODES);
    } else {
      type = 2;
      w.writeBits(final ? 1 : 0, 1);
      w.writeBits(2, 2);
      this.writeDynamicHeader(dyn);
      this.writeSymbols(
        dyn.litLens,
        canonicalCodesReversed(dyn.litLens),
        dyn.distLens,
        canonicalCodesReversed(dyn.distLens),
      );
    }
    if (this.trace) {
      const headerBits =
        type === 0
          ? w.bitLength - blockBitStart - rawLen * 8
          : type === 1
            ? 3
            : 3 + dyn.headerBits;
      this.trace.blocks.push({
        type,
        final,
        bitStart: blockBitStart,
        headerBits,
        bitEnd: w.bitLength,
        outStart: this.blockStart - this.dictLen,
        outEnd: this.rawPos - this.dictLen,
        tokenStart: tokStart,
        tokenEnd: this.trace.tokens.count,
        litLenLengths: type === 0 ? undefined : type === 1 ? FIXED_LITLEN_LENGTHS.slice() : dyn.litLens.slice(0, dyn.hlit),
        distLengths: type === 0 ? undefined : type === 1 ? FIXED_DIST_LENGTHS.slice(0, 30) : dyn.distLens.slice(0, dyn.hdist),
        codeLengthLengths: type === 2 ? dyn.clenLens.slice() : undefined,
      });
    }
    // Reset for the next block.
    this.ntok = 0;
    litFreq.fill(0);
    distFreq.fill(0);
    this.blockStart = this.rawPos;
    this.obs.fill(0);
    this.newObs.fill(0);
    this.numObs = 0;
    this.numNewObs = 0;
  }

  private writeStored(final: boolean, rawLen: number): void {
    const w = this.w;
    let p = this.blockStart;
    let left = rawLen;
    do {
      const n = Math.min(left, 65535);
      left -= n;
      w.writeBits(final && left === 0 ? 1 : 0, 1);
      w.writeBits(0, 2);
      w.alignToByte();
      w.writeBits(n & 0xffff, 16);
      w.writeBits(~n & 0xffff, 16);
      w.writeBytes(this.buf, p, p + n);
      p += n;
    } while (left > 0);
  }

  private writeDynamicHeader(d: DynamicCode): void {
    const w = this.w;
    w.writeBits(d.hlit - 257, 5);
    w.writeBits(d.hdist - 1, 5);
    w.writeBits(d.hclen - 4, 4);
    for (let i = 0; i < d.hclen; i++) w.writeBits(d.clenLens[CLEN_ORDER[i]], 3);
    const clenCodes = canonicalCodesReversed(d.clenLens);
    for (let i = 0; i < d.rleCount; i++) {
      const s = d.rleSyms[i];
      w.writeBits(clenCodes[s], d.clenLens[s]);
      if (s === 16) w.writeBits(d.rleExtra[i], 2);
      else if (s === 17) w.writeBits(d.rleExtra[i], 3);
      else if (s === 18) w.writeBits(d.rleExtra[i], 7);
    }
  }

  private writeSymbols(
    litLens: ArrayLike<number>,
    litCodes: Uint16Array,
    distLens: ArrayLike<number>,
    distCodes: Uint16Array,
  ): void {
    const w = this.w;
    const tokens = this.tokens;
    const tt = this.trace ? this.trace.tokens : null;
    let pos = this.blockStart - this.dictLen;
    for (let i = 0; i < this.ntok; i++) {
      const t = tokens[i];
      if (t < 256) {
        w.writeBits(litCodes[t], litLens[t]);
        if (tt) tt.push(pos, 0, t, litLens[t]);
        pos++;
      } else {
        const len = t & 0xffff;
        const dist = t >>> 16;
        const lc = LENGTH_TO_CODE[len];
        const lsym = 257 + lc;
        const leb = LENGTH_EXTRA[lc];
        w.writeBits(litCodes[lsym] | ((len - LENGTH_BASE[lc]) << litLens[lsym]), litLens[lsym] + leb);
        const dc = distCode(dist);
        const deb = DIST_EXTRA[dc];
        w.writeBits(distCodes[dc], distLens[dc]);
        if (deb) w.writeBits(dist - DIST_BASE[dc], deb);
        if (tt) tt.push(pos, len, dist, litLens[lsym] + leb + distLens[dc] + deb);
        pos += len;
      }
    }
    w.writeBits(litCodes[256], litLens[256]);
  }
}
