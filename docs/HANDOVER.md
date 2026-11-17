# Handover

Where the project stands, so a new session can pick it up. Updated after each milestone.

## Status by milestone

| Milestone                                       | State                            |
| ----------------------------------------------- | -------------------------------- |
| M0 scaffolding, docs, tooling                   | done                             |
| M1 inflate, zlib/gzip decoding                  | done                             |
| M2 deflate 0–9, zlib/gzip encoding              | done                             |
| M3 PNG decoder (PngSuite)                       | done                             |
| M4 PNG encoder + optimiser                      | done                             |
| M5 CLI                                          | done                             |
| M6 levels 10–12, fuzzing, corpora, benchmarks   | done (benchmark run in progress) |
| M7 web page                                     | done                             |
| M8 polish, acceptance from fresh clone, release | in progress                      |

## How to resume

```sh
npm ci && npm run lint && npm test && npm run build
npm run acceptance -- --full     # every check in docs/ACCEPTANCE.md
```

Work happens on branch `claude/squeeze-compression-aypkk6`; see docs/DECISIONS.md D24.
