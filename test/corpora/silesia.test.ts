import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS helper without types
import { fetchCorpus } from '../../scripts/fetch-corpora.mjs';
import { checkFile, checkGnuGzip, corpusFiles, hasGzip } from './corpus-roundtrip.js';

// 200 MB download and several minutes of CPU: opt in with SQUEEZE_SILESIA=1.
const enabled = process.env.SQUEEZE_SILESIA === '1';

describe.runIf(enabled)('Silesia corpus', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await fetchCorpus('silesia');
  }, 600_000);
  it('has 12 files', () => expect(corpusFiles(dir).length).toBe(12));
  it('round-trips every file through zlib both ways (levels 1,6,9)', () => {
    for (const f of corpusFiles(dir)) checkFile(join(dir, f), [1, 6, 9], [1, 6, 9]);
  }, 1_800_000);
  it.runIf(hasGzip())(
    'interoperates with GNU gzip',
    () => {
      for (const f of corpusFiles(dir)) checkGnuGzip(join(dir, f));
    },
    1_800_000,
  );
});
