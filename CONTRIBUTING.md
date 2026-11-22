# Contributing

Thanks for helping. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Squeeze is small on purpose: the core (`src/`) has **no runtime dependencies** and all compression and PNG code is written from scratch. Please keep it that way.

## Setup

```sh
npm ci            # Node 22 or newer for the dev tools (the library runs on Node 20+)
npm run lint      # Biome + TypeScript
npm test          # unit, interop, corpus (Canterbury, PngSuite) and short fuzz tests
npm run build     # dist/lib, dist/cli, dist/web
```

The first `npm test` downloads the Canterbury corpus and PngSuite (about 0.8 MB) into `.cache/corpora`, checking pinned SHA-256 hashes.

## Longer checks

```sh
SQUEEZE_SILESIA=1 npx vitest run test/corpora/silesia.test.ts   # 212 MB corpus, several minutes
npm run fuzz -- --iterations 200000                            # differential fuzzing vs zlib
npm run bench                                                 # regenerates docs/BENCHMARKS.md
npm run coverage                                              # test coverage of src/
npm run acceptance -- --full                                  # everything in docs/ACCEPTANCE.md
```

## Pull requests

- Add a test for every bug fix. Inputs found by the fuzzer go in `test/errors.test.ts` as a regression case.
- Run `npm run lint && npm test && npm run build` before pushing.
- Record design decisions in `docs/DECISIONS.md` and user-visible changes in `CHANGELOG.md`.

## Releases

Bump `version` in `package.json`, add the matching `## [x.y.z]` section to `CHANGELOG.md`, and merge to `main`. The Release workflow then tests the build, creates the `vx.y.z` tag and publishes a GitHub Release with the changelog notes, the web page as a zip and the npm package tarball. The Pages workflow republishes the web page on every push to `main`.
