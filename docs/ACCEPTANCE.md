# Acceptance checks

Every check below is run by `npm run acceptance` (fast set) or `npm run acceptance -- --full` (adds the Silesia corpus, the long fuzz run, benchmarks and the browser checks). The script prints PASS/FAIL per ID and exits non-zero on any failure. Run it from a fresh clone after `npm ci`.

| ID | Check | How the script verifies it |
|---|---|---|
| A1 | Open-source hygiene | `LICENSE` is MIT with `Copyright (c) 2026 Vin's Atelier`; `SECURITY.md`, `CHANGELOG.md`, `README.md`, `.github/workflows/ci.yml` exist; `package.json` author is `Vin's Atelier`; README credits Vin's Atelier |
| A2 | Lint and types | `npm run lint` exits 0 |
| A3 | Unit and interop tests | `npm test` exits 0 |
| A4 | Build output | `npm run build` exits 0; `dist/lib/index.js`, `dist/cli/squeeze.js`, `dist/web/index.html` exist; every file under `dist/web` is < 25 MiB |
| A5 | zlib interop, Canterbury | For every Canterbury file and levels 0,1,6,9,12: Node's zlib decodes Squeeze's zlib/raw output to the original; Squeeze decodes Node zlib's output (levels 1,6,9) to the original |
| A6 | zlib interop, Silesia (`--full`) | Same as A5 for every Silesia file at levels 1,6,9 |
| A7 | gzip CLI interop | `gzip -dc` decodes `squeeze compress -f gzip` output for each Canterbury file; `squeeze decompress` decodes `gzip -9c` output; a two-member gzip file decodes to the concatenation |
| A8 | PngSuite valid images | Every non-`x` PngSuite image decodes and its RGBA8 pixels equal pngjs's |
| A9 | PngSuite broken images | Every `x*` image is rejected with a `SqueezeError` (no other exception, no crash) |
| A10 | PNG encoder interop | Squeeze re-encodes every valid PngSuite image (default and `optimise`); pngjs decodes the result to identical pixels; Pillow (if Python+Pillow available) also agrees |
| A11 | Fuzzing | `npm run fuzz -- --iterations N` (N=2000 fast, 50000 full) finds no non-`SqueezeError` exception, no hang, and no disagreement with Node's zlib on accept/reject or output |
| A12 | Benchmarks published | `docs/BENCHMARKS.md` exists, contains a Squeeze vs zlib table for Canterbury and Silesia and a "Method" section; `--full` regenerates it |
| A13 | CLI round trip | `squeeze compress` then `squeeze decompress` restores a file for each format (raw/zlib/gzip); `squeeze png optimise` output decodes to the same pixels |
| A14 | No secrets committed | `git ls-files` content contains no private keys or common token patterns |
| A15 | Web page (`--full`, needs Chromium) | `dist/web/index.html` served locally loads with no console errors at 390×844 and 1280×800, has no horizontal overflow, compresses the sample text, renders arcs and the Huffman tree, and its footer credits Vin's Atelier |
| A16 | Browser decodes our PNGs (`--full`, needs Chromium) | Chromium decodes PNGs written by Squeeze to the expected pixels |
