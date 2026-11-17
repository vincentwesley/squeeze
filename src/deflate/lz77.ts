// Hash-chain LZ77 match finding with zlib's greedy ("fast") and lazy ("slow") strategies.

import type { BlockWriter } from './blocks.js';

export const WSIZE = 32768;
export const WMASK = WSIZE - 1;
export const MAX_MATCH = 258;
export const MIN_MATCH = 3;
export const HASH_BITS = 15;
export const HASH_SIZE = 1 << HASH_BITS;
/** zlib drops 3-byte matches farther than this: they rarely pay for themselves. */
const TOO_FAR = 4096;

export interface LevelConfig {
  good: number;
  lazy: number;
  nice: number;
  chain: number;
  lazyMatching: boolean;
}

/** zlib's configuration table (deflate.c), levels 1..9. */
export const LEVELS: LevelConfig[] = [
  { good: 0, lazy: 0, nice: 0, chain: 0, lazyMatching: false },
  { good: 4, lazy: 4, nice: 8, chain: 4, lazyMatching: false },
  { good: 4, lazy: 5, nice: 16, chain: 8, lazyMatching: false },
  { good: 4, lazy: 6, nice: 32, chain: 32, lazyMatching: false },
  { good: 4, lazy: 4, nice: 16, chain: 16, lazyMatching: true },
  { good: 8, lazy: 16, nice: 32, chain: 32, lazyMatching: true },
  { good: 8, lazy: 16, nice: 128, chain: 128, lazyMatching: true },
  { good: 8, lazy: 32, nice: 128, chain: 256, lazyMatching: true },
  { good: 32, lazy: 128, nice: 258, chain: 1024, lazyMatching: true },
  { good: 32, lazy: 258, nice: 258, chain: 4096, lazyMatching: true },
];

export function hash3(buf: Uint8Array, p: number): number {
  return (Math.imul(buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16), 0x1e35a7bd) >>> (32 - HASH_BITS)) | 0;
}

/** Hash chains: head[h] = most recent position with hash h; prev[p & WMASK] = previous one. */
export class HashChains {
  readonly head = new Int32Array(HASH_SIZE).fill(-1);
  readonly prev = new Int32Array(WSIZE).fill(-1);
  /** Result of the last `longest` call. */
  matchDist = 0;

  constructor(readonly buf: Uint8Array) {}

  /** Insert position p (needs p + 2 < buf.length); returns the previous head for its hash. */
  insert(p: number): number {
    const h = hash3(this.buf, p);
    const old = this.head[h];
    this.prev[p & WMASK] = old;
    this.head[h] = p;
    return old;
  }

  /**
   * Longest match at `pos` starting from chain entry `cur`, longer than `bestLen`.
   * Returns the length (or bestLen if nothing longer) and sets `matchDist`.
   */
  longest(pos: number, cur: number, bestLen: number, chain: number, nice: number, end: number): number {
    const buf = this.buf;
    const prev = this.prev;
    const maxLen = Math.min(MAX_MATCH, end - pos);
    if (maxLen < MIN_MATCH) return bestLen;
    if (nice > maxLen) nice = maxLen;
    const limit = pos > WSIZE ? pos - WSIZE : 0;
    let scanEnd = buf[pos + bestLen];
    let scanEnd1 = buf[pos + bestLen - 1];
    const b0 = buf[pos];
    const b1 = buf[pos + 1];
    while (cur >= limit && chain-- > 0) {
      if (
        buf[cur + bestLen] === scanEnd &&
        buf[cur + bestLen - 1] === scanEnd1 &&
        buf[cur] === b0 &&
        buf[cur + 1] === b1
      ) {
        let len = 2;
        while (len < maxLen && buf[cur + len] === buf[pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          this.matchDist = pos - cur;
          if (len >= nice) break;
          scanEnd = buf[pos + bestLen];
          scanEnd1 = buf[pos + bestLen - 1];
        }
      }
      const next = prev[cur & WMASK];
      if (next >= cur) break;
      cur = next;
    }
    return bestLen;
  }
}

/** zlib's deflate_fast: take the longest match at each position, no lazy evaluation. */
export function compressGreedy(bw: BlockWriter, buf: Uint8Array, start: number, cfg: LevelConfig): void {
  const end = buf.length;
  const hc = new HashChains(buf);
  for (let p = Math.max(0, start - WSIZE); p < start && p + 2 < end; p++) hc.insert(p);
  let pos = start;
  while (pos < end) {
    let len = 0;
    if (pos + 2 < end) {
      const head = hc.insert(pos);
      if (head >= 0 && pos - head <= WSIZE)
        len = hc.longest(pos, head, MIN_MATCH - 1, cfg.chain, cfg.nice, end);
    }
    if (len >= MIN_MATCH) {
      bw.match(len, hc.matchDist);
      const stop = pos + len;
      if (len <= cfg.lazy) {
        for (let p = pos + 1; p < stop && p + 2 < end; p++) hc.insert(p);
      }
      pos = stop;
    } else {
      bw.literal(buf[pos]);
      pos++;
    }
  }
}

/** zlib's deflate_slow: lazy evaluation — prefer a longer match starting one byte later. */
export function compressLazy(bw: BlockWriter, buf: Uint8Array, start: number, cfg: LevelConfig): void {
  const end = buf.length;
  const hc = new HashChains(buf);
  for (let p = Math.max(0, start - WSIZE); p < start && p + 2 < end; p++) hc.insert(p);
  let pos = start;
  let prevLen = MIN_MATCH - 1;
  let prevDist = 0;
  let matchAvailable = false;
  while (pos < end) {
    let head = -1;
    if (pos + 2 < end) head = hc.insert(pos);
    let len = MIN_MATCH - 1;
    let dist = 0;
    if (head >= 0 && prevLen < cfg.lazy && pos - head <= WSIZE) {
      const chain = prevLen >= cfg.good ? cfg.chain >> 2 : cfg.chain;
      len = hc.longest(pos, head, prevLen, chain, cfg.nice, end);
      if (len > prevLen) dist = hc.matchDist;
      else len = MIN_MATCH - 1;
      if (len === MIN_MATCH && dist > TOO_FAR) len = MIN_MATCH - 1;
    }
    if (prevLen >= MIN_MATCH && len <= prevLen) {
      // Emit the previous match, which started at pos - 1.
      bw.match(prevLen, prevDist);
      const stop = pos - 1 + prevLen;
      for (let p = pos + 1; p < stop && p + 2 < end; p++) hc.insert(p);
      pos = stop;
      matchAvailable = false;
      prevLen = MIN_MATCH - 1;
    } else {
      if (matchAvailable) bw.literal(buf[pos - 1]);
      matchAvailable = true;
      prevLen = len;
      prevDist = dist;
      pos++;
    }
  }
  if (matchAvailable) bw.literal(buf[pos - 1]);
}
