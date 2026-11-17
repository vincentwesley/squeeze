// PNG encoder with lossless colour-type reduction and filter selection.

import { crc32 } from '../checksum.js';
import { fail } from '../errors.js';
import { zlibCompress } from '../zlib.js';
import { type BitDepth, CHANNELS, type ColorType, PNG_SIGNATURE, passes, rowBytes } from './common.js';
import { filterRow } from './filter.js';

/** An RGBA image: 8-bit (Uint8Array/Uint8ClampedArray) or 16-bit (Uint16Array) channels. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray | Uint16Array;
}

export type FilterStrategy = 'none' | 'sub' | 'up' | 'average' | 'paeth' | 'minsum' | 'entropy' | 'auto';

export interface PngEncodeOptions {
  /** DEFLATE level 0–12 (default 6). */
  level?: number;
  /**
   * Row filter choice. 'auto' (default): no filter for palette/low-depth images, otherwise
   * 'minsum' (minimum sum of absolute differences, the PNG spec's recommendation).
   */
  filter?: FilterStrategy;
  /** Force a colour type; default picks the smallest lossless one. */
  colorType?: ColorType;
  /** Adam7 interlacing (default false). */
  interlace?: boolean;
  /** Extra tEXt chunks. */
  text?: Record<string, string>;
}

/** Describes how the image will be stored. */
export interface PngLayout {
  colorType: ColorType;
  bitDepth: BitDepth;
  /** RGBA palette for colour type 3. */
  palette?: Uint8Array;
}

interface Analysis {
  sixteen: boolean;
  /** 16-bit data whose samples all fit in 8 bits (v % 257 == 0). */
  reducible16: boolean;
  opaque: boolean;
  gray: boolean;
  /** Minimum bit depth for greyscale (1, 2, 4, 8 or 16). */
  grayDepth: BitDepth;
  /** Unique colours as packed RGBA8 → count, if ≤ 256 and 8-bit-representable. */
  colors: Map<number, number> | null;
}

function analyse(img: RgbaImage): Analysis {
  const d = img.data;
  const sixteen = d instanceof Uint16Array;
  const n = img.width * img.height;
  const max = sixteen ? 65535 : 255;
  let opaque = true;
  let gray = true;
  let reducible16 = sixteen;
  let colors: Map<number, number> | null = new Map();
  let grayDepth: BitDepth = 1;
  for (let i = 0; i < n; i++) {
    const r = d[4 * i];
    const g = d[4 * i + 1];
    const b = d[4 * i + 2];
    const a = d[4 * i + 3];
    if (a !== max) opaque = false;
    if (r !== g || g !== b) gray = false;
    if (reducible16 && (r % 257 || g % 257 || b % 257 || a % 257)) reducible16 = false;
    if (gray && grayDepth < 16) {
      const v = sixteen ? (r % 257 === 0 ? r / 257 : -1) : r;
      if (v < 0) grayDepth = 16;
      else if (grayDepth < 8) {
        if (grayDepth === 1 && v !== 0 && v !== 255) grayDepth = 2;
        if (grayDepth === 2 && v % 85 !== 0) grayDepth = 4;
        if (grayDepth === 4 && v % 17 !== 0) grayDepth = 8;
      }
    }
    if (colors) {
      if (sixteen && (r % 257 || g % 257 || b % 257 || a % 257)) colors = null;
      else {
        const key = sixteen
          ? ((r / 257) << 24) | ((g / 257) << 16) | ((b / 257) << 8) | (a / 257)
          : (r << 24) | (g << 16) | (b << 8) | a;
        colors.set(key, (colors.get(key) ?? 0) + 1);
        if (colors.size > 256) colors = null;
      }
    }
  }
  if (!gray) grayDepth = sixteen && !reducible16 ? 16 : 8;
  return { sixteen, reducible16, opaque, gray, grayDepth, colors };
}

/** Choose the smallest lossless layout for an image (lodepng-style heuristic). */
export function chooseLayout(img: RgbaImage, forced?: ColorType): PngLayout {
  const a = analyse(img);
  const depth8or16: BitDepth = a.sixteen && !a.reducible16 ? 16 : 8;
  const paletteLayout = (): PngLayout | null => {
    if (!a.colors) return null;
    // Transparent entries first (shorter tRNS), then by frequency.
    const entries = [...a.colors.entries()].sort((x, y) => {
      const ax = x[0] & 255;
      const ay = y[0] & 255;
      if ((ax === 255) !== (ay === 255)) return ax === 255 ? 1 : -1;
      return y[1] - x[1] || x[0] - y[0];
    });
    const pal = new Uint8Array(entries.length * 4);
    entries.forEach(([k], i) => {
      pal[4 * i] = k >>> 24;
      pal[4 * i + 1] = (k >>> 16) & 255;
      pal[4 * i + 2] = (k >>> 8) & 255;
      pal[4 * i + 3] = k & 255;
    });
    const n = entries.length;
    const bitDepth: BitDepth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
    return { colorType: 3, bitDepth, palette: pal };
  };
  if (forced !== undefined) {
    if (forced === 3) {
      const p = paletteLayout();
      if (!p) fail('BAD_ARGUMENT', 'image has more than 256 colours; cannot use a palette');
      return p;
    }
    if ((forced === 0 || forced === 4) && !a.gray) fail('BAD_ARGUMENT', 'image is not greyscale');
    if ((forced === 0 || forced === 2) && !a.opaque) fail('BAD_ARGUMENT', 'image has transparency');
    return { colorType: forced, bitDepth: forced === 0 ? a.grayDepth : depth8or16 };
  }
  if (a.gray && a.opaque) {
    const p = paletteLayout();
    if (p && p.bitDepth < a.grayDepth) return p;
    return { colorType: 0, bitDepth: a.grayDepth };
  }
  const p = paletteLayout();
  if (p && depth8or16 === 8) {
    // A palette wins unless greyscale+alpha would be as small.
    if (!(a.gray && p.bitDepth === 8 && !a.opaque)) return p;
  }
  if (a.gray) return { colorType: 4, bitDepth: depth8or16 };
  return { colorType: a.opaque ? 2 : 6, bitDepth: depth8or16 };
}

/** Pack the image into unfiltered scanlines for one (sub)image. */
function packPass(
  img: RgbaImage,
  layout: PngLayout,
  pass: { width: number; height: number; xStart: number; yStart: number; xStep: number; yStep: number },
  index: Map<number, number> | null,
): Uint8Array {
  const { colorType, bitDepth } = layout;
  const stride = rowBytes(pass.width, bitDepth, colorType);
  const out = new Uint8Array(stride * pass.height);
  const d = img.data;
  const src16 = d instanceof Uint16Array;
  const channels = CHANNELS[colorType];
  for (let y = 0; y < pass.height; y++) {
    const sy = pass.yStart + y * pass.yStep;
    let bit = 0;
    const row = y * stride;
    const put = (v: number) => {
      if (bitDepth === 8) out[row + bit++] = v;
      else if (bitDepth === 16) {
        out[row + 2 * bit] = v >>> 8;
        out[row + 2 * bit + 1] = v & 255;
        bit++;
      } else {
        out[row + (bit >> 3)] |= v << (8 - bitDepth - (bit & 7));
        bit += bitDepth;
      }
    };
    // Convert a channel value to the target depth (only exact reductions are ever requested).
    const conv = (v: number) => {
      if (bitDepth === 16) return src16 ? v : v * 257;
      const v8 = src16 ? v / 257 : v;
      return bitDepth === 8 ? v8 : v8 / (255 / ((1 << bitDepth) - 1));
    };
    for (let x = 0; x < pass.width; x++) {
      const i = (sy * img.width + pass.xStart + x * pass.xStep) * 4;
      if (colorType === 3) {
        const k = src16
          ? ((d[i] / 257) << 24) | ((d[i + 1] / 257) << 16) | ((d[i + 2] / 257) << 8) | (d[i + 3] / 257)
          : (d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3];
        put(index!.get(k)!);
      } else {
        put(conv(d[i]));
        if (channels >= 3) {
          put(conv(d[i + 1]));
          put(conv(d[i + 2]));
        }
        if (channels === 2 || channels === 4) put(conv(d[i + 3]));
      }
    }
  }
  return out;
}

const FIXED: Record<string, number> = { none: 0, sub: 1, up: 2, average: 3, paeth: 4 };

/** Filter scanlines with the chosen strategy; returns filtered data (with filter-type bytes). */
export function filterImage(
  pix: Uint8Array,
  stride: number,
  height: number,
  bpp: number,
  strategy: Exclude<FilterStrategy, 'auto'>,
): Uint8Array {
  const out = new Uint8Array((stride + 1) * height);
  const tmp = strategy === 'minsum' || strategy === 'entropy' ? new Uint8Array(stride) : null;
  const hist = new Int32Array(256);
  for (let y = 0; y < height; y++) {
    const r = y * stride;
    const prev = y > 0 ? pix : null;
    const p = r - stride;
    const o = y * (stride + 1);
    let ft = FIXED[strategy] ?? 0;
    if (tmp) {
      let best = Number.POSITIVE_INFINITY;
      for (let f = 0; f < 5; f++) {
        filterRow(f, pix, r, prev, p, stride, bpp, tmp, 0);
        let score = 0;
        if (strategy === 'minsum') {
          for (let i = 0; i < stride; i++) score += tmp[i] < 128 ? tmp[i] : 256 - tmp[i];
        } else {
          hist.fill(0);
          for (let i = 0; i < stride; i++) hist[tmp[i]]++;
          for (let i = 0; i < 256; i++) if (hist[i]) score -= hist[i] * Math.log2(hist[i] / stride);
        }
        if (score < best) {
          best = score;
          ft = f;
        }
      }
    }
    out[o] = ft;
    filterRow(ft, pix, r, prev, p, stride, bpp, out, o + 1);
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const n = data.length;
  out[0] = n >>> 24;
  out[1] = (n >>> 16) & 255;
  out[2] = (n >>> 8) & 255;
  out[3] = n & 255;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const c = crc32(out, 0, 4, 8 + n);
  out[8 + n] = c >>> 24;
  out[9 + n] = (c >>> 16) & 255;
  out[10 + n] = (c >>> 8) & 255;
  out[11 + n] = c & 255;
  return out;
}

/** Produce the filtered, uncompressed image data for a layout. */
export function filteredData(
  img: RgbaImage,
  layout: PngLayout,
  filter: FilterStrategy,
  interlace: boolean,
): Uint8Array {
  let index: Map<number, number> | null = null;
  if (layout.colorType === 3) {
    index = new Map();
    const pal = layout.palette!;
    for (let i = 0; i < pal.length / 4; i++)
      index.set((pal[4 * i] << 24) | (pal[4 * i + 1] << 16) | (pal[4 * i + 2] << 8) | pal[4 * i + 3] | 0, i);
  }
  const strategy: Exclude<FilterStrategy, 'auto'> =
    filter === 'auto' ? (layout.colorType === 3 || layout.bitDepth < 8 ? 'none' : 'minsum') : filter;
  const bpp = Math.max(1, (layout.bitDepth * CHANNELS[layout.colorType]) >> 3);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const pass of passes(img.width, img.height, interlace ? 1 : 0)) {
    if (pass.width === 0 || pass.height === 0) continue;
    const pix = packPass(img, layout, pass, index);
    const stride = rowBytes(pass.width, layout.bitDepth, layout.colorType);
    const f = filterImage(pix, stride, pass.height, bpp, strategy);
    parts.push(f);
    total += f.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function validate(img: RgbaImage): void {
  const { width, height, data } = img;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 0x7fffffff ||
    height > 0x7fffffff
  )
    fail('BAD_ARGUMENT', 'width and height must be positive integers');
  if (data.length !== width * height * 4)
    fail('BAD_ARGUMENT', 'data must hold width × height × 4 channel values');
}

/** Assemble a PNG file from a layout and already-compressed image data. */
export function assemblePng(
  width: number,
  height: number,
  layout: PngLayout,
  interlace: boolean,
  zdata: Uint8Array,
  text?: Record<string, string>,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr.set([width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255]);
  ihdr.set([height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255], 4);
  ihdr[8] = layout.bitDepth;
  ihdr[9] = layout.colorType;
  ihdr[12] = interlace ? 1 : 0;
  const parts: Uint8Array[] = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  if (text) {
    for (const [k, v] of Object.entries(text)) {
      const b = new Uint8Array(k.length + 1 + v.length);
      for (let i = 0; i < k.length; i++) b[i] = k.charCodeAt(i) & 255;
      for (let i = 0; i < v.length; i++) b[k.length + 1 + i] = v.charCodeAt(i) & 255;
      parts.push(chunk('tEXt', b));
    }
  }
  if (layout.colorType === 3) {
    const pal = layout.palette!;
    const n = pal.length / 4;
    const plte = new Uint8Array(n * 3);
    let trnsLen = 0;
    for (let i = 0; i < n; i++) {
      plte[3 * i] = pal[4 * i];
      plte[3 * i + 1] = pal[4 * i + 1];
      plte[3 * i + 2] = pal[4 * i + 2];
      if (pal[4 * i + 3] !== 255) trnsLen = i + 1;
    }
    parts.push(chunk('PLTE', plte));
    if (trnsLen) {
      const t = new Uint8Array(trnsLen);
      for (let i = 0; i < trnsLen; i++) t[i] = pal[4 * i + 3];
      parts.push(chunk('tRNS', t));
    }
  }
  for (let p = 0; p < zdata.length || p === 0; p += 1 << 16)
    parts.push(chunk('IDAT', zdata.subarray(p, p + (1 << 16))));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encode RGBA pixels as a PNG file. */
export function encodePng(img: RgbaImage, options: PngEncodeOptions = {}): Uint8Array {
  validate(img);
  const layout = chooseLayout(img, options.colorType);
  const interlace = options.interlace === true;
  const raw = filteredData(img, layout, options.filter ?? 'auto', interlace);
  const z = zlibCompress(raw, { level: options.level ?? 6 });
  return assemblePng(img.width, img.height, layout, interlace, z, options.text);
}

export interface OptimiseResult {
  png: Uint8Array;
  layout: PngLayout;
  filter: FilterStrategy;
  /** Every candidate tried, with its size. */
  tried: { filter: FilterStrategy; colorType: ColorType; bitDepth: BitDepth; size: number }[];
}

/**
 * Try several filter strategies (and greyscale vs palette where both are possible) at a fast
 * level, then re-compress the best candidate at `level` (default 9).
 */
export function optimisePng(
  img: RgbaImage,
  options: { level?: number; interlace?: boolean } = {},
): OptimiseResult {
  validate(img);
  const interlace = options.interlace === true;
  const layouts: PngLayout[] = [chooseLayout(img)];
  const a = analyse(img);
  if (layouts[0].colorType === 3 && a.gray && a.opaque) layouts.push(chooseLayout(img, 0));
  if (layouts[0].colorType === 0 && a.colors) layouts.push(chooseLayout(img, 3));
  const filters: FilterStrategy[] = ['none', 'sub', 'up', 'average', 'paeth', 'minsum', 'entropy'];
  const tried: OptimiseResult['tried'] = [];
  let best: { raw: Uint8Array; layout: PngLayout; filter: FilterStrategy; size: number } | null = null;
  for (const layout of layouts) {
    for (const filter of filters) {
      const raw = filteredData(img, layout, filter, interlace);
      const size = zlibCompress(raw, { level: 6 }).length;
      tried.push({ filter, colorType: layout.colorType, bitDepth: layout.bitDepth, size });
      if (!best || size < best.size) best = { raw, layout, filter, size };
    }
  }
  const z = zlibCompress(best!.raw, { level: options.level ?? 9 });
  return {
    png: assemblePng(img.width, img.height, best!.layout, interlace, z),
    layout: best!.layout,
    filter: best!.filter,
    tried,
  };
}
