// Reads text from a screenshot on the phone itself, with Tesseract running in WebAssembly.
// The engine and the English and German language files ship with the app; no image leaves the device.

import { mergeRows } from './parse.js';

let workerPromise = null;
let progressListener = null;

function base() {
  return new URL('./vendor/tesseract/', document.baseURI).href;
}

async function loadScript(src) {
  if (window.Tesseract) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the text reader'));
    document.head.appendChild(s);
  });
}

async function getWorker(onProgress) {
  progressListener = onProgress || null;
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(base() + 'tesseract.min.js');
      const worker = await window.Tesseract.createWorker(['deu', 'eng'], 1, {
        workerPath: base() + 'worker.min.js',
        corePath: base() + 'core/',
        langPath: base() + 'lang/',
        workerBlobURL: false,
        cacheMethod: 'none',
        logger: (m) => progressListener?.(m),
      });
      // App screens are scattered text rather than a page of paragraphs.
      await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// Dark-mode screenshots read much better inverted; small ones read better enlarged.
async function prepare(file) {
  const bitmap = await createImageBitmap(file);
  const scale = bitmap.width < 1000 ? 2 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width * scale;
  canvas.height = bitmap.height * scale;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 16) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const dark = sum / (d.length / 16) < 110;
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (dark) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Returns [{ text, height }] for every row of text on the screen, top to bottom.
export async function readScreenshot(file, onProgress) {
  const worker = await getWorker(onProgress);
  const canvas = await prepare(file);
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const lines = [];
  for (const block of data.blocks || [])
    for (const para of block.paragraphs || [])
      for (const line of para.lines || [])
        lines.push({ text: line.text.trim(), top: line.bbox.y0, bottom: line.bbox.y1, left: line.bbox.x0 });
  return mergeRows(lines);
}

// Loads the engine in the background so the first scan is quicker and works offline later.
export function warmUp() {
  getWorker().catch(() => {});
}
