// Huffman code construction (encoder side) and decode tables (decoder side).

import { reverseBits } from './bitio.js';

/**
 * Optimal length-limited Huffman code lengths by package-merge (Larmore & Hirschberg 1990).
 * Symbols with frequency 0 get length 0. With exactly one used symbol it gets length 1.
 */
export function buildCodeLengths(freqs: ArrayLike<number>, maxBits: number): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  if (syms.length > 1 << maxBits) throw new Error('too many symbols for maxBits');
  syms.sort((a, b) => freqs[a] - freqs[b] || a - b);
  const m = syms.length;
  const leafW = syms.map((s) => freqs[s]);

  // Each level's list holds items: weight + (leaf index | package of two previous-level items).
  // We store, per level, arrays of weight and "isPackage" + child pointer (index of first child in prev level).
  type Level = { w: number[]; pkg: number[] }; // pkg[i] = -1 for leaf (leaf index stored in leafIdx), else first child idx
  const levels: (Level & { leaf: number[] })[] = [];
  let prev: (Level & { leaf: number[] }) | null = null;
  for (let level = 0; level < maxBits; level++) {
    const w: number[] = [];
    const pkg: number[] = [];
    const leaf: number[] = [];
    // Packages from previous level: pairs (0,1), (2,3), ...
    let li = 0;
    let pi = 0;
    const pcount = prev ? prev.w.length >> 1 : 0;
    while (li < m || pi < pcount) {
      const pw = pi < pcount ? prev!.w[2 * pi] + prev!.w[2 * pi + 1] : Number.POSITIVE_INFINITY;
      if (li < m && leafW[li] <= pw) {
        w.push(leafW[li]);
        pkg.push(-1);
        leaf.push(li);
        li++;
      } else {
        w.push(pw);
        pkg.push(2 * pi);
        leaf.push(-1);
        pi++;
      }
    }
    prev = { w, pkg, leaf };
    levels.push(prev);
  }
  // Take the first 2m-2 items of the last level; every leaf occurrence adds 1 to that symbol's length.
  const counts = new Int32Array(m);
  // take[level] = number of items taken from that level's list (always a prefix).
  let take = 2 * m - 2;
  for (let level = maxBits - 1; level >= 0; level--) {
    const L = levels[level];
    let packages = 0;
    for (let i = 0; i < take; i++) {
      if (L.pkg[i] < 0) counts[L.leaf[i]]++;
      else packages++;
    }
    // Packages taken are always the first `packages` packages, i.e. the first 2*packages items below.
    take = 2 * packages;
  }
  for (let i = 0; i < m; i++) lengths[syms[i]] = counts[i];
  return lengths;
}

/**
 * Canonical codes for the given lengths, already bit-reversed for an LSB-first writer.
 * codes[s] is meaningless when lengths[s] == 0.
 */
export function canonicalCodesReversed(lengths: ArrayLike<number>): Uint16Array {
  const maxLen = 16;
  const blCount = new Uint16Array(maxLen);
  for (let i = 0; i < lengths.length; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const next = new Uint16Array(maxLen);
  let code = 0;
  for (let bits = 1; bits < maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s];
    if (len !== 0) codes[s] = reverseBits(next[len]++, len);
  }
  return codes;
}

/** Canonical codes, MSB-first (as drawn in a tree). */
export function canonicalCodes(lengths: ArrayLike<number>): Uint16Array {
  const rev = canonicalCodesReversed(lengths);
  const out = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) out[s] = reverseBits(rev[s], lengths[s]);
  return out;
}

/**
 * Decode table. Entry layout (Int32):
 *   0                              → invalid bit pattern
 *   (symbol << 8) | nbits          → direct hit, consume nbits (1..15)
 *   (offset << 8) | 0x80 | subBits → consume `rootBits`, then index sub-table at offset with `subBits` bits
 */
export interface DecodeTable {
  table: Int32Array;
  rootBits: number;
}

export enum CodeKind {
  /** Code-length code: must be complete. */
  Codes = 0,
  /** Literal/length or distance code: incomplete only if a single 1-bit code. */
  Lens = 1,
}

/**
 * Build a decode table. Returns null if the lengths do not describe a valid code under
 * zlib's rules (over-subscribed, or incomplete other than the single-code case).
 * An all-zero set returns a table whose every entry is invalid.
 */
export function buildDecodeTable(
  lengths: ArrayLike<number>,
  start: number,
  count: number,
  rootBits: number,
  kind: CodeKind,
): DecodeTable | null {
  const blCount = new Int32Array(16);
  let maxLen = 0;
  for (let i = 0; i < count; i++) {
    const l = lengths[start + i];
    blCount[l]++;
    if (l > maxLen) maxLen = l;
  }
  if (maxLen === 0) return { table: new Int32Array(1 << rootBits), rootBits };
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left <<= 1;
    left -= blCount[len];
    if (left < 0) return null; // over-subscribed
  }
  if (left > 0 && (kind === CodeKind.Codes || maxLen !== 1)) return null; // incomplete
  if (rootBits > maxLen) rootBits = maxLen;

  // Canonical first codes.
  const next = new Int32Array(16);
  let code = 0;
  blCount[0] = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  const rootSize = 1 << rootBits;
  // Pass 1: reversed codes, and max length per root prefix for long codes.
  const rev = new Int32Array(count);
  const subMax = maxLen > rootBits ? new Int32Array(rootSize) : null;
  for (let s = 0; s < count; s++) {
    const len = lengths[start + s];
    if (len === 0) continue;
    const r = reverseBits(next[len]++, len);
    rev[s] = r;
    if (subMax && len > rootBits) {
      const p = r & (rootSize - 1);
      if (len > subMax[p]) subMax[p] = len;
    }
  }
  let total = rootSize;
  const subOffset = subMax ? new Int32Array(rootSize) : null;
  if (subMax && subOffset) {
    for (let p = 0; p < rootSize; p++) {
      if (subMax[p]) {
        subOffset[p] = total;
        total += 1 << (subMax[p] - rootBits);
      }
    }
  }
  const table = new Int32Array(total);
  if (subMax && subOffset) {
    for (let p = 0; p < rootSize; p++) {
      if (subMax[p]) table[p] = (subOffset[p] << 8) | 0x80 | (subMax[p] - rootBits);
    }
  }
  for (let s = 0; s < count; s++) {
    const len = lengths[start + s];
    if (len === 0) continue;
    const r = rev[s];
    if (len <= rootBits) {
      const entry = (s << 8) | len;
      for (let i = r; i < rootSize; i += 1 << len) table[i] = entry;
    } else {
      const p = r & (rootSize - 1);
      const subBits = subMax![p] - rootBits;
      const off = subOffset![p];
      const sl = len - rootBits;
      const entry = (s << 8) | sl;
      for (let i = r >>> rootBits; i < 1 << subBits; i += 1 << sl) table[off + i] = entry;
    }
  }
  return { table, rootBits };
}
