// Minimal Netpbm (PGM/PPM P5/P6) and PAM (P7) reading/writing for the CLI's PNG commands.

import { SqueezeError } from '../src/errors.js';
import type { RgbaImage } from '../src/png/encode.js';

export function readPnm(buf: Uint8Array): RgbaImage {
  let p = 0;
  const token = (): string => {
    for (;;) {
      while (p < buf.length && /\s/.test(String.fromCharCode(buf[p]))) p++;
      if (buf[p] === 35) while (p < buf.length && buf[p] !== 10) p++;
      else break;
    }
    let s = '';
    while (p < buf.length && !/\s/.test(String.fromCharCode(buf[p]))) s += String.fromCharCode(buf[p++]);
    return s;
  };
  const magic = token();
  let width: number;
  let height: number;
  let maxval: number;
  let depth: number;
  if (magic === 'P5' || magic === 'P6') {
    width = Number(token());
    height = Number(token());
    maxval = Number(token());
    depth = magic === 'P5' ? 1 : 3;
    p++; // single whitespace before raster
  } else if (magic === 'P7') {
    const h: Record<string, string> = {};
    for (;;) {
      const line = readLine();
      if (line === null) throw new SqueezeError('BAD_ARGUMENT', 'PAM header not terminated');
      if (line === 'ENDHDR') break;
      if (!line || line.startsWith('#')) continue;
      const [k, ...v] = line.split(/\s+/);
      h[k] = v.join(' ');
    }
    width = Number(h.WIDTH);
    height = Number(h.HEIGHT);
    maxval = Number(h.MAXVAL);
    depth = Number(h.DEPTH);
  } else throw new SqueezeError('BAD_ARGUMENT', 'input is not a PGM, PPM or PAM file');
  function readLine(): string | null {
    if (p >= buf.length) return null;
    let s = '';
    while (p < buf.length && buf[p] !== 10) s += String.fromCharCode(buf[p++]);
    p++;
    return s.trim();
  }
  if (!(width > 0 && height > 0 && (maxval === 255 || maxval === 65535) && depth >= 1 && depth <= 4))
    throw new SqueezeError('BAD_ARGUMENT', 'unsupported PNM/PAM header (maxval must be 255 or 65535)');
  const wide = maxval === 65535;
  const n = width * height;
  const need = n * depth * (wide ? 2 : 1);
  if (buf.length - p < need) throw new SqueezeError('UNEXPECTED_EOF', 'PNM raster truncated');
  const out = wide ? new Uint16Array(n * 4) : new Uint8Array(n * 4);
  const s = (i: number) => (wide ? (buf[p + 2 * i] << 8) | buf[p + 2 * i + 1] : buf[p + i]);
  for (let i = 0; i < n; i++) {
    const b = i * depth;
    if (depth <= 2) out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = s(b);
    else {
      out[4 * i] = s(b);
      out[4 * i + 1] = s(b + 1);
      out[4 * i + 2] = s(b + 2);
    }
    out[4 * i + 3] = depth === 2 ? s(b + 1) : depth === 4 ? s(b + 3) : maxval;
  }
  return { width, height, data: out };
}

export function writePam(img: RgbaImage): Uint8Array {
  const wide = img.data instanceof Uint16Array;
  const head = new TextEncoder().encode(
    `P7\nWIDTH ${img.width}\nHEIGHT ${img.height}\nDEPTH 4\nMAXVAL ${wide ? 65535 : 255}\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
  );
  const n = img.data.length;
  const out = new Uint8Array(head.length + n * (wide ? 2 : 1));
  out.set(head);
  if (wide) {
    for (let i = 0; i < n; i++) {
      out[head.length + 2 * i] = img.data[i] >>> 8;
      out[head.length + 2 * i + 1] = img.data[i] & 255;
    }
  } else out.set(img.data as Uint8Array, head.length);
  return out;
}
