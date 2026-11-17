// Bundle the CLI into a single executable ESM file.
import { chmodSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['cli/squeeze.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli/squeeze.js',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
});
chmodSync('dist/cli/squeeze.js', 0o755);
