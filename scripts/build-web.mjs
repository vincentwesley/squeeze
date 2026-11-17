// Build the static web page into dist/web (open dist/web/index.html via any static server).
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const out = 'dist/web';
mkdirSync(out, { recursive: true });
const common = {
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  logLevel: 'warning',
};
await build({ ...common, entryPoints: ['web/main.ts'], outfile: join(out, 'app.js') });
await build({ ...common, entryPoints: ['web/worker.ts'], outfile: join(out, 'worker.js') });
for (const f of ['index.html', 'styles.css']) copyFileSync(join('web', f), join(out, f));

const LIMIT = 25 * 1024 * 1024;
for (const f of readdirSync(out)) {
  const size = statSync(join(out, f)).size;
  if (size >= LIMIT) throw new Error(`${f} is ${size} bytes, over the 25 MiB limit`);
}
