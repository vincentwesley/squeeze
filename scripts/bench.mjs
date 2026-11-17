#!/usr/bin/env node
// Ratio and speed of Squeeze beside zlib, on the same machine, in the same Node process.
// Usage: node scripts/bench.mjs [--quick] [--no-silesia] [--runs N]
// Requires `npm run build` (uses dist/lib). Writes bench/results.json and docs/BENCHMARKS.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as zlib from 'node:zlib';
import { deflateRaw, inflateRaw } from '../dist/lib/index.js';
import { fetchCorpus } from './fetch-corpora.mjs';

const { values } = parseArgs({
  options: { quick: { type: 'boolean' }, 'no-silesia': { type: 'boolean' }, runs: { type: 'string' } },
});
const RUNS = Number(values.runs ?? (values.quick ? 1 : 5));

function median(fn, runs) {
  const t = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const s = process.hrtime.bigint();
    out = fn();
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  t.sort((a, b) => a - b);
  return { ms: t[Math.floor(t.length / 2)], out };
}

async function corpus(name, levels, runsFor) {
  const dir = await fetchCorpus(name);
  const names = (await import('node:fs'))
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort();
  const rows = [];
  for (const f of names) {
    const data = new Uint8Array(readFileSync(join(dir, f)));
    const row = { file: f, bytes: data.length, levels: {} };
    for (const level of levels) {
      const runs = runsFor(level, data.length);
      const ours = median(() => deflateRaw(data, { level }), runs);
      const zl = Math.min(level, 9);
      const theirs = median(() => zlib.deflateRawSync(data, { level: zl }), runs);
      // Correctness guard: zlib must decode ours.
      if (Buffer.compare(zlib.inflateRawSync(ours.out), data) !== 0)
        throw new Error(`${f} L${level}: round trip failed`);
      row.levels[level] = {
        squeezeBytes: ours.out.length,
        squeezeMs: ours.ms,
        zlibLevel: zl,
        zlibBytes: theirs.out.length,
        zlibMs: theirs.ms,
      };
      process.stderr.write(
        `${name}/${f} L${level}: ${ours.out.length} vs ${theirs.out.length}, ${ours.ms.toFixed(0)} vs ${theirs.ms.toFixed(0)} ms\n`,
      );
    }
    // Decompression of zlib's level-6 output.
    const z6 = zlib.deflateRawSync(data, { level: 6 });
    const runs = runsFor(6, data.length);
    const di = median(() => inflateRaw(z6), runs);
    const dz = median(() => zlib.inflateRawSync(z6), runs);
    row.inflate = { squeezeMs: di.ms, zlibMs: dz.ms };
    rows.push(row);
  }
  return rows;
}

const canterburyLevels = [1, 6, 9, 12];
const silesiaLevels = [1, 6, 9, 10];
const results = {
  date: new Date().toISOString().slice(0, 10),
  machine: {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memGiB: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
  },
  node: process.version,
  zlib: process.versions.zlib,
  runs: RUNS,
  canterbury: await corpus('canterbury', canterburyLevels, () => RUNS),
  silesia: values['no-silesia']
    ? null
    : await corpus('silesia', silesiaLevels, (level) => (level >= 10 ? 1 : Math.min(RUNS, 3))),
};
writeFileSync('bench/results.json', `${JSON.stringify(results, null, 2)}\n`);

// ---- Markdown ---------------------------------------------------------------
const fmt = (n) => n.toLocaleString('en-US');
const mbs = (bytes, ms) => (bytes / 1e6 / (ms / 1000)).toFixed(1);
function totals(rows, level) {
  let bytes = 0,
    sq = 0,
    zb = 0,
    sqMs = 0,
    zMs = 0;
  for (const r of rows) {
    const l = r.levels[level];
    bytes += r.bytes;
    sq += l.squeezeBytes;
    zb += l.zlibBytes;
    sqMs += l.squeezeMs;
    zMs += l.zlibMs;
  }
  return { bytes, sq, zb, sqMs, zMs, zlibLevel: rows[0].levels[level].zlibLevel };
}
function summary(title, rows, levels) {
  let md = `### ${title}\n\n| Level | Squeeze bytes | zlib bytes (level) | Squeeze ratio | zlib ratio | Size vs zlib | Squeeze MB/s | zlib MB/s |\n|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const level of levels) {
    const t = totals(rows, level);
    md += `| ${level} | ${fmt(t.sq)} | ${fmt(t.zb)} (${t.zlibLevel}) | ${((100 * t.sq) / t.bytes).toFixed(2)}% | ${((100 * t.zb) / t.bytes).toFixed(2)}% | ${((100 * t.sq) / t.zb - 100).toFixed(2)}% | ${mbs(t.bytes, t.sqMs)} | ${mbs(t.bytes, t.zMs)} |\n`;
  }
  let bytes = 0,
    iMs = 0,
    zMs = 0;
  for (const r of rows) {
    bytes += r.bytes;
    iMs += r.inflate.squeezeMs;
    zMs += r.inflate.zlibMs;
  }
  md += `\nDecompression (of zlib level-6 output), output MB/s: **Squeeze ${mbs(bytes, iMs)}**, zlib ${mbs(bytes, zMs)}.\n\n`;
  md += `<details><summary>Per file</summary>\n\n| File | Bytes | ${levels.map((l) => `L${l} Squeeze / zlib`).join(' | ')} |\n|---|---:|${levels.map(() => '---:').join('|')}|\n`;
  for (const r of rows)
    md += `| ${r.file} | ${fmt(r.bytes)} | ${levels.map((l) => `${fmt(r.levels[l].squeezeBytes)} / ${fmt(r.levels[l].zlibBytes)}`).join(' | ')} |\n`;
  return `${md}\n</details>\n\n`;
}
let md = `# Benchmarks

Generated by \`npm run bench\` on ${results.date}. Raw numbers: [\`bench/results.json\`](../bench/results.json).

## Method

- **Same machine, same process.** Squeeze (built TypeScript, \`dist/lib\`) and zlib ${results.zlib} (Node ${results.node}'s built-in \`node:zlib\`, native C) run one after the other in a single Node.js process on: ${results.machine.cpu}, ${results.machine.cores} cores, ${results.machine.memGiB} GiB RAM, ${results.machine.os}. Single-threaded.
- **Whole-buffer, raw DEFLATE.** \`deflateRaw(data, { level })\` vs \`zlib.deflateRawSync(data, { level })\`; sizes are raw DEFLATE bytes (no zlib/gzip framing). Levels 10–12 exist only in Squeeze and are compared with zlib level 9.
- **Timing:** median of ${RUNS} runs per file and level (Silesia: median of ${Math.min(RUNS, 3)}, level 10 a single run), wall-clock via \`process.hrtime\`. MB/s = uncompressed bytes / total median time over the corpus (10^6 bytes per MB).
- **Correctness guard:** every Squeeze output is decompressed by zlib and compared with the input before it is counted.
- **Corpora:** Canterbury (11 files, 2.8 MB) and Silesia (12 files, 211.9 MB), downloaded and SHA-256-verified by \`scripts/fetch-corpora.mjs\`.
- To reproduce: \`npm ci && npm run build && npm run bench\` (add \`--no-silesia\` for a 1-minute run).

## Results

`;
md += summary('Canterbury corpus', results.canterbury, canterburyLevels);
if (results.silesia) md += summary('Silesia corpus', results.silesia, silesiaLevels);
md += `## Reading the numbers

- Levels 1–9 use zlib's own search parameters (good/lazy/nice/chain), so sizes land close to zlib's; differences come from Squeeze's block splitting and optimal (package-merge) Huffman code lengths versus zlib's fixed 16K-symbol blocks and heuristic length limiting.
- Levels 10–12 replace greedy/lazy matching with a near-optimal parse (a shortest path under an iteratively refitted cost model), which is how they beat zlib's best level at a large cost in time.
- Speed: Squeeze is JavaScript running on V8; zlib is optimised C. The gap is reported as measured, not adjusted.
`;
writeFileSync('docs/BENCHMARKS.md', md);
console.log('wrote bench/results.json and docs/BENCHMARKS.md');
