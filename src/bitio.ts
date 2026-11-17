/** LSB-first bit writer used by the DEFLATE encoder. Grows its buffer as needed. */
export class BitWriter {
  buf: Uint8Array;
  pos = 0;
  /** Pending bits, LSB first. Never holds more than 31 bits between calls. */
  private bits = 0;
  private count = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Write the low `n` bits of `value` (n ≤ 24). Invariant: fewer than 8 bits pending between calls. */
  writeBits(value: number, n: number): void {
    let bits = this.bits | (value << this.count);
    let count = this.count + n;
    if (count >= 8) {
      if (this.pos + 4 > this.buf.length) this.ensure(4);
      const buf = this.buf;
      let pos = this.pos;
      do {
        buf[pos++] = bits & 0xff;
        bits >>>= 8;
        count -= 8;
      } while (count >= 8);
      this.pos = pos;
    }
    this.bits = bits;
    this.count = count;
  }

  /** Total number of bits written so far. */
  get bitLength(): number {
    return this.pos * 8 + this.count;
  }

  /** Pad with zero bits to the next byte boundary. */
  alignToByte(): void {
    this.ensure(4);
    while (this.count > 0) {
      this.buf[this.pos++] = this.bits & 0xff;
      this.bits >>>= 8;
      this.count = Math.max(0, this.count - 8);
    }
    this.bits = 0;
    this.count = 0;
  }

  /** Append whole bytes; the writer must be byte-aligned. */
  writeBytes(data: Uint8Array, start = 0, end = data.length): void {
    this.alignToByte();
    this.ensure(end - start);
    this.buf.set(data.subarray(start, end), this.pos);
    this.pos += end - start;
  }

  finish(): Uint8Array {
    this.alignToByte();
    return this.buf.subarray(0, this.pos);
  }
}

/** Reverse the low `n` bits of `code`. */
export function reverseBits(code: number, n: number): number {
  let r = 0;
  for (let i = 0; i < n; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}
