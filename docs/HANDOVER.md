# Handover

State of Squeeze at v1.0.0 (2026-11-17), so anyone can pick it up.

## How to resume

```sh
npm ci && npm run lint && npm test && npm run build
npm run acceptance -- --full     # every check in docs/ACCEPTANCE.md (about 6 minutes)
npm run acceptance -- --full --bench   # also regenerates docs/BENCHMARKS.md (about 25 more minutes)
```

All milestones M0–M8 in docs/PLAN.md are complete. Development happened on branch `claude/squeeze-compression-aypkk6` and was merged to `main` in a single pull request (DECISIONS D24).

## Done and verified

- **Acceptance from a fresh clone** (`npm run acceptance -- --full`): A1, A3–A16 passed; A2 (lint) failed only on Markdown formatting, was fixed in the next commit, and passes in CI and locally.
- **CI** (GitHub Actions, every push): lint + build + tests on Node 22 and 24, 20 000 random-seed fuzz cases, Silesia interop, Chromium page and PNG checks, and a Node 20 runtime smoke test. All green.
- **Compression ratio vs zlib 1.3.1** (same machine and process, docs/BENCHMARKS.md):
  - Silesia (211.9 MB): level 6 is 0.99% smaller than zlib -6; level 9 is 1.23% smaller than zlib -9; level 10 is 4.32% smaller than zlib -9. Level 1 is 0.86% larger than zlib -1.
  - Canterbury (2.8 MB): level 6 is 0.93% smaller; level 9 is 0.69% smaller; level 12 is 7.47% smaller than zlib -9.
- **Speed vs zlib** (Intel Xeon 2.1 GHz, Node 22): Silesia compression at level 1 45.0 vs 100.8 MB/s, level 6 14.7 vs 41.1 MB/s, level 9 5.5 vs 17.1 MB/s, level 10 1.8 MB/s. Decompression 149.9 vs 333.7 MB/s.
- **Interoperability, both ways:** Node's zlib decodes Squeeze's output at every level (0–12) for raw, zlib and gzip; Squeeze decodes zlib's output at levels 0–9 and the Huffman-only, RLE and fixed strategies; GNU gzip interop including multi-member files; all 11 Canterbury and 12 Silesia files round-trip.
- **PngSuite:** all 162 valid images match pngjs pixel for pixel (RGB under alpha 0 excepted, D16); all 14 broken images are rejected with `SqueezeError`; every image re-encodes losslessly (default, interlaced, optimised). Pillow decodes 258 Squeeze-written PNGs with 0 mismatches; Chromium decodes 7 test PNGs pixel-exactly.
- **Fuzzing:** more than 500 000 differential cases across runs (seeds 7, 11–14, 21–23, 31, CI random seeds), 0 disagreements with zlib, 0 non-`SqueezeError` exceptions, slowest case under 40 ms. One real divergence found and fixed (gzip trailing data, D15).
- **Tests:** 73 vitest tests (70 run by default, 3 Silesia tests opt-in); 23 error-handling tests (malformed streams are also checked against zlib). Coverage of `src/` without the corpus suites (`npm run coverage`): 94.9% of lines, 92.3% of statements, 86.2% of branches, 96.8% of functions.
- **Release and hosting automation:** merging to `main` runs the Release workflow (tags the `package.json` version and publishes a GitHub Release with notes, web zip and npm tarball) and the Pages workflow (deploys `dist/web`).
- **Web page:** checked at 390×844 and 1280×800 in Chromium, with no console errors and no horizontal overflow; all four tabs work; the largest file in `dist/web` is 177 KiB (a source map).
- **Repository standard:** MIT licence (Copyright (c) 2026 Vin's Atelier), README, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, Dependabot, docs (RESEARCH, DECISIONS, PLAN, ACCEPTANCE, BENCHMARKS).

## Not done, and why

- **Streaming / incremental API:** deliberately left out of v1 (DECISIONS B10). The whole-buffer API handles the largest corpus file (51 MB) comfortably.
- **Compression speed parity with zlib:** Squeeze is about 2.2–3× slower than native C zlib. That is expected for JavaScript, and the gap is published rather than hidden. A binary-tree match finder (as in libdeflate) would speed up levels 10–12 most; it is the obvious next step.
- **APNG, ZIP archives, colour management:** out of scope (DECISIONS B13, B14).
- **Publishing to npm:** optional and needs an npm account; see below.

## Needs Vin

Nothing is required. Optional extras, with exact steps in docs/NEEDS-VIN.md:

1. Publish `@vins-atelier/squeeze` to npm (needs an npm account).
2. Enable private vulnerability reporting (needs repository admin rights).
3. If the Pages workflow reports that Pages is not enabled, switch **Settings → Pages → Source** to **GitHub Actions** once.
