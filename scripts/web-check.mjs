#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
// Browser checks for the web page (A15) and browser decoding of Squeeze PNGs (A16).
// Needs `npm run build` first and Playwright with Chromium available.
// Usage: node scripts/web-check.mjs [--screenshots DIR]
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { encodePng } from '../dist/lib/index.js';
import { serve } from './serve.mjs';

const { values } = parseArgs({ options: { screenshots: { type: 'string' } } });
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch {
    console.error('SKIP: playwright is not installed');
    process.exit(3);
  }
}

const server = await serve(0);
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

try {
  for (const vp of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(
      () => document.getElementById('stats')?.textContent?.includes('round trip verified'),
      null,
      { timeout: 30000 },
    );
    check(true, `${vp.name}: sample text compressed and verified`);
    const arcs = await page.evaluate(() => {
      const c = document.querySelector('#textview canvas');
      return c ? c.width * c.height : 0;
    });
    check(arcs > 0, `${vp.name}: back-reference canvas rendered`);
    const overflow = async () =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check((await overflow()) <= 0, `${vp.name}: no horizontal overflow on the text tab`);
    const footer = await page.textContent('footer');
    check(footer.includes("Vin's Atelier"), `${vp.name}: footer credits Vin's Atelier`);
    if (values.screenshots) {
      mkdirSync(values.screenshots, { recursive: true });
      await page.screenshot({ path: join(values.screenshots, `${vp.name}-text.png`), fullPage: false });
    }
    await page.click('#tab-huffman');
    await page.waitForSelector('#huff-tree svg', { timeout: 10000 });
    await page.click('#huff-play');
    await page.waitForTimeout(800);
    check((await page.locator('#huff-tree circle').count()) > 10, `${vp.name}: Huffman tree drawn`);
    check((await overflow()) <= 0, `${vp.name}: no horizontal overflow on the Huffman tab`);
    if (values.screenshots)
      await page.screenshot({ path: join(values.screenshots, `${vp.name}-huffman.png`) });
    await page.click('#tab-levels');
    await page.waitForFunction(() => document.querySelectorAll('#levels .lv-row').length >= 13, null, {
      timeout: 60000,
    });
    check(true, `${vp.name}: all 13 levels measured`);
    check((await overflow()) <= 0, `${vp.name}: no horizontal overflow on the levels tab`);
    if (values.screenshots)
      await page.screenshot({ path: join(values.screenshots, `${vp.name}-levels.png`) });
    await page.click('#tab-png');
    await page.waitForFunction(
      () => document.getElementById('png-info')?.textContent?.includes('identical pixels'),
      null,
      { timeout: 30000 },
    );
    check(true, `${vp.name}: sample image encoded and round-tripped`);
    check((await overflow()) <= 0, `${vp.name}: no horizontal overflow on the PNG tab`);
    if (values.screenshots) await page.screenshot({ path: join(values.screenshots, `${vp.name}-png.png`) });
    check(
      errors.length === 0,
      `${vp.name}: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`,
    );
    await page.close();
  }

  // A16: Chromium decodes PNGs written by Squeeze.
  const page = await browser.newPage();
  await page.goto(url);
  const cases = [];
  const mk = (name, w, h, f, opts = {}) => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), 4 * (y * w + x));
    cases.push({ name, w, h, data, png: encodePng({ width: w, height: h, data }, opts) });
  };
  mk('truecolour', 64, 48, (x, y) => [x * 4, y * 5, (x * y) & 255, 255]);
  mk('palette', 50, 30, (x, y) => (((x >> 2) + (y >> 2)) & 1 ? [200, 30, 30, 255] : [20, 20, 160, 255]));
  mk('greyscale 1-bit', 33, 17, (x, y) => ((x ^ y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  mk('greyscale 8-bit', 40, 40, (x) => [x * 6, x * 6, x * 6, 255]);
  mk('alpha 0/255', 32, 32, (x, y) => [x * 8, 100, y * 8, (x + y) % 3 ? 255 : 0]);
  mk('interlaced', 37, 29, (x, y) => [x * 7, y * 9, 128, 255], { interlace: true });
  mk('level 12', 64, 64, (x, y) => [(x * y) & 255, x * 4, y * 4, 255], { level: 12 });
  for (const c of cases) {
    const got = await page.evaluate(
      async ({ b64, w, h }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0);
        return [img.naturalWidth, img.naturalHeight, Array.from(g.getImageData(0, 0, w, h).data)];
      },
      { b64: Buffer.from(c.png).toString('base64'), w: c.w, h: c.h },
    );
    let bad = 0;
    for (let i = 0; i < c.data.length; i += 4) {
      if (c.data[i + 3] !== got[2][i + 3]) bad++;
      else if (
        c.data[i + 3] === 255 &&
        (c.data[i] !== got[2][i] || c.data[i + 1] !== got[2][i + 1] || c.data[i + 2] !== got[2][i + 2])
      )
        bad++;
    }
    check(
      got[0] === c.w && got[1] === c.h && bad === 0,
      `Chromium decodes Squeeze PNG (${c.name}) pixel-exactly${bad ? ` — ${bad} pixels differ` : ''}`,
    );
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.log(`${failures.length} browser check(s) failed`);
  process.exit(1);
}
