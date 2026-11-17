import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS helper without types
import { fetchCorpus } from '../../scripts/fetch-corpora.mjs';
import { decodePng, encodePng, optimisePng, SqueezeError } from '../../src/index.js';

let dir = '';
let files: string[] = [];
beforeAll(async () => {
  dir = await fetchCorpus('pngsuite');
  files = readdirSync(dir).filter((f) => f.endsWith('.png'));
});

/**
 * pngjs zeroes the RGB of pixels made transparent by a tRNS colour key; Squeeze keeps the
 * colour (the spec only sets alpha). Treat fully transparent pixels as equal when RGB differs.
 */
function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] !== b[i + 3]) return false;
    if (a[i + 3] === 0) continue;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) return false;
  }
  return true;
}

/** Widen 8-bit RGBA to 16-bit when comparing against a 16-bit original. */
function asDepth(d: Uint8Array | Uint16Array, depth: 8 | 16): Uint8Array | Uint16Array {
  if (depth === 8 || d instanceof Uint16Array) return d;
  return Uint16Array.from(d, (v) => v * 257);
}

function reference(buf: Buffer): Uint8Array {
  const png = PNG.sync.read(buf);
  return new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
}

describe('PngSuite', () => {
  it('has the expected files', () => {
    expect(files.length).toBe(176);
    expect(files.filter((f) => f.startsWith('x')).length).toBe(14);
  });

  it('decodes every valid image to the same RGBA8 pixels as pngjs', () => {
    const failures: string[] = [];
    for (const f of files.filter((f) => !f.startsWith('x'))) {
      const buf = readFileSync(join(dir, f));
      try {
        const ours = decodePng(buf, { forceRgba8: true });
        const ref = reference(buf);
        if (!samePixels(ours.data as Uint8Array, ref)) failures.push(`${f}: pixels differ`);
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('rejects every broken (x*) image with a SqueezeError', () => {
    for (const f of files.filter((f) => f.startsWith('x'))) {
      const buf = readFileSync(join(dir, f));
      let err: unknown = null;
      try {
        decodePng(buf);
      } catch (e) {
        err = e;
      }
      expect(err, f).toBeInstanceOf(SqueezeError);
    }
  });

  it('re-encodes every valid image losslessly (default and optimised), readable by pngjs', () => {
    for (const f of files.filter((f) => !f.startsWith('x'))) {
      const img = decodePng(readFileSync(join(dir, f)));
      for (const png of [
        encodePng(img),
        encodePng(img, { interlace: true, level: 1 }),
        optimisePng(img, { level: 9 }).png,
      ]) {
        const back = decodePng(png);
        expect(asDepth(back.data, img.depth), f).toEqual(img.data);
        const ref = reference(Buffer.from(png));
        const ours8 = decodePng(png, { forceRgba8: true }).data as Uint8Array;
        expect(samePixels(ours8, ref), `${f} via pngjs`).toBe(true);
      }
    }
  });
});
