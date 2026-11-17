#!/usr/bin/env node
// Long fuzzing run. Usage: node scripts/fuzz.mjs [--iterations N] [--seed S]
// Bundles test/fuzz-core.ts with esbuild, runs it, writes failing inputs to fuzz-crashes/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values } = parseArgs({ options: { iterations: { type: 'string' }, seed: { type: 'string' } } });
const iterations = Number(values.iterations ?? 20000);
const seed = Number(values.seed ?? Date.now() % 1e9);
const out = join('.cache', 'fuzz-core.mjs');
await build({
  entryPoints: ['test/fuzz-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'warning',
});
const { runFuzz } = await import(join(process.cwd(), out));
const t = performance.now();
const stats = runFuzz(iterations, seed);
const secs = ((performance.now() - t) / 1000).toFixed(1);
console.log(
  `fuzz seed=${seed}: ${stats.cases} cases in ${secs}s — agreed with zlib: ${stats.bothAccepted} accepted, ${stats.bothRejected} rejected; ` +
    `PNG: ${stats.pngAccepted} decoded, ${stats.pngRejected} rejected; slowest case ${stats.slowestMs.toFixed(1)} ms; failures: ${stats.failures.length}`,
);
if (stats.failures.length) {
  mkdirSync('fuzz-crashes', { recursive: true });
  stats.failures.slice(0, 50).forEach((f, i) => {
    writeFileSync(join('fuzz-crashes', `${f.kind}-${seed}-${i}.bin`), f.input);
    console.log(`  ${f.kind}: ${f.detail}`);
  });
  process.exit(1);
}
if (stats.slowestMs > 2000) {
  console.log('a single case took over 2 s — possible hang');
  process.exit(1);
}
