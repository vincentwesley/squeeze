import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BitWriter } from '../src/bitio.js';
import {
  adler32,
  crc32,
  decodePng,
  encodePng,
  gunzip,
  gzip,
  inflateRaw,
  SqueezeError,
  type SqueezeErrorCode,
  zlibCompress,
  zlibDecompress,
} from '../src/index.js';

function code(fn: () => unknown): SqueezeErrorCode | 'ok' {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (e instanceof SqueezeError) return e.code;
    throw e;
  }
}

/** Build a raw stream from (value, bits) pairs written LSB-first. */
function bits(...pairs: [number, number][]): Uint8Array {
  const w = new BitWriter();
  for (const [v, n] of pairs) w.writeBits(v, n);
  return w.finish();
}

/** zlib must reject the same stream. */
function zlibRejects(b: Uint8Array): boolean {
  try {
    zlib.inflateRawSync(b);
    return false;
  } catch {
    return true;
  }
}

describe('checksums', () => {
  it('match known values', () => {
    const s = new TextEncoder().encode('123456789');
    expect(crc32(s)).toBe(0xcbf43926);
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(adler32(new Uint8Array(0))).toBe(1);
    const big = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 255);
    let a = 1;
    let b = 0;
    for (const v of big) {
      a = (a + v) % 65521;
      b = (b + a) % 65521;
    }
    expect(adler32(big)).toBe(((b << 16) | a) >>> 0);
    expect(crc32(big)).toBe(zlib.crc32(big));
    expect(crc32(big.subarray(500), crc32(big.subarray(0, 500)))).toBe(crc32(big));
  });
});

describe('inflate rejects malformed streams like zlib', () => {
  const cases: [string, Uint8Array, SqueezeErrorCode][] = [
    ['empty input', new Uint8Array(0), 'UNEXPECTED_EOF'],
    ['block type 3', bits([1, 1], [3, 2]), 'BAD_BLOCK_TYPE'],
    ['stored LEN/NLEN mismatch', Uint8Array.of(1, 5, 0, 0, 0), 'BAD_STORED_LENGTH'],
    ['stored block truncated', Uint8Array.of(1, 5, 0, 0xfa, 0xff, 65, 66), 'UNEXPECTED_EOF'],
    // Fixed block: distance 1 with no output yet. Length code 257 = 0000001 (7 bits), dist 0 = 00000.
    ['distance too far back', bits([1, 1], [1, 2], [0b1000000, 7], [0, 5], [0, 7]), 'DISTANCE_TOO_FAR'],
    // Fixed code literal/length 286: 11000110 reversed.
    ['fixed code symbol 286', bits([1, 1], [1, 2], [0b01100011, 8]), 'BAD_SYMBOL'],
    // Length 3 (code 0000001, written reversed) then distance code 30 (11110, reversed).
    ['fixed distance code 30', bits([1, 1], [1, 2], [0b1000000, 7], [0b01111, 5], [0, 8]), 'BAD_SYMBOL'],
    ['HLIT too large (287)', bits([1, 1], [2, 2], [30, 5], [0, 5], [0, 4]), 'TOO_MANY_SYMBOLS'],
    ['HDIST too large (31)', bits([1, 1], [2, 2], [0, 5], [30, 5], [0, 4]), 'TOO_MANY_SYMBOLS'],
    // Code-length code with a single length-1 code: incomplete, which zlib rejects for this code.
    [
      'incomplete code-length code',
      bits([1, 1], [2, 2], [0, 5], [0, 5], [0, 4], [1, 3], [0, 3], [0, 3], [0, 3], [0, 0]),
      'BAD_CODE_LENGTHS',
    ],
    // Code-length code over-subscribed: three codes of length 1.
    [
      'over-subscribed code-length code',
      bits([1, 1], [2, 2], [0, 5], [0, 5], [0, 4], [1, 3], [1, 3], [1, 3], [0, 3]),
      'BAD_CODE_LENGTHS',
    ],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(code(() => inflateRaw(input))).toBe(want);
      expect(zlibRejects(input)).toBe(true);
    });
  }

  it('repeat code 16 with no previous length', () => {
    // HCLEN=4 → lengths for 16,17,18,0. Give 16 and 0 length 1 each (canonical: 0→'0', 16→'1').
    const b = bits(
      [1, 1],
      [2, 2],
      [0, 5],
      [0, 5],
      [0, 4],
      [1, 3],
      [0, 3],
      [0, 3],
      [1, 3],
      [1, 1],
      [0, 2],
      [0, 16],
    );
    expect(code(() => inflateRaw(b))).toBe('BAD_CODE_LENGTHS');
    expect(zlibRejects(b)).toBe(true);
  });

  it('missing end-of-block code', () => {
    // Code-length code: symbols 0 and 18 with 1 bit each. Emit 18 (138 zeros) ×2 + 18(11) ... then
    // a few non-zero lengths impossible here, so: all zero lengths → no EOB.
    const pairs: [number, number][] = [
      [1, 1],
      [2, 2],
      [0, 5],
      [0, 5],
      [0, 4],
      [0, 3],
      [0, 3],
      [1, 3],
      [1, 3],
    ];
    // HLIT=257, HDIST=1 → 258 lengths: 18 with 127 → 138, 18 with 109 → 120 zeros = 258.
    pairs.push([1, 1], [127, 7], [1, 1], [109, 7]);
    const b = bits(...pairs);
    expect(code(() => inflateRaw(b))).toBe('MISSING_END_OF_BLOCK');
    expect(zlibRejects(b)).toBe(true);
  });

  it('enforces maxOutputLength', () => {
    const z = new Uint8Array(zlib.deflateRawSync(new Uint8Array(100_000)));
    expect(code(() => inflateRaw(z, { maxOutputLength: 99_999 }))).toBe('OUTPUT_LIMIT');
    expect(inflateRaw(z, { maxOutputLength: 100_000 }).length).toBe(100_000);
  });
});

describe('zlib container', () => {
  const data = new TextEncoder().encode('dictionary dictionary dictionary words');
  it('rejects bad headers and checksums', () => {
    const z = zlibCompress(data);
    expect(code(() => zlibDecompress(Uint8Array.of(0x78)))).toBe('UNEXPECTED_EOF');
    expect(code(() => zlibDecompress(Uint8Array.from([z[0], z[1] ^ 1, ...z.subarray(2)])))).toBe(
      'BAD_HEADER',
    );
    expect(code(() => zlibDecompress(Uint8Array.of(0x79, 0x9c - 0x1f + 0x1f, 0)))).toBe('BAD_HEADER');
    const bad = z.slice();
    bad[bad.length - 1] ^= 1;
    expect(code(() => zlibDecompress(bad))).toBe('BAD_CHECKSUM');
    expect(code(() => zlibDecompress(Uint8Array.from([...z, 0])))).toBe('TRAILING_DATA');
    expect(zlibDecompress(Uint8Array.from([...z, 0]), { allowTrailingData: true })).toEqual(data);
  });
  it('supports preset dictionaries, interoperably with zlib', () => {
    const dictionary = new TextEncoder().encode('dictionary words');
    const ours = zlibCompress(data, { dictionary });
    expect(new Uint8Array(zlib.inflateSync(ours, { dictionary }))).toEqual(data);
    const theirs = new Uint8Array(zlib.deflateSync(data, { dictionary }));
    expect(zlibDecompress(theirs, { dictionary })).toEqual(data);
    expect(code(() => zlibDecompress(theirs))).toBe('NEED_DICTIONARY');
    expect(code(() => zlibDecompress(theirs, { dictionary: Uint8Array.of(1) }))).toBe('NEED_DICTIONARY');
    expect(ours.length).toBeLessThan(zlibCompress(data).length);
  });
});

describe('gzip container', () => {
  const data = new TextEncoder().encode('hello gzip '.repeat(100));
  it('round-trips header fields and is read by zlib', () => {
    const g = gzip(data, {
      name: 'hello.txt',
      comment: 'a comment',
      mtime: 1_700_000_000,
      extra: Uint8Array.of(65, 66, 2, 0, 1, 2),
      headerCrc: true,
      text: true,
    });
    expect(new Uint8Array(zlib.gunzipSync(g))).toEqual(data);
    expect(gunzip(g)).toEqual(data);
  });
  it('rejects corruption', () => {
    const g = gzip(data, { headerCrc: true, name: 'n' });
    const flip = (i: number) => {
      const b = g.slice();
      b[i] ^= 1;
      return b;
    };
    expect(code(() => gunzip(flip(0)))).toBe('BAD_HEADER');
    expect(code(() => gunzip(flip(2)))).toBe('BAD_HEADER');
    expect(code(() => gunzip(Uint8Array.from([...g.subarray(0, 3), g[3] | 0x20, ...g.subarray(4)])))).toBe(
      'BAD_HEADER',
    );
    expect(code(() => gunzip(flip(12)))).toBe('BAD_CRC'); // header CRC covers the name
    expect(code(() => gunzip(flip(g.length - 8)))).toBe('BAD_CHECKSUM');
    expect(code(() => gunzip(flip(g.length - 4)))).toBe('BAD_LENGTH');
    expect(code(() => gunzip(g.subarray(0, g.length - 1)))).toBe('UNEXPECTED_EOF');
    expect(code(() => gunzip(Uint8Array.from([...g, 7, 7])))).toBe('TRAILING_DATA');
    expect(gunzip(Uint8Array.from([...g, 0, 0, 0]))).toEqual(data);
  });
  it('concatenates multiple members', () => {
    const two = Uint8Array.from([...gzip(data), ...zlib.gzipSync(data)]);
    expect(gunzip(two).length).toBe(data.length * 2);
  });
});

describe('PNG decoder rejects malformed files', () => {
  const img = { width: 3, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37) & 255) };
  const png = encodePng(img);
  it('decodes the original', () => {
    expect(decodePng(png).data).toEqual(img.data);
  });
  it('errors', () => {
    expect(code(() => decodePng(png.subarray(0, 7)))).toBe('BAD_SIGNATURE');
    expect(code(() => decodePng(png.subarray(0, png.length - 12)))).toBe('UNEXPECTED_EOF'); // no IEND
    expect(code(() => decodePng(png.subarray(0, 40)))).toBe('UNEXPECTED_EOF');
    const bad = png.slice();
    bad[20] ^= 1; // inside IHDR data
    expect(code(() => decodePng(bad))).toBe('BAD_CRC');
  });
  it('rejects bad colour/depth combinations and filters', () => {
    expect(() => encodePng({ width: 0, height: 1, data: new Uint8Array(0) })).toThrow(SqueezeError);
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(SqueezeError);
  });
});
