import { describe, expect, it } from 'vitest';
import { runFuzz } from './fuzz-core.js';

describe('fuzzing (short run; `npm run fuzz` runs longer)', () => {
  it('agrees with zlib on mutated streams and never throws anything but SqueezeError', () => {
    const stats = runFuzz(3000, 7);
    expect(
      stats.failures.map(
        (f) => `${f.kind}: ${f.detail} [${Buffer.from(f.input).toString('hex').slice(0, 120)}]`,
      ),
    ).toEqual([]);
    expect(stats.bothAccepted).toBeGreaterThan(50);
    expect(stats.bothRejected).toBeGreaterThan(500);
    expect(stats.pngRejected).toBeGreaterThan(100);
  });
});
