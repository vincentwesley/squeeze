// Squeeze visualiser: wires the page to the worker and the views.

import { escapeHtml, HuffmanView, type SymbolInfo } from './huffview.js';
import type {
  CompressResult,
  DecodeResult,
  LevelPoint,
  PlainTrace,
  PngDecodeResult,
  PngEncodeResult,
  Request,
  Response,
} from './protocol.js';
import { SAMPLE_TEXT, sampleImage } from './sample.js';
import { TextView } from './textview.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const VIEW_LIMIT = 24_000; // bytes drawn in the text view
const MAX_INPUT = 4 << 20; // bytes compressed per run
const LEVELS_LIMIT = 256 << 10; // bytes used for the levels comparison

const STRATEGY = (l: number) => (l === 0 ? 'stored' : l <= 3 ? 'greedy' : l <= 9 ? 'lazy' : 'optimal');

// ---- worker plumbing -------------------------------------------------------
const worker = new Worker('worker.js');
let nextId = 1;
const handlers = new Map<number, (r: Response) => void>();
worker.onmessage = (e: MessageEvent<Response>) => handlers.get(e.data.id)?.(e.data);
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;
function request(msg: NoId<Request>, on: (r: Response) => void): number {
  const id = nextId++;
  handlers.set(id, on);
  worker.postMessage({ ...msg, id } as Request);
  return id;
}

// ---- tabs ------------------------------------------------------------------
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function selectTab(name: string): void {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`panel-${t.dataset.tab}`).hidden = !on;
  }
  if (name === 'levels') runLevels();
  if (name === 'png' && !pngLoaded) loadSampleImage();
  if (name === 'huffman') showHuffman();
}
for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t.dataset.tab!));
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    const j =
      e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (i + tabs.length - 1) % tabs.length
          : -1;
    if (j >= 0) {
      tabs[j].focus();
      selectTab(tabs[j].dataset.tab!);
    }
  });
}

// ---- state -----------------------------------------------------------------
const input = $<HTMLTextAreaElement>('input');
const levelInput = $<HTMLInputElement>('level');
const levelOut = $('level-out');
const stats = $('stats');
const blocksEl = $('blocks');
const view = new TextView($('textview'));
let current: { bytes: Uint8Array; trace: PlainTrace; source: 'text' | 'file'; label: string } | null = null;
let levelsFor: Uint8Array | null = null;

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');

function inputBytes(): Uint8Array {
  return new TextEncoder().encode(input.value).subarray(0, MAX_INPUT);
}

let pending = 0;
function compressText(): void {
  const bytes = inputBytes();
  const level = Number(levelInput.value);
  levelOut.textContent = `${level} · ${STRATEGY(level)}`;
  const ticket = ++pending;
  stats.textContent = 'Compressing…';
  // Small blocks make the per-block Huffman codes visible on short texts.
  request(
    { type: 'compress', data: bytes, level, maxBlockTokens: bytes.length < 50_000 ? 4096 : 32768 },
    (r) => {
      if (ticket !== pending) return;
      if (r.type === 'error') {
        stats.textContent = r.message;
        return;
      }
      if (r.type !== 'compress') return;
      const res: CompressResult = r.result;
      current = { bytes, trace: res.trace, source: 'text', label: 'your text' };
      stats.innerHTML = statLine(bytes.length, res.compressed, [
        `deflate ${res.ms.toFixed(1)} ms`,
        `inflate ${res.inflateMs.toFixed(1)} ms`,
        res.verified ? '✓ round trip verified' : '✗ round trip FAILED',
      ]);
      showTrace();
    },
  );
}

function statLine(orig: number, packed: number, extra: string[]): string {
  return `<span><b>${fmt(orig)}</b> bytes → <b>${fmt(packed)}</b> bytes (${pct(packed, orig)})</span>${extra.map((e) => `<span>${e}</span>`).join('')}`;
}

function showTrace(): void {
  if (!current) return;
  const { bytes, trace } = current;
  view.set(bytes, trace, VIEW_LIMIT);
  $('view-note').textContent =
    bytes.length > VIEW_LIMIT ? `Showing the first ${fmt(VIEW_LIMIT)} of ${fmt(bytes.length)} bytes.` : '';
  const types = ['stored', 'fixed', 'dynamic'];
  blocksEl.innerHTML = trace.blocks
    .map((b, i) => {
      const bytesIn = b.outEnd - b.outStart;
      const bits = b.bitEnd - b.bitStart;
      return `<li><b>Block ${i + 1}</b> ${types[b.type]} Huffman${b.type === 0 ? ' (stored)' : ''} · ${fmt(bytesIn)} bytes → ${fmt(Math.ceil(bits / 8))} bytes · header ${fmt(b.headerBits)} bits${b.final ? ' · final' : ''}</li>`;
    })
    .join('');
  const sel = $<HTMLSelectElement>('huff-block');
  sel.innerHTML = trace.blocks
    .map((b, i) =>
      b.type === 0
        ? ''
        : `<option value="${i}">Block ${i + 1} (${types[b.type]}, ${fmt(b.outEnd - b.outStart)} bytes)</option>`,
    )
    .join('');
  if (!$('panel-huffman').hidden) showHuffman();
}

// ---- Huffman ---------------------------------------------------------------
const huff = new HuffmanView($('huff-tree'), $('huff-table'));
huff.onStep = (s, total) => {
  $('huff-step').textContent = total ? `Merge ${s} of ${total}` : '';
  $<HTMLButtonElement>('huff-play').textContent = huff.playing ? 'Pause' : 'Play';
};

function lengthLabel(sym: number): string {
  const base = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195,
    227, 258,
  ];
  const i = sym - 257;
  const hi = i === 28 ? 258 : base[i + 1] - 1;
  return base[i] === hi ? `len ${hi}` : `len ${base[i]}–${hi}`;
}
function distLabel(sym: number): string {
  const base = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
    4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const hi = sym === 29 ? 32768 : base[sym + 1] - 1;
  return base[sym] === hi ? `d ${hi}` : `d ${base[sym]}–${hi}`;
}
function litLabel(sym: number): string {
  if (sym === 256) return 'END';
  if (sym > 256) return lengthLabel(sym);
  if (sym === 32) return '␠';
  if (sym === 10) return '↵';
  if (sym > 32 && sym < 127) return String.fromCharCode(sym);
  return `x${sym.toString(16).padStart(2, '0')}`;
}

function showHuffman(): void {
  if (!current) return;
  const sel = $<HTMLSelectElement>('huff-block');
  const bi = Number(sel.value || 0);
  const b = current.trace.blocks[bi];
  if (!b || b.type === 0) {
    $('huff-tree').textContent = 'No Huffman-coded block to show (stored blocks have no codes).';
    $('huff-table').textContent = '';
    return;
  }
  const alphabet = $<HTMLSelectElement>('huff-alphabet').value;
  const t = current.trace;
  const lit = new Map<number, number>();
  const dist = new Map<number, number>();
  const inc = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
  const LB = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195,
    227, 258,
  ];
  const DB = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
    4097, 6145, 8193, 12289, 16385, 24577,
  ];
  for (let k = b.tokenStart; k < b.tokenEnd; k++) {
    if (t.len[k] === 0) inc(lit, t.dist[k]);
    else {
      let li = 28;
      while (LB[li] > t.len[k]) li--;
      inc(lit, 257 + li);
      let di = 29;
      while (DB[di] > t.dist[k]) di--;
      inc(dist, di);
    }
  }
  inc(lit, 256);
  let symbols: SymbolInfo[];
  if (alphabet === 'dist') {
    symbols = [...dist].map(([s, f]) => ({
      symbol: s,
      label: distLabel(s),
      freq: f,
      deflateBits: b.distLengths?.[s] ?? 0,
    }));
  } else {
    symbols = [...lit].map(([s, f]) => ({
      symbol: s,
      label: litLabel(s),
      freq: f,
      deflateBits: b.litLenLengths?.[s] ?? 0,
    }));
  }
  $('huff-kind').textContent =
    b.type === 1
      ? 'This block uses the fixed code from RFC 1951, so its code lengths were not built from these counts; the tree shows what a dynamic block would have used.'
      : 'This block carries its own dynamic Huffman code, built from these counts.';
  huff.set(symbols);
}
$('huff-block').addEventListener('change', showHuffman);
$('huff-alphabet').addEventListener('change', showHuffman);
$('huff-play').addEventListener('click', () => {
  if (huff.playing) huff.stop();
  else huff.play(Math.max(60, 9000 / Math.max(1, huff.total)));
  $<HTMLButtonElement>('huff-play').textContent = huff.playing ? 'Pause' : 'Play';
});
$('huff-step-btn').addEventListener('click', () => {
  huff.stop();
  huff.next();
});
$('huff-reset').addEventListener('click', () => huff.reset());

// ---- levels ----------------------------------------------------------------
let levelsTicket = 0;
function runLevels(): void {
  const data = current?.bytes ?? inputBytes();
  const slice = data.subarray(0, LEVELS_LIMIT);
  if (levelsFor && levelsFor.length === slice.length && levelsFor.every((v, i) => v === slice[i])) return;
  levelsFor = slice;
  const points: LevelPoint[] = [];
  let native: { size: number; ms: number } | undefined;
  const ticket = ++levelsTicket;
  $('levels-note').textContent =
    `Compressing ${fmt(slice.length)} bytes${data.length > slice.length ? ` (the first ${fmt(LEVELS_LIMIT)})` : ''} at every level, in your browser…`;
  const draw = () => drawLevels(slice.length, points, native);
  request({ type: 'levels', data: slice }, (r) => {
    if (ticket !== levelsTicket) return;
    if (r.type === 'level') {
      points.push(r.point);
      draw();
    } else if (r.type === 'levels-done') {
      native = r.native;
      draw();
      $('levels-note').textContent =
        `${fmt(slice.length)} bytes, each level timed once in a Web Worker on this device. Times include JIT warm-up for the first levels; the published benchmark (docs/BENCHMARKS.md) uses medians of repeated runs.`;
    } else if (r.type === 'error') $('levels-note').textContent = r.message;
  });
}

function drawLevels(orig: number, points: LevelPoint[], native?: { size: number; ms: number }): void {
  const rows = points.map((p) => ({
    label: `Level ${p.level}`,
    sub: STRATEGY(p.level),
    size: p.size,
    ms: p.ms,
    ref: false,
  }));
  if (native)
    rows.push({ label: 'Browser', sub: 'native zlib', size: native.size, ms: native.ms, ref: true });
  const maxSize = Math.max(orig, ...rows.map((r) => r.size));
  const maxMs = Math.max(1, ...rows.map((r) => r.ms));
  const logMs = (ms: number) => Math.log10(1 + ms) / Math.log10(1 + maxMs);
  const best = Math.min(...rows.map((r) => r.size));
  $('levels').innerHTML =
    `<div class="lv-head"><span></span><span>Compressed size (share of original)</span><span>Time (log scale)</span></div>${rows
      .map(
        (
          r,
        ) => `<div class="lv-row${r.ref ? ' ref' : ''}" title="${r.label}: ${fmt(r.size)} bytes, ${r.ms.toFixed(1)} ms">
      <span class="lv-label">${r.label}<small>${r.sub}</small></span>
      <span class="lv-bar"><i style="width:${((100 * r.size) / maxSize).toFixed(2)}%"></i><em>${pct(r.size, orig)}${r.size === best ? ' · smallest' : ''}</em></span>
      <span class="lv-bar time"><i style="width:${(100 * logMs(r.ms)).toFixed(2)}%"></i><em>${r.ms < 10 ? r.ms.toFixed(1) : fmt(Math.round(r.ms))} ms</em></span>
    </div>`,
      )
      .join('')}`;
}

// ---- PNG -------------------------------------------------------------------
let pngLoaded = false;
const FILTER_NAMES = ['None', 'Sub', 'Up', 'Average', 'Paeth'];
const COLOR_TYPES: Record<number, string> = {
  0: 'greyscale',
  2: 'truecolour',
  3: 'indexed (palette)',
  4: 'greyscale + alpha',
  6: 'truecolour + alpha',
};
let downloadUrl = '';

function showImage(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): void {
  const c = $<HTMLCanvasElement>('png-canvas');
  c.width = width;
  c.height = height;
  c.style.aspectRatio = `${width} / ${height}`;
  c.style.maxWidth = `${Math.max(width, Math.min(width * 4, 626))}px`;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
}

function showRowFilters(f: Uint8Array): void {
  const c = $<HTMLCanvasElement>('png-rows');
  c.width = 1;
  c.height = Math.max(1, f.length);
  const g = c.getContext('2d')!;
  const colors = ['--f0', '--f1', '--f2', '--f3', '--f4'].map((v) =>
    getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
  );
  for (let y = 0; y < f.length; y++) {
    g.fillStyle = colors[f[y]] ?? '#888';
    g.fillRect(0, y, 1, 1);
  }
  const counts = [0, 0, 0, 0, 0];
  for (const v of f) counts[v]++;
  $('png-legend').innerHTML = FILTER_NAMES.map(
    (n, i) => `<li><i class="sw f${i}"></i>${n} <small>${counts[i]} rows</small></li>`,
  ).join('');
}

function encodeImage(img: ImageData, label: string): void {
  pngLoaded = true;
  showImage(img.width, img.height, img.data);
  $('png-info').textContent = `Encoding ${label}…`;
  const rgba = new Uint8Array(img.data);
  request({ type: 'png-encode', width: img.width, height: img.height, rgba }, (r) => {
    if (r.type === 'error') {
      $('png-info').textContent = r.message;
      return;
    }
    if (r.type !== 'png-encode') return;
    const res: PngEncodeResult = r.result;
    showRowFilters(res.rowFilters);
    const raw = img.width * img.height * 4;
    $('png-info').innerHTML =
      `<p><b>${escapeHtml(label)}</b>, ${img.width}×${img.height}: ${fmt(raw)} bytes of RGBA → <b>${fmt(res.png.length)}</b> byte PNG (${pct(res.png.length, raw)}) in ${res.ms.toFixed(0)} ms.</p>
      <p>Squeeze tried every filter strategy and kept the smallest (<b>${res.filter}</b>), storing the pixels as <b>${COLOR_TYPES[res.colorType]}</b> at ${res.bitDepth} bits per sample, the smallest lossless layout for them. ${res.roundTrip ? '✓ Decoding it again with Squeeze gives back identical pixels.' : '✗ Round trip mismatch!'}</p>`;
    const best = Math.min(...res.filters.map((f) => f.size));
    const max = Math.max(...res.filters.map((f) => f.size));
    $('png-filters').innerHTML = res.filters
      .map(
        (f) =>
          `<div class="lv-row" title="${f.filter}: ${fmt(f.size)} bytes"><span class="lv-label">${f.filter}</span><span class="lv-bar"><i style="width:${((100 * f.size) / max).toFixed(1)}%"></i><em>${fmt(f.size)} bytes${f.size === best ? ' · smallest' : ''}</em></span></div>`,
      )
      .join('');
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([res.png as BlobPart], { type: 'image/png' }));
    const a = $<HTMLAnchorElement>('png-download');
    a.href = downloadUrl;
    a.hidden = false;
    $('png-chunks').textContent = '';
  });
}

function decodePngFile(bytes: Uint8Array, name: string): void {
  pngLoaded = true;
  $('png-info').textContent = `Decoding ${name} with Squeeze…`;
  request({ type: 'png-decode', file: bytes }, (r) => {
    if (r.type === 'error') {
      $('png-info').innerHTML =
        `<p class="err">Squeeze rejected <b>${escapeHtml(name)}</b>: ${escapeHtml(r.message)}</p>`;
      return;
    }
    if (r.type !== 'png-decode') return;
    const res: PngDecodeResult = r.result;
    showImage(res.width, res.height, res.rgba);
    if (res.rowFilters.length) showRowFilters(res.rowFilters);
    else $('png-legend').innerHTML = '<li>Interlaced image: filters are per pass.</li>';
    const blocks = res.trace.blocks.length;
    $('png-info').innerHTML =
      `<p><b>${escapeHtml(name)}</b>: ${res.width}×${res.height}, ${COLOR_TYPES[res.header.colorType]}, ${res.header.bitDepth}-bit${res.header.interlace ? ', Adam7 interlaced' : ''}. Decoded by Squeeze (not the browser) in ${res.ms.toFixed(0)} ms.</p>
      <p>The image data is one zlib stream of ${fmt(res.idatBytes)} bytes in ${blocks} DEFLATE block${blocks === 1 ? '' : 's'}, inflating to ${fmt(res.rawBytes)} bytes of filtered scanlines. Re-encoding below shows what Squeeze would write.</p>`;
    $('png-chunks').innerHTML =
      `<h3>Chunks</h3><ul class="chips">${res.chunks.map((c) => `<li><code>${c.type}</code> ${fmt(c.length)} B</li>`).join('')}</ul>`;
    // Also show the Squeeze re-encode of the same pixels.
    const rgba = new Uint8Array(res.rgba);
    request({ type: 'png-encode', width: res.width, height: res.height, rgba }, (r2) => {
      if (r2.type !== 'png-encode') return;
      const best = Math.min(...r2.result.filters.map((f) => f.size));
      const max = Math.max(...r2.result.filters.map((f) => f.size));
      $('png-filters').innerHTML = r2.result.filters
        .map(
          (f) =>
            `<div class="lv-row"><span class="lv-label">${f.filter}</span><span class="lv-bar"><i style="width:${((100 * f.size) / max).toFixed(1)}%"></i><em>${fmt(f.size)} bytes${f.size === best ? ' · smallest' : ''}</em></span></div>`,
        )
        .join('');
      $('png-info').innerHTML +=
        `<p>Squeeze's re-encode: <b>${fmt(r2.result.png.length)}</b> bytes vs ${fmt(bytes.length)} bytes in the original file (${pct(r2.result.png.length, bytes.length)}).</p>`;
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([r2.result.png as BlobPart], { type: 'image/png' }));
      const a = $<HTMLAnchorElement>('png-download');
      a.href = downloadUrl;
      a.hidden = false;
    });
  });
}

function loadSampleImage(): void {
  encodeImage(sampleImage(), 'Sample image (drawn in your browser)');
}

async function loadImageFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePngFile(bytes, file.name);
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    encodeImage(g.getImageData(0, 0, bmp.width, bmp.height), file.name);
  } catch {
    $('png-info').textContent = `Your browser could not read ${file.name} as an image.`;
  }
}

// ---- inputs ----------------------------------------------------------------
let debounce = 0;
input.addEventListener('input', () => {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(compressText, 250);
});
levelInput.addEventListener('input', compressText);
$('sample').addEventListener('click', () => {
  input.value = SAMPLE_TEXT;
  compressText();
});
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  r.addEventListener('change', () => {
    view.mode = r.value as 'refs' | 'heat';
    $('legend-refs').hidden = view.mode !== 'refs';
    $('legend-heat').hidden = view.mode !== 'heat';
    view.draw();
  });
}
$('min-arc').addEventListener('input', (e) => {
  view.minArc = Number((e.target as HTMLInputElement).value);
  $('min-arc-out').textContent = String(view.minArc);
  view.draw();
});

$<HTMLInputElement>('open-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    selectTab('png');
    decodePngFile(bytes, file.name);
    return;
  }
  const looksCompressed =
    /\.(gz|zz|z|deflate|zlib|tgz)$/i.test(file.name) || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (looksCompressed) {
    stats.textContent = `Decoding ${file.name}…`;
    request({ type: 'decode', file: bytes }, (r) => {
      if (r.type === 'error') {
        stats.innerHTML = `<span class="err">Squeeze rejected ${escapeHtml(file.name)}: ${escapeHtml(r.message)}</span>`;
        return;
      }
      if (r.type !== 'decode') return;
      const res: DecodeResult = r.result;
      current = { bytes: res.data, trace: res.trace, source: 'file', label: file.name };
      levelsFor = null;
      stats.innerHTML = statLine(res.data.length, res.compressed, [
        `${res.format} file${res.name ? ` “${escapeHtml(res.name)}”` : ''}`,
        `decoded by Squeeze in ${res.ms.toFixed(1)} ms`,
        'showing the back-references its compressor chose',
      ]);
      showTrace();
    });
  } else {
    input.value = new TextDecoder().decode(bytes.subarray(0, MAX_INPUT));
    compressText();
  }
});
$<HTMLInputElement>('open-image').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadImageFile(file);
});
$('sample-image').addEventListener('click', loadSampleImage);

input.value = SAMPLE_TEXT;
compressText();
