# Third-party notices

Squeeze ships no third-party code, fonts, images or icons.

- Runtime dependencies: none. `dist/lib`, `dist/cli` and `dist/web` contain only code written for this project (esbuild only bundles it).
- Fonts: none bundled; the web page uses the system font stack.
- Images and icons: none; the favicon is an inline SVG and the sample image is drawn in the browser. `docs/images/` holds screenshots of this project.
- Test data (not committed, not bundled): Canterbury and Silesia corpora (no stated licence) and PngSuite (© Willem van Schaik, free to use) are downloaded at test time with pinned SHA-256 hashes.
- Dev-only tooling (TypeScript, esbuild, Vitest, Biome, pngjs, ...) is MIT/Apache-2.0 licensed and not distributed with the package; see `package-lock.json`.
- No vendored house kit or art, so no `NOTICE.md` is needed.
