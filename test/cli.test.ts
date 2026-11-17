import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/index.js';

let cli = '';
let tmp = '';
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'squeeze-cli-'));
  cli = join(tmp, 'squeeze.mjs');
  await build({
    entryPoints: ['cli/squeeze.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: cli,
    logLevel: 'warning',
  });
});

const run = (args: string[], input?: Uint8Array) =>
  spawnSync('node', [cli, ...args], { input, maxBuffer: 1 << 28 });

describe('squeeze CLI', () => {
  const text = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(500));

  it('prints help and version', () => {
    expect(run(['--help']).stdout.toString()).toContain('Usage:');
    expect(run(['--version']).status).toBe(0);
  });

  for (const [fmt, ext, decode] of [
    ['gzip', '.gz', zlib.gunzipSync],
    ['zlib', '.zz', zlib.inflateSync],
    ['raw', '.deflate', zlib.inflateRawSync],
  ] as const) {
    it(`compress/decompress round trip (${fmt})`, () => {
      const f = join(tmp, `t-${fmt}.txt`);
      writeFileSync(f, text);
      expect(run(['compress', f, '-f', fmt, '-l', '9']).status).toBe(0);
      const packed = readFileSync(f + ext);
      expect(new Uint8Array(decode(packed))).toEqual(text);
      expect(run(['compress', f, '-f', fmt]).status).toBe(2); // exists
      const out = join(tmp, `t-${fmt}.out`);
      expect(run(['decompress', f + ext, '-f', fmt, '-o', out]).status).toBe(0);
      expect(new Uint8Array(readFileSync(out))).toEqual(text);
    });
  }

  it('works as a pipe and auto-detects formats', () => {
    const z = run(['compress', '-f', 'zlib'], text).stdout;
    expect(new Uint8Array(run(['decompress'], z).stdout)).toEqual(text);
    const g = zlib.gzipSync(text);
    expect(new Uint8Array(run(['decompress'], g).stdout)).toEqual(text);
  });

  it('fails cleanly on corrupt input', () => {
    const r = run(['decompress', '-f', 'gzip'], Uint8Array.of(1, 2, 3));
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/BAD_HEADER/);
  });

  it('enforces --max-output', () => {
    const r = run(['decompress', '--max-output', '100'], zlib.gzipSync(new Uint8Array(1000)));
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/OUTPUT_LIMIT/);
  });

  it('inspects streams and PNGs', () => {
    const out = run(['inspect', '--tokens', '80'], zlib.deflateRawSync(text)).stdout.toString();
    expect(out).toMatch(/blocks: 1/);
    expect(out).toMatch(/match length/);
    const img = { width: 4, height: 4, data: new Uint8Array(64).fill(200) };
    const p = join(tmp, 'i.png');
    writeFileSync(p, encodePng(img));
    expect(run(['png', 'info', p]).stdout.toString()).toMatch(/IHDR/);
  });

  it('encodes PAM/PPM to PNG, decodes back, and optimises', () => {
    const w = 5;
    const h = 3;
    const rgb = Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * 53) & 255);
    const ppm = Uint8Array.from([...new TextEncoder().encode(`P6\n# comment\n${w} ${h}\n255\n`), ...rgb]);
    const ppmPath = join(tmp, 'a.ppm');
    writeFileSync(ppmPath, ppm);
    const pngPath = join(tmp, 'a.png');
    expect(run(['png', 'encode', ppmPath, '-o', pngPath]).status).toBe(0);
    const img = decodePng(readFileSync(pngPath));
    for (let i = 0; i < w * h; i++) {
      expect([img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2], img.data[4 * i + 3]]).toEqual([
        ...rgb.subarray(3 * i, 3 * i + 3),
        255,
      ]);
    }
    const pam = join(tmp, 'a.pam');
    expect(run(['png', 'decode', pngPath, '-o', pam]).status).toBe(0);
    const pngAgain = join(tmp, 'b.png');
    expect(run(['png', 'encode', pam, '-o', pngAgain]).status).toBe(0);
    expect(decodePng(readFileSync(pngAgain)).data).toEqual(img.data);
    const r = run(['png', 'optimise', pngPath, '-o', join(tmp, 'c.png')]);
    expect(r.status).toBe(0);
    expect(decodePng(readFileSync(join(tmp, 'c.png'))).data).toEqual(img.data);
  });

  it('bench prints a comparison table', () => {
    const f = join(tmp, 'bench.txt');
    writeFileSync(f, text);
    expect(execFileSync('node', [cli, 'bench', f, '-l', '1,6', '--runs', '1']).toString()).toMatch(
      /zlib MB\/s/,
    );
  });
});
