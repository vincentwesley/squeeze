# Squeeze

**DEFLATE, zlib, gzip and PNG written from scratch in TypeScript** — a library, a command-line tool and a web page that shows compression happening on your own text and images.

[![CI](https://github.com/vincentwesley/squeeze/actions/workflows/ci.yml/badge.svg)](https://github.com/vincentwesley/squeeze/actions/workflows/ci.yml)
![runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-blue)
![licence: MIT](https://img.shields.io/badge/licence-MIT-green)

Built by **Vin's Atelier**.

Everything that touches bits — Huffman coding, LZ77 matching, the bit reader and writer, CRC-32, Adler-32, PNG filters and Adam7 — is implemented in `src/` with no compression or image libraries. Libraries are used only for tests, the build and tooling.

## Results at a glance

Measured beside zlib 1.3.1 (Node's built-in, native C) on the same machine; full method and per-file numbers in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

| Silesia corpus (212 MB)             |    Squeeze |       zlib |                               |
| ----------------------------------- | ---------: | ---------: | ----------------------------- |
| Level 6 (default) size              | 67,895,248 | 68,575,876 | **0.99% smaller**             |
| Level 9 size                        | 67,335,827 | 68,172,488 | **1.23% smaller**             |
| Level 10 (optimal parse) vs zlib -9 | 65,225,309 | 68,172,488 | **4.32% smaller**             |
| Level 6 compression speed           |  14.7 MB/s |  41.1 MB/s | 2.8× slower (JavaScript vs C) |
| Decompression speed                 | 149.9 MB/s | 333.7 MB/s | 2.2× slower                   |

On the Canterbury corpus level 12 is **7.47% smaller than zlib -9**. Both corpora round-trip through zlib and GNU gzip in both directions; all 162 valid PngSuite images decode correctly and all 14 broken ones are rejected; hundreds of thousands of differential fuzz cases agree with zlib.

## What's in it

|                        |                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DEFLATE** (RFC 1951) | Decoder with two-level lookup tables and zlib-identical validation. Encoder with stored/fixed/dynamic blocks chosen by exact bit cost, statistics-based block splitting, package-merge (optimal length-limited) Huffman codes, zlib's greedy and lazy matchers for levels 1–9, and near-optimal parsing for levels 10–12. Preset dictionaries. |
| **zlib** (RFC 1950)    | Header/Adler-32 framing, FDICT preset dictionaries, FLEVEL.                                                                                                                                                                                                                                                                                    |
| **gzip** (RFC 1952)    | All header fields (name, comment, mtime, extra, header CRC), multi-member files, trailing zero padding.                                                                                                                                                                                                                                        |
| **PNG**                | Decoder for every colour type and bit depth (1–16), palettes, tRNS, Adam7, strict chunk/CRC/order checks. Encoder that picks the smallest lossless layout (palette, greyscale, bit-depth reduction, alpha drop) and per-row filters; an optimiser that tries every filter strategy.                                                            |
| **CLI**                | `squeeze compress / decompress / inspect / png / bench`.                                                                                                                                                                                                                                                                                       |
| **Web page**           | Back-reference arcs drawn over your text, a bit-cost heat map, step-by-step Huffman tree construction, speed vs size for all 13 levels, and a PNG view showing each row's filter. Runs entirely in the browser.                                                                                                                                |

## Install and build

Requires Node.js 22+ to build (the built library and CLI run on Node 20+).

```sh
git clone https://github.com/vincentwesley/squeeze.git
cd squeeze
npm ci
npm run build        # → dist/lib (ESM + .d.ts), dist/cli/squeeze.js, dist/web/
npm link             # optional: puts `squeeze` on your PATH
```

## Library

The package is not on npm yet (see [docs/NEEDS-VIN.md](docs/NEEDS-VIN.md)); after `npm run build`, import from `dist/lib/index.js` or install the folder with `npm install /path/to/squeeze`.

```ts
// Raw DEFLATE, zlib, gzip, PNG, and the error type.
import {
  deflateRaw,
  inflateRaw,
  zlibCompress,
  zlibDecompress,
  gzip,
  gunzip,
  gunzipMembers,
  encodePng,
  decodePng,
  optimisePng,
  SqueezeError,
} from '@vins-atelier/squeeze';

const text = new TextEncoder().encode('hello hello hello hello');
const gz = gzip(text, { level: 9, name: 'hello.txt' });
const back = gunzip(gz, { maxOutputLength: 1 << 20 }); // throws SqueezeError('OUTPUT_LIMIT') beyond 1 MiB

const smallest = zlibCompress(text, { level: 12 }); // near-optimal parse, slow

// PNG: RGBA in (8-bit Uint8Array or 16-bit Uint16Array), RGBA out.
const png = encodePng({ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) });
const img = decodePng(png); // { width, height, depth: 8, data: Uint8Array(RGBA), header, palette, chunks, ... }

try {
  inflateRaw(new Uint8Array([0xff]));
} catch (e) {
  if (e instanceof SqueezeError) console.log(e.code); // 'BAD_BLOCK_TYPE'
}
```

All functions take and return `Uint8Array`s and work the same in Node and browsers. Every decoding failure throws `SqueezeError` with a stable `code` (`UNEXPECTED_EOF`, `BAD_CODE_LENGTHS`, `DISTANCE_TOO_FAR`, `BAD_CRC`, `BAD_CHECKSUM`, `OUTPUT_LIMIT`, …) — never anything else.

| Level | Strategy                   | Notes                                                                                   |
| ----- | -------------------------- | --------------------------------------------------------------------------------------- |
| 0     | stored                     | no compression                                                                          |
| 1–3   | greedy hash-chain matching | zlib's `deflate_fast` parameters                                                        |
| 4–9   | lazy matching              | zlib's `deflate_slow` parameters; 6 is the default                                      |
| 10–12 | near-optimal parsing       | shortest path over a cost model refitted 2 / 6 / 15 times; much slower, smallest output |

Pass `trace: newTrace()` to `deflateRaw` or `inflateRaw` to record every block and every literal/match with its bit cost — the same data the web page and `squeeze inspect` use.

## Command line

```sh
squeeze compress notes.txt                 # → notes.txt.gz (gzip, level 6)
squeeze compress notes.txt -f zlib -l 12   # → notes.txt.zz, smallest
squeeze decompress notes.txt.gz            # → notes.txt (format auto-detected)
cat data | squeeze compress -f raw > data.deflate
squeeze inspect file.gz --tokens 20        # blocks, sizes, first 20 tokens
squeeze png optimise photo.png             # → photo.min.png, lossless
squeeze png encode image.ppm -o image.png  # PPM / PGM / PAM in
squeeze png decode image.png -o image.pam
squeeze bench file1 file2 -l 1,6,9         # Squeeze vs Node's zlib on your files
```

`decompress` refuses to write more than 1 GiB unless you pass `--max-output BYTES`, and never overwrites a file without `--force`. Exit codes: 0 success, 1 bad input or usage, 2 output exists.

## Web page

```sh
npm run build && npm run serve   # http://127.0.0.1:8080/
```

`dist/web/` is a plain static site (HTML, CSS and two scripts, about 80 KB before source maps) that can be hosted anywhere. Compression runs in a Web Worker on the visitor's device; nothing is uploaded.

- **Back-refs** — your text with every LZ77 match drawn as an arc back to its source. Hover a character for the token, its length, distance and bit cost. Switch to _Bit cost_ for a heat map of bits per byte. Open a `.gz`, `.zz` or `.deflate` file to see the matches another compressor chose.
- **Huffman** — replay Huffman's algorithm merging symbols for any block, next to the canonical codes DEFLATE actually wrote.
- **Levels** — all 13 levels on your input, size and time side by side, plus the browser's native deflate for reference.
- **PNG** — encode any image or decode any PNG with Squeeze; see the filter chosen for each row and the size each filter strategy gives.

## How it is tested

| What                        | How                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interoperability, both ways | Node's built-in zlib decodes everything Squeeze writes (raw, zlib, gzip, levels 0–12) and Squeeze decodes everything zlib writes (levels 0–9 and the Huffman-only, RLE and fixed strategies). GNU `gzip` reads Squeeze's files and vice versa, including multi-member files.                                                                             |
| Corpora                     | Every Canterbury file and every Silesia file round-trips through zlib and GNU gzip in both directions.                                                                                                                                                                                                                                                   |
| PngSuite                    | All 162 valid images decode to the same pixels as pngjs; all 14 broken `x*` images are rejected with a `SqueezeError`; every image re-encodes losslessly (default, interlaced and optimised) and is read back by pngjs and Pillow.                                                                                                                       |
| Browsers                    | Chromium decodes Squeeze's PNGs pixel-exactly (palette, 1-bit grey, alpha, interlaced, level 12).                                                                                                                                                                                                                                                        |
| Fuzzing                     | Differential fuzzing against zlib: mutated raw/zlib/gzip streams (bit flips, truncation, splices, random dynamic headers, tiny output limits) must be accepted or rejected by **both**, with identical output. PNG fuzzing with repaired CRCs so mutations reach the decoder. Short run in `npm test`, 20 000 cases per CI run, `npm run fuzz` for more. |
| Hand-made error cases       | Each RFC error condition (`test/errors.test.ts`), checked against zlib too.                                                                                                                                                                                                                                                                              |

`npm run acceptance` runs every check in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md); `npm run acceptance -- --full` adds Silesia, a 50 000-case fuzz run and the browser checks (`--bench` also regenerates the benchmark).

## Project layout

```
src/            the library (no dependencies)
  inflate.ts      DEFLATE decoder
  deflate/        lz77.ts (matchers), optimal.ts (levels 10–12), blocks.ts (block writer)
  huffman.ts      package-merge code lengths, canonical codes, decode tables
  zlib.ts gzip.ts containers
  png/            decode.ts, encode.ts, filter.ts, common.ts
  trace.ts        block/token traces for visualisation
cli/            the squeeze command
web/            the visualiser (bundled by esbuild into dist/web)
test/           vitest suites, fuzz harness, corpus tests
scripts/        build, corpora download, bench, fuzz, acceptance, browser checks
docs/           research, decisions, plan, acceptance, benchmarks, handover
```

## Documentation

- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) — ratio and speed beside zlib, with the method
- [docs/RESEARCH.md](docs/RESEARCH.md) — specs, implementations studied, data licences
- [docs/DECISIONS.md](docs/DECISIONS.md) — what was chosen and rejected, and why
- [docs/PLAN.md](docs/PLAN.md) and [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md)

## Test data

The Canterbury and Silesia corpora state no licence, so they are downloaded at test time (SHA-256 pinned) and never committed or bundled. PngSuite is © Willem van Schaik and free to use; it is also downloaded at test time. The web page bundles no third-party files: its sample text was written for it and its sample image is drawn in the browser.

## Licence

[MIT](LICENSE) © 2026 Vin's Atelier.
