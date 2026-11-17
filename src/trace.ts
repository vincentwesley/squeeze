// A trace records what a DEFLATE stream contains: its blocks and every literal/match token,
// with bit offsets. The encoder and decoder produce the same format, which the CLI's
// `inspect` command and the web visualiser consume.

export type BlockType = 0 | 1 | 2;

export interface TraceBlock {
  /** 0 = stored, 1 = fixed Huffman, 2 = dynamic Huffman. */
  type: BlockType;
  final: boolean;
  /** Bit offset of the 3-bit block header within the deflate stream. */
  bitStart: number;
  /** Bits spent on the header (3 + stored padding/LEN/NLEN, or dynamic code description). */
  headerBits: number;
  /** Bit offset just past the end-of-block code (or stored bytes). */
  bitEnd: number;
  /** Range of uncompressed output covered by this block. */
  outStart: number;
  outEnd: number;
  /** Range of tokens (indices into TokenTrace) in this block. */
  tokenStart: number;
  tokenEnd: number;
  /** Code lengths for Huffman blocks (fixed blocks get the fixed lengths). */
  litLenLengths?: Uint8Array;
  distLengths?: Uint8Array;
  /** Code-length-code lengths (dynamic blocks only), indexed by symbol 0..18. */
  codeLengthLengths?: Uint8Array;
}

/** Struct-of-arrays token list. A literal has len = 0 and dist = byte value. */
export class TokenTrace {
  count = 0;
  pos = new Int32Array(1024);
  len = new Int32Array(1024);
  dist = new Int32Array(1024);
  /** Bits used to code the token, including extra bits (0 for stored data). */
  bits = new Int32Array(1024);

  push(pos: number, len: number, dist: number, bits: number): void {
    if (this.count === this.pos.length) this.grow();
    const i = this.count++;
    this.pos[i] = pos;
    this.len[i] = len;
    this.dist[i] = dist;
    this.bits[i] = bits;
  }

  private grow(): void {
    const n = this.pos.length * 2;
    const g = (a: Int32Array) => {
      const b = new Int32Array(n);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos);
    this.len = g(this.len);
    this.dist = g(this.dist);
    this.bits = g(this.bits);
  }
}

export interface Trace {
  blocks: TraceBlock[];
  tokens: TokenTrace;
}

export function newTrace(): Trace {
  return { blocks: [], tokens: new TokenTrace() };
}

/** Bits spent per uncompressed byte (a match's bits are spread evenly over its bytes). */
export function bitCostPerByte(trace: Trace, outputLength: number): Float32Array {
  const cost = new Float32Array(outputLength);
  const t = trace.tokens;
  for (let i = 0; i < t.count; i++) {
    const p = t.pos[i];
    if (t.len[i] === 0) {
      if (p < outputLength) cost[p] = t.bits[i];
    } else {
      const per = t.bits[i] / t.len[i];
      const end = Math.min(outputLength, p + t.len[i]);
      for (let j = p; j < end; j++) cost[j] = per;
    }
  }
  for (const b of trace.blocks) {
    if (b.type === 0) for (let j = b.outStart; j < b.outEnd && j < outputLength; j++) cost[j] = 8;
  }
  return cost;
}
