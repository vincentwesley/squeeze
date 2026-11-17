import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateRaw, gunzip, gzip, inflateRaw, newTrace, zlibCompress, zlibDecompress } from '../src/index.js';
import { sampleInputs } from './helpers.js';

const inputs = sampleInputs();
const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.length);

describe('inflate decodes what zlib writes', () => {
  for (const { name, data } of inputs) {
    it(name, () => {
      for (const level of [0, 1, 4, 6, 9]) {
        expect(inflateRaw(u8(zlib.deflateRawSync(data, { level })))).toEqual(data);
        expect(zlibDecompress(u8(zlib.deflateSync(data, { level })))).toEqual(data);
        expect(gunzip(u8(zlib.gzipSync(data, { level })))).toEqual(data);
      }
      for (const strategy of [zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE, zlib.constants.Z_FIXED]) {
        expect(inflateRaw(u8(zlib.deflateRawSync(data, { strategy })))).toEqual(data);
      }
    });
  }
});

describe('zlib decodes what deflate writes', () => {
  for (const { name, data } of inputs) {
    it(name, () => {
      for (let level = 0; level <= 12; level++) {
        const raw = deflateRaw(data, { level });
        expect(u8(zlib.inflateRawSync(raw)), `raw level ${level}`).toEqual(data);
        expect(inflateRaw(raw)).toEqual(data);
        expect(u8(zlib.inflateSync(zlibCompress(data, { level }))), `zlib level ${level}`).toEqual(data);
        expect(u8(zlib.gunzipSync(gzip(data, { level }))), `gzip level ${level}`).toEqual(data);
      }
    });
  }
});

describe('ratio is in zlib’s league', () => {
  it('level 6 and 9 within 3% of zlib on structured inputs', () => {
    for (const { name, data } of inputs) {
      if (data.length < 10_000 || name.startsWith('random')) continue;
      for (const level of [6, 9]) {
        const ours = deflateRaw(data, { level }).length;
        const theirs = zlib.deflateRawSync(data, { level }).length;
        expect(ours, `${name} level ${level}: ${ours} vs ${theirs}`).toBeLessThanOrEqual(Math.ceil(theirs * 1.03) + 16);
      }
    }
  });
  it('level 12 beats zlib -9 on text', () => {
    const data = inputs.find((i) => i.name === 'word salad 200k')!.data;
    expect(deflateRaw(data, { level: 12 }).length).toBeLessThan(zlib.deflateRawSync(data, { level: 9 }).length);
  });
});

describe('traces', () => {
  it('encoder and decoder traces agree', () => {
    const data = inputs.find((i) => i.name === 'word salad 200k')!.data;
    const et = newTrace();
    const raw = deflateRaw(data, { level: 6, trace: et });
    const dt = newTrace();
    inflateRaw(raw, { trace: dt });
    expect(dt.tokens.count).toBe(et.tokens.count);
    expect(dt.blocks.map((b) => [b.type, b.bitStart, b.bitEnd, b.outEnd])).toEqual(
      et.blocks.map((b) => [b.type, b.bitStart, b.bitEnd, b.outEnd]),
    );
    for (let i = 0; i < et.tokens.count; i += 97) {
      expect([dt.tokens.pos[i], dt.tokens.len[i], dt.tokens.dist[i], dt.tokens.bits[i]]).toEqual([
        et.tokens.pos[i],
        et.tokens.len[i],
        et.tokens.dist[i],
        et.tokens.bits[i],
      ]);
    }
  });
});
