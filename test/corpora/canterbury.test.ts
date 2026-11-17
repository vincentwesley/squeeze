import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS helper without types
import { fetchCorpus } from '../../scripts/fetch-corpora.mjs';
import { gunzip, gzip } from '../../src/index.js';
import { checkFile, checkGnuGzip, corpusFiles, hasGzip } from './corpus-roundtrip.js';

let dir = '';
beforeAll(async () => {
  dir = await fetchCorpus('canterbury');
});

describe('Canterbury corpus', () => {
  it('has 11 files', () => expect(corpusFiles(dir).length).toBe(11));
  it('round-trips every file through zlib both ways (levels 0,1,6,9,12)', () => {
    for (const f of corpusFiles(dir)) checkFile(join(dir, f), [0, 1, 6, 9, 12], [1, 6, 9]);
  });
  it.runIf(hasGzip())('interoperates with GNU gzip', () => {
    for (const f of corpusFiles(dir)) checkGnuGzip(join(dir, f));
  });
  it.runIf(hasGzip())('reads multi-member files written by GNU gzip and vice versa', () => {
    const a = join(dir, 'alice29.txt');
    const b = join(dir, 'fields.c');
    const both = Buffer.concat([execFileSync('gzip', ['-c', a]), execFileSync('gzip', ['-c', b])]);
    const plain = Buffer.concat([execFileSync('cat', [a]), execFileSync('cat', [b])]);
    expect(Buffer.from(gunzip(both)).equals(plain)).toBe(true);
    const ours = Buffer.concat([gzip(execFileSync('cat', [a])), gzip(execFileSync('cat', [b]))]);
    expect(execFileSync('gzip', ['-dc'], { input: ours }).equals(plain)).toBe(true);
  });
});
