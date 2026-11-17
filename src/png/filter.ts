// Scanline filters (PNG §9). Filtering works on bytes; `bpp` is bytes per complete pixel (≥ 1).

import { fail } from '../errors.js';

export enum Filter {
  None = 0,
  Sub = 1,
  Up = 2,
  Average = 3,
  Paeth = 4,
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Undo filtering in place. `data` holds `height` rows of (1 + stride) bytes starting at `offset`.
 * Returns the unfiltered pixels as a new array of height * stride bytes.
 */
export function unfilter(
  data: Uint8Array,
  offset: number,
  stride: number,
  height: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(stride * height);
  let prev = -1; // offset of previous unfiltered row in `out`, -1 for none
  for (let y = 0; y < height; y++) {
    const ft = data[offset];
    const src = offset + 1;
    const dst = y * stride;
    offset += stride + 1;
    switch (ft) {
      case 0:
        out.set(data.subarray(src, src + stride), dst);
        break;
      case 1:
        for (let i = 0; i < stride; i++)
          out[dst + i] = (data[src + i] + (i >= bpp ? out[dst + i - bpp] : 0)) & 255;
        break;
      case 2:
        if (prev < 0) out.set(data.subarray(src, src + stride), dst);
        else for (let i = 0; i < stride; i++) out[dst + i] = (data[src + i] + out[prev + i]) & 255;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = prev >= 0 ? out[prev + i] : 0;
          out[dst + i] = (data[src + i] + ((a + b) >>> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = prev >= 0 ? out[prev + i] : 0;
          const c = i >= bpp && prev >= 0 ? out[prev + i - bpp] : 0;
          out[dst + i] = (data[src + i] + paeth(a, b, c)) & 255;
        }
        break;
      default:
        fail('BAD_FILTER', `invalid filter type ${ft} on row ${y}`);
    }
    prev = dst;
  }
  return out;
}

/** Apply filter `ft` to one row. `prev` is the previous unfiltered row or null. Writes stride bytes to out[o..]. */
export function filterRow(
  ft: number,
  row: Uint8Array,
  r: number,
  prev: Uint8Array | null,
  p: number,
  stride: number,
  bpp: number,
  out: Uint8Array,
  o: number,
): void {
  switch (ft) {
    case 0:
      out.set(row.subarray(r, r + stride), o);
      break;
    case 1:
      for (let i = 0; i < stride; i++) out[o + i] = (row[r + i] - (i >= bpp ? row[r + i - bpp] : 0)) & 255;
      break;
    case 2:
      for (let i = 0; i < stride; i++) out[o + i] = (row[r + i] - (prev ? prev[p + i] : 0)) & 255;
      break;
    case 3:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[r + i - bpp] : 0;
        const b = prev ? prev[p + i] : 0;
        out[o + i] = (row[r + i] - ((a + b) >>> 1)) & 255;
      }
      break;
    default:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[r + i - bpp] : 0;
        const b = prev ? prev[p + i] : 0;
        const c = i >= bpp && prev ? prev[p + i - bpp] : 0;
        out[o + i] = (row[r + i] - paeth(a, b, c)) & 255;
      }
  }
}
