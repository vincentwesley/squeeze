// Step-by-step Huffman tree construction for one alphabet of one block, drawn in SVG.

import { canonicalCodes } from '../src/huffman.js';

export interface SymbolInfo {
  symbol: number;
  label: string;
  freq: number;
  /** Code length DEFLATE actually used (length-limited), 0 if unused. */
  deflateBits: number;
}

interface Node {
  id: number;
  weight: number;
  left: number;
  right: number;
  sym: number; // -1 for internal
  depth: number;
  x: number;
  y: number;
}

const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class HuffmanView {
  private nodes: Node[] = [];
  private leaves = 0;
  private step = 0;
  private timer: number | null = null;
  private symbols: SymbolInfo[] = [];
  onStep: (step: number, total: number) => void = () => {};

  constructor(
    private readonly svgHost: HTMLElement,
    private readonly tableHost: HTMLElement,
  ) {}

  get total(): number {
    return Math.max(0, this.leaves - 1);
  }

  set(symbols: SymbolInfo[]): void {
    this.stop();
    this.symbols = symbols.filter((s) => s.freq > 0);
    const leaves = [...this.symbols].sort((a, b) => a.freq - b.freq || a.symbol - b.symbol);
    this.nodes = leaves.map((s, i) => ({
      id: i,
      weight: s.freq,
      left: -1,
      right: -1,
      sym: s.symbol,
      depth: 0,
      x: 0,
      y: 0,
    }));
    this.leaves = this.nodes.length;
    // Classic Huffman: repeatedly merge the two lightest roots (ties: older node first).
    const roots = this.nodes.map((n) => n.id);
    while (roots.length > 1) {
      roots.sort((a, b) => this.nodes[a].weight - this.nodes[b].weight || a - b);
      const [a, b] = roots.splice(0, 2);
      const id = this.nodes.length;
      this.nodes.push({
        id,
        weight: this.nodes[a].weight + this.nodes[b].weight,
        left: a,
        right: b,
        sym: -1,
        depth: 0,
        x: 0,
        y: 0,
      });
      roots.push(id);
    }
    // Layout the final tree: leaves in in-order sequence, parents centred over children.
    let leafX = 0;
    const place = (id: number, depth: number): void => {
      const n = this.nodes[id];
      n.depth = depth;
      n.y = depth;
      if (n.sym >= 0) {
        n.x = leafX++;
        return;
      }
      place(n.left, depth + 1);
      place(n.right, depth + 1);
      n.x = (this.nodes[n.left].x + this.nodes[n.right].x) / 2;
    };
    if (this.nodes.length) place(this.nodes.length - 1, 0);
    this.step = this.total;
    this.render();
    this.renderTable();
  }

  reset(): void {
    this.stop();
    this.step = 0;
    this.render();
  }

  next(): boolean {
    if (this.step >= this.total) return false;
    this.step++;
    this.render();
    return true;
  }

  play(ms = 350): void {
    this.stop();
    if (this.step >= this.total) this.step = 0;
    this.render();
    this.timer = window.setInterval(() => {
      if (!this.next()) this.stop();
    }, ms);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  private label(sym: number): string {
    return this.symbols.find((s) => s.symbol === sym)?.label ?? String(sym);
  }

  private render(): void {
    this.svgHost.textContent = '';
    this.onStep(this.step, this.total);
    if (!this.nodes.length) {
      this.svgHost.textContent = 'This block has no symbols in this alphabet.';
      return;
    }
    const dx = 26;
    const dy = 46;
    const maxDepth = Math.max(...this.nodes.map((n) => n.depth));
    const width = this.leaves * dx + 40;
    const height = (maxDepth + 1) * dy + 50;
    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
    svg.setAttribute(
      'aria-label',
      `Huffman tree with ${this.leaves} symbols, step ${this.step} of ${this.total}`,
    );
    const X = (n: Node) => 20 + n.x * dx + dx / 2;
    // During construction, unmerged subtrees sit on the bottom row; they rise to their final depth once joined.
    const shown = this.leaves + this.step;
    const parentOf = new Int32Array(this.nodes.length).fill(-1);
    for (const n of this.nodes) if (n.sym < 0) parentOf[n.left] = parentOf[n.right] = n.id;
    const isRoot = (id: number) => id < shown && (parentOf[id] < 0 || parentOf[id] >= shown);
    const rootOf = (id: number) => {
      while (!isRoot(id)) id = parentOf[id];
      return id;
    };
    // Height of each subtree (for drawing unfinished subtrees bottom-aligned).
    const height2 = new Int32Array(this.nodes.length);
    for (const n of this.nodes)
      if (n.sym < 0) height2[n.id] = 1 + Math.max(height2[n.left], height2[n.right]);
    const Y = (n: Node) => {
      const r = this.nodes[rootOf(n.id)];
      const rootDepth = maxDepth - height2[r.id];
      return 24 + (rootDepth + (n.depth - r.depth)) * dy;
    };
    const merging = this.step > 0 ? this.nodes[this.leaves + this.step - 1] : null;
    const g = el('g', {});
    for (let id = this.leaves; id < shown; id++) {
      const n = this.nodes[id];
      for (const c of [n.left, n.right]) {
        const ch = this.nodes[c];
        g.append(
          el('line', {
            x1: X(n),
            y1: Y(n),
            x2: X(ch),
            y2: Y(ch),
            class: merging && merging.id === id ? 'edge hot' : 'edge',
          }),
        );
        const lbl = el('text', {
          x: (X(n) + X(ch)) / 2 + (c === n.left ? -7 : 7),
          y: (Y(n) + Y(ch)) / 2,
          class: 'bit',
        });
        lbl.textContent = c === n.left ? '0' : '1';
        g.append(lbl);
      }
    }
    for (let id = 0; id < shown; id++) {
      const n = this.nodes[id];
      const cls = ['node', n.sym >= 0 ? 'leaf' : 'inner'];
      if (isRoot(id)) cls.push('root');
      if (merging && (merging.id === id || merging.left === id || merging.right === id)) cls.push('hot');
      const c = el('circle', { cx: X(n), cy: Y(n), r: n.sym >= 0 ? 9 : 6, class: cls.join(' ') });
      const title = el('title', {});
      title.textContent = n.sym >= 0 ? `${this.label(n.sym)}: ${n.weight} occurrences` : `weight ${n.weight}`;
      c.append(title);
      g.append(c);
      if (n.sym >= 0) {
        const t = el('text', { x: X(n), y: Y(n) + 24, class: 'sym' });
        t.textContent = this.label(n.sym);
        g.append(t);
      }
    }
    svg.append(g);
    this.svgHost.append(svg);
    if (merging) {
      const mx = X(merging);
      const host = this.svgHost;
      if (mx < host.scrollLeft + 40 || mx > host.scrollLeft + host.clientWidth - 40)
        host.scrollLeft = mx - host.clientWidth / 2;
    }
  }

  private renderTable(): void {
    const lengths = new Uint8Array(Math.max(1, ...this.symbols.map((s) => s.symbol + 1)));
    for (const s of this.symbols) lengths[s.symbol] = s.deflateBits;
    const codes = canonicalCodes(lengths);
    const depth = new Map<number, number>();
    for (const n of this.nodes) if (n.sym >= 0) depth.set(n.sym, n.depth || 1);
    const rows = [...this.symbols].sort((a, b) => b.freq - a.freq || a.symbol - b.symbol);
    const total = rows.reduce((a, s) => a + s.freq, 0);
    const huffBits = rows.reduce((a, s) => a + s.freq * (depth.get(s.symbol) ?? 0), 0);
    const deflBits = rows.reduce((a, s) => a + s.freq * s.deflateBits, 0);
    const limited = rows.some((s) => s.deflateBits !== (depth.get(s.symbol) ?? 0));
    let html = `<p class="note">${total.toLocaleString()} symbols. Plain Huffman: ${huffBits.toLocaleString()} bits; DEFLATE's canonical code: ${deflBits.toLocaleString()} bits${
      limited
        ? '. Some lengths differ: DEFLATE caps codes at 15 bits (7 for the code-length alphabet) and ties can be broken differently, so Squeeze computes lengths with package-merge.'
        : '.'
    }</p>`;
    html +=
      '<table><thead><tr><th>Symbol</th><th>Count</th><th>Huffman depth</th><th>DEFLATE bits</th><th>Canonical code</th></tr></thead><tbody>';
    for (const s of rows.slice(0, 400)) {
      const code = s.deflateBits ? codes[s.symbol].toString(2).padStart(s.deflateBits, '0') : '—';
      html += `<tr><td>${escapeHtml(s.label)}</td><td>${s.freq.toLocaleString()}</td><td>${depth.get(s.symbol) ?? ''}</td><td>${s.deflateBits || '—'}</td><td><code>${code}</code></td></tr>`;
    }
    html += '</tbody></table>';
    this.tableHost.innerHTML = html;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
