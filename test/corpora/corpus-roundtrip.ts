import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { expect } from 'vitest';
import { deflateRaw, gunzip, gzip, inflateRaw, zlibCompress, zlibDecompress } from '../../src/index.js';

export function corpusFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isFile())
    .sort();
}

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.length);
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** Both directions of zlib interoperability for one file. */
export function checkFile(path: string, ourLevels: number[], zlibLevels: number[]): void {
  const data = u8(readFileSync(path));
  for (const level of ourLevels) {
    const raw = deflateRaw(data, { level });
    expect(same(u8(zlib.inflateRawSync(raw)), data), `${path} raw L${level} via zlib`).toBe(true);
    const z = zlibCompress(data, { level });
    expect(same(u8(zlib.inflateSync(z)), data), `${path} zlib L${level} via zlib`).toBe(true);
    expect(same(inflateRaw(raw), data), `${path} raw L${level} via squeeze`).toBe(true);
  }
  for (const level of zlibLevels) {
    expect(
      same(zlibDecompress(u8(zlib.deflateSync(data, { level }))), data),
      `${path} zlib L${level} → squeeze`,
    ).toBe(true);
    expect(same(gunzip(u8(zlib.gzipSync(data, { level }))), data), `${path} gzip L${level} → squeeze`).toBe(
      true,
    );
  }
}

export function hasGzip(): boolean {
  try {
    execFileSync('gzip', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** GNU gzip reads our files and we read its files. */
export function checkGnuGzip(path: string): void {
  const data = u8(readFileSync(path));
  const ours = gzip(data, { level: 9, name: 'x' });
  const back = u8(execFileSync('gzip', ['-dc'], { input: ours, maxBuffer: 1 << 30 }));
  expect(same(back, data), `${path}: gzip -d of squeeze output`).toBe(true);
  const theirs = u8(execFileSync('gzip', ['-9c', path], { maxBuffer: 1 << 30 }));
  expect(same(gunzip(theirs), data), `${path}: squeeze of gzip -9 output`).toBe(true);
}
