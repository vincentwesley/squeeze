// Strict PNG decoder.

import { crc32 } from '../checksum.js';
import { fail } from '../errors.js';
import { zlibDecompress } from '../zlib.js';
import {
  ALLOWED_DEPTHS,
  type BitDepth,
  CHANNELS,
  type ColorType,
  PNG_SIGNATURE,
  type PngHeader,
  passes,
  rawDataSize,
  rowBytes,
} from './common.js';
import { unfilter } from './filter.js';

export interface PngChunkInfo {
  type: string;
  /** Offset of the chunk's length field in the file. */
  offset: number;
  length: number;
}

export interface DecodedPng {
  width: number;
  height: number;
  /** Bits per channel of `data`: 16 for 16-bit images, otherwise 8. */
  depth: 8 | 16;
  /** Non-interlaced RGBA pixels, row-major. */
  data: Uint8Array | Uint16Array;
  header: PngHeader;
  /** Palette as RGBA quadruples (colour type 3, or a suggested palette for types 2/6). */
  palette?: Uint8Array;
  /** Raw tRNS chunk data. */
  transparency?: Uint8Array;
  /** Gamma from gAMA (e.g. 0.45455), if present. */
  gamma?: number;
  /** Keyword → text from tEXt chunks. */
  text: Record<string, string>;
  chunks: PngChunkInfo[];
}

export interface PngDecodeOptions {
  /** Reject images with more pixels than this (default 2^26 ≈ 67 million). */
  maxPixels?: number;
  /** Return 8-bit RGBA even for 16-bit images. */
  forceRgba8?: boolean;
}

function chunkType(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

/** Decode a PNG file to RGBA. Throws SqueezeError on any malformed input. */
export function decodePng(file: Uint8Array, options: PngDecodeOptions = {}): DecodedPng {
  const maxPixels = options.maxPixels ?? 1 << 26;
  if (file.length < 8) fail('BAD_SIGNATURE', 'file too short to be a PNG');
  for (let i = 0; i < 8; i++)
    if (file[i] !== PNG_SIGNATURE[i]) fail('BAD_SIGNATURE', 'not a PNG file (bad signature)');

  let header: PngHeader | null = null;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  let gamma: number | undefined;
  const text: Record<string, string> = {};
  const chunks: PngChunkInfo[] = [];
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  let idatDone = false; // a non-IDAT chunk followed IDAT
  let sawIend = false;

  let p = 8;
  while (p < file.length) {
    if (p + 12 > file.length) fail('UNEXPECTED_EOF', 'truncated chunk');
    const length = u32(file, p);
    if (length > 0x7fffffff) fail('BAD_CHUNK', 'chunk length exceeds 2^31-1');
    for (let i = 4; i < 8; i++) if (!isLetter(file[p + i])) fail('BAD_CHUNK', 'invalid chunk type');
    const type = chunkType(file, p + 4);
    if (p + 12 + length > file.length) fail('UNEXPECTED_EOF', `truncated ${type} chunk`);
    const data = file.subarray(p + 8, p + 8 + length);
    if (crc32(file, 0, p + 4, p + 8 + length) !== u32(file, p + 8 + length))
      fail('BAD_CRC', `CRC error in ${type} chunk`);
    chunks.push({ type, offset: p, length });
    p += 12 + length;

    if (!header && type !== 'IHDR') fail('BAD_CHUNK', 'first chunk is not IHDR');
    if (idat.length > 0 && type !== 'IDAT') idatDone = true;
    switch (type) {
      case 'IHDR': {
        if (header) fail('BAD_CHUNK', 'duplicate IHDR');
        if (length !== 13) fail('BAD_IHDR', 'IHDR has wrong length');
        const width = u32(data, 0);
        const height = u32(data, 4);
        const bitDepth = data[8];
        const colorType = data[9];
        if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff)
          fail('BAD_IHDR', 'invalid image dimensions');
        if (!(colorType in ALLOWED_DEPTHS)) fail('BAD_IHDR', `invalid colour type ${colorType}`);
        if (!ALLOWED_DEPTHS[colorType].includes(bitDepth))
          fail('BAD_IHDR', `invalid bit depth ${bitDepth} for colour type ${colorType}`);
        if (data[10] !== 0) fail('BAD_IHDR', 'unknown compression method');
        if (data[11] !== 0) fail('BAD_IHDR', 'unknown filter method');
        if (data[12] > 1) fail('BAD_IHDR', 'unknown interlace method');
        if (width * height > maxPixels) fail('UNSUPPORTED', `image has more than ${maxPixels} pixels`);
        header = {
          width,
          height,
          bitDepth: bitDepth as BitDepth,
          colorType: colorType as ColorType,
          compression: 0,
          filter: 0,
          interlace: data[12] as 0 | 1,
        };
        break;
      }
      case 'PLTE': {
        const h = header!;
        if (palette) fail('BAD_PALETTE', 'duplicate PLTE');
        if (idat.length) fail('BAD_CHUNK', 'PLTE after IDAT');
        if (transparency) fail('BAD_CHUNK', 'PLTE after tRNS');
        if (h.colorType === 0 || h.colorType === 4) fail('BAD_PALETTE', 'PLTE not allowed for greyscale');
        const n = length / 3;
        if (length % 3 !== 0 || n < 1 || n > 256) fail('BAD_PALETTE', 'invalid PLTE length');
        if (h.colorType === 3 && n > 1 << h.bitDepth)
          fail('BAD_PALETTE', 'too many palette entries for bit depth');
        palette = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) {
          palette[4 * i] = data[3 * i];
          palette[4 * i + 1] = data[3 * i + 1];
          palette[4 * i + 2] = data[3 * i + 2];
          palette[4 * i + 3] = 255;
        }
        break;
      }
      case 'tRNS': {
        const h = header!;
        if (transparency) fail('BAD_CHUNK', 'duplicate tRNS');
        if (idat.length) fail('BAD_CHUNK', 'tRNS after IDAT');
        if (h.colorType === 3) {
          if (!palette) fail('BAD_CHUNK', 'tRNS before PLTE');
          if (length > palette.length / 4) fail('BAD_CHUNK', 'tRNS has more entries than PLTE');
          for (let i = 0; i < length; i++) palette[4 * i + 3] = data[i];
        } else if (h.colorType === 0) {
          if (length !== 2) fail('BAD_CHUNK', 'invalid tRNS length');
        } else if (h.colorType === 2) {
          if (length !== 6) fail('BAD_CHUNK', 'invalid tRNS length');
        } else fail('BAD_CHUNK', 'tRNS not allowed with an alpha channel');
        transparency = data.slice();
        break;
      }
      case 'IDAT':
        if (idatDone) fail('BAD_CHUNK', 'IDAT chunks are not consecutive');
        idat.push(data);
        idatLen += length;
        break;
      case 'IEND':
        if (length !== 0) fail('BAD_CHUNK', 'IEND has data');
        sawIend = true;
        break;
      case 'gAMA':
        if (length === 4 && !idat.length) gamma = u32(data, 0) / 100000;
        break;
      case 'tEXt': {
        const z = data.indexOf(0);
        if (z > 0) {
          let k = '';
          for (let i = 0; i < z; i++) k += String.fromCharCode(data[i]);
          let v = '';
          for (let i = z + 1; i < data.length; i++) v += String.fromCharCode(data[i]);
          text[k] = v;
        }
        break;
      }
      default:
        // Unknown critical chunks (uppercase first letter) cannot be safely ignored.
        if ((file[p - 12 - length + 4] & 0x20) === 0) fail('UNSUPPORTED', `unknown critical chunk ${type}`);
    }
    if (sawIend) break;
  }
  if (!header) fail('BAD_CHUNK', 'missing IHDR');
  if (!sawIend) fail('UNEXPECTED_EOF', 'missing IEND');
  if (idat.length === 0) fail('BAD_IMAGE_DATA', 'missing IDAT');
  if (header.colorType === 3 && !palette) fail('BAD_PALETTE', 'missing PLTE for indexed image');

  // Inflate the concatenated IDAT stream.
  const z = new Uint8Array(idatLen);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  const expected = rawDataSize(header);
  const raw = zlibDecompress(z, {
    maxOutputLength: expected,
    sizeHint: Math.min(expected, idatLen * 8 + 1024),
  });
  if (raw.length !== expected)
    fail('BAD_IMAGE_DATA', `image data too short (${raw.length} of ${expected} bytes)`);

  return {
    ...toRgba(header, raw, palette, transparency, options.forceRgba8 === true),
    header,
    palette: header.colorType === 3 || palette ? palette : undefined,
    transparency,
    gamma,
    text,
    chunks,
  };
}

function toRgba(
  h: PngHeader,
  raw: Uint8Array,
  palette: Uint8Array | undefined,
  trns: Uint8Array | undefined,
  force8: boolean,
): { width: number; height: number; depth: 8 | 16; data: Uint8Array | Uint16Array } {
  const { width, height, bitDepth, colorType } = h;
  const sixteen = bitDepth === 16 && !force8;
  const out = sixteen ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  const channels = CHANNELS[colorType];
  const bpp = Math.max(1, (bitDepth * channels) >> 3);
  const maxIn = (1 << bitDepth) - 1;
  const maxOut = sixteen ? 65535 : 255;
  // Scale factor for sub-8-bit greyscale; 16→8 uses rounding like libpng's/pngjs's scaling.
  const scale = (v: number) =>
    bitDepth === 16 ? (sixteen ? v : Math.round((v * 255) / 65535)) : bitDepth === 8 ? v : (v * 255) / maxIn;
  const trnsGray = trns && colorType === 0 ? (trns[0] << 8) | trns[1] : -1;
  const trnsR = trns && colorType === 2 ? (trns[0] << 8) | trns[1] : -1;
  const trnsG = trns && colorType === 2 ? (trns[2] << 8) | trns[3] : -1;
  const trnsB = trns && colorType === 2 ? (trns[4] << 8) | trns[5] : -1;
  const palCount = palette ? palette.length / 4 : 0;

  let off = 0;
  for (const pass of passes(width, height, h.interlace)) {
    if (pass.width === 0 || pass.height === 0) continue;
    const stride = rowBytes(pass.width, bitDepth, colorType);
    const pix = unfilter(raw, off, stride, pass.height, bpp);
    off += (stride + 1) * pass.height;
    for (let y = 0; y < pass.height; y++) {
      const row = y * stride;
      let d = ((pass.yStart + y * pass.yStep) * width + pass.xStart) * 4;
      const dStep = pass.xStep * 4;
      // Sample reader for this row.
      let bitPos = 0;
      const next = (): number => {
        if (bitDepth === 8) return pix[row + bitPos++];
        if (bitDepth === 16) {
          const v = (pix[row + 2 * bitPos] << 8) | pix[row + 2 * bitPos + 1];
          bitPos++;
          return v;
        }
        const byte = pix[row + (bitPos >> 3)];
        const v = (byte >> (8 - bitDepth - (bitPos & 7))) & maxIn;
        bitPos += bitDepth;
        return v;
      };
      for (let x = 0; x < pass.width; x++, d += dStep) {
        switch (colorType) {
          case 0: {
            const v = next();
            const g = scale(v);
            out[d] = out[d + 1] = out[d + 2] = g;
            out[d + 3] = v === trnsGray ? 0 : maxOut;
            break;
          }
          case 2: {
            const r = next();
            const g = next();
            const b = next();
            out[d] = scale(r);
            out[d + 1] = scale(g);
            out[d + 2] = scale(b);
            out[d + 3] = r === trnsR && g === trnsG && b === trnsB ? 0 : maxOut;
            break;
          }
          case 3: {
            const i = next();
            if (i >= palCount) fail('BAD_PALETTE', `palette index ${i} out of range`);
            out[d] = palette![4 * i];
            out[d + 1] = palette![4 * i + 1];
            out[d + 2] = palette![4 * i + 2];
            out[d + 3] = palette![4 * i + 3];
            break;
          }
          case 4: {
            const g = scale(next());
            out[d] = out[d + 1] = out[d + 2] = g;
            out[d + 3] = scale(next());
            break;
          }
          default: {
            out[d] = scale(next());
            out[d + 1] = scale(next());
            out[d + 2] = scale(next());
            out[d + 3] = scale(next());
          }
        }
      }
    }
  }
  return { width, height, depth: sixteen ? 16 : 8, data: out };
}
