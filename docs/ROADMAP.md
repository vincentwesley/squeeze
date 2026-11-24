# Roadmap

**Status: complete.** Squeeze 1.0.0 is the finished product. It is a portfolio project that is maintained for correctness, not grown with new features.

## Definition of done

Each item is met and verified:

|     | Item                                                                                      | Evidence                                                               |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ✅  | DEFLATE, zlib and gzip encoder and decoder written from scratch                           | `src/`, no runtime dependencies                                        |
| ✅  | PNG decoder and encoder written from scratch                                              | `src/png/`                                                             |
| ✅  | Library, CLI and static web page                                                          | `dist/lib`, `dist/cli/squeeze.js`, `dist/web`                          |
| ✅  | Interoperability both ways with zlib, GNU gzip and standard PNG decoders                  | acceptance checks A5–A10, A16                                          |
| ✅  | Canterbury, Silesia and PngSuite pass; broken PngSuite files are rejected cleanly         | A5, A6, A8, A9                                                         |
| ✅  | Decoders fuzzed with random and corrupted input, differentially against zlib              | A11; CI fuzzes on every push                                           |
| ✅  | Ratio and speed published beside zlib, with the method                                    | `docs/BENCHMARKS.md`                                                   |
| ✅  | Open-source standard: MIT licence, tests, lint, CI, SECURITY, CHANGELOG, contributor docs | A1–A4, `.github/`                                                      |
| ✅  | Tagged release with downloadable artifacts                                                | [v1.0.0](https://github.com/vincentwesley/squeeze/releases/tag/v1.0.0) |
| ✅  | README presents the project at a glance (screenshots, results, live demo link)            | `README.md`                                                            |
| ⏳  | Live demo online                                                                          | needs one admin click: `docs/NEEDS-VIN.md` §1                          |

## Maintenance policy

- **Bugs and security issues are fixed.** A wrong output, a crash, a hang or a decoder disagreeing with zlib is in scope. Each fix comes with a regression test and a patch release (1.0.x) through the Release workflow.
- **No routine dependency churn.** Dependabot version-update PRs are switched off; GitHub's security alerts and security updates still apply.
- **No new features.** Ideas are recorded below rather than built.

## Deliberately not planned

These ideas were considered and set aside to keep the project finished and small (see also `docs/DECISIONS.md`):

- Streaming / incremental compression API
- Binary-tree match finder to speed up levels 10–12
- WebAssembly build or multi-threaded compression
- ZIP archives, APNG, colour management (gAMA/iCCP)
- Publishing to npm (the package tarball is attached to each release instead)
