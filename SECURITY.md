# Security policy

Squeeze parses untrusted, attacker-controlled input (compressed streams and PNG files), so decoder bugs are treated as security bugs.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private vulnerability reporting instead: on the repository page, open **Security → Report a vulnerability**. Include a minimal input file that triggers the problem, the API or CLI command you ran, and what happened (crash, hang, wrong output, excessive memory).

You can expect an acknowledgement within 7 days and a fix or a plan within 30 days. Credit is given in the changelog unless you ask otherwise.

## What counts

- Any exception other than `SqueezeError` escaping a decoder (`inflateRaw`, `zlibDecompress`, `gunzip`, `decodePng`).
- A hang, or super-linear running time, on any input.
- Memory use not bounded by the `maxOutputLength` / `maxPixels` options.
- Output that differs from zlib's for a stream zlib accepts, or acceptance of a stream zlib rejects (see the differential fuzzer in `test/fuzz-core.ts`).

## Hardening already in place

- Every decoder failure is a `SqueezeError` with a stable `code`; the fuzz suite asserts that nothing else is thrown.
- `maxOutputLength` caps decompressed size (the CLI defaults to 1 GiB; raise it with `--max-output`).
- `decodePng` rejects images over `maxPixels` (default 2^26) before allocating, checks every chunk CRC and validates chunk order and IHDR fields.
- Differential fuzzing against zlib runs in CI on every push.
