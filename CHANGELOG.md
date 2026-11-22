# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-11-17

First release.

### Added

- DEFLATE decoder (RFC 1951) with two-level decode tables and validation identical to zlib's (`inflateRaw`, `inflateRawAt`).
- DEFLATE encoder (`deflateRaw`): levels 0–9 with zlib's greedy/lazy parameters, levels 10–12 with near-optimal parsing; stored/fixed/dynamic block choice by exact bit cost; statistics-based block splitting; package-merge Huffman code lengths; preset dictionaries.
- zlib container (RFC 1950) with Adler-32 and FDICT (`zlibCompress`, `zlibDecompress`).
- gzip container (RFC 1952) with all header fields, header CRC, multi-member files and zero padding (`gzip`, `gunzip`, `gunzipMembers`, `parseGzipHeader`).
- PNG decoder for all colour types, bit depths, palettes, tRNS and Adam7, with strict CRC/chunk-order/IHDR validation (`decodePng`).
- PNG encoder with lossless colour-type and bit-depth reduction, five filters plus min-sum and entropy heuristics, optional Adam7 (`encodePng`), and an optimiser trying every strategy (`optimisePng`).
- Traces of blocks and tokens with bit costs for visualisation (`newTrace`, `bitCostPerByte`).
- `squeeze` CLI: `compress`, `decompress`, `inspect`, `png encode|decode|optimise|info`, `bench`.
- Static web visualiser: back-reference arcs, bit-cost heat map, Huffman tree construction, level comparison, PNG filter view.
- Test suites: zlib/GNU gzip interoperability, Canterbury, Silesia, PngSuite, Chromium decoding, differential fuzzing against zlib.
- Benchmarks against zlib (`npm run bench`, `docs/BENCHMARKS.md`) and an acceptance runner (`npm run acceptance`).
- Release automation (tag, GitHub Release with web zip and npm tarball), GitHub Pages deployment of the web page, test coverage report (`npm run coverage`).
- Issue and pull request templates, code of conduct, `.editorconfig`, `.nvmrc`; GitHub Actions updated to current major versions.

[1.0.0]: https://github.com/vincentwesley/squeeze/releases/tag/v1.0.0
