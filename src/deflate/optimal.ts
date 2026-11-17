// Near-optimal parsing (levels 10-12), in the spirit of Zopfli and libdeflate's high levels.
// For each segment: collect, at every position, the shortest distance for every reachable
// match length; then repeatedly find the cheapest parse (a shortest path over positions)
// under a cost model taken from the previous parse's symbol statistics.

import { buildCodeLengths } from '../huffman.js';
import { DIST_EXTRA, distCode, LENGTH_EXTRA, LENGTH_TO_CODE } from '../tables.js';
import { buildDynamicCode, dataBits, type BlockWriter } from './blocks.js';
import { HashChains, MAX_MATCH, MIN_MATCH, WSIZE } from './lz77.js';

export interface OptimalConfig {
  chain: number;
  iterations: number;
  segment: number;
}

export const OPTIMAL_LEVELS: Record<number, OptimalConfig> = {
  10: { chain: 256, iterations: 2, segment: 1 << 17 },
  11: { chain: 1024, iterations: 6, segment: 1 << 17 },
  12: { chain: 4096, iterations: 15, segment: 1 << 17 },
};

/** Matches at least this long are taken directly; interior positions are not searched. */
const LONG_MATCH = 258;
const GOOD_MATCH = 32;

export function compressOptimal(bw: BlockWriter, buf: Uint8Array, start: number, cfg: OptimalConfig): void {
  const end = buf.length;
  const hc = new HashChains(buf);
  for (let p = Math.max(0, start - WSIZE); p < start && p + 2 < end; p++) hc.insert(p);

  let pairLen = new Int32Array(1 << 16);
  let pairDist = new Int32Array(1 << 16);

  for (let segStart = start; segStart < end; segStart += cfg.segment) {
    const segEnd = Math.min(end, segStart + cfg.segment);
    const n = segEnd - segStart;
    const posStart = new Int32Array(n + 1);
    const forced = new Uint8Array(n);
    let np = 0;

    // 1. Match candidates.
    for (let i = 0; i < n; ) {
      const pos = segStart + i;
      posStart[i] = np;
      if (pos + 2 >= end) {
        i++;
        continue;
      }
      let cur = hc.insert(pos);
      const maxLen = Math.min(MAX_MATCH, segEnd - pos);
      if (maxLen >= MIN_MATCH && cur >= 0) {
        // Walk the chain; record (length, distance) every time the best length improves.
        const limit = pos > WSIZE ? pos - WSIZE : 0;
        let best = MIN_MATCH - 1;
        let chain = cfg.chain;
        const prev = hc.prev;
        while (cur >= limit && chain-- > 0) {
          if (buf[cur + best] === buf[pos + best] && buf[cur] === buf[pos]) {
            let len = 0;
            while (len < maxLen && buf[cur + len] === buf[pos + len]) len++;
            if (len > best) {
              if (np >= pairLen.length) {
                const a = new Int32Array(pairLen.length * 2);
                a.set(pairLen);
                pairLen = a;
                const b = new Int32Array(pairDist.length * 2);
                b.set(pairDist);
                pairDist = b;
              }
              pairLen[np] = len;
              pairDist[np++] = pos - cur;
              // Like zlib's good_length: once a decent match is in hand, search less hard.
              if (best < GOOD_MATCH && len >= GOOD_MATCH) chain >>= 2;
              best = len;
              if (len >= maxLen) break;
            }
          }
          const next = prev[cur & 32767];
          if (next >= cur) break;
          cur = next;
        }
        if (best >= LONG_MATCH || (best >= MIN_MATCH && best === maxLen && maxLen >= 64)) {
          // Long match: take it, skip searching its interior.
          forced[i] = 1;
          for (let k = 1; k < best; k++) {
            posStart[i + k] = np;
            if (pos + k + 2 < end) hc.insert(pos + k);
          }
          i += best;
          continue;
        }
      }
      i++;
    }
    posStart[n] = np;

    // 2. Iterate: shortest path under a cost model, refit model to the result.
    const litCost = new Float64Array(286);
    const distSymCost = new Float64Array(30);
    // Initial model: roughly the fixed Huffman code.
    for (let s = 0; s < 286; s++) litCost[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
    for (let s = 0; s < 30; s++) distSymCost[s] = 5;

    const cost = new Float64Array(n + 1);
    const lenTo = new Int32Array(n + 1);
    const distTo = new Int32Array(n + 1);
    const lenCost = new Float64Array(MAX_MATCH + 1);
    let bestTokens: Uint32Array | null = null;
    let bestCount = 0;
    let bestBits = Number.POSITIVE_INFINITY;
    const litFreq = new Int32Array(286);
    const distFreq = new Int32Array(30);

    for (let iter = 0; iter < cfg.iterations; iter++) {
      for (let L = MIN_MATCH; L <= MAX_MATCH; L++) {
        const c = LENGTH_TO_CODE[L];
        lenCost[L] = litCost[257 + c] + LENGTH_EXTRA[c];
      }
      cost.fill(Number.POSITIVE_INFINITY);
      cost[0] = 0;
      for (let i = 0; i < n; i++) {
        const c = cost[i];
        if (forced[i]) {
          const L = pairLen[posStart[i + 1] - 1];
          const d = pairDist[posStart[i + 1] - 1];
          const dc = distCode(d);
          const t = c + lenCost[L] + distSymCost[dc] + DIST_EXTRA[dc];
          if (t < cost[i + L]) {
            cost[i + L] = t;
            lenTo[i + L] = L;
            distTo[i + L] = d;
          }
          continue;
        }
        const lc = c + litCost[buf[segStart + i]];
        if (lc < cost[i + 1]) {
          cost[i + 1] = lc;
          lenTo[i + 1] = 1;
        }
        let prevL = MIN_MATCH - 1;
        for (let k = posStart[i]; k < posStart[i + 1]; k++) {
          const Lmax = pairLen[k];
          const d = pairDist[k];
          const dc = distCode(d);
          const dcost = c + distSymCost[dc] + DIST_EXTRA[dc];
          for (let L = prevL + 1; L <= Lmax; L++) {
            const t = dcost + lenCost[L];
            if (t < cost[i + L]) {
              cost[i + L] = t;
              lenTo[i + L] = L;
              distTo[i + L] = d;
            }
          }
          prevL = Lmax;
        }
      }
      // Backtrack.
      let count = 0;
      for (let i = n; i > 0; i -= lenTo[i]) count++;
      const toks = new Uint32Array(count);
      let k = count;
      for (let i = n; i > 0; ) {
        const L = lenTo[i];
        toks[--k] = L === 1 ? buf[segStart + i - 1] : ((distTo[i] << 16) | L) >>> 0;
        i -= L;
      }
      // Statistics → actual size, and the next cost model.
      litFreq.fill(0);
      distFreq.fill(0);
      for (let j = 0; j < count; j++) {
        const t = toks[j];
        if (t < 256) litFreq[t]++;
        else {
          litFreq[257 + LENGTH_TO_CODE[t & 0xffff]]++;
          distFreq[distCode(t >>> 16)]++;
        }
      }
      litFreq[256] = 1;
      const dyn = buildDynamicCode(litFreq, distFreq);
      const bits = dyn.headerBits + dataBits(litFreq, distFreq, dyn.litLens, dyn.distLens);
      if (bits < bestBits) {
        bestBits = bits;
        bestTokens = toks;
        bestCount = count;
      }
      // Next model: entropy-based costs (fractional bits), unseen symbols priced pessimistically.
      fitCosts(litFreq, litCost, 15);
      fitCosts(distFreq, distSymCost, 15);
    }

    for (let j = 0; j < bestCount; j++) {
      const t = bestTokens![j];
      if (t < 256) bw.literal(t);
      else bw.match(t & 0xffff, t >>> 16);
    }
  }
}

function fitCosts(freq: Int32Array, out: Float64Array, maxBits: number): void {
  let total = 0;
  for (let i = 0; i < freq.length; i++) total += freq[i];
  if (total === 0) {
    out.fill(maxBits / 2);
    return;
  }
  // Blend entropy with the real (length-limited) code lengths to stay close to what is emitted.
  const lens = buildCodeLengths(freq, maxBits);
  const log2t = Math.log2(total);
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] > 0) out[i] = 0.5 * (log2t - Math.log2(freq[i])) + 0.5 * lens[i];
    else out[i] = Math.min(maxBits, log2t + 2);
  }
}
