/// <reference lib="webworker" />
// Runs all compression work off the main thread.

import {
  decodePng,
  deflateRaw,
  gunzipMembers,
  inflateRaw,
  newTrace,
  optimisePng,
  parseGzipHeader,
  SqueezeError,
  type Trace,
  zlibDecompress,
} from '../src/index.js';
import { filteredData } from '../src/png/encode.js';
import type { PlainTrace, Request, Response } from './protocol.js';

const post = (r: Response, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(r, transfer);

function plain(t: Trace): PlainTrace {
  const n = t.tokens.count;
  return {
    blocks: t.blocks,
    count: n,
    pos: t.tokens.pos.slice(0, n),
    len: t.tokens.len.slice(0, n),
    dist: t.tokens.dist.slice(0, n),
    bits: t.tokens.bits.slice(0, n),
  };
}

function detect(d: Uint8Array): 'gzip' | 'zlib' | 'png' | 'raw' {
  if (d[0] === 0x1f && d[1] === 0x8b) return 'gzip';
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'png';
  if (d.length >= 2 && (d[0] & 15) === 8 && d[0] >>> 4 <= 7 && ((d[0] << 8) | d[1]) % 31 === 0) return 'zlib';
  return 'raw';
}

async function nativeDeflate(data: Uint8Array): Promise<{ size: number; ms: number } | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  try {
    const t = performance.now();
    const cs = new CompressionStream('deflate-raw');
    const out = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(cs)).arrayBuffer();
    return { size: out.byteLength, ms: performance.now() - t };
  } catch {
    return undefined;
  }
}

/** Per-row filter types in a filtered (non-interlaced) image. */
function rowFiltersOf(raw: Uint8Array, rows: number): Uint8Array {
  const stride = raw.length / rows;
  const f = new Uint8Array(rows);
  for (let y = 0; y < rows; y++) f[y] = raw[y * stride];
  return f;
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'compress': {
        const trace = newTrace();
        const t = performance.now();
        const z = deflateRaw(m.data, { level: m.level, trace, maxBlockTokens: m.maxBlockTokens });
        const ms = performance.now() - t;
        const t2 = performance.now();
        const back = inflateRaw(z);
        const inflateMs = performance.now() - t2;
        const verified = back.length === m.data.length && back.every((v, i) => v === m.data[i]);
        post({
          id: m.id,
          type: 'compress',
          result: { compressed: z.length, ms, inflateMs, trace: plain(trace), verified },
        });
        return;
      }
      case 'decode': {
        const f = m.file;
        const fmt = detect(f);
        const trace = newTrace();
        const t = performance.now();
        let data: Uint8Array;
        let name: string | undefined;
        if (fmt === 'gzip') {
          const { members } = gunzipMembers(f);
          const { header, dataStart } = parseGzipHeader(f, 0);
          name = header.name;
          data = inflateRaw(f.subarray(dataStart, members[0].end - 8), { trace });
        } else if (fmt === 'zlib') {
          zlibDecompress(f, { allowTrailingData: true });
          data = inflateRaw(f.subarray(2 + (f[1] & 0x20 ? 4 : 0)), { trace });
        } else if (fmt === 'png') {
          throw new SqueezeError('UNSUPPORTED', 'PNG files belong in the PNG tab');
        } else data = inflateRaw(f, { trace });
        post({
          id: m.id,
          type: 'decode',
          result: {
            format: fmt,
            data,
            compressed: f.length,
            ms: performance.now() - t,
            trace: plain(trace),
            name,
          },
        });
        return;
      }
      case 'levels': {
        for (let level = 0; level <= 12; level++) {
          const t = performance.now();
          const z = deflateRaw(m.data, { level });
          post({ id: m.id, type: 'level', point: { level, size: z.length, ms: performance.now() - t } });
        }
        post({ id: m.id, type: 'levels-done', native: await nativeDeflate(m.data) });
        return;
      }
      case 'png-encode': {
        const img = { width: m.width, height: m.height, data: m.rgba };
        const t = performance.now();
        const best = optimisePng(img, { level: 9 });
        const ms = performance.now() - t;
        const filters = best.tried
          .filter((c) => c.colorType === best.layout.colorType)
          .map((c) => ({ filter: c.filter, size: c.size }));
        const rowFilters = rowFiltersOf(filteredData(img, best.layout, best.filter, false), m.height);
        const back = decodePng(best.png, { forceRgba8: true }).data;
        const roundTrip = back.length === m.rgba.length && back.every((v, i) => v === m.rgba[i]);
        const png = best.png;
        post(
          {
            id: m.id,
            type: 'png-encode',
            result: {
              png,
              filter: best.filter,
              colorType: best.layout.colorType,
              bitDepth: best.layout.bitDepth,
              filters,
              rowFilters,
              ms,
              roundTrip,
            },
          },
          [png.buffer],
        );
        return;
      }
      case 'png-decode': {
        const t = performance.now();
        const img = decodePng(m.file, { forceRgba8: true });
        const ms = performance.now() - t;
        // Re-inflate IDAT with tracing for the stats, and recover the per-row filter bytes.
        const idat: Uint8Array[] = [];
        for (const c of img.chunks)
          if (c.type === 'IDAT') idat.push(m.file.subarray(c.offset + 8, c.offset + 8 + c.length));
        const z = new Uint8Array(idat.reduce((a, b) => a + b.length, 0));
        let o = 0;
        for (const c of idat) {
          z.set(c, o);
          o += c.length;
        }
        const trace = newTrace();
        const raw = inflateRaw(z.subarray(2), { trace });
        const rowFilters = img.header.interlace ? new Uint8Array(0) : rowFiltersOf(raw, img.height);
        post({
          id: m.id,
          type: 'png-decode',
          result: {
            width: img.width,
            height: img.height,
            rgba: img.data as Uint8Array,
            header: img.header,
            chunks: img.chunks.map((c) => ({ type: c.type, length: c.length })),
            idatBytes: z.length,
            rawBytes: raw.length,
            rowFilters,
            trace: plain(trace),
            ms,
          },
        });
        return;
      }
    }
  } catch (e) {
    const msg = e instanceof SqueezeError ? `${e.message} [${e.code}]` : String(e);
    post({ id: m.id, type: 'error', message: msg });
  }
};
