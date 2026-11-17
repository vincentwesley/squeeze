// gzip container (RFC 1952).

import { crc32 } from './checksum.js';
import { type DeflateOptions, deflateRaw } from './deflate/index.js';
import { fail } from './errors.js';
import { type InflateOptions, inflateRawAt } from './inflate.js';

export interface GzipHeader {
  /** Original file name (FNAME), decoded as Latin-1. */
  name?: string;
  /** Comment (FCOMMENT), decoded as Latin-1. */
  comment?: string;
  /** Modification time, seconds since the Unix epoch (0 = unknown). */
  mtime?: number;
  /** Raw FEXTRA field. */
  extra?: Uint8Array;
  /** Operating system byte (default 255 = unknown). */
  os?: number;
  /** FTEXT flag. */
  text?: boolean;
  /** Include a header CRC16 (FHCRC). */
  headerCrc?: boolean;
}

export interface GzipOptions extends DeflateOptions, GzipHeader {}

export interface GunzipOptions extends InflateOptions {
  /**
   * What to do with bytes after the last member that are not another gzip member.
   * Default false: throw TRAILING_DATA. (GNU gzip warns and ignores them.)
   */
  allowTrailingData?: boolean;
}

export interface GunzipMember {
  header: GzipHeader;
  /** Offset of the member within the input. */
  start: number;
  end: number;
  /** Uncompressed size of this member. */
  size: number;
}

/** Compress into a single-member gzip file. */
export function gzip(input: Uint8Array, options: GzipOptions = {}): Uint8Array {
  const level = options.level ?? 6;
  const head: number[] = [0x1f, 0x8b, 8];
  let flg = 0;
  if (options.text) flg |= 1;
  if (options.headerCrc) flg |= 2;
  if (options.extra) flg |= 4;
  if (options.name !== undefined) flg |= 8;
  if (options.comment !== undefined) flg |= 16;
  head.push(flg);
  const mtime = options.mtime ?? 0;
  head.push(mtime & 0xff, (mtime >>> 8) & 0xff, (mtime >>> 16) & 0xff, (mtime >>> 24) & 0xff);
  head.push(level >= 9 ? 2 : level === 1 ? 4 : 0, options.os ?? 255);
  if (options.extra) {
    if (options.extra.length > 65535) fail('BAD_ARGUMENT', 'gzip extra field too long');
    head.push(options.extra.length & 0xff, options.extra.length >>> 8, ...options.extra);
  }
  for (const s of [options.name, options.comment]) {
    if (s === undefined) continue;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0 || c > 255) fail('BAD_ARGUMENT', 'gzip name/comment must be Latin-1 without NUL');
      head.push(c);
    }
    head.push(0);
  }
  if (options.headerCrc) {
    const c = crc32(Uint8Array.from(head));
    head.push(c & 0xff, (c >>> 8) & 0xff);
  }
  const body = deflateRaw(input, options);
  const out = new Uint8Array(head.length + body.length + 8);
  out.set(head);
  out.set(body, head.length);
  let p = head.length + body.length;
  const crc = crc32(input);
  for (const v of [crc, input.length >>> 0]) {
    out[p++] = v & 0xff;
    out[p++] = (v >>> 8) & 0xff;
    out[p++] = (v >>> 16) & 0xff;
    out[p++] = v >>> 24;
  }
  return out;
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Parse one gzip member header at `p`; returns the header and the offset of the deflate data. */
export function parseGzipHeader(input: Uint8Array, p: number): { header: GzipHeader; dataStart: number } {
  const start = p;
  const need = (n: number) => {
    if (p + n > input.length) fail('UNEXPECTED_EOF', 'gzip header truncated');
  };
  need(10);
  if (input[p] !== 0x1f || input[p + 1] !== 0x8b) fail('BAD_HEADER', 'not a gzip file (bad magic)');
  if (input[p + 2] !== 8) fail('BAD_HEADER', 'unknown compression method');
  const flg = input[p + 3];
  if (flg & 0xe0) fail('BAD_HEADER', 'unknown header flags set');
  const header: GzipHeader = {
    mtime: (input[p + 4] | (input[p + 5] << 8) | (input[p + 6] << 16) | (input[p + 7] << 24)) >>> 0,
    os: input[p + 9],
    text: (flg & 1) !== 0,
    headerCrc: (flg & 2) !== 0,
  };
  p += 10;
  if (flg & 4) {
    need(2);
    const xlen = input[p] | (input[p + 1] << 8);
    p += 2;
    need(xlen);
    header.extra = input.slice(p, p + xlen);
    p += xlen;
  }
  if (flg & 8) {
    const z = input.indexOf(0, p);
    if (z < 0) fail('UNEXPECTED_EOF', 'gzip file name not terminated');
    header.name = latin1(input, p, z);
    p = z + 1;
  }
  if (flg & 16) {
    const z = input.indexOf(0, p);
    if (z < 0) fail('UNEXPECTED_EOF', 'gzip comment not terminated');
    header.comment = latin1(input, p, z);
    p = z + 1;
  }
  if (flg & 2) {
    need(2);
    const want = input[p] | (input[p + 1] << 8);
    if ((crc32(input, 0, start, p) & 0xffff) !== want) fail('BAD_CRC', 'header crc mismatch');
    p += 2;
  }
  return { header, dataStart: p };
}

/** Decompress every member of a gzip file and describe each one. */
export function gunzipMembers(
  input: Uint8Array,
  options: GunzipOptions = {},
): { data: Uint8Array; members: GunzipMember[] } {
  const parts: Uint8Array[] = [];
  const members: GunzipMember[] = [];
  let total = 0;
  let p = 0;
  const limit = options.maxOutputLength ?? Number.POSITIVE_INFINITY;
  do {
    const start = p;
    const { header, dataStart } = parseGzipHeader(input, p);
    const r = inflateRawAt(input, dataStart, { ...options, maxOutputLength: limit - total });
    p = r.end;
    if (p + 8 > input.length) fail('UNEXPECTED_EOF', 'gzip trailer truncated');
    const crc = (input[p] | (input[p + 1] << 8) | (input[p + 2] << 16) | (input[p + 3] << 24)) >>> 0;
    const isize = (input[p + 4] | (input[p + 5] << 8) | (input[p + 6] << 16) | (input[p + 7] << 24)) >>> 0;
    if (crc !== crc32(r.data)) fail('BAD_CHECKSUM', 'incorrect data check (CRC-32)');
    if (isize !== r.data.length >>> 0) fail('BAD_LENGTH', 'incorrect length check');
    p += 8;
    parts.push(r.data);
    total += r.data.length;
    members.push({ header, start, end: p, size: r.data.length });
    if (p < input.length && !(input[p] === 0x1f && (p + 1 >= input.length || input[p + 1] === 0x8b))) {
      if (options.allowTrailingData) break;
      fail('TRAILING_DATA', `${input.length - p} bytes of trailing garbage after gzip data`);
    }
  } while (p < input.length);
  if (parts.length === 1) return { data: parts[0], members };
  const data = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    data.set(part, o);
    o += part.length;
  }
  return { data, members };
}

/** Decompress a gzip file (all members, concatenated). */
export function gunzip(input: Uint8Array, options: GunzipOptions = {}): Uint8Array {
  return gunzipMembers(input, options).data;
}
