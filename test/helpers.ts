import { randomBytes } from 'node:crypto';

/** Deterministic PRNG (mulberry32) so failures reproduce. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mix of inputs that exercise different code paths. */
export function sampleInputs(): { name: string; data: Uint8Array }[] {
  const r = rng(42);
  const text = new TextEncoder().encode(
    'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, '.repeat(
      50,
    ),
  );
  const words = ['alpha', 'beta', 'gamma', 'delta', 'squeeze', 'deflate', 'huffman', ' ', '\n', 'the'];
  let wtext = '';
  while (wtext.length < 200_000) wtext += words[Math.floor(r() * words.length)];
  const skewed = new Uint8Array(100_000);
  for (let i = 0; i < skewed.length; i++) skewed[i] = Math.floor(r() ** 4 * 256);
  const runs = new Uint8Array(300_000);
  for (let i = 0; i < runs.length; ) {
    const v = Math.floor(r() * 4);
    const n = 1 + Math.floor(r() * 600);
    runs.fill(v, i, i + n);
    i += n;
  }
  return [
    { name: 'empty', data: new Uint8Array(0) },
    { name: 'one byte', data: Uint8Array.of(65) },
    { name: 'two bytes', data: Uint8Array.of(0, 255) },
    { name: 'zeros 100k', data: new Uint8Array(100_000) },
    { name: 'zeros 70000 (crosses stored limit)', data: new Uint8Array(70_000) },
    { name: 'random 100k', data: new Uint8Array(randomBytes(100_000)) },
    { name: 'random 1k', data: new Uint8Array(randomBytes(1000)) },
    { name: 'repeated text', data: text },
    { name: 'word salad 200k', data: new TextEncoder().encode(wtext) },
    { name: 'skewed bytes', data: skewed },
    { name: 'runs', data: runs },
    { name: 'all bytes', data: Uint8Array.from({ length: 256 * 40 }, (_, i) => i & 255) },
  ];
}
