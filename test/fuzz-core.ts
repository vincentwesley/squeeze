// Fuzzing harness shared by test/fuzz.test.ts (short run) and scripts/fuzz.mjs (long run).
//
// 1. Differential fuzzing of the DEFLATE/zlib/gzip decoders against Node's zlib: mutated
//    streams must be accepted or rejected by both, and when accepted the output must match.
// 2. Robustness fuzzing of the PNG decoder: mutated files (with and without repaired CRCs, so
//    mutations reach the inner decoder) must decode or throw SqueezeError — nothing else.

import * as zlib from 'node:zlib';
import { crc32 } from '../src/checksum.js';
import {
  deflateRaw,
  encodePng,
  gunzip,
  gzip,
  inflateRaw,
  SqueezeError,
  zlibCompress,
  zlibDecompress,
} from '../src/index.js';
import { decodePng } from '../src/png/decode.js';
import { rng } from './helpers.js';

export interface FuzzFailure {
  kind: string;
  detail: string;
  input: Uint8Array;
}

export interface FuzzStats {
  cases: number;
  bothAccepted: number;
  bothRejected: number;
  pngAccepted: number;
  pngRejected: number;
  slowestMs: number;
  failures: FuzzFailure[];
}

const LIMIT = 1 << 22;
type Outcome = { ok: true; data: Uint8Array } | { ok: false; err: string };

function ours(fn: () => Uint8Array): Outcome | { crash: unknown } {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof SqueezeError) return { ok: false, err: e.code };
    return { crash: e };
  }
}

function ref(fn: () => Buffer): Outcome {
  try {
    const b = fn();
    return { ok: true, data: new Uint8Array(b.buffer, b.byteOffset, b.length) };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

function seeds(r: () => number): { raw: Uint8Array[]; plain: Uint8Array[] } {
  const plain: Uint8Array[] = [];
  const words = ['the ', 'quick ', 'brown ', 'fox ', 'jumps ', '\n', 'over ', 'lazy ', 'dog ', '0123456789'];
  for (let k = 0; k < 6; k++) {
    let s = '';
    const n = 20 + Math.floor(r() * 3000);
    while (s.length < n) s += words[Math.floor(r() * words.length)];
    plain.push(new TextEncoder().encode(s));
  }
  plain.push(Uint8Array.from({ length: 2000 }, () => Math.floor(r() * 256)));
  plain.push(new Uint8Array(5000));
  plain.push(new Uint8Array(0));
  const raw: Uint8Array[] = [];
  for (const p of plain) {
    for (const level of [1, 6, 9]) raw.push(new Uint8Array(zlib.deflateRawSync(p, { level })));
    raw.push(new Uint8Array(zlib.deflateRawSync(p, { strategy: zlib.constants.Z_FIXED })));
    for (const level of [0, 4, 12]) raw.push(deflateRaw(p, { level, maxBlockTokens: 512 }));
  }
  return { raw, plain };
}

function mutate(src: Uint8Array, r: () => number, other: Uint8Array): Uint8Array {
  let b = src.slice();
  const ops = 1 + Math.floor(r() * 4);
  for (let k = 0; k < ops; k++) {
    const op = Math.floor(r() * 7);
    if (b.length === 0) b = Uint8Array.of(Math.floor(r() * 256));
    const i = Math.floor(r() * b.length);
    switch (op) {
      case 0:
      case 1: // bit flip, biased toward the start where headers live
        b[op === 0 ? i : Math.floor(i * r() * r())] ^= 1 << Math.floor(r() * 8);
        break;
      case 2: // random byte
        b[i] = Math.floor(r() * 256);
        break;
      case 3: // truncate
        b = b.slice(0, i);
        break;
      case 4: {
        // insert random bytes
        const ins = Uint8Array.from({ length: 1 + Math.floor(r() * 8) }, () => Math.floor(r() * 256));
        const nb = new Uint8Array(b.length + ins.length);
        nb.set(b.subarray(0, i));
        nb.set(ins, i);
        nb.set(b.subarray(i), i + ins.length);
        b = nb;
        break;
      }
      case 5: // delete a range
        b = Uint8Array.from([
          ...b.subarray(0, i),
          ...b.subarray(Math.min(b.length, i + 1 + Math.floor(r() * 16))),
        ]);
        break;
      default: {
        // splice with another stream
        const j = Math.floor(r() * other.length);
        b = Uint8Array.from([...b.subarray(0, i), ...other.subarray(j)]);
      }
    }
  }
  return b;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compare(
  kind: string,
  input: Uint8Array,
  o: ReturnType<typeof ours>,
  z: Outcome,
  stats: FuzzStats,
): void {
  if ('crash' in o) {
    stats.failures.push({ kind, detail: `non-SqueezeError thrown: ${String(o.crash)}`, input });
    return;
  }
  if (o.ok && z.ok) {
    if (!same(o.data, z.data)) stats.failures.push({ kind, detail: 'outputs differ', input });
    else stats.bothAccepted++;
  } else if (!o.ok && !z.ok) stats.bothRejected++;
  else
    stats.failures.push({
      kind,
      detail: o.ok
        ? `squeeze accepted, zlib rejected (${(z as { err: string }).err})`
        : `squeeze rejected (${o.err}), zlib accepted`,
      input,
    });
}

/** Wrap a raw deflate stream as zlib / gzip without recomputing anything from the payload. */
function wrapZlib(raw: Uint8Array, plain: Uint8Array): Uint8Array {
  const z = zlibCompress(plain, { level: 1 });
  return Uint8Array.from([...z.subarray(0, 2), ...raw, ...z.subarray(z.length - 4)]);
}

function pngSeeds(r: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const shapes: [number, number][] = [
    [1, 1],
    [7, 5],
    [16, 16],
    [33, 9],
  ];
  for (const [w, h] of shapes) {
    const rgba = new Uint8Array(w * h * 4);
    const pal = Math.floor(r() * 3);
    for (let i = 0; i < w * h; i++) {
      const v = pal === 0 ? Math.floor(r() * 4) * 80 : Math.floor(r() * 256);
      rgba[4 * i] = v;
      rgba[4 * i + 1] = pal === 1 ? v : Math.floor(r() * 256);
      rgba[4 * i + 2] = pal === 1 ? v : Math.floor(r() * 256);
      rgba[4 * i + 3] = r() < 0.8 ? 255 : Math.floor(r() * 256);
    }
    out.push(encodePng({ width: w, height: h, data: rgba }));
    out.push(encodePng({ width: w, height: h, data: rgba }, { interlace: true }));
    const r16 = Uint16Array.from(rgba, (v, i) => v * 257 + (i % 3));
    out.push(encodePng({ width: w, height: h, data: r16 }));
  }
  return out;
}

/** Recompute every chunk CRC so mutations reach the chunk parser and image decoder. */
function fixCrcs(png: Uint8Array): Uint8Array {
  const b = png.slice();
  let p = 8;
  while (p + 12 <= b.length) {
    const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    if (p + 12 + len > b.length) break;
    const c = crc32(b, 0, p + 4, p + 8 + len);
    b[p + 8 + len] = c >>> 24;
    b[p + 9 + len] = (c >>> 16) & 255;
    b[p + 10 + len] = (c >>> 8) & 255;
    b[p + 11 + len] = c & 255;
    p += 12 + len;
  }
  return b;
}

export function runFuzz(iterations: number, seed = 1): FuzzStats {
  const r = rng(seed);
  const { raw, plain } = seeds(r);
  const pngs = pngSeeds(r);
  const stats: FuzzStats = {
    cases: 0,
    bothAccepted: 0,
    bothRejected: 0,
    pngAccepted: 0,
    pngRejected: 0,
    slowestMs: 0,
    failures: [],
  };
  for (let it = 0; it < iterations; it++) {
    const t0 = performance.now();
    const k = Math.floor(r() * raw.length);
    const base = raw[k];
    const other = raw[Math.floor(r() * raw.length)];
    const mode = it % 5;
    if (mode <= 1) {
      const x = r();
      let m: Uint8Array;
      if (x < 0.05) m = Uint8Array.from({ length: Math.floor(r() * 64) }, () => Math.floor(r() * 256));
      else if (x < 0.2) {
        // Random bits behind a final-dynamic (or fixed) block header: stresses code-set validation.
        m = Uint8Array.from({ length: 8 + Math.floor(r() * 200) }, () => Math.floor(r() * 256));
        m[0] = (m[0] & 0xf8) | (r() < 0.8 ? 0b101 : 0b011);
        if (r() < 0.5) m[1] &= 0xc7; // small HCLEN/HDIST more often
      } else m = mutate(base, r, other);
      // Sometimes use a tiny output limit to exercise OUTPUT_LIMIT against zlib's maxOutputLength.
      const limit = r() < 0.2 ? 1 + Math.floor(r() * 300) : LIMIT;
      compare(
        'raw',
        m,
        ours(() => inflateRaw(m, { maxOutputLength: limit })),
        ref(() => zlib.inflateRawSync(m, { maxOutputLength: limit })),
        stats,
      );
    } else if (mode === 2) {
      const p = plain[Math.floor(k / 7)];
      const m = mutate(wrapZlib(base, p), r, other);
      compare(
        'zlib',
        m,
        ours(() => zlibDecompress(m, { maxOutputLength: LIMIT, allowTrailingData: true })),
        ref(() => zlib.inflateSync(m, { maxOutputLength: LIMIT })),
        stats,
      );
    } else if (mode === 3) {
      const p = plain[Math.floor(k / 7)];
      const g =
        r() < 0.5
          ? gzip(p, { level: 6, name: 'x.txt', headerCrc: r() < 0.5, extra: Uint8Array.of(1, 2, 3, 4) })
          : new Uint8Array(zlib.gzipSync(p));
      const m = mutate(g, r, other);
      compare(
        'gzip',
        m,
        ours(() => gunzip(m, { maxOutputLength: LIMIT })),
        ref(() => zlib.gunzipSync(m, { maxOutputLength: LIMIT })),
        stats,
      );
    } else {
      const src = pngs[Math.floor(r() * pngs.length)];
      let m = mutate(src, r, pngs[Math.floor(r() * pngs.length)]);
      if (r() < 0.7) m = fixCrcs(m);
      try {
        decodePng(m, { maxPixels: 1 << 20 });
        stats.pngAccepted++;
      } catch (e) {
        if (e instanceof SqueezeError) stats.pngRejected++;
        else stats.failures.push({ kind: 'png', detail: `non-SqueezeError thrown: ${String(e)}`, input: m });
      }
    }
    stats.cases++;
    stats.slowestMs = Math.max(stats.slowestMs, performance.now() - t0);
  }
  return stats;
}
