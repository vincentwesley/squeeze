#!/usr/bin/env node
// Download the public test corpora into .cache/corpora, verifying pinned SHA-256 hashes.
// Usage: node scripts/fetch-corpora.mjs [--silesia] [--all]
// The corpora are never committed or bundled (see docs/RESEARCH.md for licences).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CORPORA_DIR = process.env.SQUEEZE_CORPORA_DIR ?? join(root, '.cache', 'corpora');

const SOURCES = {
  canterbury: {
    url: 'https://corpus.canterbury.ac.nz/resources/cantrbry.tar.gz',
    mirrors: [
      'http://corpus.canterbury.ac.nz/resources/cantrbry.tar.gz',
      'https://web.archive.org/web/2024id_/https://corpus.canterbury.ac.nz/resources/cantrbry.tar.gz',
    ],
    sha256: 'f140e8a5b73d3f53198555a63bfb827889394a42f20825df33c810c3d5e3f8fb',
    kind: 'tgz',
  },
  pngsuite: {
    url: 'http://www.schaik.com/pngsuite/PngSuite-2017jul19.tgz',
    mirrors: ['https://web.archive.org/web/2024id_/http://www.schaik.com/pngsuite/PngSuite-2017jul19.tgz'],
    sha256: '0294b244c95a8342c01b00010cf34abdcabc7c6a34fd0fe1bd963917537bfdc8',
    kind: 'tgz',
  },
  silesia: {
    url: 'https://sun.aei.polsl.pl//~sdeor/corpus/silesia.zip',
    mirrors: ['https://web.archive.org/web/2024id_/https://sun.aei.polsl.pl//~sdeor/corpus/silesia.zip'],
    sha256: '0626e25f45c0ffb5dc801f13b7c82a3b75743ba07e3a71835a41e3d9f63c77af',
    kind: 'zip',
  },
};

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'squeeze-test-corpus-fetch/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw new Error(`download failed for ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Try the primary URL, then each mirror; accept only bytes matching the pinned hash. */
async function downloadVerified(name, src) {
  const errors = [];
  for (const url of [src.url, ...(src.mirrors ?? [])]) {
    try {
      process.stderr.write(`downloading ${name} from ${url}\n`);
      const buf = await download(url);
      const got = createHash('sha256').update(buf).digest('hex');
      if (got === src.sha256) return buf;
      errors.push(`${url}: SHA-256 mismatch (got ${got})`);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`${name}: every source failed:\n  ${errors.join('\n  ')}`);
}

export async function fetchCorpus(name) {
  const src = SOURCES[name];
  const dir = join(CORPORA_DIR, name);
  const stamp = join(dir, '.sha256');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === src.sha256) return dir;
  mkdirSync(dir, { recursive: true });
  const archive = join(CORPORA_DIR, `${name}.${src.kind === 'zip' ? 'zip' : 'tgz'}`);
  let buf = existsSync(archive) ? readFileSync(archive) : null;
  if (!buf || createHash('sha256').update(buf).digest('hex') !== src.sha256) {
    buf = await downloadVerified(name, src);
    writeFileSync(archive, buf);
  }
  if (src.kind === 'tgz') execFileSync('tar', ['xzf', archive, '-C', dir]);
  else {
    try {
      execFileSync('unzip', ['-o', '-q', archive, '-d', dir]);
    } catch {
      execFileSync('python3', ['-I', '-m', 'zipfile', '-e', archive, dir]);
    }
  }
  writeFileSync(stamp, src.sha256);
  process.stderr.write(`${name}: ${readdirSync(dir).length - 1} files in ${dir}\n`);
  return dir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const names = ['canterbury', 'pngsuite'];
  if (args.includes('--silesia') || args.includes('--all')) names.push('silesia');
  for (const n of names) await fetchCorpus(n);
}
