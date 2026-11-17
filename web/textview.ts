// Canvas view of the uncompressed bytes with LZ77 back-references drawn as arcs,
// or coloured by the number of bits each byte cost (a heat map).

import type { PlainTrace } from './protocol.js';

export type ViewMode = 'refs' | 'heat';

/** Space above the first row so arcs into it are not clipped. */
const TOP = 56;

/** Sequential blue ramp, light → dark (cheap → expensive bits). */
const HEAT = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
];

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class TextView {
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  private trace: PlainTrace | null = null;
  private n = 0;
  private xs = new Float32Array(0);
  private rows = new Int32Array(0);
  private visible = new Uint8Array(0);
  private glyph: string[] = [];
  private rowStart: number[] = [];
  private tokenAt = new Int32Array(0);
  private cw = 8;
  private readonly lh = 26;
  private readonly pad = 12;
  private hover = -1;
  mode: ViewMode = 'refs';
  minArc = 4;

  constructor(private readonly host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    host.append(this.canvas, this.tip);
    new ResizeObserver(() => this.layout()).observe(host);
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e.offsetX, e.offsetY));
    this.canvas.addEventListener('mouseleave', () => this.setHover(-1, 0, 0));
    this.canvas.addEventListener('click', (e) => this.onMove(e.offsetX, e.offsetY));
  }

  /** Show `bytes` (only the first `limit`) with the tokens from `trace`. */
  set(bytes: Uint8Array, trace: PlainTrace, limit: number): void {
    this.trace = trace;
    this.n = Math.min(bytes.length, limit);
    // Display glyph per byte; UTF-8 continuation bytes are folded into their lead byte.
    this.glyph = new Array(this.n);
    this.visible = new Uint8Array(this.n);
    const dec = new TextDecoder('utf-8', { fatal: true });
    for (let i = 0; i < this.n; i++) {
      const b = bytes[i];
      let g = '';
      if (b === 10) g = '\n';
      else if (b === 9) g = ' ';
      else if (b >= 32 && b < 127) g = String.fromCharCode(b);
      else if (b >= 0xc2 && b <= 0xf4) {
        const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
        try {
          g = dec.decode(bytes.subarray(i, i + len));
          for (let k = 1; k < len && i + k < this.n; k++) this.glyph[i + k] = '';
          this.glyph[i] = g;
          this.visible[i] = 1;
          i += len - 1;
          continue;
        } catch {
          g = '·';
        }
      } else if (b >= 0x80 && b < 0xc0) g = '·';
      else g = '·';
      this.glyph[i] = g;
      this.visible[i] = g === '\n' ? 0 : 1;
    }
    this.tokenAt = new Int32Array(this.n).fill(-1);
    for (let t = 0; t < trace.count; t++) {
      const p = trace.pos[t];
      if (p >= this.n) break;
      const end = Math.min(this.n, p + Math.max(1, trace.len[t]));
      for (let j = p; j < end; j++) this.tokenAt[j] = t;
    }
    this.hover = -1;
    this.layout();
  }

  private layout(): void {
    const width = this.host.clientWidth;
    if (!width) return;
    const ctx = this.canvas.getContext('2d')!;
    ctx.font = this.font();
    this.cw = Math.max(6, ctx.measureText('M').width);
    const cols = Math.max(10, Math.floor((width - 2 * this.pad) / this.cw));
    this.xs = new Float32Array(this.n);
    this.rows = new Int32Array(this.n);
    this.rowStart = [0];
    let row = 0;
    let col = 0;
    for (let i = 0; i < this.n; i++) {
      const g = this.glyph[i];
      if (g === '') {
        this.xs[i] = this.xs[i - 1];
        this.rows[i] = this.rows[i - 1];
        continue;
      }
      // Wrap before a word that would not fit (or mid-word if the word is longer than a line).
      const startsWord =
        g !== ' ' && g !== '\n' && (i === 0 || this.glyph[i - 1] === ' ' || this.glyph[i - 1] === '\n');
      let wrap = col >= cols;
      if (!wrap && startsWord && col > 0) {
        let w = 0;
        for (let j = i; j < this.n && w <= cols; j++) {
          const gj = this.glyph[j];
          if (gj === ' ' || gj === '\n') break;
          if (gj !== '') w++;
        }
        wrap = w <= cols && col + w > cols;
      }
      if (wrap) {
        row++;
        col = 0;
        this.rowStart.push(i);
      }
      this.xs[i] = this.pad + col * this.cw;
      this.rows[i] = row;
      if (g === '\n') {
        row++;
        col = 0;
        this.rowStart.push(i + 1);
      } else col++;
    }
    const height = (row + 1) * this.lh + 2 * this.pad + TOP;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.draw();
  }

  private font(): string {
    return `15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  }

  private y(i: number): number {
    return this.pad + TOP + this.rows[i] * this.lh;
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const t = this.trace;
    if (!t) return;
    const ink = css('--text-primary');
    const muted = css('--text-muted');
    const matchBg = css('--match-bg');
    const arcColor = css('--arc');
    const hot = css('--accent-2');
    ctx.font = this.font();
    ctx.textBaseline = 'alphabetic';
    const cw = this.cw;
    const lh = this.lh;

    // Backgrounds.
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) continue;
      const tok = this.tokenAt[i];
      if (tok < 0) continue;
      let fill = '';
      if (this.mode === 'heat') {
        const bits = t.len[tok] === 0 ? t.bits[tok] : t.bits[tok] / t.len[tok];
        fill = HEAT[Math.min(HEAT.length - 1, Math.round(bits))];
      } else if (t.len[tok] > 0) fill = matchBg;
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(this.xs[i], this.y(i) - lh + 7, Math.ceil(cw), lh - 4);
      }
    }
    // Hovered token: highlight source and copy.
    const ht = this.hover >= 0 ? this.tokenAt[this.hover] : -1;
    if (ht >= 0 && t.len[ht] > 0) {
      const p = t.pos[ht];
      ctx.fillStyle = hot;
      ctx.globalAlpha = 0.28;
      for (const start of [p, p - t.dist[ht]]) {
        for (let j = Math.max(0, start); j < Math.min(this.n, start + t.len[ht]); j++) {
          if (this.visible[j]) ctx.fillRect(this.xs[j], this.y(j) - lh + 7, Math.ceil(cw), lh - 4);
        }
      }
      ctx.globalAlpha = 1;
    }
    // Glyphs.
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) continue;
      const tok = this.tokenAt[i];
      const heatDark =
        this.mode === 'heat' && tok >= 0 && (t.len[tok] === 0 ? t.bits[tok] : t.bits[tok] / t.len[tok]) >= 7;
      ctx.fillStyle = this.glyph[i] === '·' ? muted : heatDark ? '#ffffff' : ink;
      ctx.fillText(this.glyph[i], this.xs[i], this.y(i) - 6);
    }
    // Arcs.
    if (this.mode === 'refs') {
      ctx.lineWidth = 1;
      ctx.strokeStyle = arcColor;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      for (let k = 0; k < t.count; k++) {
        const p = t.pos[k];
        if (p >= this.n) break;
        if (t.len[k] < this.minArc || k === ht) continue;
        this.arcPath(ctx, k);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (ht >= 0 && t.len[ht] > 0) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = hot;
        ctx.beginPath();
        this.arcPath(ctx, ht);
        ctx.stroke();
      }
    }
  }

  private arcPath(ctx: CanvasRenderingContext2D, k: number): void {
    const t = this.trace!;
    const d = t.pos[k];
    const s = d - t.dist[k];
    if (s < 0) return;
    const half = Math.max(0, Math.min(t.len[k], 6) / 2) * this.cw;
    const x1 = this.xs[s] + half;
    const y1 = this.y(s) - this.lh + 7;
    const x2 = this.xs[d] + half;
    const y2 = this.y(d) - this.lh + 7;
    const lift = Math.min(48, 8 + Math.abs(x2 - x1) * 0.2 + Math.abs(y2 - y1) * 0.1);
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo((x1 + x2) / 2, Math.min(y1, y2) - lift, x2, y2);
  }

  private indexAt(x: number, y: number): number {
    const row = Math.floor((y - this.pad - TOP + this.lh - 7) / this.lh);
    if (row < 0 || row >= this.rowStart.length) return -1;
    const start = this.rowStart[row];
    const end = row + 1 < this.rowStart.length ? this.rowStart[row + 1] : this.n;
    for (let i = start; i < end; i++)
      if (this.visible[i] && x >= this.xs[i] && x < this.xs[i] + this.cw) return i;
    return -1;
  }

  private onMove(x: number, y: number): void {
    this.setHover(this.indexAt(x, y), x, y);
  }

  private setHover(i: number, x: number, y: number): void {
    const t = this.trace;
    const changed = (this.hover >= 0 ? this.tokenAt[this.hover] : -1) !== (i >= 0 ? this.tokenAt[i] : -1);
    this.hover = i;
    if (changed) this.draw();
    const tok = i >= 0 && t ? this.tokenAt[i] : -1;
    if (tok < 0 || !t) {
      this.tip.hidden = true;
      return;
    }
    const len = t.len[tok];
    if (len === 0) {
      const c = t.dist[tok];
      const ch =
        c >= 33 && c < 127
          ? `“${String.fromCharCode(c)}”`
          : c === 32
            ? 'space'
            : `byte 0x${c.toString(16).padStart(2, '0')}`;
      this.tip.innerHTML = `<b>Literal</b> ${ch}<br>${t.bits[tok]} bits (8 bits uncompressed)`;
    } else {
      this.tip.innerHTML = `<b>Back-reference</b>: copy ${len} bytes from ${t.dist[tok]} bytes back<br>${t.bits[tok]} bits for ${len * 8} bits of text (${(t.bits[tok] / len).toFixed(1)} bits/byte)`;
    }
    this.tip.hidden = false;
    const w = this.host.clientWidth;
    this.tip.style.left = `${Math.min(Math.max(4, x + 12), Math.max(4, w - 260))}px`;
    this.tip.style.top = `${y + 18}px`;
  }
}
