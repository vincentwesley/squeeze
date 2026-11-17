// Sample content written for this page (no third-party text or images are bundled).

export const SAMPLE_TEXT = `How does a compressor squeeze a file?

It looks for things it has seen before. When a run of bytes repeats something earlier in the file, the compressor does not write the bytes again; it writes a short note instead: "go back 42 bytes and copy 17 of them". Those notes are back-references, and each one is drawn above as an arc from the copy back to its source.

What cannot be copied is written as a literal, one byte at a time. Then a second trick squeezes the literals and the notes together: common symbols get short codes and rare symbols get long ones. That is Huffman coding, and the codes are chosen fresh for every block of the file.

Repetition is the fuel. A paragraph that repeats itself, a paragraph that repeats itself, compresses beautifully. Random noise does not compress at all, because random noise never repeats.

The same two tricks, back-references and Huffman codes, sit inside every zip file, every gzip file and every PNG image. Type anything into the box to watch them work on your own words, or open a .gz file to see the decisions another compressor made.
`;

/** A procedurally drawn test image: gradients, shapes, flat areas and fine detail. */
export function sampleImage(width = 320, height = 200): ImageData {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#1c5cab');
  sky.addColorStop(1, '#cde2fb');
  g.fillStyle = sky;
  g.fillRect(0, 0, width, height);
  g.fillStyle = '#eda100';
  g.beginPath();
  g.arc(width * 0.78, height * 0.3, height * 0.14, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a6b3c';
  g.beginPath();
  g.moveTo(0, height);
  for (let x = 0; x <= width; x += 4)
    g.lineTo(x, height * 0.72 - Math.sin(x / 23) * 14 - Math.sin(x / 7) * 3);
  g.lineTo(width, height);
  g.fill();
  g.fillStyle = '#fcfcfb';
  g.font = `bold ${Math.round(height / 7)}px system-ui, sans-serif`;
  g.fillText('squeeze', width * 0.06, height * 0.22);
  for (let i = 0; i < 6; i++) {
    g.fillStyle = i % 2 ? '#e34948' : '#fcfcfb';
    g.fillRect(width * 0.06 + i * 14, height * 0.86, 10, 10);
  }
  // Photographic-style texture in the lower half: smooth shading plus deterministic grain.
  const img = g.getImageData(0, 0, width, height);
  let seed = 7;
  for (let y = Math.floor(height * 0.45); y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = ((seed >>> 16) % 5) - 2 + Math.round(6 * Math.sin(x / 9) * Math.cos(y / 11));
      const i = 4 * (y * width + x);
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.max(0, Math.min(255, img.data[i + c] + n));
    }
  }
  return img;
}
