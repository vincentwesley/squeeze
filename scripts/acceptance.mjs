#!/usr/bin/env node
// Runs every check in docs/ACCEPTANCE.md and prints PASS/FAIL per ID.
// Usage: node scripts/acceptance.mjs [--full] [--bench]
// Run from a fresh clone after `npm ci`. --full adds Silesia, a long fuzz run
// and the Chromium checks; --bench also regenerates docs/BENCHMARKS.md (about 25 minutes).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const full = process.argv.includes('--full');
const rebench = process.argv.includes('--bench');
const results = [];
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', maxBuffer: 1 << 30, ...opts });

async function check(id, title, fn) {
  const t = Date.now();
  process.stdout.write(`\n=== ${id} ${title}\n`);
  let status = 'PASS';
  let note = '';
  try {
    const r = await fn();
    if (r === 'SKIP' || (typeof r === 'string' && r.startsWith('SKIP'))) {
      status = 'SKIP';
      note = r;
    } else if (r === false) status = 'FAIL';
    else if (typeof r === 'string') note = r;
  } catch (e) {
    status = 'FAIL';
    note = e.message.split('\n')[0];
  }
  results.push({ id, title, status, note, secs: ((Date.now() - t) / 1000).toFixed(1) });
  process.stdout.write(`--- ${id} ${status}${note ? ` (${note})` : ''}\n`);
}

const npm = (script, ...args) =>
  run('npm', ['run', script, ...(args.length ? ['--', ...args] : [])]).status === 0;
const vitest = (...files) => run('npx', ['vitest', 'run', ...files]).status === 0;

await check('A1', 'Open-source hygiene', () => {
  const lic = readFileSync('LICENSE', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const readme = readFileSync('README.md', 'utf8');
  const ok =
    lic.startsWith('MIT License') &&
    /Copyright \(c\) 20\d\d Vin's Atelier/.test(lic) &&
    ['SECURITY.md', 'CHANGELOG.md', 'README.md', '.github/workflows/ci.yml'].every(existsSync) &&
    pkg.author === "Vin's Atelier" &&
    readme.includes("Vin's Atelier");
  return ok;
});
await check('A2', 'Lint and types', () => npm('lint'));
await check('A3', 'Unit and interop tests', () => npm('test'));
await check('A4', 'Build output', () => {
  if (!npm('build')) return false;
  for (const f of [
    'dist/lib/index.js',
    'dist/lib/index.d.ts',
    'dist/cli/squeeze.js',
    'dist/web/index.html',
    'dist/web/app.js',
    'dist/web/worker.js',
  ])
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  let biggest = 0;
  for (const f of readdirSync('dist/web')) biggest = Math.max(biggest, statSync(join('dist/web', f)).size);
  if (biggest >= 25 * 1024 * 1024) throw new Error('a web file is over 25 MiB');
  return `largest web file ${(biggest / 1024).toFixed(0)} KiB`;
});
await check('A5', 'zlib interop, Canterbury', () => vitest('test/corpora/canterbury.test.ts'));
await check('A6', 'zlib interop, Silesia', () => {
  if (!full) return 'SKIP (needs --full)';
  if (run('node', ['scripts/fetch-corpora.mjs', '--all']).status !== 0) return false;
  return (
    run('npx', ['vitest', 'run', 'test/corpora/silesia.test.ts'], {
      env: { ...process.env, SQUEEZE_SILESIA: '1' },
    }).status === 0
  );
});
await check('A7', 'gzip CLI interop', () => {
  const dir = '.cache/corpora/canterbury';
  const tmp = mkdtempSync(join(tmpdir(), 'squeeze-a7-'));
  for (const f of readdirSync(dir).filter((f) => !f.startsWith('.'))) {
    const src = join(dir, f);
    const out = join(tmp, `${f}.gz`);
    execFileSync('node', ['dist/cli/squeeze.js', 'compress', src, '-o', out, '-l', '9']);
    const back = execFileSync('gzip', ['-dc', out], { maxBuffer: 1 << 28 });
    if (!back.equals(readFileSync(src))) throw new Error(`gzip -d mismatch on ${f}`);
    const gz = execFileSync('gzip', ['-9c', src], { maxBuffer: 1 << 28 });
    const ours = execFileSync('node', ['dist/cli/squeeze.js', 'decompress', '-c'], {
      input: gz,
      maxBuffer: 1 << 28,
    });
    if (!ours.equals(readFileSync(src))) throw new Error(`squeeze decompress mismatch on ${f}`);
  }
  const a = readFileSync(join(dir, 'alice29.txt'));
  const b = readFileSync(join(dir, 'fields.c'));
  const two = Buffer.concat([
    execFileSync('gzip', ['-c'], { input: a }),
    execFileSync('gzip', ['-c'], { input: b }),
  ]);
  const cat = execFileSync('node', ['dist/cli/squeeze.js', 'decompress', '-c'], { input: two });
  return cat.equals(Buffer.concat([a, b]));
});
await check(
  'A8+A9+A10',
  'PngSuite: valid images match pngjs, broken images rejected, re-encodes readable',
  () => vitest('test/corpora/pngsuite.test.ts'),
);
await check('A10b', 'Pillow decodes Squeeze PNGs', async () => {
  const lib = await import(join(process.cwd(), 'dist/lib/index.js'));
  const dir = '.cache/corpora/pngsuite';
  const tmp = mkdtempSync(join(tmpdir(), 'squeeze-pillow-'));
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.png') && !f.startsWith('x'))) {
    const img = lib.decodePng(readFileSync(join(dir, f)));
    if (img.header.bitDepth === 16) continue; // Pillow reduces 16-bit differently; covered by pngjs in A10
    const rgba8 = lib.decodePng(readFileSync(join(dir, f)), { forceRgba8: true }).data;
    const base = f.slice(0, -4);
    writeFileSync(join(tmp, `${base}.png`), lib.encodePng(img));
    writeFileSync(join(tmp, `${base}.rgba`), rgba8);
    writeFileSync(join(tmp, `${base}-opt.png`), lib.optimisePng(img).png);
    writeFileSync(join(tmp, `${base}-opt.rgba`), rgba8);
    n++;
  }
  const r = run('python3', ['-I', 'scripts/pillow_check.py', tmp]);
  if (r.status === 3) return 'SKIP (Pillow not installed)';
  return r.status === 0 ? `${n * 2} files` : false;
});
await check('A11', 'Fuzzing', () => npm('fuzz', '--iterations', full ? '50000' : '2000'));
await check('A12', 'Benchmarks published', () => {
  if (rebench && !npm('bench')) return false;
  const md = readFileSync('docs/BENCHMARKS.md', 'utf8');
  return (
    md.includes('## Method') &&
    md.includes('Canterbury corpus') &&
    md.includes('Silesia corpus') &&
    md.includes('zlib')
  );
});
await check('A13', 'CLI round trip', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'squeeze-a13-'));
  const src = '.cache/corpora/canterbury/kennedy.xls';
  for (const fmt of ['raw', 'zlib', 'gzip']) {
    const out = join(tmp, `k.${fmt}`);
    execFileSync('node', ['dist/cli/squeeze.js', 'compress', src, '-f', fmt, '-o', out]);
    const back = execFileSync('node', ['dist/cli/squeeze.js', 'decompress', out, '-f', fmt, '-c'], {
      maxBuffer: 1 << 28,
    });
    if (!back.equals(readFileSync(src))) throw new Error(`${fmt} round trip failed`);
  }
  const lib = await import(join(process.cwd(), 'dist/lib/index.js'));
  const png = '.cache/corpora/pngsuite/basn6a08.png';
  const out = join(tmp, 'o.png');
  execFileSync('node', ['dist/cli/squeeze.js', 'png', 'optimise', png, '-o', out]);
  const a = lib.decodePng(readFileSync(png)).data;
  const b = lib.decodePng(readFileSync(out)).data;
  return a.length === b.length && a.every((v, i) => v === b[i]);
});
await check('A14', 'No secrets committed', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bghp_[A-Za-z0-9]{36}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9]{32,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  ];
  const hits = [];
  for (const f of files) {
    if (!existsSync(f) || statSync(f).size > 5e6) continue;
    const s = readFileSync(f, 'latin1');
    for (const p of patterns) if (p.test(s) && f !== 'scripts/acceptance.mjs') hits.push(`${f} ~ ${p}`);
  }
  if (hits.length) throw new Error(hits.join(', '));
  return `${files.length} files scanned`;
});
await check('A15+A16', 'Web page at phone/desktop widths; Chromium decodes Squeeze PNGs', () => {
  if (!full) return 'SKIP (needs --full)';
  const r = run('node', ['scripts/web-check.mjs']);
  if (r.status === 3) return 'SKIP (Playwright not installed)';
  return r.status === 0;
});

console.log('\n================ Acceptance summary ================');
for (const r of results)
  console.log(
    `${r.status.padEnd(5)} ${r.id.padEnd(10)} ${r.title}${r.note ? ` — ${r.note}` : ''} (${r.secs}s)`,
  );
const failed = results.filter((r) => r.status === 'FAIL');
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nAll checks passed');
process.exit(failed.length ? 1 : 0);
