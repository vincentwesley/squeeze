// Shared PNG definitions (W3C PNG Specification, Third Edition).

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export type ColorType = 0 | 2 | 3 | 4 | 6;
export type BitDepth = 1 | 2 | 4 | 8 | 16;

/** Allowed bit depths per colour type. */
export const ALLOWED_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: BitDepth;
  colorType: ColorType;
  compression: number;
  filter: number;
  interlace: 0 | 1;
}

/** Adam7 passes: [xStart, yStart, xStep, yStep]. */
export const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

export interface PassGeometry {
  /** Pass size in pixels (0 if the pass is empty). */
  width: number;
  height: number;
  xStart: number;
  yStart: number;
  xStep: number;
  yStep: number;
}

/** Sub-images making up the image: one for non-interlaced, seven (some possibly empty) for Adam7. */
export function passes(width: number, height: number, interlace: 0 | 1): PassGeometry[] {
  if (!interlace) return [{ width, height, xStart: 0, yStart: 0, xStep: 1, yStep: 1 }];
  return ADAM7.map(([xs, ys, dx, dy]) => ({
    width: width > xs ? Math.ceil((width - xs) / dx) : 0,
    height: height > ys ? Math.ceil((height - ys) / dy) : 0,
    xStart: xs,
    yStart: ys,
    xStep: dx,
    yStep: dy,
  }));
}

/** Bytes per scanline (excluding the filter byte). */
export function rowBytes(width: number, bitDepth: number, colorType: number): number {
  return Math.ceil((width * bitDepth * CHANNELS[colorType]) / 8);
}

/** Total filtered image data size (with filter bytes) for a header. */
export function rawDataSize(h: PngHeader): number {
  let total = 0;
  for (const p of passes(h.width, h.height, h.interlace)) {
    if (p.width === 0 || p.height === 0) continue;
    total += (rowBytes(p.width, h.bitDepth, h.colorType) + 1) * p.height;
  }
  return total;
}
