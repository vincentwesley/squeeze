# Plan

## Goal

A from-scratch DEFLATE/zlib/gzip/PNG implementation in TypeScript that ships as a library, a CLI (`squeeze`) and a static web page, and that proves its correctness by interoperating with zlib, GNU gzip and standard PNG decoders on public corpora, under fuzzing, with published ratio/speed numbers beside zlib.

## Layout

```
src/                 library (zero runtime dependencies)
  errors.ts          SqueezeError + codes
  checksum.ts        CRC-32, Adler-32
  bitio.ts           LSB-first BitWriter
  huffman.ts         package-merge lengths, canonical codes, decode tables
  inflate.ts         raw DEFLATE decoder (+ optional trace)
  deflate/           LZ77 matchers, optimal parser, block writer
  zlib.ts gzip.ts    containers
  png/               chunks, filters, Adam7, decoder, encoder, optimiser
  trace.ts           trace types shared with the web page
  index.ts           public API
cli/squeeze.ts       command-line tool
web/                 static visualiser (HTML/CSS/TS, bundled by esbuild)
test/                vitest unit/interop/fuzz tests; test/corpora for downloaded corpora
scripts/             build, fetch-corpora, bench, fuzz, acceptance, serve
docs/                research, decisions, plan, acceptance, benchmarks, handover
```

## Milestones

| M   | Scope                                                                                               | Done when                                                                                                |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M0  | Repo scaffolding, licence, docs, lint/test/build wiring, CI skeleton                                | `npm run lint && npm test && npm run build` green                                                        |
| M1  | Checksums, inflate (all block types, strict validation), zlib/gzip decoding                         | Decodes everything Node's zlib produces at levels 0–9, rejects the RFC error cases                       |
| M2  | Deflate levels 0–9, block writer, zlib/gzip encoding                                                | Node zlib + `gzip -d` decode our output; ratio within a few % of zlib                                    |
| M3  | PNG decoder: all colour types/bit depths, Adam7, tRNS, strict chunks                                | All PngSuite valid images match pngjs pixels; all 14 `x*` rejected                                       |
| M4  | PNG encoder + optimiser                                                                             | pngjs, Pillow and Chromium decode our PNGs pixel-identically                                             |
| M5  | CLI                                                                                                 | compress/decompress/inspect/png/bench commands with tests                                                |
| M6  | Optimal parsing levels 10–12, fuzzing (random + mutation + differential), corpora tests, benchmarks | Fuzz clean; corpora round trip; `docs/BENCHMARKS.md` generated                                           |
| M7  | Web page                                                                                            | Text arcs, heat map, Huffman tree builder, levels chart, PNG/file inspector; works at 390 px and 1280 px |
| M8  | Polish: README, SECURITY, CHANGELOG, acceptance from a fresh clone, v1.0.0                          | `npm run acceptance -- --full` green from a fresh clone                                                  |

Every push runs lint, tests and build first.

## Risks

- **JS speed vs native zlib.** Mitigated by typed arrays, 32-bit bit buffers and two-level decode tables; results are published honestly either way.
- **Exact zlib agreement under fuzzing.** Follow `inftrees.c` / `inflate.c` rules precisely; any disagreement found by the fuzzer becomes a regression test.
- **Silesia is 200 MB.** Download once, cache in CI with `actions/cache`, keyed by the pinned hash.
