import { BitWriter } from '../bitio.js';
import { fail } from '../errors.js';
import type { Trace } from '../trace.js';
import { BlockWriter } from './blocks.js';
import { compressGreedy, compressLazy, LEVELS } from './lz77.js';
import { compressOptimal, OPTIMAL_LEVELS } from './optimal.js';

export interface DeflateOptions {
  /**
   * 0 = stored only, 1–3 = greedy, 4–9 = lazy matching (zlib's parameters),
   * 10–12 = near-optimal parsing (slow, smallest). Default 6.
   */
  level?: number;
  /** Preset dictionary; the decoder must be given the same bytes. */
  dictionary?: Uint8Array;
  /** Record blocks and tokens. */
  trace?: Trace;
  /** Maximum tokens per block (default 32768). Smaller is useful for visualisation. */
  maxBlockTokens?: number;
}

export const MAX_LEVEL = 12;

/** Compress to a raw DEFLATE stream (RFC 1951). */
export function deflateRaw(input: Uint8Array, options: DeflateOptions = {}): Uint8Array {
  const level = options.level ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL)
    fail('BAD_ARGUMENT', `level must be an integer 0..${MAX_LEVEL}`);
  const dict = options.dictionary?.subarray(Math.max(0, options.dictionary.length - 32768));
  let buf = input;
  let start = 0;
  if (dict && dict.length > 0) {
    buf = new Uint8Array(dict.length + input.length);
    buf.set(dict);
    buf.set(input, dict.length);
    start = dict.length;
  }
  const w = new BitWriter(Math.max(1024, (input.length >>> 1) + 64));
  const maxBlockTokens = options.maxBlockTokens ?? 32768;
  if (level === 0) {
    // Stored blocks only.
    const bw = new BlockWriter(buf, start, { maxBlockTokens: 1, split: false, trace: options.trace }, w);
    let p = start;
    do {
      const n = Math.min(65535, buf.length - p);
      bw.blockStart = p;
      bw.rawPos = p + n;
      p += n;
      bw.flushStored(p >= buf.length);
    } while (p < buf.length);
    return w.finish();
  }
  const bw = new BlockWriter(buf, start, { maxBlockTokens, split: true, trace: options.trace }, w);
  if (level >= 10) compressOptimal(bw, buf, start, OPTIMAL_LEVELS[level]);
  else if (LEVELS[level].lazyMatching) compressLazy(bw, buf, start, LEVELS[level]);
  else compressGreedy(bw, buf, start, LEVELS[level]);
  bw.flush(true);
  return w.finish();
}
