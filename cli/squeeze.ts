#!/usr/bin/env node
// squeeze — command-line front end for the Squeeze library.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import * as zlibNative from 'node:zlib';
import {
  decodePng,
  deflateRaw,
  encodePng,
  gunzipMembers,
  gzip,
  inflateRaw,
  MAX_LEVEL,
  newTrace,
  optimisePng,
  SqueezeError,
  type Trace,
  zlibCompress,
  zlibDecompress,
} from '../src/index.js';
import { readPnm, writePam } from './pnm.js';

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

const HELP = `squeeze ${VERSION} — DEFLATE, zlib, gzip and PNG from scratch (Vin's Atelier)

Usage:
  squeeze compress   [file] [-f gzip|zlib|raw] [-l 0-${MAX_LEVEL}] [-o out | -c] [--force]
  squeeze decompress [file] [-f auto|gzip|zlib|raw] [-o out | -c] [--max-output BYTES] [--force]
  squeeze inspect    [file] [-f auto|gzip|zlib|raw|png] [--tokens N]
  squeeze png encode   <in.pam|ppm|pgm> -o out.png [-l N] [--interlace]
  squeeze png decode   <in.png> -o out.pam
  squeeze png optimise <in.png> [-o out.png] [-l N]
  squeeze png info     <in.png>
  squeeze bench      <file...> [-l LEVELS] [--runs N]

With no file (or "-"), compress/decompress read stdin and write stdout.
Without -o, "compress x" writes x.gz / x.zz / x.deflate and "decompress x.gz" writes x.
Levels: 0 stored, 1-3 greedy, 4-9 lazy (zlib's settings), 10-12 optimal parsing (slow).
Exit codes: 0 ok, 1 bad input or usage, 2 file exists (use --force).
`;

const EXT: Record<string, string> = { gzip: '.gz', zlib: '.zz', raw: '.deflate' };

function readInput(file: string | undefined): Uint8Array {
  const b = !file || file === '-' ? readFileSync(0) : readFileSync(file);
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

function writeOutput(path: string | null, data: Uint8Array, force: boolean): void {
  if (path === null) {
    process.stdout.write(data);
    return;
  }
  if (existsSync(path) && !force) {
    process.stderr.write(`squeeze: ${path} already exists (use --force to overwrite)\n`);
    process.exit(2);
  }
  writeFileSync(path, data);
}

function detect(data: Uint8Array): 'gzip' | 'zlib' | 'png' | 'raw' {
  if (data[0] === 0x1f && data[1] === 0x8b) return 'gzip';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (data.length >= 2 && (data[0] & 15) === 8 && data[0] >>> 4 <= 7 && ((data[0] << 8) | data[1]) % 31 === 0)
    return 'zlib';
  return 'raw';
}

function parseLevel(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEVEL)
    throw new SqueezeError('BAD_ARGUMENT', `level must be 0..${MAX_LEVEL}`);
  return n;
}

const fmtBytes = (n: number) => n.toLocaleString('en-US');

function main(argv: string[]): void {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '-v' || cmd === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const { values: o, positionals: pos } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      format: { type: 'string', short: 'f' },
      level: { type: 'string', short: 'l' },
      output: { type: 'string', short: 'o' },
      stdout: { type: 'boolean', short: 'c' },
      force: { type: 'boolean' },
      'max-output': { type: 'string' },
      tokens: { type: 'string' },
      interlace: { type: 'boolean' },
      runs: { type: 'string' },
    },
  });
  const force = o.force === true;

  switch (cmd) {
    case 'compress': {
      const fmt = o.format ?? 'gzip';
      if (!(fmt in EXT)) throw new SqueezeError('BAD_ARGUMENT', `unknown format ${fmt}`);
      const file = pos[0];
      const data = readInput(file);
      const level = parseLevel(o.level, 6);
      const out =
        fmt === 'gzip'
          ? gzip(data, { level, name: file && file !== '-' ? basename(file) : undefined })
          : fmt === 'zlib'
            ? zlibCompress(data, { level })
            : deflateRaw(data, { level });
      const dest = o.stdout || !file || file === '-' ? (o.output ?? null) : (o.output ?? file + EXT[fmt]);
      writeOutput(dest, out, force);
      return;
    }
    case 'decompress': {
      const file = pos[0];
      const data = readInput(file);
      const maxOutputLength = o['max-output'] ? Number(o['max-output']) : 1 << 30;
      let fmt = o.format ?? 'auto';
      if (fmt === 'auto') fmt = detect(data);
      const out =
        fmt === 'gzip'
          ? gunzipMembers(data, { maxOutputLength }).data
          : fmt === 'zlib'
            ? zlibDecompress(data, { maxOutputLength })
            : fmt === 'raw'
              ? inflateRaw(data, { maxOutputLength })
              : (() => {
                  throw new SqueezeError('BAD_ARGUMENT', `cannot decompress format ${fmt}`);
                })();
      let dest: string | null = o.output ?? null;
      if (!dest && !o.stdout && file && file !== '-') {
        const ext = Object.values(EXT).find((e) => file.endsWith(e));
        if (!ext)
          throw new SqueezeError('BAD_ARGUMENT', `don't know the output name for ${file}; use -o or -c`);
        dest = file.slice(0, -ext.length);
      }
      writeOutput(dest, out, force);
      return;
    }
    case 'inspect':
      inspect(readInput(pos[0]), o.format ?? 'auto', Number(o.tokens ?? 0));
      return;
    case 'png':
      png(pos, o.output, parseLevel(o.level, 9), o.interlace === true, force);
      return;
    case 'bench':
      bench(
        pos,
        (o.level ?? '1,6,9').split(',').map((l) => parseLevel(l, 6)),
        Number(o.runs ?? 3),
      );
      return;
    default:
      throw new SqueezeError('BAD_ARGUMENT', `unknown command "${cmd}" (try --help)`);
  }
}

function describeTrace(trace: Trace, outLen: number, inBits: number, showTokens: number): void {
  const t = trace.tokens;
  let lits = 0;
  let matches = 0;
  let matched = 0;
  for (let i = 0; i < t.count; i++) {
    if (t.len[i] === 0) lits++;
    else {
      matches++;
      matched += t.len[i];
    }
  }
  const types = ['stored', 'fixed', 'dynamic'];
  console.log(`deflate stream: ${fmtBytes(Math.ceil(inBits / 8))} bytes → ${fmtBytes(outLen)} bytes`);
  console.log(
    `blocks: ${trace.blocks.length}, literals: ${fmtBytes(lits)}, matches: ${fmtBytes(matches)} covering ${fmtBytes(matched)} bytes`,
  );
  console.log('');
  console.log('  #  type     final  out bytes        bits  header bits  bits/byte');
  trace.blocks.forEach((b, i) => {
    const bytes = b.outEnd - b.outStart;
    const bits = b.bitEnd - b.bitStart;
    console.log(
      `${String(i).padStart(3)}  ${types[b.type].padEnd(8)} ${(b.final ? 'yes' : '').padEnd(5)} ${String(bytes).padStart(10)} ${String(bits).padStart(11)} ${String(b.headerBits).padStart(12)} ${(bytes ? bits / bytes : 0).toFixed(2).padStart(10)}`,
    );
  });
  if (showTokens > 0) {
    console.log('');
    for (let i = 0; i < Math.min(showTokens, t.count); i++) {
      if (t.len[i] === 0) {
        const c = t.dist[i];
        console.log(
          `  @${t.pos[i]}  literal ${c >= 32 && c < 127 ? `'${String.fromCharCode(c)}'` : `0x${c.toString(16).padStart(2, '0')}`}  (${t.bits[i]} bits)`,
        );
      } else
        console.log(`  @${t.pos[i]}  match length ${t.len[i]} distance ${t.dist[i]}  (${t.bits[i]} bits)`);
    }
  }
}

function inspect(data: Uint8Array, format: string, tokens: number): void {
  const fmt = format === 'auto' ? detect(data) : format;
  const trace = newTrace();
  if (fmt === 'png') {
    const img = decodePng(data);
    const h = img.header;
    console.log(
      `PNG ${h.width}×${h.height}, colour type ${h.colorType}, bit depth ${h.bitDepth}, ${h.interlace ? 'Adam7 interlaced' : 'not interlaced'}`,
    );
    for (const c of img.chunks)
      console.log(`  ${c.type}  ${String(c.length).padStart(8)} bytes at offset ${c.offset}`);
    return;
  }
  if (fmt === 'gzip') {
    const { members } = gunzipMembers(data);
    for (const m of members) {
      console.log(
        `gzip member at ${m.start}: name=${m.header.name ?? '-'} mtime=${m.header.mtime} os=${m.header.os}, ${fmtBytes(m.size)} bytes`,
      );
    }
    // Trace the first member.
    const m = members[0];
    let p = 10;
    const flg = data[3];
    if (flg & 4) p += 2 + (data[10] | (data[11] << 8));
    if (flg & 8) p = data.indexOf(0, p) + 1;
    if (flg & 16) p = data.indexOf(0, p) + 1;
    if (flg & 2) p += 2;
    const sub = data.subarray(p, m.end - 8);
    const out = inflateRaw(sub, { trace });
    describeTrace(trace, out.length, sub.length * 8, tokens);
    return;
  }
  if (fmt === 'zlib') {
    const sub = data.subarray(2 + (data[1] & 0x20 ? 4 : 0), data.length - 4);
    zlibDecompress(data);
    const out = inflateRaw(sub, { trace });
    describeTrace(trace, out.length, sub.length * 8, tokens);
    return;
  }
  const out = inflateRaw(data, { trace });
  describeTrace(trace, out.length, data.length * 8, tokens);
}

function png(
  pos: string[],
  output: string | undefined,
  level: number,
  interlace: boolean,
  force: boolean,
): void {
  const [sub, file] = pos;
  if (!file) throw new SqueezeError('BAD_ARGUMENT', 'png: missing input file');
  const data = readInput(file);
  switch (sub) {
    case 'encode': {
      if (!output) throw new SqueezeError('BAD_ARGUMENT', 'png encode: -o out.png is required');
      writeOutput(output, encodePng(readPnm(data), { level, interlace }), force);
      return;
    }
    case 'decode': {
      if (!output) throw new SqueezeError('BAD_ARGUMENT', 'png decode: -o out.pam is required');
      writeOutput(output, writePam(decodePng(data)), force);
      return;
    }
    case 'optimise':
    case 'optimize': {
      const img = decodePng(data);
      const r = optimisePng(img, { level, interlace });
      const dest = output ?? `${file.replace(/\.png$/i, '')}.min.png`;
      writeOutput(dest, r.png, force);
      const pct = ((100 * r.png.length) / data.length).toFixed(1);
      process.stderr.write(
        `${file}: ${fmtBytes(data.length)} → ${fmtBytes(r.png.length)} bytes (${pct}%), colour type ${r.layout.colorType}, depth ${r.layout.bitDepth}, filter ${r.filter}\n`,
      );
      return;
    }
    case 'info':
      inspect(data, 'png', 0);
      return;
    default:
      throw new SqueezeError('BAD_ARGUMENT', `unknown png command "${sub}"`);
  }
}

function bench(files: string[], levels: number[], runs: number): void {
  if (!files.length) throw new SqueezeError('BAD_ARGUMENT', 'bench: give at least one file');
  const time = (f: () => unknown) => {
    const ts: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      f();
      ts.push(performance.now() - t);
    }
    return ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)];
  };
  console.log('file                 level   squeeze bytes   zlib bytes   squeeze MB/s   zlib MB/s');
  for (const file of files) {
    const data = readInput(file);
    for (const level of levels) {
      let ours: Uint8Array = new Uint8Array();
      const t1 = time(() => (ours = deflateRaw(data, { level })));
      let theirs: Buffer = Buffer.alloc(0);
      const t2 = time(() => (theirs = zlibNative.deflateRawSync(data, { level: Math.min(level, 9) })));
      const mbs = (ms: number) => (data.length / 1e6 / (ms / 1000)).toFixed(1);
      console.log(
        `${basename(file).slice(0, 20).padEnd(20)} ${String(level).padStart(5)} ${String(ours.length).padStart(15)} ${String(theirs.length).padStart(12)} ${mbs(t1).padStart(14)} ${mbs(t2).padStart(11)}`,
      );
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof SqueezeError) {
    process.stderr.write(`squeeze: ${e.message} [${e.code}]\n`);
    process.exit(1);
  }
  if (e instanceof Error && 'code' in e && typeof (e as NodeJS.ErrnoException).code === 'string') {
    process.stderr.write(`squeeze: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
