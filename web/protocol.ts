// Messages between the page and its worker.
import type { TraceBlock } from '../src/trace.js';

export interface PlainTrace {
  blocks: TraceBlock[];
  count: number;
  pos: Int32Array;
  len: Int32Array;
  dist: Int32Array;
  bits: Int32Array;
}

export type Request =
  | { type: 'compress'; id: number; data: Uint8Array; level: number; maxBlockTokens: number }
  | { type: 'decode'; id: number; file: Uint8Array }
  | { type: 'levels'; id: number; data: Uint8Array }
  | { type: 'png-encode'; id: number; width: number; height: number; rgba: Uint8Array }
  | { type: 'png-decode'; id: number; file: Uint8Array };

export interface CompressResult {
  compressed: number;
  ms: number;
  inflateMs: number;
  trace: PlainTrace;
  verified: boolean;
}

export interface DecodeResult {
  format: 'gzip' | 'zlib' | 'raw' | 'png';
  data: Uint8Array;
  compressed: number;
  ms: number;
  trace: PlainTrace;
  name?: string;
}

export interface LevelPoint {
  level: number;
  size: number;
  ms: number;
}

export interface PngFilterResult {
  filter: string;
  size: number;
}

export interface PngEncodeResult {
  png: Uint8Array;
  /** Filter strategy the optimiser kept. */
  filter: string;
  colorType: number;
  bitDepth: number;
  filters: PngFilterResult[];
  /** Filter type used for each row of the final PNG. */
  rowFilters: Uint8Array;
  ms: number;
  roundTrip: boolean;
}

export interface PngDecodeResult {
  width: number;
  height: number;
  rgba: Uint8Array;
  header: { bitDepth: number; colorType: number; interlace: number };
  chunks: { type: string; length: number }[];
  idatBytes: number;
  rawBytes: number;
  rowFilters: Uint8Array;
  trace: PlainTrace;
  ms: number;
}

export type Response =
  | { id: number; type: 'compress'; result: CompressResult }
  | { id: number; type: 'decode'; result: DecodeResult }
  | { id: number; type: 'level'; point: LevelPoint }
  | { id: number; type: 'levels-done'; native?: { size: number; ms: number } }
  | { id: number; type: 'png-encode'; result: PngEncodeResult }
  | { id: number; type: 'png-decode'; result: PngDecodeResult }
  | { id: number; type: 'error'; message: string };
